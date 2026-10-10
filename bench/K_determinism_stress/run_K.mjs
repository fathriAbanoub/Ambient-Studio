/**
 * run_K.mjs — concurrency/determinism stress test (D2 validation), independently
 * runnable:   node bench/K_determinism_stress/run_K.mjs
 *
 * Controlled experiment proving the D2 fix works, not an assertion of it.
 * Three variants render the same seeded multi-layer program:
 *
 *   sync_fixed        — layers summed in index order, no async (baseline truth)
 *   async_fixed_order — layers synthesized asynchronously (jittered completion),
 *                       then summed in INDEX order  ← the production pattern
 *   async_completion  — layers synthesized asynchronously and summed in
 *                       COMPLETION order ← deliberately reproduces the AGA
 *                       failure pattern (92.65% of same-seed samples differed
 *                       in the external survey because layer sums happened in
 *                       RPC-completion order)
 *
 * K_RUNS runs per variant, same seed. Real invariants asserted: both
 * fixed-order variants must be byte-identical across every run AND to each
 * other; the completion-order variant must NOT be (if the race fails to
 * manifest on this machine, that is recorded honestly as a limitation).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Result } from "../lib/result.mjs";
import { captureEnvironment } from "../lib/env.mjs";
import { K_LAYERS, K_BLOCK_FRAMES, K_CHUNKS, K_RUNS, K_JITTER_MAX_MS } from "../lib/constants.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? path.join(BENCH_DIR, "results");
const ENV = process.env.BENCH_ENV ? JSON.parse(process.env.BENCH_ENV) : await captureEnvironment(RESULTS_DIR);

const SAMPLE_RATE = 44100;
const TOTAL_FRAMES = K_BLOCK_FRAMES * K_CHUNKS;
const DUR_SEC = TOTAL_FRAMES / SAMPLE_RATE;

/** Deterministic per-layer generator: sine with a slow tremolo, phase carried
 * block-to-block. mulberry32 seeds the layer's initial phase — all randomness
 * derives from the seed (D3); the completion jitter deliberately does NOT. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Layer {
  constructor(index, seed) {
    this.index = index;
    this.freqHz = 110 * Math.pow(2, index / 12);
    this.amp = 0.7 / (index + 1);
    this.phase = mulberry32(seed + index)() * Math.PI * 2;
    this.tremoloRateHz = 0.5 + index * 0.13;
  }
  /** Render one block into a fresh Float32Array (like a per-layer bus render). */
  block(blockIdx) {
    const out = new Float32Array(K_BLOCK_FRAMES);
    let phase = this.phase;
    for (let i = 0; i < K_BLOCK_FRAMES; i++) {
      const n = blockIdx * K_BLOCK_FRAMES + i;
      const t = n / SAMPLE_RATE;
      const trem = 1 + 0.2 * Math.sin(2 * Math.PI * this.tremoloRateHz * t);
      phase += this.freqHz / SAMPLE_RATE;
      out[i] = this.amp * Math.sin(2 * Math.PI * phase) * trem;
    }
    this.phase = phase % (2 * Math.PI); // carried state — deterministic
    return out;
  }
}

const jitter = () => new Promise((r) => setTimeout(r, Math.random() * K_JITTER_MAX_MS));

/** One full render. Returns the PCM16 hash and the completion-order log
 * (identity of the first layer to arrive per block — evidence the race
 * actually varied). Buffers are bounded (K_BLOCK_FRAMES accumulator). */
async function renderVariant(variant, seed) {
  const layers = Array.from({ length: K_LAYERS }, (_, i) => new Layer(i, seed));
  const acc = new Float32Array(K_BLOCK_FRAMES);
  const h = createHash("sha256");

  for (let b = 0; b < K_CHUNKS; b++) {
    let parts;
    if (variant === "sync_fixed") {
      parts = layers.map((ly) => ly.block(b)); // index order, synchronous
    } else if (variant === "async_fixed_order") {
      // Promise.all resolves in INPUT order (the contract), then we sum in
      // index order anyway — execution async, summation fixed: the D2 fix.
      parts = await Promise.all(layers.map(async (ly) => {
        await jitter();
        return ly.block(b);
      }));
      parts = layers.map((ly) => parts[ly.index]);
    } else {
      // async_completion — the AGA pattern: results are APPENDED as they
      // arrive and summed in ARRIVAL order. (Promise.all's output array is
      // input-ordered, which is why the first draft of this variant measured
      // zero divergence — the harness itself had the bug the brief warned
      // about. Measured 6 distinct first-finishers with 0 hash variance.)
      const arrivals = [];
      await Promise.all(layers.map(async (ly) => {
        await jitter();
        arrivals.push(ly.block(b)); // push order = completion order
      }));
      parts = arrivals;
    }
    acc.fill(0);
    for (const buf of parts) {
      for (let i = 0; i < K_BLOCK_FRAMES; i++) acc[i] += buf[i];
    }
    const chunk = Buffer.alloc(K_BLOCK_FRAMES * 4);
    for (let i = 0; i < K_BLOCK_FRAMES; i++) {
      const s = Math.max(-1, Math.min(1, acc[i]));
      const v = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
      chunk.writeInt16LE(v, i * 4);
      chunk.writeInt16LE(v, i * 4 + 2);
    }
    h.update(chunk);
  }
  return { sha256: h.digest("hex") };
}

