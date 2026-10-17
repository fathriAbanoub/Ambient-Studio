import { describe, it, expect } from "vitest";
import {
  laneRateControl,
  laneRatePerSec,
  shiftedExponentialGapBeats,
  laneControlSeed,
  mulberry32Next,
  maybeBellEvent,
  maybeSampleEvent,
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  getEffectiveSceneParams,
  SAMPLE_TRIGGER_PROBABILITY,
  SAMPLE_MIN_GAP_BEATS,
  SAMPLE_JITTER_BEATS,
  LANE_GAP_FLOOR_SEC,
  LANE_RATE_PER_SEC,
  LANE_MIN_GAP_BEATS,
  RATE_SWING_OCTAVES,
  CONTROL_BASE_PERIOD_BEATS,
  LANE_CONTROL_SEED_SALT,
  GAP_UNIFORM_CAP,
  type EngineParams,
  type MusicalEvent,
} from "./musicalLogic";

// Pure-math checks for the stochastic sparse-event lane helpers. Every
// expectation is derived HERE from the published formulas (constants +
// closed forms), never by calling the helper under test twice and comparing.
// These helpers are not wired into getMusicalEvents yet, so the
// backward-compatibility literals in space.test.ts / harmony.test.ts /
// melody.test.ts exercise nothing on this path and must pass unchanged.

// Float headroom for time comparisons: the quotient gapSec/beatSec rounds
// before ceil, so a realized gap can sit one ulp under the exact bound.
// 1e-9 s is far above ulp(4 s) ≈ 9e-16 and far below any musical time.
const GAP_FLOOR_TOLERANCE_SEC = 1e-9;

// Mean-gap tolerance at 72 bpm: the closed form at LANE_RATE_PER_SEC gives
// 12.0042 beats, and the stratified-grid estimate lands within 1e-4 of it.
// 0.05 beats leaves a >100x margin while still catching a mis-calibration
// (the mean moves ~3.8 beats per 0.001 of rate near the solution).
const CALIBRATION_TOLERANCE_BEATS = 0.05;

// The control signal is a normalized sum of sinusoids, so its standard
// deviation over a long sweep is sqrt(Σ a_k²/2)/Σ a_k ≈ 0.352; the floor
// only has to separate a living signal from a degenerate flat one.
const CONTROL_STD_FLOOR = 0.15;

// If c were periodic with the base period, c(b + P) - c(b) would be 0 for
// every beat (the jitters make the component periods incommensurate, so the
// observed difference is O(amplitude) — measured ≥ 0.84 over the sweep for
// the seeds below). The floor catches an accidental period lock.
const NOT_PERIODIC_MIN_DIFF = 0.25;

// Long sweep for the boundedness/movement checks: 0..20000 covers ~208
// cycles of the slowest component at the base period.
const CONTROL_SWEEP_BEATS = 20000;

const CONTROL_SEEDS = [0, 42, 7, 99] as const;

/** Stratified midpoint grid over [0, 1): no RNG, deterministic coverage. */
function stratifiedGrid(n: number): number[] {
  return Array.from({ length: n }, (_v, i) => (i + 0.5) / n);
}

