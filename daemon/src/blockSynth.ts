/**
 * blockSynth.ts — the in-process streaming synthesis core (Product A render
 * path PoC). Replaces the "materialize the whole render in an
 * OfflineAudioContext" model with: kernel event timeline → fixed-size block
 * synthesis → sink (streaming WAV / ffmpeg stdin / hash), where every buffer
 * is allocated once at construction and bounded by BLOCK SIZE, never duration.
 *
 * Real sources, unmodified (bundled at bench time):
 *   musicalLogic.ts — the kernel: createInitialState → advanceRngPastNoiseBuffer
 *     → initializeBell → initializeSampleLane → getMusicalEvents per beat.
 *   scheduling.ts   — resolveToneEnvelope, getSubBeatEventTime,
 *     getSidechainDuckShape, TONAL_BUS_GAIN, PAN_DRIFT_TIME_CONSTANT_SEC.
 *
 * Determinism rules enforced here as executable structure (D1–D5):
 *   D1 — buildTimeline() returns one flat list sorted by
 *        (t, EVENT_TYPE_PRIORITY[type], insertionSeq). The synth consumes it
 *        through a single monotonic pointer; a regression throws.
 *   D2 — voices are summed into the block accumulators in SPAWN order (= D1
 *        event order); per-block compaction preserves relative order, so
 *        summation order is a pure function of the event stream — never of
 *        async completion time. (Direct fix for the AGA failure: layer sums
 *        in RPC-completion order made 92.65% of same-seed samples differ.)
 *   D3 — the synth contains ZERO randomness of its own. The drum noise table
 *        comes from the kernel's mulberry32 stream in the exact renderAmbient
 *        order: 22,050 draws from the createInitialState state (what
 *        createNoiseBufferFromState materializes), main stream advanced by
 *        advanceRngPastNoiseBuffer.
 *   D4 — every exponential-shape automation (setTargetAtTime semantics) is a
 *        per-sample geometric recurrence toward its target, carrying its
 *        running value across block boundaries — never re-anchored. The
 *        `brokenReanchor` mode (I1) proves the tests detect the anti-pattern:
 *        it resets each approach to its initial value at every block start,
 *        mirroring what per-chunk OfflineAudioContext re-rendering does.
 *   D5 — ingest() is the single validation chokepoint: unknown event type,
 *        non-finite or out-of-range parameters throw immediately with the
 *        event attached. No silent skips.
 *
 * Filters: RBJ cookbook biquads (the family Web Audio's BiquadFilterNode
 * implements). Coefficients are recomputed on a 128-frame quantum aligned to
 * the ABSOLUTE frame index (mirroring Web Audio's own render-quantum
 * coefficient updates) — absolute alignment is what keeps output invariant
 * across synth block sizes. DF1 state is carried — O(1) memory.
 *
 * ROUND-2 SIGNAL-PATH FIXES (marked `round2:` below) — deliberate, measured
 * divergences from the bench PoC's blockSynth, each verified against the
 * real renderAmbient.ts running in headless Chromium (see REPORT and
 * test/round2/): (1) DelayNode feedback cycles re-enter with one extra
 * render quantum (+128 samples) in Web Audio; (2) BiquadFilterNode
 * interprets Q in dB for lowpass/highpass, linear for bandpass; (3) the
 * drone FM mod-index and sweep rate are frozen at layer start, as the
 * browser's un-retained modGain / never-updated LFO frequency are;
 * (4) render() is async and awaits an optional sink drain hook so ffmpeg
 * stdin backpressure is respected.
 *
 * COMPLETE ALLOCATION INVENTORY (the self-audit table for the O(1) claim):
 *   accL/R, drumL/R, outL/R     6 × blockFrames floats   (block-sized)
 *   delayL/R                    2 × (2 s · sr) floats     (fixed ring, port createDelay(2.0))
 *   noise                       22,050 floats             (kernel-derived, fixed)
 *   voices                      O(polyphony) small objects (each bounded lifetime)
 *   drones                      MAX_DRONE_LAYERS fixed slots
 *   timeline.events             O(beats) — the kernel output itself (~0.2 KB/event,
 *                               ~3 orders of magnitude below PCM: 2 h ≈ 58k events
 *                               vs 2.5 GB PCM16). Measured, reported in every result.
 * Nothing else is allocated during render. Verification (hashes) is streaming.
 */

import {
  type EngineParams,
  type EngineState,
  type MusicalEvent,
  type TimbreMode,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  getMusicalEvents,
  getEffectiveSceneParams,
  getScenePackScenes,
  mulberry32Next,
  MAX_DRONE_LAYERS,
  DRONE_FADE_SEC,
  NOISE_BUFFER_SAMPLES,
} from "../../kernel/musicalLogic";
import {
  resolveToneEnvelope,
  getSubBeatEventTime,
  getSidechainDuckShape,
  PAN_DRIFT_TIME_CONSTANT_SEC,
  TONAL_BUS_GAIN,
} from "../../kernel/scheduling";

// ── Constants ported from renderAmbient.ts:92-102, 161-174, 260, 318-372 ────
const FM_MOD_RATIO = 1.5; // port: renderAmbient.ts:92
const FM_INDEX = 1.8; // port: renderAmbient.ts:93
const DRONE_PAN_TIME_CONSTANT_SEC = 0.25; // port: renderAmbient.ts:96
const DRONE_FILTER_CUTOFF_HZ = 3600; // port: renderAmbient.ts:97
const DRONE_PARAMETER_TIME_CONSTANT_SEC = 0.5; // port: renderAmbient.ts:98
const DRONE_FADE_TARGET_DIVISOR = 3; // port: renderAmbient.ts:99
const DRONE_FILTER_LFO_DEPTH_HZ = 800; // port: renderAmbient.ts:100
const DRONE_RELEASE_SILENCE_GAIN = 0.0001; // port: renderAmbient.ts:102
const DRONE_FILTER_Q = 0.7; // port: renderAmbient.ts:220 droneFilter.Q.value
const SLEW_DURATION_SEC = 0.6; // port: renderAmbient.ts:260
const MASTER_FILTER_BASE_HZ = 5000; // port: renderAmbient.ts:172 (5000 + mix*4000)
const MASTER_FILTER_MIX_HZ = 4000;
const MASTER_FILTER_Q = 1.0; // port: renderAmbient.ts:174
const DELAY_MAX_SEC = 2.0; // port: renderAmbient.ts:161 createDelay(2.0)
const DELAY_BASE_SEC = 0.3; // port: renderAmbient.ts:166 (0.3 + 0.4*mix)
const DELAY_MIX_SEC = 0.4;
const FEEDBACK_BASE = 0.2; // port: renderAmbient.ts:167
const FEEDBACK_MIX = 0.5;
const DELAY_AUTOMATION_TC_SEC = 0.1; // port: renderAmbient.ts:370-371
const SOFTSQ_LPF_HZ = 3200; // port: scheduleTonal softsq lowpass
const SOFTSQ_LPF_Q = 0.7;
const HZ_GUARD_MAX = 20000; // D5: audio-rate upper bound for any hz/cutoff

