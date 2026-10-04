/**
 * bench/A/kernel_bench.ts — A1/A2/A3 kernel throughput.
 *
 * Measures the REAL kernel (frontend/src/lib/ambient-engine/musicalLogic.ts,
 * imported unmodified) exactly the way the synthesis shells drive it:
 *   createInitialState → advanceRngPastNoiseBuffer → initializeBell →
 *   initializeSampleLane → getMusicalEvents per beat (state threaded via
 *   nextState; wall-clock beat advance mirrors renderAmbient.ts:318-404).
 *
 * Prints ONE JSON measurement object to stdout; bench/A/run_A.mjs wraps it
 * into the shared result schema.
 */
import {
  getMusicalEvents,
  getEffectiveSceneParams,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  type EngineParams,
  type EngineState,
} from "../../kernel/musicalLogic";

// Ported defaults: frontend/src/store/studioStore.ts:214 (initial generator
// state) + useProceduralEngine.ts:13 (DEFAULT_ROOT_HZ). Named here so the
// benchmark's params are visible in the result file.
const REPO_DEFAULT_PARAMS = {
  scale: "majorPent",
  rootHz: 220,
  bpm: 72,
  complexity: 0.35,
  mix: 0.4,
  sceneDurationBars: 32,
  enableScenes: true,
  enableHarmonicLoop: true,
  enableBeats: true,
  seed: 42,
  drumLevel: 0.5,
  swing: 0,
  drumStyle: "euclideanTrap" as const,
  sidechainAmount: 0,
};

const WARMUP_CALLS = Number(process.env.BENCH_A_WARMUP_CALLS ?? 100);
const BUCKETS = Number(process.env.BENCH_A_BUCKETS ?? 48);
const A2_HORIZON_BEATS = Number(process.env.BENCH_A2_HORIZON_BEATS ?? 2000);
const A2_DRONE_COUNTS = [0, 4, 8];
const A2_SAMPLE_BANK_SIZES = [0, 16];
const SAMPLE_ENTRY = (i: number) => ({ id: `bench-sample-${i}`, url: `file:///bench-nonexistent-${i}.wav`, gain: 0.25, pan: 0 });
const HORIZON_HOURS = Number(process.env.BENCH_A_HOURS ?? 8);

function initEngine(params: EngineParams): EngineState {
  let state = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, params);
  return state;
}

/** Drive the kernel for `horizonSec`, mirroring renderAmbient's beat loop. */
function runSequence(params: EngineParams, horizonSec: number, collect: boolean) {
  const timings: number[] = [];
  const isTransition: boolean[] = [];
  const eventCounts: number[] = [];
  let state = initEngine(params);
  let simTime = 0;
  let calls = 0;
  let events = 0;
  const eventsByType: Record<string, number> = {};

  while (simTime < horizonSec) {
    const preBeat = getEffectiveSceneParams(state, params);
    const beatSec = 60 / preBeat.bpm;
    const sceneStartBeatBefore = state.sceneStartBeat;
    const sceneIndexBefore = state.currentSceneIndex;

    const t0 = performance.now();
    const { events: evts, nextState } = getMusicalEvents(state.beat, state, params);
    const dt = performance.now() - t0;

    state = nextState;
    if (collect) {
      timings.push(dt);
      eventCounts.push(evts.length);
      isTransition.push(
        state.sceneStartBeat !== sceneStartBeatBefore || state.currentSceneIndex !== sceneIndexBefore,
      );
    }
    for (const e of evts) {
      events++;
      eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
    }
    calls++;
    simTime += beatSec;
  }
  return { timings, isTransition, eventCounts, calls, events, eventsByType };
}