describe("stochastic lane gap: refractory floor and beat bound", () => {
  // Ambient scene-pack tempos plus slow/fast extremes; 240 bpm makes
  // beatSec (0.25 s) much shorter than the 4 s floor, 30 bpm the opposite.
  const BPM_GRID = [30, 62, 68, 72, 120, 240];

  // Dense deterministic grid plus the exact boundary cases: u = 0 (gap must
  // equal the floor before discretisation) and u at the log cap.
  const uniforms = [
    ...stratifiedGrid(2048),
    0,
    GAP_UNIFORM_CAP,
    1 - 2 ** -32, // the largest value mulberry32 can actually return
  ];

  it("keeps every realised gap at or above the refractory floor in seconds", () => {
    for (const bpm of BPM_GRID) {
      const beatSec = 60 / bpm;
      for (const u of uniforms) {
        const gap = shiftedExponentialGapBeats(
          u,
          laneRatePerSec(0),
          beatSec,
        );
        expect(
          gap * beatSec,
          `bpm ${bpm}, u ${u}: realized gap seconds`,
        ).toBeGreaterThanOrEqual(LANE_GAP_FLOOR_SEC - GAP_FLOOR_TOLERANCE_SEC);
      }
    }
  });

  it("keeps every gap at or above one beat", () => {
    for (const bpm of BPM_GRID) {
      const beatSec = 60 / bpm;
      for (const u of uniforms) {
        expect(
          shiftedExponentialGapBeats(u, laneRatePerSec(0), beatSec),
        ).toBeGreaterThanOrEqual(LANE_MIN_GAP_BEATS);
      }
    }
  });

  it("maps u = 0 to exactly the refractory floor before discretisation", () => {
    // At u = 0 the exponential part vanishes, so ceil(T_MIN / beatSec) is
    // the whole answer — verify it beat-by-beat against the formula.
    for (const bpm of BPM_GRID) {
      const beatSec = 60 / bpm;
      const expected = Math.max(
        LANE_MIN_GAP_BEATS,
        Math.ceil(LANE_GAP_FLOOR_SEC / beatSec),
      );
      expect(shiftedExponentialGapBeats(0, LANE_RATE_PER_SEC, beatSec)).toBe(
        expected,
      );
    }
  });

  it("stays finite at the log cap and the largest real mulberry32 draw", () => {
    for (const u of [GAP_UNIFORM_CAP, 1 - 2 ** -32]) {
      const gap = shiftedExponentialGapBeats(u, LANE_RATE_PER_SEC, 60 / 72);
      expect(Number.isFinite(gap)).toBe(true);
    }
  });
});

describe("stochastic lane gap: 72 bpm calibration", () => {
  const BPM = 72;
  const beatSec = 60 / BPM;
  // Stratified grid: each stratum contributes one midpoint, so the mean of
  // any monotone function of u converges with O(1/N) error and no RNG.
  const N = 4096;

  // Closed-form mean of ceil(Y / beatSec) for Y = T_MIN + Exp(rate),
  // derived from E[ceil(Y/b)] = Σ_{k≥0} P(Y > k·b) = n0 + exp(-r·d)/(1 -
  // exp(-r·b)) with n0 = ceil(T_MIN/b) and d = n0·b − T_MIN. Computed here
  // from the exported constants, not copied from the helper.
  const rate = laneRatePerSec(0);
  const n0 = Math.ceil(LANE_GAP_FLOOR_SEC / beatSec);
  const d = n0 * beatSec - LANE_GAP_FLOOR_SEC;
  const closedFormMean =
    n0 + Math.exp(-rate * d) / (1 - Math.exp(-rate * beatSec));

  it("uses the rate value the calibration solves for", () => {
    // laneRatePerSec(0) must be the bare constant (2^0 = 1).
    expect(laneRatePerSec(0)).toBe(LANE_RATE_PER_SEC);
  });

  it("matches the closed-form discretised mean and the legacy 12 beats", () => {
    let sum = 0;
    for (const u of stratifiedGrid(N)) {
      sum += shiftedExponentialGapBeats(u, rate, beatSec);
    }
    const mean = sum / N;
    expect(mean).toBeCloseTo(closedFormMean, 3);
    expect(Math.abs(mean - 12)).toBeLessThan(CALIBRATION_TOLERANCE_BEATS);
  });

  it("shows the legacy uniform lane means 12 beats on the same grid", () => {
    // Legacy bell/sample gap: 8 + floor(u * 9), u uniform. Integer
    // arithmetic on a shared grid, so the comparison is exact.
    let sum = 0;
    for (const u of stratifiedGrid(N)) sum += 8 + Math.floor(u * 9);
    expect(sum / N).toBe(12);
  });
});

