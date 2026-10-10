/**
 * c_graph.ts — the exact minimal graph shape from category C
 * (bench/C/run_C.mjs: two oscillators → automated lowpass(Q=1) → master →
 * panner → destination, plus an automated 0.2→0.35 s feedback delay),
 * rendered by the in-process block-synth discipline instead of chunked
 * OfflineAudioContext instances. This is the direct successor to C.
 *
 * Differences from C's chunked PoC, and why they matter:
 *   - Filter/delay/node state lives IN THIS PROCESS and carries: the ring
 *     buffer and biquad states never reset. C's impossible "exact hand-off"
 *     is trivially exact here.
 *   - The exponential pan automation (setTargetAtTime, tc = 0.08 s, targets
 *     ±0.8 alternating every C_PAN_PERIOD_SEC) is evaluated as a per-sample
 *     carried geometric recurrence — D4. The `broken` mode re-anchors it at
 *     every block boundary by SNAPPING to the scheduled target, which is
 *     exactly what C's per-chunk re-scheduling did to it (and what the C
 *     measurements showed: divergence NOT seam-localized → systematic
 *     re-anchoring, not edge effects).
 *   - Linear automations (filter freq, delay time, master fade-in) are
 *     closed-form functions of absolute time — identical to C's finding that
 *     "linear automations shift exactly".
 *
 * `blockFrames` parameterizes ONLY the block partition: where block
 * boundaries fall (and, in broken mode, where re-anchoring fires). Healthy
 * output must therefore be byte-identical for every blockFrames — including
 * the degenerate single-block partition — and that is I1's core assertion.
 * ponytail: rendering is per-sample into small flush buffers regardless of
 * blockFrames, so the "single block" partition costs no giant accumulator;
 * upgrade path: none needed — the accumulator-free formulation is the point.
 */
import { Biquad, ExpApproach, waveSine, waveTriangle, panGainL, panGainR, type SynthSink } from "../G_streaming_synth/blockSynth";

export interface CGraphParams {
  sampleRate: number;
  totalSec: number;
  blockFrames: number;
  broken: boolean;
  // port: bench/lib/constants.mjs C_ section (values passed by run_I.mjs)
  carrierHz: number; subHz: number; subGain: number;
  filterStartHz: number; filterEndHz: number; filterQ: number;
  delayStartSec: number; delayEndSec: number; delayMaxSec: number; feedbackGain: number;
  masterGain: number;
  panPeriodSec: number; panTargetTcSec: number;
}

export interface CGraphStats {
  frames: number;
  blocks: number;
  nonFinite: number;
  peakAbs: number;
  rms: number;
  sumSq: number;
}

const TWO_PI = 2 * Math.PI;

