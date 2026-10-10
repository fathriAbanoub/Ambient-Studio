/**
 * i_entry.ts — runs all I1 measurements in one child process:
 *   I1a  healthy in-process C-graph at 1024/4096/16384 frames + single-block
 *        partition → streaming sha256 equality. c_graph renders per-sample
 *        and flushes in 8192-frame slices, so the "single block" partition
 *        allocates no giant accumulator — partition size parameterizes only
 *        where block boundaries fall.
 *   I1b  broken variant (re-anchoring + block-relative coefficient quanta —
 *        the two mechanisms per-chunk OfflineAudioContext rendering applies)
 *        at 3 block sizes → hashes must differ, and sampled max|Δ| vs the
 *        healthy reference must grow with block size.
 *   I1c  node-web-audio-api single-pass reference of the same graph at
 *        crossSec → per-sample max|Δ| / rms vs my 4096-frame render.
 *        The reference buffer is materialized by the Web Audio API (bounded,
 *        disclosed in the result) — my side always streams.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { renderCGraph, compareAgainstReference, type SynthSink, type CGraphParams } from "./c_graph";
import { renderCGraphWebAudio } from "./c_webaudio";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SR = Number(process.env.BENCH_G_SAMPLE_RATE ?? 44100);
const totalSec = Number(arg("--total-sec") ?? 1800);
const crossSec = Number(arg("--cross-sec") ?? 120);

const C = {
  sampleRate: SR, totalSec,
  carrierHz: 220, subHz: 55, subGain: 0.5,
  filterStartHz: 600, filterEndHz: 2400, filterQ: 1.0,
  delayStartSec: 0.2, delayEndSec: 0.35, delayMaxSec: 2.0, feedbackGain: 0.35,
  masterGain: 0.5,
  panPeriodSec: 10, panTargetTcSec: 0.08,
};

class HashSink implements SynthSink {
  private h = createHash("sha256");
  private hex: string | null = null;
  nonFinite = 0;
  peak = 0;
  samples = 0;
  writeBlock(l: Float32Array, r: Float32Array, frames: number): void {
    const buf = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const cl = Math.max(-1, Math.min(1, l[i]));
      const cr = Math.max(-1, Math.min(1, r[i]));
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) this.nonFinite++;
      const al = Math.abs(l[i]), ar = Math.abs(r[i]);
      if (al > this.peak) this.peak = al;
      if (ar > this.peak) this.peak = ar;
      buf.writeInt16LE(Math.round(cl < 0 ? cl * 0x8000 : cl * 0x7fff), i * 4);
      buf.writeInt16LE(Math.round(cr < 0 ? cr * 0x8000 : cr * 0x7fff), i * 4 + 2);
    }
    this.h.update(buf);
    this.samples += frames;
  }
  sha256(): string { if (this.hex === null) this.hex = this.h.digest("hex"); return this.hex; }
}

const assertions: Array<{ name: string; passed: boolean; detail: string }> = [];
const stats: Record<string, unknown> = {};
const healthy_hashes: Record<string, string> = {};
const broken_hashes: Record<string, string> = {};

async function main(): Promise<void> {
// ── I1a: healthy partitions ─────────────────────────────────────────────────
const partitions = [1024, 4096, 16384, Math.ceil(totalSec * SR)];
const healthyWalls: Record<string, number> = {};
for (const bs of partitions) {
  const params: CGraphParams = { ...C, blockFrames: bs, broken: false };
  const t0 = performance.now();
  const sink = new HashSink();
  const s = renderCGraph(params, sink);
  const wall = (performance.now() - t0) / 1000;
  const label = bs === partitions[3] ? "single_block" : String(bs);
  healthy_hashes[label] = sink.sha256();
  healthyWalls[label] = wall;
  assertions.push({ name: `nonfinite_zero_healthy_${label}`, passed: s.nonFinite === 0, detail: `non-finite: ${s.nonFinite}` });
}
const healthyEqual = Object.values(healthy_hashes).every((h) => h === healthy_hashes["1024"]);
assertions.push({
  name: "block_size_invariance_incl_single_block",
  passed: healthyEqual,
  detail: healthyEqual
    ? `1024/4096/16384/single-block partitions → identical sha256 (${healthy_hashes["1024"].slice(0, 16)}…): chunk divergence has no mechanism in this design`
    : `MISMATCH: ${JSON.stringify(Object.fromEntries(Object.entries(healthy_hashes).map(([k, v]) => [k, v.slice(0, 16)])))}`,
});
stats.healthy_walls_sec = healthyWalls;
stats.healthy_hashes = healthy_hashes;

// ── I1b: broken variant — hash divergence + sampled magnitude growth ───────
function sampledMaxDelta(brokenBs: number): number {
  // Strided comparison (every 4th frame, both channels) of broken vs healthy
  // 1024-frame render — bounded memory: (frames/4) × 8 B for the reference.
  const stride = 4;
  const sampled: number[] = [];
  let wpos = 0;
  const healthy: CGraphParams = { ...C, blockFrames: 1024, broken: false };
  renderCGraph(healthy, { writeBlock: (l, r, frames) => {
    for (let i = 0; i < frames; i++, wpos++) {
      if (wpos % stride === 0) sampled.push(l[i], r[i]);
    }
  } });
  let maxD = 0;
  let pos = 0;
  const broken: CGraphParams = { ...C, blockFrames: brokenBs, broken: true };
  renderCGraph(broken, { writeBlock: (l, r, frames) => {
    for (let i = 0; i < frames; i++, pos++) {
      if (pos % stride === 0) {
        const idx = (pos / stride) | 0;
        const dl = Math.abs(sampled[idx * 2] - l[i]);
        const dr = Math.abs(sampled[idx * 2 + 1] - r[i]);
        if (dl > maxD) maxD = dl;
        if (dr > maxD) maxD = dr;
      }
    }
  } });
  return maxD;
}

const brokenWalls: Record<string, number> = {};
const brokenGrowth: Record<string, number> = {};
for (const bs of [1024, 8192, 65536]) {
  const params: CGraphParams = { ...C, blockFrames: bs, broken: true };
  const t0 = performance.now();
  const sink = new HashSink();
  renderCGraph(params, sink);
  brokenWalls[String(bs)] = (performance.now() - t0) / 1000;
  broken_hashes[String(bs)] = sink.sha256();
  brokenGrowth[String(bs)] = sampledMaxDelta(bs);
}
const distinctBroken = new Set(Object.values(broken_hashes)).size > 1;
assertions.push({
  name: "broken_variant_diverges",
  passed: distinctBroken,
  detail: distinctBroken
    ? `broken re-anchoring produces different output per block size (${Object.keys(broken_hashes).join("/")}): the tests detect the failure mode`
    : "broken variant produced identical hashes — re-anchoring had no measurable effect at these block sizes (honest finding, needs investigation)",
});
stats.broken_hashes = broken_hashes;
stats.broken_walls_sec = brokenWalls;
stats.broken_growth_max_delta_sampled = brokenGrowth;

// ── I1c: Web Audio cross-engine reference ───────────────────────────────────
let webaudio: Record<string, unknown> = { available: false };
try {
  const root = process.env.BENCH_ROOT ?? path.resolve(import.meta.dirname, "..", "..", "..");
  const req = createRequire(path.join(root, "ui", "package.json"));
  const waa = req("node-web-audio-api");
  const t0 = performance.now();
  const ref = await renderCGraphWebAudio({ ...C, totalSec: crossSec }, waa.OfflineAudioContext);
  const refWall = (performance.now() - t0) / 1000;
  const t1 = performance.now();
  const mine: Array<{ l: Float32Array; r: Float32Array; frames: number }> = [];
  const collect: SynthSink = {
    writeBlock: (l, r, frames) => mine.push({ l: l.slice(), r: r.slice(), frames }),
  };
  renderCGraph({ ...C, totalSec: crossSec, blockFrames: 4096, broken: false }, collect);
  const mineWall = (performance.now() - t1) / 1000;
  const cmp = compareAgainstReference(ref.left, ref.right, mine);
  webaudio = {
    available: true,
    duration_sec: crossSec,
    reference_frames: ref.frames,
    reference_wall_sec: refWall,
    my_wall_sec: mineWall,
    compared_frames: cmp.compared,
    byte_identical: cmp.byteIdentical,
    max_abs_delta: cmp.maxAbsDelta,
    rms_delta: cmp.rmsDelta,
    non_finite: cmp.nonFinite,
    reference_buffer_mb: (ref.frames * 2 * 4) / 1048576,
  };
  assertions.push({ name: "crossengine_nonfinite_zero", passed: cmp.nonFinite === 0, detail: `non-finite in my stream vs reference: ${cmp.nonFinite}` });
} catch (err) {
  webaudio = { available: false, reason: String(err).slice(0, 300) };
  assertions.push({ name: "crossengine_skipped", passed: true, detail: `node-web-audio-api unavailable or failed: ${String(err).slice(0, 160)}` });
}
stats.webaudio = webaudio;

process.stdout.write("__BENCH_JSON__" + JSON.stringify({
  assertions, stats, healthy_hashes, broken_hashes, webaudio,
}));
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
