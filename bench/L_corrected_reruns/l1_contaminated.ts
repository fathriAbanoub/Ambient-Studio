/**
 * l1_contaminated.ts — deliberate reproduction of the ORIGINAL A2 execution
 * pattern (all 6 configs sequential in ONE process, per-config warm-up only),
 * with the config order controllable via argv. This is the "before" picture
 * for L1: if execution order flips the numbers, the old sweep's ordering is
 * contamination, not signal.
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

const REPO_DEFAULT_PARAMS = {
  scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true,
  enableBeats: true, seed: 42, drumLevel: 0.5, swing: 0,
  drumStyle: "euclideanTrap" as const, sidechainAmount: 0,
};

const order = (process.argv[2] ?? "asc") as "asc" | "desc";
const beats = Number(process.argv[3] ?? 2000);
const WARMUP_CALLS = Number(process.env.BENCH_A_WARMUP_CALLS ?? 100);

const CONFIGS = [
  { drones: 0, bank: 0 }, { drones: 0, bank: 16 },
  { drones: 4, bank: 0 }, { drones: 4, bank: 16 },
  { drones: 8, bank: 0 }, { drones: 8, bank: 16 },
];
const ordered = order === "asc" ? CONFIGS : [...CONFIGS].reverse();

function initEngine(p: EngineParams) {
  let state = createInitialState(p);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, p);
  return state;
}

function runSequence(p: EngineParams, horizonBeats: number, collect: boolean) {
  const timings: number[] = [];
  let state = initEngine(p);
  let done = 0;
  const batchWallStart = performance.now();
  while (done < horizonBeats) {
    const preBeat = getEffectiveSceneParams(state, p);
    const beatSec = 60 / preBeat.bpm;
    const t0 = performance.now();
    const { events: evts, nextState } = getMusicalEvents(state.beat, state, p);
    const dt = performance.now() - t0;
    state = nextState;
    if (collect) timings.push(dt);
    done++;
    void beatSec;
  }
  const batchWallSec = (performance.now() - batchWallStart) / 1000;
  return { timings, done, batchWallSec };
}

function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const configs = [];
for (const cfg of ordered) {
  const layers = Array.from({ length: cfg.drones }, (_, i) => ({
    hz: 55 + i * 8, amp: 0.15,
    pan: -1 + (2 * i) / Math.max(1, cfg.drones - 1 || 1),
    timbre: "sine" as const,
  }));
  const params: EngineParams = {
    ...REPO_DEFAULT_PARAMS,
    drone: cfg.drones > 0 ? { layers } : undefined,
    sampleBank: cfg.bank > 0
      ? Array.from({ length: cfg.bank }, (_, i) => ({ id: `s${i}`, url: `file:///bench-nonexistent-${i}.wav`, gain: 0.25, pan: 0 }))
      : undefined,
  };
  runSequence(params, 30 * (72 / 60), false); // per-config warm-up — the original pattern
  const seq = runSequence(params, beats, true);
  const timings = seq.timings.slice(WARMUP_CALLS);
  // Batched mean (A3-style single wall clock over the measured horizon) —
  // per-call timers cost ~100–200 ns vs 2–3 µs medians, so order sensitivity
  // is judged on this, with per-call medians kept for A2 comparability.
  const batchedMeanUs = (seq.batchWallSec * 1e6) / beats;
  configs.push({
    drone_layers: cfg.drones, sample_bank_entries: cfg.bank,
    median_ms: pct(timings, 0.5), p95_ms: pct(timings, 0.95),
    batched_mean_us_per_call: batchedMeanUs,
    measured_calls: timings.length,
  });
}
process.stdout.write("__BENCH_JSON__" + JSON.stringify({ order, horizon_beats: beats, configs }));