/** Which layer finished first per block — directly observable completion
 * order, to prove the jitter actually varied it. */
async function completionOrderSample() {
  const layers = Array.from({ length: K_LAYERS }, (_, i) => new Layer(i, 42));
  const firsts = [];
  for (let b = 0; b < 40; b++) {
    let first = -1;
    await Promise.all(layers.map(async (ly) => {
      await jitter();
      if (first === -1) first = ly.index; // racy write — that's the point
      ly.block(b);
    }));
    firsts.push(first);
  }
  return firsts;
}

/** Frames (sample pairs) whose PCM16 words differ between two rendered
 * buffers. Holds ONE 4.6 s stereo buffer (~74 KB) — bounded. */
function diffFractionBuffers(a, b) {
  let differ = 0;
  const frames = a.length / 4;
  for (let i = 0; i < frames; i++) {
    if (a.readInt16LE(i * 4) !== b.readInt16LE(i * 4)) differ++;
  }
  return differ / frames;
}

async function renderToBuffer(variant) {
  const layers = Array.from({ length: K_LAYERS }, (_, i) => new Layer(i, 42));
  const acc = new Float32Array(K_BLOCK_FRAMES);
  const out = Buffer.alloc(TOTAL_FRAMES * 4);
  const floatSum = new Float32Array(TOTAL_FRAMES); // float-level sum for magnitude metrics
  for (let b = 0; b < K_CHUNKS; b++) {
    let parts;
    if (variant === "sync_fixed") parts = layers.map((ly) => ly.block(b));
    else if (variant === "async_fixed_order") {
      parts = await Promise.all(layers.map(async (ly) => { await jitter(); return ly.block(b); }));
      parts = layers.map((ly) => parts[ly.index]);
    } else {
      // async_completion — same arrivals pattern as renderVariant
      const arrivals = [];
      await Promise.all(layers.map(async (ly) => { await jitter(); arrivals.push(ly.block(b)); }));
      parts = arrivals;
    }
    acc.fill(0);
    for (const buf of parts) for (let i = 0; i < K_BLOCK_FRAMES; i++) acc[i] += buf[i];
    for (let i = 0; i < K_BLOCK_FRAMES; i++) {
      floatSum[b * K_BLOCK_FRAMES + i] = acc[i];
      const s = Math.max(-1, Math.min(1, acc[i]));
      const v = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
      out.writeInt16LE(v, (b * K_BLOCK_FRAMES + i) * 4);
      out.writeInt16LE(v, (b * K_BLOCK_FRAMES + i) * 4 + 2);
    }
  }
  return { pcm: out, floatSum };
}

