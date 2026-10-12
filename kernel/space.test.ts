import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  mulberry32Next,
  type EngineParams,
  type MusicalEvent,
} from "./musicalLogic";
import {
  REVERB_COMB_DELAY_SAMPLES,
  REVERB_COMB_FEEDBACK,
  REVERB_RT60_TARGET_SEC,
  SPACE_REFERENCE_SAMPLE_RATE,
  MEDIUM_NOISE_BUFFER_SAMPLES,
  MEDIUM_NOISE_SEED_SALT,
  generateMediumNoiseTable,
  mediumNoiseSeed,
  resolveReverbLevel,
} from "./space";

// Phase 1 Space guards: reverbLevel is a shell-only param (zero RNG draws,
// stream unchanged), the medium noise table is deterministic and salted away
// from the main kernel stream, and the derived comb feedback actually hits
// the RT60 target.
//
// The backward-compatibility literals below were captured from the UNMODIFIED
// pre-Space code (commit 19e4282), 256 beats, full default path (scenes +
// harmonic loop on). Event count and final rngState are integers and portable
// as-is. The stream hash is computed over events whose non-integer numbers are
// rounded to EVENT_FLOAT_DIGITS decimals, because the last float digits depend
// on the machine's math library (the unrounded hash differed between two
// environments while the integers matched).
// ponytail: rounding to 6 digits assumes cross-machine float drift stays below
// 5e-7; if a machine ever disagrees, coarsen EVENT_FLOAT_DIGITS or rely on
// count + rngState + the flag-on == flag-off test only.

const EVENT_FLOAT_DIGITS = 6;

describe("Phase 1 Space: reverbLevel is a shell-only param", () => {
  const LEGACY: Record<number, { events: number; rngState: number; sha256: string }> = {
    42: {
      events: 1854,
      rngState: 2832085384,
      sha256: "b3d723f06793fcf6611154f0c3848e90fc2cd8e52a8409c4c08c9c40c87c4c1c",
    },
    7: {
      events: 1859,
      rngState: 1000519536,
      sha256: "e817187ac95b14eaaf9ebf7a99985f5ecd3d2ea976cec115b930f192ed314515",
    },
    99: {
      events: 1853,
      rngState: 3463921111,
      sha256: "b82307fd43c8f78e78748298576bb1417ca2ed47d5096a77f254859ca1d7cbf1",
    },
  };

  const baseParams: EngineParams = {
    scale: "majorPent",
    rootHz: 220,
    bpm: 72,
    complexity: 0.35,
    mix: 0.4,
    enableScenes: true,
    enableHarmonicLoop: true,
    sceneDurationBars: 32,
    drumLevel: 0.5,
  };

  // Round non-integer numbers so the digest survives last-digit float drift.
  const roundFloats = (_key: string, value: unknown): unknown =>
    typeof value === "number" && !Number.isInteger(value)
      ? Number(value.toFixed(EVENT_FLOAT_DIGITS))
      : value;

  function run256(params: EngineParams): { sha256: string; rngState: number; count: number } {
    const seeded: EngineParams = { ...params, seed: params.seed };
    let state = createInitialState(seeded);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const all: MusicalEvent[] = [];
    for (let i = 0; i < 256; i++) {
      const { events, nextState } = getMusicalEvents(i, { ...state }, seeded);
      all.push(...events);
      state = nextState;
    }
    const pick = (e: MusicalEvent) => ({
      type: e.type,
      hz: e.hz,
      amp: e.amp,
      subBeatIndex: e.subBeatIndex,
      isGhost: e.isGhost,
      isClosed: e.isClosed,
      durationSec: e.durationSec,
      pan: e.pan,
      timbre: e.timbre,
      beatIndex: e.beatIndex,
    });
    const h = createHash("sha256");
    for (const e of all) h.update(JSON.stringify(pick(e), roundFloats));
    return { sha256: h.digest("hex"), rngState: state.rngState >>> 0, count: all.length };
  }

  it("flag off: event stream matches the pre-change literal for seeds 42/7/99 over 256 beats", () => {
    for (const seed of [42, 7, 99] as const) {
      const legacy = LEGACY[seed];
      const run = run256({ ...baseParams, seed });
      expect(run.count, `seed ${seed} event count`).toBe(legacy.events);
      expect(run.rngState, `seed ${seed} final rngState`).toBe(legacy.rngState);
      expect(run.sha256, `seed ${seed} stream hash`).toBe(legacy.sha256);
    }
  });

  // Draw-count invariance: the two param values start identically and finish
  // with the SAME rngState — mulberry32 advances once per call, so equal end
  // state proves equal call count (zero draws added). Unlike a musical knob,
  // the event streams are also expected to be IDENTICAL here: reverbLevel is
  // applied by the shells, mirroring the swing/sidechainAmount no-op tests.
  it("flag on (reverbLevel 0.7): identical stream and identical final rngState — zero new draws", () => {
    for (const seed of [42, 7, 99] as const) {
      const off = run256({ ...baseParams, seed });
      const on = run256({ ...baseParams, seed, reverbLevel: 0.7 });
      expect(on.count).toBe(off.count);
      expect(on.sha256, `seed ${seed} stream must not change`).toBe(off.sha256);
      expect(on.rngState, `seed ${seed} draw-count invariance`).toBe(off.rngState);
    }
  });

  it("resolveReverbLevel clamps into [0,1] and defaults non-finite/absent to 0", () => {
    expect(resolveReverbLevel(undefined)).toBe(0);
    expect(resolveReverbLevel(Number.NaN)).toBe(0);
    expect(resolveReverbLevel(0)).toBe(0);
    expect(resolveReverbLevel(0.7)).toBe(0.7);
    expect(resolveReverbLevel(-0.5)).toBe(0);
    expect(resolveReverbLevel(1.5)).toBe(1);
  });
});