// Kick/snare/hat shapes — port: renderAmbient.ts scheduleKick/Snare/Hat.
const KICK_START_HZ = 150;
const KICK_END_HZ = 40;
const KICK_PITCH_GLIDE_SEC = 0.05;
const KICK_DECAY_SEC = 0.3;
const DRUM_END_GAIN = 0.001;
const SNARE_BANDPASS_HZ = 2000;
const SNARE_BANDPASS_Q = 1.5;
const SNARE_DUR_GHOST_SEC = 0.06;
const SNARE_DUR_SEC = 0.12;
const HAT_HIGHPASS_HZ = 7000;
const HAT_HIGHPASS_Q = 1.0;
const HAT_DUR_CLOSED_SEC = 0.03;
const HAT_DUR_OPEN_SEC = 0.08;
const TONAL_ENV_END_GAIN = 0.0001; // port: scheduleTonal release ramp target
const TONAL_TAIL_SEC = 0.05; // port: scheduleTonal stopTime = … + env.r + 0.05
const VIBRATO_RATE_HZ = 4.5; // port: scheduleTonal lfo.frequency
const COEFF_QUANTUM_FRAMES = 128; // biquad coefficient update quantum (Web Audio render quantum)

// ── D1: fixed event priority. Any total order works; it only has to be
// fixed and total. Drums first (a kick's sidechain duck and the beat anchor
// are independent automations; the order between them is arbitrary but fixed),
// then the per-beat global automation anchor, then drones, then tonal. ──────
const EVENT_TYPE_PRIORITY: Record<string, number> = {
  kick: 0,
  snare: 1,
  hihat: 2,
  beat: 3,
  drone: 4,
  sample: 5,
  bass: 6,
  melody: 7,
  pad: 8,
  bell: 9,
};

export interface TimelineEvent {
  t: number;
  priority: number;
  seq: number; // insertion order — D1 final tie-break
  ev?: MusicalEvent;
  beat?: { sceneMix: number; panDriftPhase: number };
}

export interface Timeline {
  events: TimelineEvent[]; // sorted by (t, priority, seq) — D1
  preRollSec: number;
  beats: number;
  kernelEventCount: number;
  kernelEventsByType: Record<string, number>;
}

/** Drain the kernel for `durationSec` (+4-bar pre-roll) and sort (D1+D3). */
export function buildTimeline(params: EngineParams, durationSec: number): Timeline {
  const bpm = params.bpm || 72;
  const preRollSec = 4 * (60 / bpm) * 4; // port: renderAmbient.ts:145
  const targetEnd = preRollSec + durationSec;

  // RNG init — exact renderAmbient order (renderAmbient.ts:341-349). The 22k
  // draws the noise buffer consumes are consumed on the main stream by
  // advanceRngPastNoiseBuffer; the noise VALUES are re-derived in BlockSynth
  // from a snapshot (mathematically identical, main stream untouched).
  let state: EngineState = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, params);

  const raw: TimelineEvent[] = [];
  let seq = 0;
  let kernelEventCount = 0;
  const kernelEventsByType: Record<string, number> = {};

  const push = (t: number, priority: number, rec: Partial<TimelineEvent>) => {
    if (!Number.isFinite(t)) {
      // D5: a non-finite event time poisons the sort — fail loudly now.
      throw new Error(`[D5] non-finite event time ${t} for ${JSON.stringify(rec.ev ?? rec.beat)}`);
    }
    raw.push({ t, priority, seq: seq++, ...rec } as TimelineEvent);
  };

  // Harmonic slew tracking — port: renderAmbient.ts:322-335, 345-352.
  let slewStartHz: number | null = null;
  let slewEndHz: number | null = null;
  let slewStartTime: number | null = null;
  let slewEndTime: number | null = null;
  const slewedHz = (now: number, currentHz: number): number => {
    if (slewStartHz === null || slewEndHz === null || slewStartTime === null || slewEndTime === null) return currentHz;
    if (now >= slewEndTime) return slewEndHz;
    return slewStartHz + (slewEndHz - slewStartHz) * ((now - slewStartTime) / SLEW_DURATION_SEC);
  };

  // Beat cap — port: renderAmbient.ts:277-281.
  const minBpm = Math.min(bpm, ...getScenePackScenes(params).map((s) => s.bpm));
  const maxBeats = Math.ceil((preRollSec + durationSec) * 1.1 * (minBpm / 60)) + 100;

  let currentTime = 0;
  let beatIndex = 0;
  let beats = 0;
  while (currentTime < targetEnd && beatIndex < maxBeats) {
    state = { ...state, currentRootHz: slewedHz(currentTime, state.currentRootHz) };
    const prevTargetRootHz = state.targetRootHz;

    const preBeatParams = getEffectiveSceneParams(state, params);
    const beatSec = 60 / preBeatParams.bpm;
    const sixteenthSec = beatSec / 4;

    const { events, nextState } = getMusicalEvents(state.beat, { ...state }, params);
    state = nextState;
    if (state.targetRootHz !== prevTargetRootHz) {
      slewStartHz = state.currentRootHz;
      slewEndHz = state.targetRootHz;
      slewStartTime = currentTime;
      slewEndTime = currentTime + SLEW_DURATION_SEC;
    }

    for (const ev of events) {
      kernelEventCount++;
      kernelEventsByType[ev.type] = (kernelEventsByType[ev.type] ?? 0) + 1;
      const t = getSubBeatEventTime(currentTime, ev.subBeatIndex, sixteenthSec, params.swing);
      push(t, EVENT_TYPE_PRIORITY[ev.type] ?? 999, { ev });
    }
    push(currentTime, EVENT_TYPE_PRIORITY.beat, {
      beat: { sceneMix: preBeatParams.mix, panDriftPhase: state.panDriftPhase },
    });

    currentTime += beatSec;
    beatIndex++;
    beats++;
  }
  if (currentTime < targetEnd) {
    // D5: the beat loop must reach the horizon — truncation is loud failure.
    throw new Error(`[D5] beat loop ended at ${currentTime.toFixed(2)}s < target ${targetEnd.toFixed(2)}s (${beatIndex} beats)`);
  }

  raw.sort((a, b) => a.t - b.t || a.priority - b.priority || a.seq - b.seq);
  // D1 post-condition (once, cheap): the total order actually holds.
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    if (b.t < a.t || (b.t === a.t && (b.priority < a.priority || (b.priority === a.priority && b.seq < a.seq)))) {
      throw new Error(`[D1] sort regression at index ${i}`);
    }
  }
  return { events: raw, preRollSec, beats, kernelEventCount, kernelEventsByType };
}

