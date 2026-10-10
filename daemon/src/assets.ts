/**
 * assets.ts — content-hashed asset registry + one-time normalize/ingest.
 *
 * Ingest flow (once per distinct video, cached forever by content hash):
 *   download → probe → normalize (codec h264-in-mp4, target bitrate, target
 *   resolution via scale+crop — never per render) → sha256 the RESULTING file
 *   → store as data/assets/<hex>.mp4 → index entry.
 *
 * Normalization policy (v1, documented ceiling):
 *   ponytail: sources LARGER than target (1920x1080) or with a mismatched
 *   aspect ratio get scale+crop to target; sources smaller than target with
 *   matching aspect keep their resolution (upscaling spends bits on
 *   interpolated detail). Target bitrate 2.5 Mbps at 1080p, scaled by pixel
 *   area for smaller outputs, clamped to [0.5, 2.5] Mbps. A source already
 *   h264-in-mp4 at/under target bitrate and resolution is cached as-is.
 *   The source's own audio track is stripped (-an): the mux maps 0:v only,
 *   so it is dead weight in the cache.
 */
import fs from "node:fs";
import path from "node:path";
import { ffmpegRun, ffprobeJson, videoStream, atomicWriteJson, type FfprobeInfo } from "./ffmpeg";
import { searchAll, type StockCandidate } from "./providers";

export const DATA_DIR = process.env.AMBIENTD_DATA ?? path.resolve(process.cwd(), "data");
export const ASSETS_DIR = path.join(DATA_DIR, "assets");
const INDEX_PATH = path.join(DATA_DIR, "assets.json");

const TARGET_W = 1920;
const TARGET_H = 1080;
const BASE_BITRATE = 2_500_000; // 2.5 Mbps @ 1080p — spec default band 1.5–3
const MIN_BITRATE = 500_000;

export interface AssetEntry {
  asset_id: string; // "sha256:<hex of normalized file>"
  file: string;
  source: { provider?: string; url?: string; label?: string; author?: string; license?: string };
  width: number;
  height: number;
  duration_sec: number;
  bitrate: number;
  bytes: number;
  codec: string;
  created: string;
  reencoded: boolean;
}

function loadIndex(): Record<string, AssetEntry> {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveIndex(idx: Record<string, AssetEntry>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteJson(INDEX_PATH, idx);
}

export function listAssets(): AssetEntry[] {
  return Object.values(loadIndex()).sort((a, b) => a.created.localeCompare(b.created));
}
export function getAsset(assetId: string): AssetEntry | undefined {
  return loadIndex()[assetId];
}
export function evictAsset(assetId: string): boolean {
  const idx = loadIndex();
  const entry = idx[assetId];
  if (!entry) return false;
  fs.rmSync(entry.file, { force: true });
  delete idx[assetId];
  saveIndex(idx);
  return true;
}

export async function sha256File(file: string): Promise<string> {
  // streaming (bounded 1 MiB buffer) — uploads can be large; never read whole
  const { sha256FileStreaming } = await import("./ffmpeg");
  return sha256FileStreaming(file);
}

interface NormalizeDecision {
  reencode: boolean;
  reason: string;
  targetW: number;
  targetH: number;
  targetBitrate: number;
}

export function decideNormalize(info: FfprobeInfo): NormalizeDecision {
  const vs = videoStream(info);
  if (!vs) throw new Error("no video stream in source");
  const srcBitrate = Number(info.format.bit_rate ?? 0);
  const bitrateTarget = Math.max(
    MIN_BITRATE,
    Math.min(BASE_BITRATE, Math.round((BASE_BITRATE * (vs.width ?? TARGET_W) * (vs.height ?? TARGET_H)) / (TARGET_W * TARGET_H))),
  );
  const w = vs.width ?? 0;
  const h = vs.height ?? 0;
  const srcAr = h > 0 ? w / h : 1;
  const targetAr = TARGET_W / TARGET_H;

  if (vs.codec_name !== "h264") {
    return { reencode: true, reason: `codec ${vs.codec_name} is not h264`, targetW: w, targetH: h, targetBitrate: bitrateTarget };
  }
  if (!(info.format.format_name ?? "").split(",").some((n) => ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].includes(n))) {
    return { reencode: true, reason: `container ${info.format.format_name} does not stream-copy into mp4`, targetW: w, targetH: h, targetBitrate: bitrateTarget };
  }
  if (vs.pix_fmt && vs.pix_fmt !== "yuv420p") {
    return { reencode: true, reason: `pix_fmt ${vs.pix_fmt} not playback-safe`, targetW: w, targetH: h, targetBitrate: bitrateTarget };
  }
  if (h > TARGET_H) {
    // larger than target (any AR) → scale+crop down to target
    return { reencode: true, reason: `${w}x${h} larger than target ${TARGET_W}x${TARGET_H}`, targetW: TARGET_W, targetH: TARGET_H, targetBitrate: BASE_BITRATE };
  }
  if (Math.abs(srcAr - targetAr) > 0.02) {
    // AR mismatch at/below target size → scale+crop to target AR (keep ≤ target height)
    const outH = Math.min(h, TARGET_H);
    return { reencode: true, reason: `aspect ${srcAr.toFixed(3)} != ${targetAr.toFixed(3)}`, targetW: Math.round((outH * targetAr) / 2) * 2, targetH: outH, targetBitrate: bitrateTarget };
  }
  if (srcBitrate > bitrateTarget * 1.15) {
    return { reencode: true, reason: `bitrate ${(srcBitrate / 1e6).toFixed(2)} Mbps above target ${(bitrateTarget / 1e6).toFixed(2)}`, targetW: w, targetH: h, targetBitrate: bitrateTarget };
  }
  return { reencode: false, reason: "already h264-in-mp4 within bitrate/resolution target", targetW: w, targetH: h, targetBitrate: bitrateTarget };
}