describe("stochastic lane rate scaling", () => {
  it("spans exactly 2^(2*RATE_SWING_OCTAVES) between c = -1 and c = +1", () => {
    // Both rates share the mantissa of LANE_RATE_PER_SEC (powers of two are
    // exponent-only scaling), so the ratio is exact, not approximate.
    const ratio = laneRatePerSec(1) / laneRatePerSec(-1);
    expect(ratio).toBe(Math.pow(2, 2 * RATE_SWING_OCTAVES));
  });

  it("keeps the rate positive and the c = 0 rate calibrated", () => {
    expect(laneRatePerSec(-1)).toBeGreaterThan(0);
    expect(laneRatePerSec(1)).toBeGreaterThan(laneRatePerSec(0));
    expect(laneRatePerSec(0.5)).toBeGreaterThan(LANE_RATE_PER_SEC);
    expect(laneRatePerSec(-0.5)).toBeLessThan(LANE_RATE_PER_SEC);
  });
});

describe("stochastic lane control signal", () => {
  function sweep(seed: number): number[] {
    const out: number[] = [];
    for (let beat = 0; beat <= CONTROL_SWEEP_BEATS; beat++) {
      out.push(laneRateControl(seed, beat));
    }
    return out;
  }

  it("stays within [-1, 1] over a long sweep for several seeds", () => {
    for (const seed of CONTROL_SEEDS) {
      for (const c of sweep(seed)) {
        expect(Math.abs(c)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic per seed", () => {
    for (const seed of CONTROL_SEEDS) {
      expect(laneRateControl(seed, 12345)).toBe(laneRateControl(seed, 12345));
      const s = sweep(seed);
      expect(s[777]).toBe(laneRateControl(seed, 777));
    }
  });

  it("differs across seeds", () => {
    for (let i = 0; i < CONTROL_SEEDS.length; i++) {
      for (let j = i + 1; j < CONTROL_SEEDS.length; j++) {
        for (const beat of [777, 5000, 15000]) {
          expect(
            laneRateControl(CONTROL_SEEDS[i], beat),
            `seeds ${CONTROL_SEEDS[i]} vs ${CONTROL_SEEDS[j]} at beat ${beat}`,
          ).not.toBe(laneRateControl(CONTROL_SEEDS[j], beat));
        }
      }
    }
  });

  it("actually moves over the sweep (standard deviation above the floor)", () => {
    for (const seed of CONTROL_SEEDS) {
      const values = sweep(seed);
      const mean = values.reduce((a, v) => a + v, 0) / values.length;
      const variance =
        values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
      expect(Math.sqrt(variance), `seed ${seed} std`).toBeGreaterThan(
        CONTROL_STD_FLOOR,
      );
    }
  });

  it("is not periodic with the base period", () => {
    // Check named in NOT_PERIODIC_MIN_DIFF: max |c(b + P) − c(b)| over the
    // sweep must stay well above zero — a signal periodic with
    // CONTROL_BASE_PERIOD_BEATS would make every term exactly 0.
    for (const seed of CONTROL_SEEDS) {
      let maxDiff = 0;
      for (let beat = 0; beat + CONTROL_BASE_PERIOD_BEATS <= CONTROL_SWEEP_BEATS; beat++) {
        maxDiff = Math.max(
          maxDiff,
          Math.abs(
            laneRateControl(seed, beat + CONTROL_BASE_PERIOD_BEATS) -
              laneRateControl(seed, beat),
          ),
        );
      }
      expect(maxDiff, `seed ${seed} period-${CONTROL_BASE_PERIOD_BEATS} diff`)
        .toBeGreaterThan(NOT_PERIODIC_MIN_DIFF);
    }
  });
});

describe("stochastic lane control stream derivation", () => {
  // Same style as the noise-bed stream test in space.test.ts: the salted
  // stream must split from the main stream for every seed, including 0.
  it("XORs the published salt and never collides with the main stream", () => {
    for (const seed of CONTROL_SEEDS) {
      expect(laneControlSeed(seed)).toBe((seed ^ LANE_CONTROL_SEED_SALT) >>> 0);
      const saltedFirst = mulberry32Next({ rngState: laneControlSeed(seed) });
      const mainFirst = mulberry32Next({ rngState: seed });
      expect(saltedFirst).not.toBe(mainFirst);
    }
    // Seed 0 must not collapse onto the main stream's seed 0.
    expect(laneControlSeed(0)).not.toBe(0);
  });
});

// ── Wiring (enableStochasticEvents) ─────────────────────────────────────────
//
// The lanes consume the SAME draws in the SAME slots with the flag on — only
// the gap VALUE maps through the stochastic rule. The proofs below run the
// lane functions directly with a counting wrapper over a shared seed, so
// both modes see an identical uniform sequence.

// Long-run stream constants. Expected bell count at 72 bpm, scenes off:
// 4096 beats / 12-beat mean gap ≈ 341; the discretised shifted-exponential
// has sd(count) ≈ sqrt(341)·(σ_gap/mean) ≈ 10, so ±40 is roughly 4σ.
// sd of the mean of ~341 gaps ≈ 0.37 beats, so ±1.5 is roughly 4σ. (Both
// cross-checked against a measured run: counts 328–345, means 11.85–12.49.)
const STREAM_BEATS = 4096;
const STREAM_COUNT_TOLERANCE = 40;
const STREAM_MEAN_TOLERANCE_BEATS = 1.5;

// Clustering check: coefficient of variation of 128-beat window counts,
// stochastic vs legacy on the same seed. Measured ratios 2.16–2.63 across
// the stream seeds (the legacy uniform gap is nearly metronomic by
// comparison); 1.5 leaves margin while still requiring real clustering.
const DENSITY_WINDOW_BEATS = 128;
const DENSITY_CV_RATIO_MIN = 1.5;

// Sample-lane effective-rate check: mean re-arm 10 s over the 0.35 trigger
// gives ≈ 28.6 s between emitted samples; the measured flag-on means land
// within ~3.5 s of that, so ±6 s is a wide but meaningful band.
const SAMPLE_MEAN_TOLERANCE_SEC = 6;

// Absolute-time accumulation over 4096 beats drifts a few nanoseconds in
// doubles; 1e-6 s is orders above that and far below any musical time.
const TIME_ACCUMULATION_TOLERANCE_SEC = 1e-6;

const STREAM_SEEDS = [42, 7, 99] as const;

const STREAM_BASE_PARAMS: EngineParams = {
  scale: "majorPent",
  rootHz: 220,
  bpm: 72,
  complexity: 0.35,
  mix: 0.4,
  enableScenes: false,
  enableHarmonicLoop: false,
  drumLevel: 0.5,
};

/** A mulberry32 wrapper that records every draw (draw-count proof). */
function makeCountingRng(seed: number) {
  const state = { rngState: seed >>> 0 };
  const draws: number[] = [];
  const rng = () => {
    const v = mulberry32Next(state);
    draws.push(v);
    return v;
  };
  return { rng, draws, state };
}

/** Fully initialized state with the bell lane parked on its due beat. */
function bellDueState(seed: number, params: EngineParams) {
  let state = createInitialState({ ...params, seed });
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  return { ...state, beat: state.nextBellBeat };
}

/** Fully initialized state with both sparse lanes, sample lane due. */
function sampleDueState(seed: number, params: EngineParams) {
  let state = createInitialState({ ...params, seed });
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, params);
  return { ...state, beat: state.nextSampleBeat };
}

function laneGapBeats(beatIndices: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < beatIndices.length; i++) {
    gaps.push(beatIndices[i] - beatIndices[i - 1]);
  }
  return gaps;
}

function windowCounts(beatIndices: number[], beats: number): number[] {
  const counts = new Array(Math.floor(beats / DENSITY_WINDOW_BEATS)).fill(0);
  for (const b of beatIndices) counts[Math.floor(b / DENSITY_WINDOW_BEATS)]++;
  return counts;
}

function cvOf(xs: number[]): number {
  const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
  const sd = Math.sqrt(
    xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length,
  );
  return sd / mean;
}

interface StreamRun {
  bells: number[];
  samples: number[];
  all: MusicalEvent[];
  finalRngState: number;
}

function runStream(params: EngineParams, beats: number): StreamRun {
  let state = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, params);
  const bells: number[] = [];
  const samples: number[] = [];
  const all: MusicalEvent[] = [];
  for (let i = 0; i < beats; i++) {
    const { events, nextState } = getMusicalEvents(i, { ...state }, params);
    for (const e of events) {
      if (e.type === "bell") bells.push(e.beatIndex);
      if (e.type === "sample") samples.push(e.beatIndex);
    }
    all.push(...events);
    state = nextState;
  }
  return { bells, samples, all, finalRngState: state.rngState >>> 0 };
}