// ── DSP primitives ───────────────────────────────────────────────────────────

/** Per-sample geometric approach — setTargetAtTime semantics as a carried
 * recurrence: v ← target + (v − target)·k, k = exp(−1/(tc·sr)). Identical to
 * sampling the continuous exponential curve (the k-products telescope), so
 * it is block-size invariant by construction. */
export class ExpApproach {
  v: number;
  target: number;
  private readonly k: number;
  private readonly initialV: number;
  constructor(v: number, target: number, timeConstantSec: number, sampleRate: number) {
    this.v = v;
    this.target = target;
    this.initialV = v;
    this.k = timeConstantSec > 0 ? Math.exp(-1 / (timeConstantSec * sampleRate)) : 0;
  }
  step(): void {
    this.v = this.target + (this.v - this.target) * this.k;
  }
  /** I1 broken variant only: forget carried progress, restart from the
   * initial value — the executable form of "re-anchored at a block boundary
   * as if starting fresh". */
  reanchorBroken(): void {
    this.v = this.initialV;
  }
}

/** Sidechain duck — port of renderAmbient's scheduleSidechain + evaluateSidechain
 * as a carried two-segment linear machine. Anchoring a new kick at the true
 * carried value replaces the whole SidechainTracker/cancelAndHold machinery. */
class SidechainDuck {
  private seg1: { startT: number; startV: number; endT: number; endV: number } | null = null;
  private seg2: { startT: number; startV: number; endT: number; endV: number } | null = null;
  constructor(private readonly steadyV: number) {}
  kick(t0: number, duckMultiplier: number, attackEndT: number, releaseEndT: number): void {
    const anchor = this.valueAt(t0); // true carried value — the cancelAndHold primitive
    this.seg1 = { startT: t0, startV: anchor, endT: attackEndT, endV: this.steadyV * duckMultiplier };
    this.seg2 = { startT: attackEndT, startV: this.steadyV * duckMultiplier, endT: releaseEndT, endV: this.steadyV };
  }
  valueAt(t: number): number {
    if (this.seg1 && t < this.seg1.endT) {
      const s = this.seg1;
      return s.startV + ((s.endV - s.startV) * (t - s.startT)) / (s.endT - s.startT);
    }
    if (this.seg2 && t < this.seg2.endT) {
      const s = this.seg2;
      return s.startV + ((s.endV - s.startV) * (t - s.startT)) / (s.endT - s.startT);
    }
    return this.steadyV;
  }
}