function pct(values: number[], p: number): number {
  if (!values.length) return null as unknown as number;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, median: pct(values, 0.5), p95: pct(values, 0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

function peakRssBytes(): number {
  try {
    const ru = (process as NodeJS.Process & { resourceUsage?: () => { maxRSS: number } }).resourceUsage?.();
    if (ru?.maxRSS) return ru.maxRSS * 1024; // Node docs: kilobytes (per getrusage convention)
  } catch { /* fall through */ }
  return process.memoryUsage().rss;
}

function modeA1() {
  const params: EngineParams = { ...REPO_DEFAULT_PARAMS };
  const horizonSec = HORIZON_HOURS * 3600;
  // Warm-up (JIT) — discarded from stats, counted in nothing.
  runSequence(params, 30, false);
  const t0 = performance.now();
  const seq = runSequence(params, horizonSec, true);
  const wallSec = (performance.now() - t0) / 1000;

  const timings = seq.timings.slice(WARMUP_CALLS);
  const stats = summarize(timings);
  // Bucket by call fraction (≈ beat index) so cost-over-time is visible.
  const bucketMedians: Array<number | null> = [];
  for (let b = 0; b < BUCKETS; b++) {
    const lo = Math.floor((b / BUCKETS) * timings.length);
    const hi = Math.floor(((b + 1) / BUCKETS) * timings.length);
    bucketMedians.push(hi > lo ? pct(timings.slice(lo, hi), 0.5) : null);
  }
  const transitionSamples = seq.timings.filter((_, i) => seq.isTransition[i]);
  const transitionStats = summarize(transitionSamples);
  const q = Math.floor(timings.length / 4);
  const q1 = summarize(timings.slice(0, q));
  const q4 = summarize(timings.slice(3 * q));

  return {
    mode: "A1",
    horizon_hours: HORIZON_HOURS,
    warmup_calls_discarded: WARMUP_CALLS,
    calls: seq.calls,
    events_total: seq.events,
    events_by_type: seq.eventsByType,
    per_call_ms: stats,
    first_quarter: q1,
    last_quarter: q4,
    last_vs_first_quarter_median_ratio: q1?.median ? (q4.median ?? 0) / q1.median : null,
    bucket_medians_ms: bucketMedians,
    scene_transition_call_ms: transitionStats,
    scene_transition_calls: transitionSamples.length,
    non_transition_calls: timings.length - transitionSamples.length,
    wall_sec: wallSec,
    peak_rss_bytes: peakRssBytes(),
  };
}

function modeA2() {
  const configs: Array<Record<string, unknown>> = [];
  for (const drones of A2_DRONE_COUNTS) {
    for (const bank of A2_SAMPLE_BANK_SIZES) {
      const layers = Array.from({ length: drones }, (_, i) => ({
        hz: 55 + i * 8,
        amp: 0.15,
        pan: -1 + (2 * i) / Math.max(1, drones - 1 || 1),
        timbre: "sine" as const,
      }));
      const params: EngineParams = {
        ...REPO_DEFAULT_PARAMS,
        drone: drones > 0 ? { layers } : undefined,
        sampleBank: bank > 0 ? Array.from({ length: bank }, (_, i) => SAMPLE_ENTRY(i)) : undefined,
      };
      runSequence(params, 30, false); // warm-up per config
      const seq = runSequence(params, (A2_HORIZON_BEATS * 60) / 72, true);
      const timings = seq.timings.slice(WARMUP_CALLS);
      configs.push({
        drone_layers: drones,
        sample_bank_entries: bank,
        horizon_beats: A2_HORIZON_BEATS,
        stats: summarize(timings),
        events_per_beat_median: summarize(seq.eventCounts)?.median ?? null,
      });
    }
  }
  return { mode: "A2", horizon_beats: A2_HORIZON_BEATS, configs };
}

function modeA3() {
  const params: EngineParams = { ...REPO_DEFAULT_PARAMS };
  const horizonSec = HORIZON_HOURS * 3600;
  const t0 = performance.now();
  const seq = runSequence(params, horizonSec, false); // no per-call timing overhead
  const wallSec = (performance.now() - t0) / 1000;
  const initStart = performance.now();
  initEngine(params);
  const initMs = performance.now() - initStart;
  return {
    mode: "A3",
    horizon_hours: HORIZON_HOURS,
    beats: seq.calls,
    events_total: seq.events,
    events_by_type: seq.eventsByType,
    wall_sec: wallSec,
    wall_per_call_us: (wallSec * 1e6) / seq.calls,
    init_chain_ms: initMs,
    peak_rss_bytes: peakRssBytes(),
    rss_note: "resourceUsage().maxRSS (KB per Node docs) where available, else memoryUsage().rss",
  };
}

const mode = process.argv[2] ?? "A1";
let out: unknown;
if (mode === "A1") out = modeA1();
else if (mode === "A2") out = modeA2();
else if (mode === "A3") out = modeA3();
else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
process.stdout.write("__BENCH_JSON__" + JSON.stringify(out));