describe("stochastic lanes: draw-schedule proof at lane level", () => {
  const PROOF_SEEDS = [42, 7, 99, 0, 5] as const;
  const beatSec = 60 / STREAM_BASE_PARAMS.bpm;

  it("bell lane consumes exactly 3 draws with the flag off and on", () => {
    for (const seed of PROOF_SEEDS) {
      const offParams = { ...STREAM_BASE_PARAMS, seed };
      const onParams = { ...offParams, enableStochasticEvents: true };
      const due = bellDueState(seed, STREAM_BASE_PARAMS);
      const stateOff = { ...due };
      const stateOn = { ...due };
      const offRng = makeCountingRng(seed);
      const onRng = makeCountingRng(seed);

      const offEvents = maybeBellEvent(stateOff, offParams, due.beat, offRng.rng);
      const onEvents = maybeBellEvent(stateOn, onParams, due.beat, onRng.rng);

      // Same uniforms consumed in the same slots; the wrapper state advanced
      // identically (mulberry32 steps a fixed odd constant per call).
      expect(offEvents, `seed ${seed} emits a bell`).toHaveLength(1);
      expect(onRng.draws).toEqual(offRng.draws);
      expect(onRng.state.rngState).toBe(offRng.state.rngState);
      // The event itself is unchanged (octave/degree draws map identically).
      expect(onEvents).toEqual(offEvents);
      // Flag-on gap = the stochastic rule applied to the SAME third draw.
      expect(stateOn.nextBellBeat - due.beat).toBe(
        shiftedExponentialGapBeats(
          offRng.draws[2],
          laneRatePerSec(laneRateControl(due.eventLaneSeed, due.beat)),
          beatSec,
        ),
      );
      // Flag-off gap = the legacy uniform formula of the same draw.
      expect(stateOff.nextBellBeat - due.beat).toBe(
        SAMPLE_MIN_GAP_BEATS + Math.floor(offRng.draws[2] * SAMPLE_JITTER_BEATS),
      );
    }
  });

  it("sample lane consumes identical draws for the same trigger outcome", () => {
    const bank = [{ id: "s1", url: "/samples/x.wav", gain: 0.4, pan: 0 }];
    for (const seed of PROOF_SEEDS) {
      const offParams = { ...STREAM_BASE_PARAMS, seed, sampleBank: bank };
      const onParams = { ...offParams, enableStochasticEvents: true };
      const due = sampleDueState(seed, offParams);
      const stateOff = { ...due };
      const stateOn = { ...due };
      const offRng = makeCountingRng(seed);
      const onRng = makeCountingRng(seed);

      const offEvents = maybeSampleEvent(stateOff, offParams, due.beat, offRng.rng);
      const onEvents = maybeSampleEvent(stateOn, onParams, due.beat, onRng.rng);

      expect(onRng.draws).toEqual(offRng.draws);
      expect(onRng.state.rngState).toBe(offRng.state.rngState);
      expect(onEvents).toEqual(offEvents);
      // The trigger gate holds in BOTH modes: emit iff the trigger draw passed.
      const emitted = offRng.draws[0] < SAMPLE_TRIGGER_PROBABILITY;
      expect(offEvents).toHaveLength(emitted ? 1 : 0);
      expect(onEvents).toHaveLength(emitted ? 1 : 0);
      // 3 draws on a hit (trigger, pick, gap), 2 on a miss (trigger, gap).
      expect(offRng.draws).toHaveLength(emitted ? 3 : 2);
      // Flag-on re-arm = the stochastic rule on the LAST draw of the lane.
      expect(stateOn.nextSampleBeat - due.beat).toBe(
        shiftedExponentialGapBeats(
          offRng.draws[offRng.draws.length - 1],
          laneRatePerSec(laneRateControl(due.eventLaneSeed, due.beat)),
          beatSec,
        ),
      );
    }
  });
});