/** RBJ cookbook biquad (DF1), coefficients recomputed lazily on parameter
 * change; state carried — O(1). */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private lastKind = ""; private lastF0 = -1; private lastQ = -1;
  constructor(private readonly sampleRate: number) {}
  private set(kind: "lpf" | "bpf" | "hpf", f0: number, q: number): void {
    if (f0 === this.lastF0 && q === this.lastQ && kind === this.lastKind) return;
    if (!(f0 > 0 && f0 < this.sampleRate / 2 && Number.isFinite(q) && q > 0)) {
      throw new Error(`[D5] invalid biquad params f0=${f0} q=${q}`);
    }
    const w0 = (2 * Math.PI * f0) / this.sampleRate;
    const cw = Math.cos(w0);
    // round2: Web Audio's BiquadFilterNode interprets Q in dB for
    // lowpass/highpass (α = sin(ω0)/(2·10^(Q/20))) and as linear Q for
    // bandpass. Verified against Chromium getFrequencyResponse with
    // max|err| = 0.000000 for all three kinds (test/round2/
    // biquad_response.json, bp_hp_response.json). The PoC's linear-Q lpf
    // was a −3.9 dB timbre error at the drone cutoff (3400 Hz).
    const qLinear = kind === "bpf" ? q : Math.pow(10, q / 20);
    const alpha = Math.sin(w0) / (2 * qLinear);
    let b0: number, b1: number, b2: number;
    if (kind === "lpf") {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    } else if (kind === "bpf") {
      b0 = alpha; b1 = 0; b2 = -alpha;
    } else {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    this.lastKind = kind; this.lastF0 = f0; this.lastQ = q;
  }
  setLpf(f0: number, q: number): void { this.set("lpf", f0, q); }
  setBpf(f0: number, q: number): void { this.set("bpf", f0, q); }
  setHpf(f0: number, q: number): void { this.set("hpf", f0, q); }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// Waveforms in turn space (phase tracked mod 1 — bounded, no drift).
export function waveSine(p: number): number { return Math.sin(2 * Math.PI * p); }
export function waveTriangle(p: number): number {
  const q = p + 0.75 - Math.floor(p + 0.75);
  return 4 * Math.abs(q - 0.5) - 1;
}
function waveSquare(p: number): number { return p < 0.5 ? 1 : -1; }
/** Equal-power stereo panner gains — Web Audio StereoPannerNode semantics. */
export function panGainL(p: number): number { return Math.cos(((p + 1) * Math.PI) / 4); }
export function panGainR(p: number): number { return Math.sin(((p + 1) * Math.PI) / 4); }

interface TonalVoice {
  kind: "tonal";
  spawnFrame: number; hz: number; amp: number; relEndT: number;
  timbre: TimbreMode;
  env: { a: number; d: number; s: number; r: number };
  sustainT: number; // max(a+d, dur) — release-ramp start
  vib: number; // vibrato depth in Hz (melody)
  phase: number; fmPhase: number; vibPhase: number;
  filter: Biquad | null; // softsq
  route: "main" | "padL" | "padR" | "bell";
}
interface KickVoice { kind: "kick"; spawnFrame: number; amp: number; phase: number; envV: number; envK: number; }
interface NoiseVoice { kind: "snare" | "hat"; spawnFrame: number; amp: number; durFrames: number; envV: number; envK: number; n: number; filter: Biquad; }
type Voice = TonalVoice | KickVoice | NoiseVoice;

interface DroneLayer {
  started: boolean;
  timbre: TimbreMode;
  hz: ExpApproach;
  detune: ExpApproach;
  pan: ExpApproach; // tc 0.25
  filterHz: ExpApproach; // tc 0.5 toward 3600
  gain: ExpApproach; // tc DRONE_FADE_SEC/3 toward amp, per-beat re-target (D4)
  gainK: number; // precomputed per-sample factor for the approach
  pendingRelease: { sustainT: number; releaseEndT: number } | null;
  inRelease: boolean;
  releaseStartV: number;
  oscPhase: number; modPhase: number; lfoPhase: number;
  modDepthHz: number; // round2: frozen at layer start — see spawnVoice
  filter: Biquad;
  sweepSec: number; // round2: frozen at layer start — see spawnVoice
}

export interface SynthSink {
  /** Called once per block with master output (de-interleaved stereo).
   * Implementations convert/stream/discard; nothing here may retain blocks. */
  writeBlock(left: Float32Array, right: Float32Array, frames: number): void;
  /** round2: optional cooperative backpressure. Called after each
   * writeBlock; return a Promise ONLY when writes are pending behind a
   * full pipe — render() awaits it before producing further samples.
   * Sync sinks omit this entirely (zero overhead, zero behavior change). */
  drain?: () => Promise<void> | undefined;
}

export interface BlockSynthOptions {
  params: EngineParams;
  timeline: Timeline;
  sampleRate: number;
  blockFrames: number;
  durationSec: number; // post-pre-roll output length
  /** I1 broken variant: re-anchor every exponential approach at block start. */
  brokenReanchor?: boolean;
}

export interface RenderStats {
  framesWritten: number;
  peakConcurrentVoices: number;
  skippedSampleEvents: number;
  droneLayersStarted: number;
  blocks: number;
}

const TWO_PI = 2 * Math.PI;

export class BlockSynth {
  private readonly sr: number;
  private readonly blockFrames: number;
  private readonly timeline: Timeline;
  private readonly params: EngineParams;
  private readonly brokenReanchor: boolean;
  private readonly durationSec: number;

  private readonly accL: Float32Array; private readonly accR: Float32Array;
  private readonly drumL: Float32Array; private readonly drumR: Float32Array;
  private readonly outL: Float32Array; private readonly outR: Float32Array;
  private readonly delayL: Float32Array; private readonly delayR: Float32Array;
  private readonly noise: Float32Array;
  private voices: Voice[] = [];
  private readonly drones: DroneLayer[] = [];

  private masterFilter: Biquad;
  private masterFc = 0;
  private delayWrite = 0;
  private delaySec: ExpApproach;
  private feedback: ExpApproach;
  private padPanL: ExpApproach; private padPanR: ExpApproach; private bellPan: ExpApproach;
  private duck: SidechainDuck;

  private evIdx = 0;
  private ops: Array<{ i: number; run: () => void }> = [];
  private absFrame = 0; // absolute timeline frame (pre-roll included)
  private frameWritten = 0;
  private totalFrames: number;
  private peakVoices = 0;
  private skippedSamples = 0;
  private readonly kickFrames: number; // frame-exact drum lifetimes (per-sr)
  private readonly kickGlideFrames: number;

  constructor(opts: BlockSynthOptions) {
    this.sr = opts.sampleRate;
    this.blockFrames = opts.blockFrames;
    this.timeline = opts.timeline;
    this.params = opts.params;
    this.brokenReanchor = opts.brokenReanchor ?? false;
    this.durationSec = opts.durationSec;
    this.kickFrames = Math.round(KICK_DECAY_SEC * this.sr);
    this.kickGlideFrames = Math.round(KICK_PITCH_GLIDE_SEC * this.sr);

    const mix = opts.params.mix || 0.4;
    const block = opts.blockFrames;
    this.accL = new Float32Array(block); this.accR = new Float32Array(block);
    this.drumL = new Float32Array(block); this.drumR = new Float32Array(block);
    this.outL = new Float32Array(block); this.outR = new Float32Array(block);
    // round2: ring is COEFF_QUANTUM_FRAMES longer so the feedback tap
    // (delay + one render quantum) is always a valid wrapped index.
    const ringLen = Math.ceil(DELAY_MAX_SEC * this.sr) + COEFF_QUANTUM_FRAMES + 1;
    this.delayL = new Float32Array(ringLen);
    this.delayR = new Float32Array(ringLen);

    // D3: noise values from the kernel stream snapshot — identical to
    // createNoiseBufferFromState's buffer (renderAmbient.ts:457-467).
    this.noise = new Float32Array(NOISE_BUFFER_SAMPLES);
    const snap = { rngState: createInitialState(opts.params).rngState };
    for (let i = 0; i < NOISE_BUFFER_SAMPLES; i++) this.noise[i] = mulberry32Next(snap) * 2 - 1;

    this.masterFc = MASTER_FILTER_BASE_HZ + mix * MASTER_FILTER_MIX_HZ;
    this.masterFilter = new Biquad(this.sr);
    this.masterFilter.setLpf(this.masterFc, MASTER_FILTER_Q);
    this.delaySec = new ExpApproach(DELAY_BASE_SEC + mix * DELAY_MIX_SEC, DELAY_BASE_SEC + mix * DELAY_MIX_SEC, DELAY_AUTOMATION_TC_SEC, this.sr);
    this.feedback = new ExpApproach(FEEDBACK_BASE + mix * FEEDBACK_MIX, FEEDBACK_BASE + mix * FEEDBACK_MIX, DELAY_AUTOMATION_TC_SEC, this.sr);
    this.padPanL = new ExpApproach(0, 0, PAN_DRIFT_TIME_CONSTANT_SEC, this.sr);
    this.padPanR = new ExpApproach(0, 0, PAN_DRIFT_TIME_CONSTANT_SEC, this.sr);
    this.bellPan = new ExpApproach(0, 0, PAN_DRIFT_TIME_CONSTANT_SEC, this.sr);
    this.duck = new SidechainDuck(TONAL_BUS_GAIN);

    const droneTc = DRONE_FADE_SEC / DRONE_FADE_TARGET_DIVISOR;
    for (let i = 0; i < MAX_DRONE_LAYERS; i++) {
      const gain = new ExpApproach(0, 0, droneTc, this.sr);
      // Access the private k via a duplicated computation — same formula,
      // keeps the per-sample step allocation-free.
      this.drones.push({
        started: false,
        timbre: "sine",
        hz: new ExpApproach(0, 0, DRONE_PARAMETER_TIME_CONSTANT_SEC, this.sr),
        detune: new ExpApproach(0, 0, DRONE_PARAMETER_TIME_CONSTANT_SEC, this.sr),
        pan: new ExpApproach(0, 0, DRONE_PAN_TIME_CONSTANT_SEC, this.sr),
        filterHz: new ExpApproach(DRONE_FILTER_CUTOFF_HZ, DRONE_FILTER_CUTOFF_HZ, DRONE_PARAMETER_TIME_CONSTANT_SEC, this.sr),
        gain,
        gainK: Math.exp(-1 / (droneTc * this.sr)),
        pendingRelease: null, inRelease: false, releaseStartV: 0,
        oscPhase: 0, modPhase: 0, lfoPhase: 0,
        modDepthHz: 0,
        filter: new Biquad(this.sr),
        sweepSec: 0,
      });
      this.drones[i].filter.setLpf(DRONE_FILTER_CUTOFF_HZ, DRONE_FILTER_Q);
    }

    this.totalFrames = Math.ceil(opts.durationSec * this.sr);
  }

  /** D5: the single validation chokepoint for every kernel event. */
  private ingest(ev: MusicalEvent, t: number): void {
    const bad = (why: string): never => {
      throw new Error(`[D5] malformed event at t=${t.toFixed(6)}: ${why}: ${JSON.stringify(ev)}`);
    };
    // priority 0 is falsy — must compare against undefined, not !lookup
    if (EVENT_TYPE_PRIORITY[ev.type] === undefined) bad("unknown event type");
    if (!Number.isFinite(ev.amp) || ev.amp < 0 || ev.amp > 2) bad("amp out of range");
    if (!Number.isFinite(ev.durationSec) || ev.durationSec < 0) bad("durationSec out of range");
    if (!Number.isFinite(ev.pan) || ev.pan < -1 || ev.pan > 1) bad("pan out of range");
    if (!Number.isInteger(ev.beatIndex) || ev.beatIndex < 0) bad("beatIndex invalid");
    if (!Number.isInteger(ev.subBeatIndex) || ev.subBeatIndex < 0 || ev.subBeatIndex > 3) bad("subBeatIndex invalid");
    switch (ev.type) {
      case "kick": case "snare": case "hihat": break; // hz undefined by design
      case "melody": case "pad": case "bass": case "bell": case "drone":
        if (ev.hz === undefined || !Number.isFinite(ev.hz) || ev.hz <= 0 || ev.hz > HZ_GUARD_MAX) bad("hz out of range");
        break;
      case "sample":
        if (!ev.sampleId) bad("sample event without sampleId");
        break;
      default: bad("unknown event type"); // exhaustive guard — never silently skipped
    }
  }

  private spawnVoice(ev: MusicalEvent, t: number, spawnFrame: number): void {
    switch (ev.type) {
      case "kick": {
        const envK = Math.exp(Math.log(DRUM_END_GAIN / Math.max(ev.amp, 1e-12)) / (KICK_DECAY_SEC * this.sr));
        this.voices.push({ kind: "kick", spawnFrame, amp: ev.amp, phase: 0, envV: ev.amp, envK });
        const shape = getSidechainDuckShape(t, this.params.sidechainAmount); // port: scheduleSidechain
        if (shape) this.duck.kick(t, shape.duckGainMultiplier, shape.attackTime, shape.releaseTime);
        break;
      }
      case "snare": {
        const dur = ev.isGhost ? SNARE_DUR_GHOST_SEC : SNARE_DUR_SEC;
        const f = new Biquad(this.sr); f.setBpf(SNARE_BANDPASS_HZ, SNARE_BANDPASS_Q);
        const nSmp = Math.max(1, Math.round(dur * this.sr));
        this.voices.push({
          kind: "snare", spawnFrame, amp: ev.amp, durFrames: nSmp,
          envV: ev.amp, envK: Math.exp(Math.log(DRUM_END_GAIN / Math.max(ev.amp, 1e-12)) / nSmp), n: 0,
          filter: f,
        });
        break;
      }
      case "hihat": {
        const dur = ev.isClosed === false ? HAT_DUR_OPEN_SEC : HAT_DUR_CLOSED_SEC;
        const f = new Biquad(this.sr); f.setHpf(HAT_HIGHPASS_HZ, HAT_HIGHPASS_Q);
        const nSmp = Math.max(1, Math.round(dur * this.sr));
        this.voices.push({
          kind: "hat", spawnFrame, amp: ev.amp, durFrames: nSmp,
          envV: ev.amp, envK: Math.exp(Math.log(DRUM_END_GAIN / Math.max(ev.amp, 1e-12)) / nSmp), n: 0,
          filter: f,
        });
        break;
      }
      case "drone": {
        const idx = ev.droneLayerIndex ?? 0;
        const layer = this.drones[idx];
        if (!layer) throw new Error(`[D5] droneLayerIndex ${idx} out of range: ${JSON.stringify(ev)}`);
        // Per-beat re-anchor — the carried gain.v IS the true value, so this
        // replaces renderAmbient's cancelAndHold + DroneCurveState machinery.
        layer.gain.target = ev.amp;
        const stopTime = this.timeline.preRollSec + this.durationSec; // port: droneStopTime
        const sustainTime = Math.max(t + DRONE_FADE_SEC, stopTime - DRONE_FADE_SEC);
        // When the drone's lifespan is shorter than DRONE_FADE_SEC the sustain
        // would land at/after stopTime; per renderAmbient the LinearRamp then
        // REPLACES the SetTarget — a straight line from the carried value.
        layer.pendingRelease = { sustainT: Math.min(sustainTime, stopTime), releaseEndT: stopTime };
        layer.inRelease = false;
        layer.pan.target = ev.pan;
        layer.filterHz.target = DRONE_FILTER_CUTOFF_HZ;
        if (!layer.started) {
          layer.started = true;
          layer.timbre = ev.timbre ?? "sine";
          layer.hz = new ExpApproach(ev.hz!, ev.hz!, DRONE_PARAMETER_TIME_CONSTANT_SEC, this.sr);
          layer.detune = new ExpApproach(ev.detuneCents ?? 0, ev.detuneCents ?? 0, DRONE_PARAMETER_TIME_CONSTANT_SEC, this.sr);
          layer.sweepSec = ev.sweepSec ?? 0;
          // round2: the browser sets the FM mod-index (modGain.gain =
          // hz·FM_INDEX, renderAmbient.ts:900-902) and the sweep LFO rate
          // (renderAmbient.ts:722-726) ONCE at layer creation and never
          // updates them — the modGain node isn't even retained (its
          // ponytail note at renderAmbient.ts:761-765). Freeze both here.
          layer.modDepthHz = ev.hz! * FM_INDEX;
          layer.oscPhase = 0; layer.modPhase = 0; layer.lfoPhase = 0;
        } else {
          layer.hz.target = ev.hz!;
          layer.detune.target = ev.detuneCents ?? 0;
          // round2: sweepSec intentionally NOT updated on later events
          // (the browser's LFO oscillator frequency is set once).
        }
        break;
      }
      case "sample": {
        // renderAmbient skips missing/undecodable sample buffers explicitly
        // (scheduleSample early-return). No bank can be decoded in Node —
        // same rule, but counted and reported, never silent.
        this.skippedSamples++;
        break;
      }
      case "melody": case "pad": case "bass": case "bell": {
        const { env, vibratoAmount } = resolveToneEnvelope(ev.type, ev.pan);
        const sustainT = Math.max(env.a + env.d, ev.durationSec);
        let filter: Biquad | null = null;
        if (ev.timbre === "softsq") {
          filter = new Biquad(this.sr);
          filter.setLpf(SOFTSQ_LPF_HZ, SOFTSQ_LPF_Q);
        }
        let route: TonalVoice["route"] = "main";
        if (ev.type === "pad" && ev.pan < 0) route = "padL";
        else if (ev.type === "pad" && ev.pan > 0) route = "padR";
        else if (ev.type === "bell") route = "bell";
        this.voices.push({
          kind: "tonal",
          spawnFrame, hz: ev.hz!, amp: ev.amp, relEndT: sustainT + env.r,
          timbre: ev.timbre ?? "sine",
          env, sustainT,
          vib: vibratoAmount ?? 0,
          phase: 0, fmPhase: 0, vibPhase: 0,
          filter, route,
        });
        break;
      }
    }
  }

  /** Closed-form port of scheduleTonal's linear-ramp ADSR (scheduleTonal:
   * setValueAtTime(0) → linRamp(amp, +a) → linRamp(amp·s, +a+d) → hold to
   * max(a+d, dur) → linRamp(0.0001, +r)). */
  private static envAt(v: TonalVoice, u: number): number {
    const { a, d, s, r } = v.env;
    if (u < 0) return 0;
    // scheduleTonal stops the osc at relEndT + 0.05 s; the value holds the
    // release target (0.0001) over that tail — port exactly, no -80 dB step.
    if (u >= v.relEndT + TONAL_TAIL_SEC) return 0;
    if (u >= v.relEndT) return TONAL_ENV_END_GAIN;
    if (u < a) return (v.amp * u) / a;
    if (u < a + d) return v.amp + ((v.amp * s - v.amp) * (u - a)) / d;
    if (u < v.sustainT) return v.amp * s;
    return v.amp * s + ((TONAL_ENV_END_GAIN - v.amp * s) * (u - v.sustainT)) / r;
  }

  /** Render the whole timeline to the sink. Never materializes more than one
   * block of audio beyond the fixed inventory.
   * round2: async so a backpressured sink can suspend production between
   * blocks (drain). No DSP state is touched across awaits — determinism
   * (D1–D5) is unaffected; sync sinks resolve immediately. */
  async render(sink: SynthSink): Promise<RenderStats> {
    const evs = this.timeline.events;
    const sr = this.sr;
    const bf = this.blockFrames;
    const blocksTotal = Math.ceil((this.preRollFrames() + this.totalFrames) / bf);
    let blockIdx = 0;

    while (this.frameWritten < this.totalFrames) {
      const blockEndFrame = (blockIdx + 1) * bf;
      const blockStartFrame = blockIdx * bf;

      // ── ingest: D1 pointer, FRAME-EXACT spawn indices. Each event's spawn
      // frame is round(t·sr) — an absolute-frame quantity, identical for any
      // block size. Events whose spawn frame falls past this block end are
      // left for the next block (spawnFrame is monotonic in the sorted t).
      this.ops.length = 0;
      while (this.evIdx < evs.length) {
        const e = evs[this.evIdx];
        const spawnFrame = Math.round(e.t * sr);
        if (spawnFrame >= blockEndFrame) break;
        const i = Math.max(0, spawnFrame - blockStartFrame);
        if (e.ev) {
          this.ingest(e.ev, e.t);
          this.spawnVoice(e.ev, e.t, spawnFrame);
        } else if (e.beat) {
          const { sceneMix, panDriftPhase } = e.beat;
          const pan = Math.sin(panDriftPhase) * 0.1; // port: renderAmbient.ts:353
          const fc = MASTER_FILTER_BASE_HZ + sceneMix * MASTER_FILTER_MIX_HZ;
          const dTarget = DELAY_BASE_SEC + sceneMix * DELAY_MIX_SEC;
          const fTarget = FEEDBACK_BASE + sceneMix * FEEDBACK_MIX;
          this.ops.push({ i, run: () => { this.masterFc = fc; } });
          this.ops.push({ i, run: () => { this.delaySec.target = dTarget; } });
          this.ops.push({ i, run: () => { this.feedback.target = fTarget; } });
          this.ops.push({ i, run: () => { this.padPanL.target = -pan; this.padPanR.target = pan; } });
          this.ops.push({ i, run: () => { this.bellPan.target = Math.sin(panDriftPhase * 1.3) * 0.15; } });
        }
        this.evIdx++;
      }

      this.accL.fill(0); this.accR.fill(0);
      this.drumL.fill(0); this.drumR.fill(0);

      if (this.brokenReanchor) {
        // I1 broken variant only — the C-failure analogue, executable.
        this.delaySec.reanchorBroken(); this.feedback.reanchorBroken();
        this.padPanL.reanchorBroken(); this.padPanR.reanchorBroken(); this.bellPan.reanchorBroken();
        for (const d of this.drones) {
          d.hz.reanchorBroken(); d.detune.reanchorBroken(); d.pan.reanchorBroken(); d.filterHz.reanchorBroken();
          d.gain.reanchorBroken();
          d.pendingRelease = null; d.inRelease = false;
        }
      }

      let opIdx = 0;
      let quantum = Math.floor(blockStartFrame / COEFF_QUANTUM_FRAMES);
      let quantumDirty = true; // coefficients must materialize at block start too

      for (let i = 0; i < bf; i++) {
        const absFrame = blockStartFrame + i;
        // Per-frame time derived from the ABSOLUTE FRAME INTEGER — the same
        // float value for the same sample regardless of block size. (The
        // first draft used tBlock + i/sr, whose 1-ulp block-dependent drift
        // flipped event/envelope sample indices and broke block-size
        // invariance at long durations — measured, then fixed here.)
        const t = absFrame / sr;
        // 1. automation ops at their exact sample, in D1 order
        while (opIdx < this.ops.length && this.ops[opIdx].i <= i) { this.ops[opIdx].run(); opIdx++; }
        // 2. biquad coefficient quantum (absolute-frame aligned → block-size
        //    invariant; mirrors Web Audio's per-render-quantum updates)
        const q = Math.floor(absFrame / COEFF_QUANTUM_FRAMES);
        if (q !== quantum || quantumDirty) {
          quantum = q; quantumDirty = false;
          this.masterFilter.setLpf(this.masterFc, MASTER_FILTER_Q);
          if (this.delaySec.v > DELAY_MAX_SEC) {
            throw new Error(`[D5] delay automation ${this.delaySec.v.toFixed(3)}s exceeds createDelay(${DELAY_MAX_SEC}) capacity`);
          }
          for (const d of this.drones) {
            if (d.started) {
              let fc = d.filterHz.v;
              if (d.sweepSec > 0) fc += DRONE_FILTER_LFO_DEPTH_HZ * waveSine(d.lfoPhase);
              d.filter.setLpf(Math.min(HZ_GUARD_MAX, Math.max(10, fc)), DRONE_FILTER_Q);
            }
          }
        }
        // 3. carried per-sample automation (D4)
        this.delaySec.step(); this.feedback.step();
        this.padPanL.step(); this.padPanR.step(); this.bellPan.step();
        const duckV = this.duck.valueAt(t);
        // 4. drones — fixed slot order (part of the D2 total order)
        for (let di = 0; di < this.drones.length; di++) {
          const d = this.drones[di];
          if (!d.started) continue;
          // gain: carried geometric approach; linear release once pending
          if (d.pendingRelease && t >= d.pendingRelease.sustainT) {
            if (!d.inRelease) { d.inRelease = true; d.releaseStartV = d.gain.v; }
            const span = d.pendingRelease.releaseEndT - d.pendingRelease.sustainT;
            d.gain.v = span > 0
              ? d.releaseStartV + ((DRONE_RELEASE_SILENCE_GAIN - d.releaseStartV) * (t - d.pendingRelease.sustainT)) / span
              : DRONE_RELEASE_SILENCE_GAIN;
          } else {
            d.gain.v = d.gain.target + (d.gain.v - d.gain.target) * d.gainK;
          }
          const hzV = d.hz.v * Math.pow(2, d.detune.v / 1200);
          let osc: number;
          if (d.timbre === "fm") {
            d.modPhase = (d.modPhase + (hzV * FM_MOD_RATIO) / sr) % 1;
            // round2: mod depth is the layer-start hz·FM_INDEX (frozen),
            // not hzV·FM_INDEX — matches the browser's un-retained modGain.
            const inst = hzV + d.modDepthHz * waveSine(d.modPhase);
            d.oscPhase = (d.oscPhase + inst / sr) % 1;
            osc = waveSine(d.oscPhase);
          } else {
            d.oscPhase = (d.oscPhase + hzV / sr) % 1;
            osc = d.timbre === "triangle" ? waveTriangle(d.oscPhase)
              : d.timbre === "softsq" ? waveSquare(d.oscPhase)
              : waveSine(d.oscPhase);
          }
          if (d.sweepSec > 0) d.lfoPhase = (d.lfoPhase + 1 / (d.sweepSec * sr)) % 1;
          const g = d.filter.process(osc) * d.gain.v;
          this.accL[i] += g * panGainL(d.pan.v);
          this.accR[i] += g * panGainR(d.pan.v);
        }
        // 5. voices in spawn order — the D2 summation order. Voice-local
        // time is FRAME-BASED: u = (absFrame − spawnFrame)/sr, so every
        // predicate is a pure function of the absolute frame.
        for (let vi = 0; vi < this.voices.length; vi++) {
          const v = this.voices[vi];
          if (v.kind === "tonal") {
            const u = (absFrame - v.spawnFrame) / sr;
            if (u >= 0 && u < v.relEndT) {
              const envV = BlockSynth.envAt(v, u);
              let s: number;
              if (v.timbre === "sine") {
                const f = v.vib > 0 ? v.hz + v.vib * Math.sin(TWO_PI * (v.vibPhase = (v.vibPhase + VIBRATO_RATE_HZ / sr) % 1)) : v.hz;
                v.phase = (v.phase + f / sr) % 1;
                s = waveSine(v.phase);
              } else if (v.timbre === "triangle") {
                v.phase = (v.phase + v.hz / sr) % 1;
                s = waveTriangle(v.phase);
              } else if (v.timbre === "softsq") {
                v.phase = (v.phase + v.hz / sr) % 1;
                s = v.filter!.process(waveSquare(v.phase));
              } else { // fm — port: modOsc(hz·1.5) → modGain(hz·1.8) → carrier frequency
                v.fmPhase = (v.fmPhase + (v.hz * FM_MOD_RATIO) / sr) % 1;
                const inst = v.hz + v.hz * FM_INDEX * waveSine(v.fmPhase);
                v.phase = (v.phase + inst / sr) % 1;
                s = waveSine(v.phase);
              }
              const routed = s * envV;
              if (v.route === "main") { this.accL[i] += routed; this.accR[i] += routed; }
              else if (v.route === "padL") { this.accL[i] += routed * panGainL(this.padPanL.v); this.accR[i] += routed * panGainR(this.padPanL.v); }
              else if (v.route === "padR") { this.accL[i] += routed * panGainL(this.padPanR.v); this.accR[i] += routed * panGainR(this.padPanR.v); }
              else { this.accL[i] += routed * panGainL(this.bellPan.v); this.accR[i] += routed * panGainR(this.bellPan.v); }
            }
          } else if (v.kind === "kick") {
            const df = absFrame - v.spawnFrame;
            if (df >= 0 && df < this.kickFrames) {
              const f = df < this.kickGlideFrames
                ? KICK_START_HZ * Math.pow(KICK_END_HZ / KICK_START_HZ, df / this.kickGlideFrames)
                : KICK_END_HZ;
              v.phase = (v.phase + f / sr) % 1;
              const s = waveSine(v.phase) * v.envV; // first sample at amp, then geometric decay
              v.envV *= v.envK;
              this.drumL[i] += s; this.drumR[i] += s;
            }
          } else { // snare | hat
            const df = absFrame - v.spawnFrame;
            if (df >= 0 && df < v.durFrames) {
              while (v.n < df) { v.n++; v.envV *= v.envK; }
              const s = v.filter.process(this.noise[df % NOISE_BUFFER_SAMPLES]) * v.envV;
              this.drumL[i] += s; this.drumR[i] += s;
            }
          }
        }
        // 6. master chain — port: gain(=TONAL_BUS_GAIN, duck-automated)→filter→out,
        // filter→delay→out, drums→out. duckV is in absolute gain units.
        const tonalL = this.accL[i] * duckV;
        const tonalR = this.accR[i] * duckV;
        const filtL = this.masterFilter.process(tonalL);
        const filtR = this.masterFilter.process(tonalR);
        const readPos = this.delayWrite - this.delaySec.v * sr;
        const i0 = Math.floor(readPos);
        const frac = readPos - i0;
        const ringLen = this.delayL.length;
        const j0 = ((i0 % ringLen) + ringLen) % ringLen;
        const j1 = (j0 + 1) % ringLen;
        const dL = this.delayL[j0] + (this.delayL[j1] - this.delayL[j0]) * frac;
        const dR = this.delayR[j0] + (this.delayR[j1] - this.delayR[j0]) * frac;
        // round2: Web Audio breaks feedback cycles with ONE EXTRA RENDER
        // QUANTUM — the delay output re-enters its input 128 samples later
        // than the node's own delay: d(t) = x(t−Δ) + fb·d(t−Δ−128).
        // Measured in Chromium's OfflineAudioContext by impulse probe:
        // echoes at 20286, 40700, 61114 samples (Δ=0.46 s → 20286), i.e.
        // spacing Δ+128, gains 1, 0.4, 0.16 (test/round2/
        // impulse_probe_result.json). The PoC fed back at Δ with no extra
        // quantum, rotating every comb peak/notch (2.0 rad at 110 Hz) —
        // the measured root cause of the "harsher than the browser
        // export" defect.
        const fbReadPos = readPos - COEFF_QUANTUM_FRAMES;
        const f0i = Math.floor(fbReadPos);
        const fFrac = fbReadPos - f0i;
        const k0 = ((f0i % ringLen) + ringLen) % ringLen;
        const k1 = (k0 + 1) % ringLen;
        const fbL = this.delayL[k0] + (this.delayL[k1] - this.delayL[k0]) * fFrac;
        const fbR = this.delayR[k0] + (this.delayR[k1] - this.delayR[k0]) * fFrac;
        this.delayL[this.delayWrite] = filtL + this.feedback.v * fbL;
        this.delayR[this.delayWrite] = filtR + this.feedback.v * fbR;
        this.delayWrite = (this.delayWrite + 1) % ringLen;
        this.outL[i] = filtL + dL + this.drumL[i];
        this.outR[i] = filtR + dR + this.drumR[i];
      }

      // 7. compact voices, preserving spawn order (D2 requires the relative
      // order of survivors to be a pure function of the event stream).
      // Frame-exact lifetimes: a voice is alive while its absolute-frame
      // range overlaps the next block.
      let w = 0;
      for (let r = 0; r < this.voices.length; r++) {
        const v = this.voices[r];
        const endFrame = v.kind === "tonal" ? v.spawnFrame + Math.ceil((v.relEndT + TONAL_TAIL_SEC) * sr)
          : v.kind === "kick" ? v.spawnFrame + this.kickFrames
          : v.spawnFrame + v.durFrames;
        if (blockEndFrame < endFrame) this.voices[w++] = v;
      }
      this.voices.length = w;
      if (this.voices.length > this.peakVoices) this.peakVoices = this.voices.length;

      // 8. emit the portion of this block past pre-roll, up to totalFrames
      let from = 0;
      if (blockStartFrame < this.preRollFrames()) from = this.preRollFrames() - blockStartFrame;
      if (from < bf) {
        const frames = Math.min(bf - from, this.totalFrames - this.frameWritten);
        if (frames > 0) {
          sink.writeBlock(this.outL.subarray(from, from + frames), this.outR.subarray(from, from + frames), frames);
          this.frameWritten += frames;
          // round2: cooperative backpressure — suspend until the consumer
          // drained, so pipe-fed encoders never lose or queue unbounded PCM.
          const pending = sink.drain?.();
          if (pending) await pending;
        }
      }
      blockIdx++;
      if (blockIdx > blocksTotal + 1) throw new Error("[D5] block loop failed to terminate — logic error");
    }

    let droneCount = 0;
    for (const d of this.drones) if (d.started) droneCount++;
    return {
      framesWritten: this.frameWritten,
      peakConcurrentVoices: this.peakVoices,
      skippedSampleEvents: this.skippedSamples,
      droneLayersStarted: droneCount,
      blocks: blockIdx,
    };
  }

  private preRollFrames(): number { return Math.ceil(this.timeline.preRollSec * this.sr); }
}
