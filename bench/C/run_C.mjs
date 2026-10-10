/**
 * bench/C/run_C.mjs — chunked-render proof-of-concept (independently
 * runnable):   node bench/C/run_C.mjs [--scale S] [--long]
 *
 * Answers ONE question with numbers: can a Web-Audio-graph render be split
 * into N sequential chunks whose output is indistinguishable from a single
 * continuous render?
 *
 * Method: the public Web Audio API exposes NO way to read a DelayNode's
 * internal buffer or a BiquadFilterNode's internal state, so exact state
 * hand-off is impossible. The honest approximation is PRIMING: each chunk k
 * re-renders the last C_PRIMER_SEC of input history in a fresh
 * OfflineAudioContext and discards that audio, letting delay-buffer and
 * filter states reconverge before the seam. This harness MEASURES how close
 * that gets — it does not pretend it is exact hand-off.
 *
 * The smallest graph that exercises everything the real engine uses:
 *   osc(220Hz) ─┐
 *   osc(55Hz) ──┴→ lowpass(auto-freq) → gain(master, auto) → panner(auto) → dest
 *                       ↓
 *                    delay(0.2→0.35s auto) → feedback gain 0.35 → back to delay
 * Automation is scripted on the absolute timeline; linear automations are
 * shifted exactly, and one exponential (setTargetAtTime) automation is
 * included deliberately so the PoC measures non-linear state loss too.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Result, skipBench } from "../lib/result.mjs";
import {
  C_SAMPLE_RATE, C_TOTAL_SEC, C_LONG_SEC, C_PRIMER_SEC, C_CHUNK_SIZES_SEC,
  C_CARRIER_HZ, C_SUBOSC_HZ, C_FILTER_START_HZ, C_FILTER_END_HZ, C_FILTER_Q,
  C_DELAY_START_SEC, C_DELAY_END_SEC, C_DELAY_MAX_SEC, C_FEEDBACK_GAIN,
  C_MASTER_GAIN, C_PAN_PERIOD_SEC, C_PAN_TARGET_TIME_CONSTANT,
} from "../lib/constants.mjs";

const ENV = JSON.parse(process.env.BENCH_ENV ?? "{}");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR;
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const LONG = process.env.BENCH_LONG === "1";
const TOTAL_SEC = Math.max(60, (LONG ? C_LONG_SEC : C_TOTAL_SEC) * SCALE);
const PRIMER_SEC = Number(process.env.BENCH_C_PRIMER_SEC ?? C_PRIMER_SEC);

let OfflineAudioContext;
try {
  const req = createRequire(path.join(ENV.ui, "package.json"));
  const waa = req("node-web-audio-api");
  OfflineAudioContext = waa.OfflineAudioContext;
} catch (err) {
  console.log("[C] chunked-render PoC");
  await skipBench(RESULTS_DIR, "C_chunked_render_poc", "C", ENV,
    `node-web-audio-api not installed — install: cd ui && npm install --save-dev node-web-audio-api (${String(err).slice(0, 120)})`);
  process.exit(0);
}

/** Scripted automations on the ABSOLUTE timeline [0, totalSec]. */
function automationValueAt(tSec) {
  const f = C_FILTER_START_HZ + ((C_FILTER_END_HZ - C_FILTER_START_HZ) / TOTAL_SEC) * tSec;
  const d = C_DELAY_START_SEC + ((C_DELAY_END_SEC - C_DELAY_START_SEC) / TOTAL_SEC) * tSec;
  return { filterHz: f, delaySec: d };
}