export function renderCGraph(p: CGraphParams, sink: SynthSink): CGraphStats {
  const { sampleRate: sr, totalSec, blockFrames } = p;
  const framesTotal = Math.ceil(totalSec * sr);

  // Fixed inventory — bounded by constants, never duration (delay ring: 2 s).
  const ringLen = Math.ceil(p.delayMaxSec * sr) + 1;
  const ringL = new Float64Array(ringLen);
  const ringR = new Float64Array(ringLen);
  let writePos = 0;
  const filter = new Biquad(sr);
  const outL = new Float32Array(8192);
  const outR = new Float32Array(8192);

  // Carried automations (D4)
  const pan = new ExpApproach(-0.8, -0.8, p.panTargetTcSec, sr); // C: setValueAtTime(-0.8, 0)
  const panK = Math.exp(-1 / (p.panTargetTcSec * sr));

  let carrierPhase = 0;
  let subPhase = 0;
  let nonFinite = 0;
  let peakAbs = 0;
  let sumSq = 0;
  let frames = 0;
  let blocks = 0;

  // Precompute the pan schedule (absolute times → targets), C's loop shape:
  // for tAbs += PERIOD/2, target = floor(tAbs/PERIOD)%2===0 ? -0.8 : +0.8.
  const panEvents: Array<{ i: number; target: number }> = [];
  for (let tAbs = 0; tAbs <= totalSec + p.panPeriodSec; tAbs += p.panPeriodSec / 2) {
    const target = Math.floor(tAbs / p.panPeriodSec) % 2 === 0 ? -0.8 : 0.8;
    panEvents.push({ i: Math.round(tAbs * sr), target });
  }
  let panEvtIdx = 0;

  const linear = (t: number, a: number, b: number) => a + ((b - a) * t) / totalSec;

  let flushN = 0;
  const flush = () => {
    if (flushN === 0) return;
    sink.writeBlock(outL.subarray(0, flushN), outR.subarray(0, flushN), flushN);
    flushN = 0;
  };

  let lastQuantum = -1;
  for (let n = 0; n < framesTotal; n++) {
    const t = n / sr;

    // Block partition: in broken mode, every block start reproduces what
    // per-chunk OfflineAudioContext rendering did to this graph —
    //   (a) the scheduled exponential automation is re-anchored (C wrote
    //       setValueAtTime(target, 0) at each chunk start), and
    //   (b) the biquad coefficient quantum grid becomes BLOCK-RELATIVE, which
    //       is exactly how chunked rendering misaligns coefficient sampling
    //       vs the absolute timeline (chunk lengths are not multiples of the
    //       128-frame render quantum; with Q=1 resonance + feedback this is
    //       the systematic, non-seam-localized divergence class C measured).
    if (n % blockFrames === 0) {
      blocks++;
      if (p.broken) pan.v = pan.target;
    }
    while (panEvtIdx < panEvents.length && panEvents[panEvtIdx].i <= n) {
      pan.target = panEvents[panEvtIdx].target;
      panEvtIdx++;
    }

    // Automation per sample
    pan.v = pan.target + (pan.v - pan.target) * panK;

    // Filter coefficients per 128-frame quantum. Healthy mode aligns to
    // ABSOLUTE frames (Web Audio's render-quantum updates on one continuous
    // timeline → block-size invariant). Broken mode aligns to BLOCK-LOCAL
    // frames — the per-chunk misalignment mechanism from (b) above.
    const qBase = p.broken ? n % blockFrames : n;
    const q = Math.floor(qBase / 128);
    if (q !== lastQuantum) {
      lastQuantum = q;
      filter.setLpf(linear(t, p.filterStartHz, p.filterEndHz), p.filterQ);
    }

    // Source graph
    carrierPhase = (carrierPhase + p.carrierHz / sr) % 1;
    subPhase = (subPhase + p.subHz / sr) % 1;
    const mixL = waveSine(carrierPhase) + waveTriangle(subPhase) * p.subGain;
    const mixR = mixL; // mono sources → identical into both channels (C's graph)

    const filtL = filter.process(mixL);
    const filtR = filter.process(mixR);

    // Feedback delay with per-sample linear-interpolated read
    const delaySec = linear(t, p.delayStartSec, p.delayEndSec);
    const readPos = writePos - delaySec * sr;
    const i0 = Math.floor(readPos);
    const frac = readPos - i0;
    const j0 = ((i0 % ringLen) + ringLen) % ringLen;
    const j1 = (j0 + 1) % ringLen;
    const dL = ringL[j0] + (ringL[j1] - ringL[j0]) * frac;
    const dR = ringR[j0] + (ringR[j1] - ringR[j0]) * frac;
    ringL[writePos] = filtL + p.feedbackGain * dL;
    ringR[writePos] = filtR + p.feedbackGain * dR;
    writePos = (writePos + 1) % ringLen;

    // Master: 0.1 → masterGain linear over first 0.5 s (C's fade-in), then flat
    const masterV = t < 0.5 ? p.masterGain * (0.2 + (0.8 * t) / 0.5) : p.masterGain;
    const pl = panGainL(pan.v);
    const pr = panGainR(pan.v);
    const l = (filtL + dL) * masterV * pl;
    const r = (filtR + dR) * masterV * pr;

    if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
    const al = Math.abs(l), ar = Math.abs(r);
    if (al > peakAbs) peakAbs = al;
    if (ar > peakAbs) peakAbs = ar;
    sumSq += l * l + r * r;

    outL[flushN] = l;
    outR[flushN] = r;
    flushN++;
    if (flushN === outL.length) flush();
    frames++;
  }
  flush();

  return { frames, blocks, nonFinite, peakAbs, rms: frames ? Math.sqrt(sumSq / (frames * 2)) : 0, sumSq };
}

/** Per-sample comparison of my block-synth output against a reference
 * Float32Array pair (the Web Audio single-pass render). Streams: reference
 * must be materialized by the Web Audio API itself (42 MB at 120 s — stated
 * in the result), my side streams. */
export function compareAgainstReference(
  refL: Float32Array, refR: Float32Array,
  mine: Iterable<{ l: Float32Array; r: Float32Array; frames: number }>,
): { compared: number; byteIdentical: boolean; maxAbsDelta: number; rmsDelta: number; nonFinite: number } {
  let pos = 0;
  let maxD = 0;
  let sumSq = 0;
  let identical = true;
  let nonFinite = 0;
  for (const blk of mine) {
    for (let i = 0; i < blk.frames && pos < refL.length; i++, pos++) {
      const a = refL[pos], b = blk.l[i];
      const a2 = refR[pos], b2 = blk.r[i];
      if (!Number.isFinite(b) || !Number.isFinite(b2)) { nonFinite++; continue; }
      const d = Math.abs(a - b);
      const d2 = Math.abs(a2 - b2);
      if (d > maxD) maxD = d;
      if (d2 > maxD) maxD = d2;
      sumSq += d * d + d2 * d2;
      if (d !== 0 || d2 !== 0) identical = false;
    }
  }
  return { compared: pos, byteIdentical: identical, maxAbsDelta: maxD, rmsDelta: Math.sqrt(sumSq / Math.max(1, pos * 2)), nonFinite };
}