export async function runK() {
  console.log("[K] concurrency/determinism stress (D2: fixed-order summation)");
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const result = new Result("K1_summation_order_determinism", "K", ENV,
    { layers: K_LAYERS, block_frames: K_BLOCK_FRAMES, chunks: K_CHUNKS, duration_sec: DUR_SEC, runs_per_variant: K_RUNS, jitter_max_ms: K_JITTER_MAX_MS, seed: 42 },
    {
      measured: "sha256 of the summed output per run per variant; observable completion order under jitter; sample-difference fraction between completion-order and fixed-order renders",
      granularity: "whole-render hash per run; first-finisher identity per block",
      trials: `${K_RUNS} runs × 3 variants, same seed`,
      warmup: "none — the subject is summation order, not throughput",
      outliers: "none",
      statistic: "distinct-hash count per variant; byte-identity booleans; differ-fraction vs AGA's 92.65% (context from the external survey, not re-run here)",
    });

  const runs = { sync_fixed: [], async_fixed_order: [], async_completion: [] };
  for (let r = 0; r < K_RUNS; r++) {
    for (const variant of Object.keys(runs)) {
      const { sha256 } = await renderVariant(variant, 42);
      runs[variant].push(sha256);
    }
  }
  const distinct = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, new Set(v).size]));
  result.setStats("distinct_hashes_per_variant", distinct);
  result.setStats("hashes", runs);

  // Observable completion order under jitter (evidence the race is real here)
  const firsts = await completionOrderSample();
  const orderVariety = new Set(firsts).size;
  result.setStats("completion_order_first_finishers", { samples: firsts.length, distinct_first_finishers: orderVariety, log: firsts.slice(0, 40) });

  // Pairwise magnitude metrics: completion-order render vs fixed-order render.
  // A single draw can coincidentally match (same arrival order); render up to
  // 5 times and diff the first draw whose PCM16 hash actually differs from the
  // fixed-order hash. Attempts recorded — no cherry-picking beyond requiring
  // the failure to be present.
  let mag = null;
  let attempts = 0;
  const fixedHash = runs.sync_fixed[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    attempts++;
    const broken = await renderToBuffer("async_completion");
    const h = createHash("sha256"); h.update(broken.pcm);
    if (h.digest("hex") !== fixedHash) {
      const fixed = await renderToBuffer("sync_fixed");
      let differFloat = 0;
      let maxAbsDelta = 0;
      const n = broken.floatSum.length;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(broken.floatSum[i] - fixed.floatSum[i]);
        if (d !== 0) differFloat++;
        if (d > maxAbsDelta) maxAbsDelta = d;
      }
      let differPcm = 0;
      for (let i = 0; i < n; i++) {
        if (broken.pcm.readInt16LE(i * 4) !== fixed.pcm.readInt16LE(i * 4)) differPcm++;
      }
      mag = {
        float_differ_fraction: differFloat / n,
        pcm16_differ_fraction: differPcm / n,
        max_abs_delta_float: maxAbsDelta,
      };
      break;
    }
  }
  result.setStats("differ_fraction_attempts", attempts);
  result.setStats("completion_vs_fixed_magnitude", mag);
  result.setStats("context", {
    aga_differ_fraction_percent: 92.65,
    aga_source: "external survey X-series (user's hardware); quoted as context, not re-run",
  });

  result.addAssertion("sync_fixed_deterministic", distinct.sync_fixed === 1,
    `${K_RUNS} synchronous fixed-order runs → ${distinct.sync_fixed} distinct hash(es)`);
  result.addAssertion("async_fixed_order_deterministic", distinct.async_fixed_order === 1,
    `${K_RUNS} async-execution fixed-order-sum runs → ${distinct.async_fixed_order} distinct hash(es) — async execution does not break determinism when summation order is fixed`);
  result.addAssertion("fixed_variants_identical", runs.sync_fixed[0] === runs.async_fixed_order[0],
    "sync and async-fixed-order produce the same bytes — the D2 rule, not execution style, determines output");
  const completionUnstable = distinct.async_completion > 1;
  result.addAssertion("completion_order_detectably_unstable", completionUnstable,
    completionUnstable
      ? `completion-order summation produced ${distinct.async_completion} distinct hashes across ${K_RUNS} runs — the AGA failure mode reproduced under controlled conditions`
      : `completion-order summation produced identical hashes across ${K_RUNS} runs (jitter window ${K_JITTER_MAX_MS} ms rarely reordered completions: ${orderVariety} distinct first-finishers over 40 blocks) — recorded as a limitation, not hidden`);

  result.addObservation(
    mag !== null
      ? `Completion-order vs fixed-order summation of the SAME seeded layers: ${(mag.float_differ_fraction * 100).toFixed(2)}% of FLOAT samples differ (max|Δ| ${mag.max_abs_delta_float.toExponential(2)}), but only ${(mag.pcm16_differ_fraction * 100).toFixed(4)}% of PCM16 words differ — most reordering deltas vanish in 16-bit quantization, which is exactly why the hash (not the ear) is the contract: the PCM16 hashes were NOT reproducible across runs. ` +
        `(attempt ${attempts} of up to 5; earlier draws coincidentally matched arrival order. External survey measured 92.65% of FLOAT samples differing for AGA's real RPC-completion-order bug — same failure class, layer magnitudes differ.)`
      : `All ${attempts} completion-order renders coincidentally matched fixed-order bytes on this machine — recorded as a limitation, not hidden.`,
  );
  result.addObservation(
    "Why the fix is structural: BlockSynth sums voices in spawn order (a pure function of the D1 event stream) inside a synchronous per-sample loop — there is no async boundary between layer render and summation, so no completion order exists to vary. async_fixed_order demonstrates the same conclusion for architectures that DO synthesize layers asynchronously: collect async, sum in fixed order.",
  );

  const file = await result.write(RESULTS_DIR);
  console.log(`  -> ${file}`);
  for (const [k, v] of Object.entries(distinct)) console.log(`  ${k}: ${v} distinct hash(es) over ${K_RUNS} runs`);
  console.log(`  completion order under jitter: ${orderVariety} distinct first-finishers / magnitude: ${mag ? JSON.stringify(mag) : "no differing draw"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runK();
}
