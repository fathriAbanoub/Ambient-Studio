/**
 * test/space_reverb.ts — Phase 1 Space checks for the daemon shell.
 *   1. reverbLevel ABSENT == reverbLevel 0 (byte-identical digests on this
 *      machine), and flag-off peak/RMS match the pre-change render within
 *      LEGACY_AUDIO_TOLERANCE (portable across machines).
 *   2. reverbLevel ON: output differs, zero non-finite samples, exact frame
 *      count, and is block-size invariant (4096 vs 1024).
 *   3. Measurements (printed, not asserted): peak / RMS / clip count and
 *      Goertzel band energies, off vs on — the ear-decision numbers.
 * Run: node build/space_reverb.cjs (bundled by test/run_all.mjs)
 *
 * Why no stored hash: a sha256 over float audio depends on the machine's math
 * library (two environments rendered the same code to different digests while
 * peak and RMS agreed to every printed digit). The strict byte-for-byte proof
 * that flag-off equals the original code is an A/B on ONE machine: render the
 * same recipe from a clean checkout of commit 19e4282 and from this tree and
 * compare the raw f32 bytes.
 */
import { BlockSynth, buildTimeline, type SynthSink } from "../src/blockSynth";
import { createHash } from "node:crypto";

const SR = 44100;
const DUR = 20;

// Captured from the UNMODIFIED code (commit 19e4282): BASE_PARAMS below, seed
// 42, 20 s, block 4096, reverbLevel absent. RMS is over both channels.
// ponytail: tolerance check, not a byte check; upgrade path is the same-machine
// A/B described in the header.
const LEGACY_PEAK = 0.5334128737449646;
const LEGACY_RMS = 0.09762361140805774;
const LEGACY_AUDIO_TOLERANCE = 1e-6;

const FLAG_ON_LEVEL = 0.6;
const BLOCK_FRAMES_DEFAULT = 4096;
const BLOCK_FRAMES_SMALL = 1024;
const CLIP_THRESHOLD = 0.999;
const TAIL_SECONDS = 5;
const BAND_FREQS_HZ = [60, 220, 1000, 5000, 9000];

const BASE_PARAMS = {
  scale: "majorPent" as const, rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap" as const, sidechainAmount: 0,
  drone: { layers: [0, 1, 2, 3].map((i) => ({ hz: 55 + i * 8, amp: 0.15, pan: -1 + (2 * i) / 3, timbre: "sine" as const })) },
};

// Goertzel band power at the bin nearest each centre frequency (whole render).
function goertzelBands(l: Float32Array, r: Float32Array, frames: number, freqs: number[]): number[] {
  const out = new Array(freqs.length).fill(0);
  const w = freqs.map((f) => (2 * Math.PI * f) / SR);
  const coef = w.map((ww) => 2 * Math.cos(ww));
  const s1 = new Array(freqs.length).fill(0);
  const s2 = new Array(freqs.length).fill(0);
  for (let i = 0; i < frames; i++) {
    for (let k = 0; k < freqs.length; k++) {
      const x = l[i] + r[i];
      const s0 = x + coef[k] * s1[k] - s2[k];
      s2[k] = s1[k];
      s1[k] = s0;
    }
  }
  for (let k = 0; k < freqs.length; k++) {
    out[k] = s1[k] * s1[k] + s2[k] * s2[k] - coef[k] * s1[k] * s2[k];
  }
  return out;
}

class MeterSink implements SynthSink {
  peak = 0;
  sumSq = 0;
  n = 0;
  clips = 0;
  nonFinite = 0;
  private bufL: Float32Array[] = [];
  private bufR: Float32Array[] = [];
  writeBlock(l: Float32Array, r: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i++) {
      for (const x of [l[i], r[i]]) {
        if (!Number.isFinite(x)) this.nonFinite++;
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        if (a >= CLIP_THRESHOLD) this.clips++;
        this.sumSq += x * x;
        this.n++;
      }
    }
    this.bufL.push(l.slice(0, frames));
    this.bufR.push(r.slice(0, frames));
  }
  digest(): string {
    // Hash the full L stream then the full R stream — NOT per-chunk
    // interleaved, so the digest is block-size invariant.
    const h2 = createHash("sha256");
    for (let i = 0; i < this.bufL.length; i++) h2.update(Buffer.from(this.bufL[i].buffer as ArrayBuffer));
    for (let i = 0; i < this.bufR.length; i++) h2.update(Buffer.from(this.bufR[i].buffer as ArrayBuffer));
    return h2.digest("hex");
  }
  rms(): number { return Math.sqrt(this.sumSq / this.n); }
  tailRms(lastSec: number): number {
    const tailStart = Math.max(0, this.n / 2 - lastSec * SR);
    let sumSq = 0; let count = 0; let seen = 0;
    for (let i = 0; i < this.bufL.length; i++) {
      const len = this.bufL[i].length;
      for (let j = 0; j < len; j++) {
        if (seen >= tailStart) {
          const l = this.bufL[i][j]; const r = this.bufR[i][j];
          sumSq += l * l + r * r; count += 2;
        }
        seen++;
      }
    }
    return count > 0 ? Math.sqrt(sumSq / count) : 0;
  }
  bands(freqs: number[]): number[] {
    const total = this.n / 2;
    const l = new Float32Array(total);
    const r = new Float32Array(total);
    let off = 0;
    for (let i = 0; i < this.bufL.length; i++) {
      l.set(this.bufL[i], off);
      r.set(this.bufR[i], off);
      off += this.bufL[i].length;
    }
    return goertzelBands(l, r, total, freqs);
  }
}