function buildGraph(ctx, offsetSec, chunkLenSec) {
  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = C_CARRIER_HZ;
  const sub = ctx.createOscillator();
  sub.type = "triangle";
  sub.frequency.value = C_SUBOSC_HZ;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.5;
  sub.connect(subGain);

  const mix = ctx.createGain();
  mix.gain.value = 1.0;
  carrier.connect(mix);
  subGain.connect(mix);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = C_FILTER_Q;
  mix.connect(filter);

  const delay = ctx.createDelay(C_DELAY_MAX_SEC);
  const feedback = ctx.createGain();
  feedback.gain.value = C_FEEDBACK_GAIN;
  filter.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);

  const master = ctx.createGain();
  master.gain.value = C_MASTER_GAIN;
  filter.connect(master);
  delay.connect(master);

  const panner = ctx.createStereoPanner();
  master.connect(panner);
  panner.connect(ctx.destination);

  // Automations shifted into chunk-local time. Linear ramps reproduce the
  // absolute timeline exactly (value is affine in t); the exponential pan
  // automation deliberately does NOT, so its state loss is measured.
  const t0 = offsetSec;
  const t1 = Math.min(offsetSec + chunkLenSec, TOTAL_SEC);
  const v0 = automationValueAt(Math.max(0, t0));
  const v1 = automationValueAt(t1);
  const localT0 = Math.max(0, t0);
  filter.frequency.setValueAtTime(v0.filterHz, 0);
  filter.frequency.linearRampToValueAtTime(v1.filterHz, Math.max(0, t1 - t0));
  delay.delayTime.setValueAtTime(v0.delaySec, 0);
  delay.delayTime.linearRampToValueAtTime(v1.delaySec, Math.max(0, t1 - t0));
  master.gain.setValueAtTime(C_MASTER_GAIN * (offsetSec < 0.5 ? 0.2 : 1), 0);
  master.gain.linearRampToValueAtTime(C_MASTER_GAIN, Math.min(0.5, Math.max(0, 0.5 - (offsetSec < 0 ? -offsetSec : 0))));

  // Exponential-shape pan automation every C_PAN_PERIOD_SEC on the absolute
  // timeline, shifted and clamped (pre-seam events fold to t=0 target values).
  const localEnd = Math.max(0, t1 - t0);
  for (let tAbs = 0; tAbs <= TOTAL_SEC + C_PAN_PERIOD_SEC; tAbs += C_PAN_PERIOD_SEC / 2) {
    const local = tAbs - t0;
    if (local < -C_PAN_PERIOD_SEC) continue;
    const target = ((Math.floor(tAbs / C_PAN_PERIOD_SEC) % 2) === 0 ? -0.8 : 0.8);
    if (local <= 0) {
      panner.pan.setValueAtTime(target, 0);
    } else if (local < localEnd) {
      panner.pan.setTargetAtTime(target, local, C_PAN_TARGET_TIME_CONSTANT);
    }
  }

  carrier.start(0);
  sub.start(0);
  carrier.stop(localEnd);
  sub.stop(localEnd);
  return { filter, delay, master, panner };
}

async function renderSingle(totalSec) {
  const frames = Math.ceil(totalSec * C_SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, frames, C_SAMPLE_RATE);
  const t0 = performance.now();
  buildGraph(ctx, 0, totalSec);
  const buildMs = performance.now() - t0;
  const renderT0 = performance.now();
  const buf = await ctx.startRendering();
  return { buf, buildMs, renderWallSec: (performance.now() - renderT0) / 1000 };
}

/**
 * Render chunk-by-chunk, comparing each chunk against the single-pass
 * region as we go and hashing streaming — the concatenated chunked output
 * is NEVER materialized (a 30-min stereo float program is 635 MB × 2 for
 * left/right, which OOM-killed the first draft of this harness).
 */
async function renderAndCompareChunked(totalSec, chunkSec, primerSec, singleBuf) {
  const walls = [];
  const buildWalls = [];
  const primerWalls = [];
  const rssSamples = [];
  const chunkCount = Math.ceil(totalSec / chunkSec);
  const seamWindowFrames = Math.ceil(Number(process.env.BENCH_C_SEAM_WINDOW_SEC ?? 1) * C_SAMPLE_RATE);
  const acc = {
    frames: 0, maxDelta: 0, sumSq: 0, nonFinite: 0, identical: true,
    maxDeltaAtSeam: 0, maxDeltaElsewhere: 0,
    hash: makePcm16Hasher(),
  };
  for (let k = 0; k < chunkCount; k++) {
    const chunkStart = k * chunkSec;
    const chunkLen = Math.min(chunkSec, totalSec - chunkStart);
    const primerLen = k === 0 ? 0 : Math.min(primerSec, chunkStart);
    const ctxLen = Math.ceil((primerLen + chunkLen) * C_SAMPLE_RATE);
    const ctx = new OfflineAudioContext(2, ctxLen, C_SAMPLE_RATE);
    const bt0 = performance.now();
    // Graph is built on the absolute timeline starting at chunkStart-primerLen.
    const graphOffset = chunkStart - primerLen;
    buildGraph(ctx, graphOffset, primerLen + chunkLen);
    const buildMs = performance.now() - bt0;
    const rt0 = performance.now();
    const buf = await ctx.startRendering();
    const wall = performance.now() - rt0;
    buildWalls.push(buildMs);
    walls.push(wall);
    rssSamples.push(process.memoryUsage().rss);
    // Discard primer; keep chunkLen seconds.
    const primerFrames = Math.ceil(primerLen * C_SAMPLE_RATE);
    const keepFrames = Math.ceil(chunkLen * C_SAMPLE_RATE);
    const refStart = Math.ceil(chunkStart * C_SAMPLE_RATE);
    const singleL = singleBuf.getChannelData(0);
    const singleR = singleBuf.getChannelData(1);
    const chanL = buf.getChannelData(0);
    const chanR = buf.getChannelData(1);
    for (let i = 0; i < keepFrames; i++) {
      const xL = singleL[refStart + i];
      const yL = chanL[primerFrames + i];
      const xR = singleR[refStart + i];
      const yR = chanR[primerFrames + i];
      if (Number.isFinite(xL) && Number.isFinite(yL)) {
        if (xL !== yL) acc.identical = false;
        const d = Math.abs(xL - yL);
        if (d > acc.maxDelta) acc.maxDelta = d;
        acc.sumSq += (xL - yL) * (xL - yL);
        if (i < seamWindowFrames) { if (d > acc.maxDeltaAtSeam) acc.maxDeltaAtSeam = d; }
        else if (d > acc.maxDeltaElsewhere) acc.maxDeltaElsewhere = d;
      } else {
        acc.nonFinite++;
      }
      if (Number.isFinite(xR) && Number.isFinite(yR)) {
        if (xR !== yR) acc.identical = false;
        const d = Math.abs(xR - yR);
        if (d > acc.maxDelta) acc.maxDelta = d;
        acc.sumSq += (xR - yR) * (xR - yR);
      } else {
        acc.nonFinite++;
      }
    }
    acc.hash.update(singleL.subarray(refStart, refStart + keepFrames), chanL.subarray(primerFrames, primerFrames + keepFrames));
    // Single-side hash contribution: single vs single would be trivially
    // identical; the chunked hash must cover the CHUNKED samples, so hash
    // (single, chunked) pairs — same scheme as the single-pass self hash
    // only if chunked === single, which is exactly what byte-identity means.
    acc.frames += keepFrames;
    if (primerLen > 0) primerWalls.push(wall * (primerLen / (primerLen + chunkLen)));
  }
  return {
    walls, buildWalls, primerWalls, rssSamples, chunkCount, chunkSec,
    comparison: {
      compared_frames: acc.frames,
      byte_identical: acc.identical,
      max_abs_delta: acc.maxDelta,
      rms_delta: Math.sqrt(acc.sumSq / Math.max(1, acc.frames)),
      non_finite: acc.nonFinite,
    },
    seam_localized: {
      max_delta_within_seam_window: acc.maxDeltaAtSeam,
      max_delta_elsewhere: acc.maxDeltaElsewhere,
      seam_window_sec: Number(process.env.BENCH_C_SEAM_WINDOW_SEC ?? 1),
    },
    chunked_pcm16_sha256: acc.hash.digest(),
  };
}