describe("stochastic lanes: long-run stream (flag on)", () => {
  it("keeps every bell and sample separation at or above the floor (72 bpm, scenes off)", () => {
    const beatSec = 60 / STREAM_BASE_PARAMS.bpm;
    for (const seed of STREAM_SEEDS) {
      const params = { ...STREAM_BASE_PARAMS, seed, enableStochasticEvents: true };
      const { bells, samples } = runStream(params, STREAM_BEATS);
      for (const g of laneGapBeats(bells)) {
        expect(g * beatSec, `seed ${seed} bell gap`).toBeGreaterThanOrEqual(
          LANE_GAP_FLOOR_SEC - GAP_FLOOR_TOLERANCE_SEC,
        );
      }
      for (const g of laneGapBeats(samples)) {
        expect(g * beatSec, `seed ${seed} sample gap`).toBeGreaterThanOrEqual(
          LANE_GAP_FLOOR_SEC - GAP_FLOOR_TOLERANCE_SEC,
        );
      }
    }
  });

  it("keeps the floor with per-beat bpm from getEffectiveSceneParams (scenes on)", () => {
    for (const seed of STREAM_SEEDS) {
      const params = {
        ...STREAM_BASE_PARAMS,
        seed,
        enableStochasticEvents: true,
        enableScenes: true,
        sceneDurationBars: 32,
      };
      let state = createInitialState(params);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      state = initializeSampleLane(state, params);
      const timeAtBeat: number[] = [];
      const bells: number[] = [];
      const samples: number[] = [];
      let t = 0;
      for (let i = 0; i < STREAM_BEATS; i++) {
        // The pre-call state's effective bpm mirrors the interpolation
        // getMusicalEvents applies internally (A2/B2 agreement is pinned in
        // musicalLogic.test.ts).
        const eff = getEffectiveSceneParams(state, params);
        timeAtBeat.push(t);
        t += 60 / eff.bpm;
        const { events, nextState } = getMusicalEvents(i, { ...state }, params);
        for (const e of events) {
          if (e.type === "bell") bells.push(e.beatIndex);
          if (e.type === "sample") samples.push(e.beatIndex);
        }
        state = nextState;
      }
      for (const lane of [bells, samples]) {
        for (let i = 1; i < lane.length; i++) {
          const gapSec = timeAtBeat[lane[i]] - timeAtBeat[lane[i - 1]];
          expect(gapSec, `seed ${seed} realized gap`).toBeGreaterThanOrEqual(
            LANE_GAP_FLOOR_SEC - TIME_ACCUMULATION_TOLERANCE_SEC,
          );
        }
      }
    }
  });

  it("lands the calibrated mean gap and event count at 72 bpm (scenes off)", () => {
    const expectedCount = STREAM_BEATS / 12;
    for (const seed of STREAM_SEEDS) {
      const params = { ...STREAM_BASE_PARAMS, seed, enableStochasticEvents: true };
      const { bells } = runStream(params, STREAM_BEATS);
      expect(bells.length, `seed ${seed} bell count`).toBeGreaterThan(
        expectedCount - STREAM_COUNT_TOLERANCE,
      );
      expect(bells.length, `seed ${seed} bell count`).toBeLessThan(
        expectedCount + STREAM_COUNT_TOLERANCE,
      );
      const gaps = laneGapBeats(bells);
      const meanBeats = gaps.reduce((a, v) => a + v, 0) / gaps.length;
      expect(
        Math.abs(meanBeats - 12),
        `seed ${seed} mean gap ${meanBeats}`,
      ).toBeLessThan(STREAM_MEAN_TOLERANCE_BEATS);
    }
  });

  it("varies density over time more than the legacy lane", () => {
    // Named check: cv = sd/mean of the per-window (128-beat) bell counts.
    // Threshold: the stochastic/legacy ratio must exceed
    // DENSITY_CV_RATIO_MIN — clustering and starving must show up in the
    // window histogram, not only in the gap distribution.
    for (const seed of STREAM_SEEDS) {
      const off = runStream({ ...STREAM_BASE_PARAMS, seed }, STREAM_BEATS);
      const on = runStream(
        { ...STREAM_BASE_PARAMS, seed, enableStochasticEvents: true },
        STREAM_BEATS,
      );
      const cvOff = cvOf(windowCounts(off.bells, STREAM_BEATS));
      const cvOn = cvOf(windowCounts(on.bells, STREAM_BEATS));
      expect(cvOn / cvOff, `seed ${seed} window-cv ratio`).toBeGreaterThan(
        DENSITY_CV_RATIO_MIN,
      );
    }
  });

  it("is deterministic across runs", () => {
    const params = { ...STREAM_BASE_PARAMS, seed: 42, enableStochasticEvents: true };
    const a = runStream(params, STREAM_BEATS);
    const b = runStream(params, STREAM_BEATS);
    expect(b.bells).toEqual(a.bells);
    expect(b.samples).toEqual(a.samples);
    expect(b.finalRngState).toBe(a.finalRngState);
  });

  it("keeps flag absent and flag false on the legacy stream", () => {
    // The pre-phase stream itself is pinned by the integer + rounded-hash
    // literals in space.test.ts / harmony.test.ts / melody.test.ts, which
    // run the flag-off path unchanged; here the two spellings must agree
    // with each other over the long run.
    for (const seed of STREAM_SEEDS) {
      const absent = runStream({ ...STREAM_BASE_PARAMS, seed }, STREAM_BEATS);
      const off = runStream(
        { ...STREAM_BASE_PARAMS, seed, enableStochasticEvents: false },
        STREAM_BEATS,
      );
      expect(off.all, `seed ${seed} events`).toEqual(absent.all);
      expect(off.finalRngState, `seed ${seed} final rngState`).toBe(
        absent.finalRngState,
      );
    }
  });

  it("preserves the sample lane's effective rate with a configured bank", () => {
    const bank = [
      { id: "s1", url: "/samples/x.wav" },
      { id: "s2", url: "/samples/y.wav", gain: 0.5 },
    ];
    const beatSec = 60 / STREAM_BASE_PARAMS.bpm;
    const params = {
      ...STREAM_BASE_PARAMS,
      seed: 42,
      enableStochasticEvents: true,
      sampleBank: bank,
    };
    const { samples, all } = runStream(params, STREAM_BEATS);
    expect(samples.length).toBeGreaterThan(0);
    for (const e of all) {
      if (e.type === "sample") {
        expect(bank.some((b) => b.id === e.sampleId)).toBe(true);
      }
    }
    // Mean re-arm 10 s over the 0.35 trigger ≈ 28.6 s between emissions.
    const gapsSec = laneGapBeats(samples).map((g) => g * beatSec);
    const meanSec = gapsSec.reduce((a, v) => a + v, 0) / gapsSec.length;
    expect(Math.abs(meanSec - 10 / SAMPLE_TRIGGER_PROBABILITY)).toBeLessThan(
      SAMPLE_MEAN_TOLERANCE_SEC,
    );
  });
});