async function render(reverbLevel: number | undefined, blockFrames: number) {
  const params = reverbLevel === undefined ? { ...BASE_PARAMS } : { ...BASE_PARAMS, reverbLevel };
  const timeline = buildTimeline(params, DUR);
  const synth = new BlockSynth({ params, timeline, sampleRate: SR, blockFrames, durationSec: DUR });
  const sink = new MeterSink();
  const stats = await synth.render(sink);
  return { sink, stats, digest: sink.digest() };
}

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

async function main() {
  const off = await render(undefined, BLOCK_FRAMES_DEFAULT);
  const zero = await render(0, BLOCK_FRAMES_DEFAULT);
  const on = await render(FLAG_ON_LEVEL, BLOCK_FRAMES_DEFAULT);
  const onSmall = await render(FLAG_ON_LEVEL, BLOCK_FRAMES_SMALL);

  const peakDiff = Math.abs(off.sink.peak - LEGACY_PEAK);
  const rmsDiff = Math.abs(off.sink.rms() - LEGACY_RMS);
  check("flag_off_matches_prechange_peak_rms", peakDiff < LEGACY_AUDIO_TOLERANCE && rmsDiff < LEGACY_AUDIO_TOLERANCE,
    `peak diff ${peakDiff.toExponential(2)}, rms diff ${rmsDiff.toExponential(2)} (tolerance ${LEGACY_AUDIO_TOLERANCE})`);
  check("flag_absent_equals_level_zero", off.digest === zero.digest,
    `${off.digest.slice(0, 16)}… vs ${zero.digest.slice(0, 16)}…`);
  check("flag_on_differs", on.digest !== off.digest, "reverb+bed changed the output");
  check("nonfinite_zero_both", off.sink.nonFinite === 0 && on.sink.nonFinite === 0,
    `off=${off.sink.nonFinite} on=${on.sink.nonFinite}`);
  check("frames_exact_both", off.stats.framesWritten === DUR * SR && on.stats.framesWritten === DUR * SR,
    `${off.stats.framesWritten}/${on.stats.framesWritten} vs ${DUR * SR}`);
  check("block_invariance_flag_on", on.digest === onSmall.digest,
    `${BLOCK_FRAMES_DEFAULT} ${on.digest.slice(0, 12)}… vs ${BLOCK_FRAMES_SMALL} ${onSmall.digest.slice(0, 12)}…`);

  const bOff = off.sink.bands(BAND_FREQS_HZ);
  const bOn = on.sink.bands(BAND_FREQS_HZ);
  console.log(`measurements (off vs reverbLevel=${FLAG_ON_LEVEL}):`);
  console.log(`  peak: ${off.sink.peak.toFixed(6)} -> ${on.sink.peak.toFixed(6)}`);
  console.log(`  rms:  ${off.sink.rms().toFixed(6)} -> ${on.sink.rms().toFixed(6)}`);
  console.log(`  tail rms (last ${TAIL_SECONDS} s): ${off.sink.tailRms(TAIL_SECONDS).toFixed(6)} -> ${on.sink.tailRms(TAIL_SECONDS).toFixed(6)}`);
  console.log(`  clips (|x|>=${CLIP_THRESHOLD}): ${off.sink.clips} -> ${on.sink.clips}`);
  for (let k = 0; k < BAND_FREQS_HZ.length; k++) {
    console.log(`  band ${BAND_FREQS_HZ[k]} Hz goertzel power: ${bOff[k].toFixed(3)} -> ${bOn[k].toFixed(3)}`);
  }

  console.log(failures === 0 ? "ALL SPACE CHECKS PASS" : `${failures} SPACE CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