function compare(a, b) {
  const n = Math.min(a.length, b.length);
  let maxDelta = 0;
  let sumSq = 0;
  let nonFinite = 0;
  let identical = true;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      nonFinite++;
      continue;
    }
    if (x !== y) identical = false;
    const d = Math.abs(x - y);
    if (d > maxDelta) maxDelta = d;
    sumSq += (x - y) * (x - y);
  }
  return { compared_frames: n, byte_identical: identical, max_abs_delta: maxDelta, rms_delta: Math.sqrt(sumSq / n), non_finite: nonFinite };
}

/**
 * Streaming hash — never materializes the interleaved PCM buffer.
 */
function makePcm16Hasher() {
  const h = crypto.createHash("sha256");
  return {
    update(a, b) {
      const buf = Buffer.alloc(4 * 65536);
      for (let i = 0; i < a.length; i += 65536) {
        const n = Math.min(65536, a.length - i);
        for (let j = 0; j < n; j++) {
          const s = Math.max(-1, Math.min(1, a[i + j]));
          buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), j * 4);
          const s2 = Math.max(-1, Math.min(1, b[i + j]));
          buf.writeInt16LE(Math.round(s2 < 0 ? s2 * 0x8000 : s2 * 0x7fff), j * 4 + 2);
        }
        h.update(buf.subarray(0, n * 4));
      }
    },
    digest() {
      return h.digest("hex");
    },
  };
}

function pcm16Bytes(a, b) {
  const hasher = makePcm16Hasher();
  hasher.update(a, b);
  return hasher.digest();
}

console.log("[C] chunked-render PoC (priming state-carry, not exact hand-off)");
const result = new Result("C_chunked_render_poc", "C", ENV,
  { total_sec: TOTAL_SEC, primer_sec: PRIMER_SEC, chunk_sizes_sec: C_CHUNK_SIZES_SEC, sample_rate: C_SAMPLE_RATE },
  {
    measured: "chunked output vs single-pass output for a minimal engine-shaped graph (osc→lowpass→master→panner→dest with feedback delay), C1 byte-identity/max-delta; C2 chunking overhead vs chunk size",
    granularity: "per-sample float comparison (L+R); per-chunk wall clock; process RSS per chunk",
    trials: "1 per configuration (determinism asserted separately by re-rendering single-pass twice)",
    warmup: "primer audio (C_PRIMER_SEC per seam) is rendered and discarded — that is the state-carry mechanism, not a discarded warm-up",
    outliers: "none removed",
    statistic: "byte_identical (boolean), max_abs_delta, rms_delta, overhead_pct",
  });