/** Normalize a local source file into a temp output; returns {file, decision, info}. */
async function normalize(srcFile: string, workDir: string): Promise<{ file: string; decision: NormalizeDecision; info: FfprobeInfo }> {
  const info = await ffprobeJson(srcFile);
  const decision = decideNormalize(info);
  if (!decision.reencode) {
    return { file: srcFile, decision, info };
  }
  const out = path.join(workDir, "normalized.mp4");
  const res = await ffmpegRun([
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", srcFile,
    "-vf", `scale=${decision.targetW}:${decision.targetH}:force_original_aspect_ratio=increase,crop=${decision.targetW}:${decision.targetH}`,
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", String(decision.targetBitrate),
    "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    out,
  ], 10 * 60_000);
  if (res.code !== 0) throw new Error(`normalize re-encode failed: ${res.stderr.slice(-800)}`);
  return { file: out, decision, info: await ffprobeJson(out) };
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/** Ingest from an HTTP(S) URL or local path. Idempotent per content hash. */
export async function ingestVideo(src: { url?: string; file?: string; label?: string; provider?: string; author?: string; license?: string }): Promise<AssetEntry> {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(DATA_DIR, "ingest-"));
  try {
    let local: string;
    if (src.url) {
      local = path.join(workDir, "source");
      await downloadTo(src.url, local);
    } else if (src.file) {
      local = src.file;
    } else {
      throw new Error("no source (pass url or file)");
    }
    if (!fs.existsSync(local)) throw new Error(`source file not found: ${local}`);

    const norm = await normalize(local, workDir);
    const vs = videoStream(norm.info);
    if (!vs?.width || !vs?.height) throw new Error("normalized asset has no usable video stream");
    const durationSec = Number(norm.info.format.duration ?? 0);
    if (!(durationSec > 0)) throw new Error("normalized asset has zero duration");

    const hex = await sha256File(norm.file);
    const assetId = `sha256:${hex}`;
    const idx = loadIndex();
    if (idx[assetId]) {
      return idx[assetId]; // already cached — content hash dedup
    }
    const dest = path.join(ASSETS_DIR, `${hex}.mp4`);
    fs.copyFileSync(norm.file, dest);
    const entry: AssetEntry = {
      asset_id: assetId,
      file: dest,
      source: {
        provider: src.provider,
        url: src.url,
        label: src.label,
        author: src.author,
        license: src.license,
      },
      width: vs.width,
      height: vs.height,
      duration_sec: durationSec,
      bitrate: Number(norm.info.format.bit_rate ?? 0),
      bytes: fs.statSync(dest).size,
      codec: vs.codec_name ?? "h264",
      created: new Date().toISOString(),
      reencoded: norm.decision.reencode,
    };
    idx[assetId] = entry;
    saveIndex(idx);
    return entry;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ── search → select wiring ───────────────────────────────────────────────────
// In-memory ref → candidate cache (search and select both hit the daemon).
// ponytail: lost on daemon restart — a raw URL is always accepted as a ref,
// and re-searching is one call. Upgrade path: persist to assets.json.

const candidateCache = new Map<string, StockCandidate>();

export async function searchStockVideos(query: string, count = 10, provider?: string): Promise<StockCandidate[]> {
  const results = await searchAll(query, count, provider);
  for (const c of results) candidateCache.set(c.ref, c);
  return results;
}

export async function selectCandidate(ref: string): Promise<AssetEntry> {
  let url = ref;
  let meta: Partial<StockCandidate> = {};
  if (!/^https?:\/\//.test(ref)) {
    const hit = candidateCache.get(ref);
    if (!hit) throw new Error(`unknown candidate_ref '${ref}' — search first, or pass a direct URL`);
    url = hit.download_url;
    meta = hit;
  }
  return ingestVideo({
    url,
    provider: meta.provider,
    label: meta.title,
    author: meta.author,
    license: meta.license,
  });
}
