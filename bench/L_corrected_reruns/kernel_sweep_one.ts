/**
 * kernel_sweep_one.ts — ONE A2-style kernel config per process (the L1
 * corrected-re-run entry). Mirrors kernel_bench.ts's runSequence exactly
 * (same init chain, same beat loop, same warm-up discard) but takes the
 * config from argv so run_L.mjs can spawn each configuration in isolation —
 * the JIT-contamination fix for the A2 sweep.
 */
import {
  getMusicalEvents,
  getEffectiveSceneParams,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  type EngineParams,
} from "../../kernel/musicalLogic";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const REPO_DEFAULT_PARAMS = {
  scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true,
  enableBeats: true, seed: 42, drumLevel: 0.5, swing: 0,
  drumStyle: "euclideanTrap" as const, sidechainAmount: 0,
};

const drones = Number(arg("--drones") ?? 0);
const bank = Number(arg("--bank") ?? 0);
const beats = Number(arg("--beats") ?? 2000);
const WARMUP_CALLS = Number(process.env.BENCH_A_WARMUP_CALLS ?? 100);

const layers = Array.from({ length: drones }, (_, i) => ({
  hz: 55 + i * 8, amp: 0.15,
  pan: -1 + (2 * i) / Math.max(1, drones - 1 || 1),
  timbre: "sine" as const,
}));
const params: EngineParams = {
  ...REPO_DEFAULT_PARAMS,
  drone: drones > 0 ? { layers } : undefined,
  sampleBank: bank > 0
    ? Array.from({ length: bank }, (_, i) => ({ id: `bench-sample-${i}`, url: `file:///bench-nonexistent-${i}.wav`, gain: 0.25, pan: 0 }))
    : undefined,
};

function initEngine(p: EngineParams) {
  let state = createInitialState(p);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, p);
  return state;
}

function runSequence(p: EngineParams, horizonBeats: number, collect: boolean) {
  const timings: number[] = [];
  const eventCounts: number[] = [];
  let state = initEngine(p);
  let done = 0;
  let events = 0;
  const batchWallStart = performance.now(); // batched throughput — timing-overhead-free
  while (done < horizonBeats) {
    const preBeat = getEffectiveSceneParams(state, p);
    const beatSec = 60 / preBeat.bpm;
    const t0 = performance.now();
    const { events: evts, nextState } = getMusicalEvents(state.beat, state, p);
    const dt = performance.now() - t0;
    state = nextState;
    if (collect) { timings.push(dt); eventCounts.push(evts.length); }
    events += evts.length;
    done++;
    void beatSec;
  }
  const batchWallSec = (performance.now() - batchWallStart) / 1000;
  return { timings, eventCounts, calls: done, events, batchWallSec };
}

function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// warm-up (discarded) then measured horizon — same shape as kernel_bench A2
runSequence(params, 30 * (72 / 60) / 1, false); // 36 warm-up calls
const seq = runSequence(params, beats, true);
const timings = seq.timings.slice(WARMUP_CALLS);
// Batched mean over the same horizon (A3-style single wall clock): per-call
// timers cost ~100–200 ns each — comparable to the measured 2–3 µs medians —
// so ORDER-SENSITIVITY is judged on the batched mean, while the per-call
// median/p95 are kept for shape-comparability with A2.
const batchedMeanUs = (seq.batchWallSec * 1e6) / beats;
const sorted = [...timings].sort((a, b) => a - b);
process.stdout.write("__BENCH_JSON__" + JSON.stringify({
  drones, bank,
  horizon_beats: beats,
  measured_calls: timings.length,
  events_total: seq.events,
  events_per_beat_median: pct(seq.eventCounts, 0.5),
  median_ms: pct(timings, 0.5),
  p95_ms: pct(timings, 0.95),
  min_ms: sorted[0],
  max_ms: sorted[sorted.length - 1],
  batched_mean_us_per_call: batchedMeanUs,
  warmup_calls_discarded: WARMUP_CALLS,
}));
