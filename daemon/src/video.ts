/**
 * video.ts — per-render mux (fast path) + static-image fallback.
 *
 * Mux = the spec's exact two-input command: looped stream-copy of the
 * normalized cached video (input 0) + raw PCM16 piped to stdin (input 1).
 * Only ever touches the source's video stream (-map 0:v); the asset's own
 * audio was stripped at ingest and is never referenced.
 *
 * The fallback encodes a single looped background image at 1 fps (measured
 * cheap in bench D1) in the same single ffmpeg pass with the audio pipe.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { DATA_DIR } from "./assets";

export const DEFAULT_BG = path.join(DATA_DIR, "default_bg.png");

/** Generate the deterministic default background once (dark blue-teal gradient). */
export async function ensureDefaultBg(): Promise<string> {
  if (fs.existsSync(DEFAULT_BG)) return DEFAULT_BG;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { ffmpegRun } = await import("./ffmpeg");
  const res = await ffmpegRun([
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "gradients=s=1920x1080:c0=0x0a1420:c1=0x1c3a4a:x0=0:y0=0:x1=1920:y1=1080:seed=42",
    "-frames:v", "1",
    DEFAULT_BG,
  ], 60_000);
  if (res.code !== 0) throw new Error(`default bg generation failed: ${res.stderr.slice(-400)}`);
  return DEFAULT_BG;
}

export interface MuxJob {
  kind: "asset" | "static";
  assetFile?: string; // normalized cached video (kind=asset)
  sampleRate: number;
  outputTmp: string;
  durationSec: number;
  onStderr?: (s: string) => void;
}

/** Spawn the two-input mux ffmpeg; caller pipes PCM16 into stdin and ends it. */
export function spawnMux(job: MuxJob): { stdin: import("node:stream").Writable; done: Promise<{ code: number | null; stderr: string }> } {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (job.kind === "asset") {
    args.push("-stream_loop", "-1", "-i", job.assetFile!);
  } else {
    // single looped image @1fps, h264, cheap
    args.push("-loop", "1", "-r", "1", "-i", DEFAULT_BG);
  }
  args.push(
    "-f", "s16le", "-ar", String(job.sampleRate), "-ac", "2", "-i", "pipe:0",
    "-map", "0:v", "-map", "1:a",
  );
  if (job.kind === "asset") {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-r", "1", "-pix_fmt", "yuv420p");
  }
  args.push(
    "-c:a", "aac", "-b:a", "160k",
    // MEASURED (test/phase4): with -stream_loop -1 (or -loop 1) on this ffmpeg
    // (7.1.5), -shortest alone overshoots the audio end by tens of seconds
    // (30 s audio → 72.5 s file: demuxed-ahead looped video packets keep
    // muxing). The repo's own bench-D pattern (explicit -t, no reliance on
    // -shortest) bounds it: -t caps output at the snapped audio length.
    "-t", String(job.durationSec),
    "-shortest",
    "-movflags", "+faststart",
    job.outputTmp,
  );
  const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
    job.onStderr?.(String(d));
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (e) => resolve({ code: null, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  return { stdin: child.stdin, done };
}