// C1 prerequisite: single-pass determinism (real invariant — loud failure).
const single1 = await renderSingle(TOTAL_SEC);
console.error(`  [C] single-pass rendered (${TOTAL_SEC}s program) in ${single1.renderWallSec.toFixed(2)}s`);
const single2 = await renderSingle(TOTAL_SEC);
const selfHash1 = pcm16Bytes(single1.buf.getChannelData(0), single1.buf.getChannelData(1));
const selfHash2 = pcm16Bytes(single2.buf.getChannelData(0), single2.buf.getChannelData(1));
result.addAssertion("single_pass_deterministic", selfHash1 === selfHash2,
  selfHash1 === selfHash2 ? "two single-pass renders are byte-identical (sha256 of PCM16)" : "MISMATCH — environment is nondeterministic; chunk comparison is meaningless without this");
void selfHash2; // single2 kept alive only until this assertion exists

const c1 = compare(single1.buf.getChannelData(0), single1.buf.getChannelData(1));
const nonFiniteSingle = c1.non_finite;
result.addAssertion("single_pass_nonfinite_zero", nonFiniteSingle === 0, `non-finite samples in single-pass output: ${nonFiniteSingle}`);

const chunkRuns = [];
for (const chunkSec of C_CHUNK_SIZES_SEC) {
  console.error(`  [C] chunk config: ${chunkSec}s chunks (primer ${PRIMER_SEC}s)`);
  const t0 = performance.now();
  const run = await renderAndCompareChunked(TOTAL_SEC, chunkSec, PRIMER_SEC, single1.buf);
  const totalWallMs = performance.now() - t0;
  chunkRuns.push({
    chunk_sec: chunkSec,
    seam_count: Math.max(0, run.chunkCount - 1),
    chunked_total_wall_sec: totalWallMs / 1000,
    single_pass_wall_sec: single1.renderWallSec,
    overhead_pct: ((totalWallMs - single1.renderWallSec * 1000) / (single1.renderWallSec * 1000)) * 100,
    priming_wall_share_pct: (run.primerWalls.reduce((a, b) => a + b, 0) / totalWallMs) * 100,
    peak_rss_bytes_chunked: Math.max(...run.rssSamples),
    comparison_left: run.comparison,
    seam_localized_left: run.seam_localized,
    chunked_pcm16_sha256: run.chunked_pcm16_sha256,
    single_pcm16_sha256: selfHash1,
  });
  result.addTrial(`chunk_${chunkSec}s`, { chunk_sec: chunkSec, primer_sec: PRIMER_SEC },
    [totalWallMs / 1000], { ...chunkRuns[chunkRuns.length - 1] });
}

result.doc.stats = {
  single_pass: {
    wall_sec: single1.renderWallSec,
    graph_build_ms: single1.buildMs,
    frames: single1.buf.length,
    pcm16_sha256: selfHash1,
  },
  chunked: chunkRuns,
};
result.addAssertion("nonfinite_zero_chunked", chunkRuns.every((r) => r.comparison_left.non_finite === 0),
  `max non-finite across chunk runs: ${Math.max(0, ...chunkRuns.map((r) => r.comparison_left.non_finite))}`);
result.doc.web_audio_state_api_limitation =
  "No public Web Audio API reads a DelayNode's internal buffer or a BiquadFilterNode's internal state, so exact cross-chunk state hand-off is impossible by construction. " +
  "This PoC therefore measures the priming approximation: each chunk re-renders the last C_PRIMER_SEC of input history and discards it. " +
  "Reported max_abs_delta is the honest distance from the continuous render, not a pass/fail threshold.";
result.addObservation(
  `Measured on a ${TOTAL_SEC}s program with ${PRIMER_SEC}s priming per seam: ` +
  chunkRuns.map((r) =>
    `${r.chunk_sec}s chunks (${r.seam_count} seams) → overhead ${r.overhead_pct?.toFixed(1)}%, ` +
    `priming share ${r.priming_wall_share_pct?.toFixed(1)}%, max|Δ| ${r.comparison_left.max_abs_delta.toExponential(2)} ` +
    `(within ${r.seam_localized_left.seam_window_sec}s of seams: ${r.seam_localized_left.max_delta_within_seam_window.toExponential(2)}, ` +
    `elsewhere: ${r.seam_localized_left.max_delta_elsewhere.toExponential(2)}), byte-identical=${r.comparison_left.byte_identical}`).join("; ") +
  ". Seam-window vs elsewhere deltas show whether divergence concentrates at seams (state reconvergence) or spreads evenly (systematic offset from shifted automations). " +
  "The real redesign eliminates this problem class by carrying EngineState, delay buffers and filter states in-process.",
);
const file = await result.write(RESULTS_DIR);
console.log(`  -> ${file}`);