describe("Phase 1 Space: medium noise table", () => {
  it("is deterministic for a given seed", () => {
    const a = generateMediumNoiseTable(42);
    const b = generateMediumNoiseTable(42);
    expect(a.length).toBe(MEDIUM_NOISE_BUFFER_SAMPLES);
    for (let i = 0; i < a.length; i += 997) {
      expect(b[i]).toBe(a[i]);
    }
    expect(b[a.length - 1]).toBe(a[a.length - 1]);
  });

  it("runs on a salted stream that never touches the main kernel stream", () => {
    // First value of the bed table must differ from the first draw of the
    // main mulberry32 stream started at the raw seed — proves the XOR salt
    // actually split the streams.
    const bed = generateMediumNoiseTable(42);
    const mainFirst = mulberry32Next({ rngState: 42 });
    expect(bed[0]).not.toBeCloseTo(mainFirst * 2 - 1, 12);
    expect(mediumNoiseSeed(42)).toBe((42 ^ MEDIUM_NOISE_SEED_SALT) >>> 0);
    expect(mediumNoiseSeed(0)).not.toBe(0);
  });
});

describe("Phase 1 Space: derived comb feedback meets the RT60 target", () => {
  // The feedback table is DERIVED from the target at module load; this check
  // pins the property RT60 = -3·L/log10(g) ≈ target for every comb.
  it("RT60 = -3L/log10(g) equals REVERB_RT60_TARGET_SEC for every comb", () => {
    for (let i = 0; i < REVERB_COMB_DELAY_SAMPLES.length; i++) {
      const L = REVERB_COMB_DELAY_SAMPLES[i] / SPACE_REFERENCE_SAMPLE_RATE;
      const g = REVERB_COMB_FEEDBACK[i];
      const rt60 = (-3 * L) / Math.log10(g);
      expect(rt60).toBeCloseTo(REVERB_RT60_TARGET_SEC, 6);
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThan(1);
    }
  });
});
