import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  mulberry32Next,
  applyHarmonyDraw,
  transformChord,
  triadPitchClasses,
  isHarmonicCycleBoundary,
  chordRootHz,
  HARMONY_TRANSFORM_WEIGHTS,
  HARMONIC_CYCLE_BARS,
  BEATS_PER_BAR,
  SCALE_TONIC_QUALITY,
  SEMITONES_PER_OCTAVE,
  MAJOR_COLOUR_INTERVALS,
  MINOR_COLOUR_INTERVALS,
  type EngineParams,
  type MusicalEvent,
  type ChordState,
  type ScaleName,
} from "./musicalLogic";

// Phase 2 Neo-Harmony guards: the P/L/R transform oracle is DERIVED here from
// the verified table (root motions + canonical triad construction), never
// copied from the kernel's internals; the pad/bass lanes are chord-voiced;
// the flag-on draw schedule depends only on the beat index; and the flag-off
// stream is bit-exact with the pre-Phase-2 code.
//
// The backward-compatibility literals below are the SAME contract literals as
// space.test.ts (captured from the UNMODIFIED pre-Space code, commit 19e4282,
// 256 beats, full default path, rounded-float hash scheme). Phase 2 must not
// move them: with enableNeoHarmony absent the code returns before any new
// draw, so these prove flag-off equals the original stream.
// ponytail: rounding to 6 digits assumes cross-machine float drift stays
// below 5e-7; if a machine ever disagrees, coarsen EVENT_FLOAT_DIGITS or rely
// on count + rngState + the flag-on == flag-off test only.

const EVENT_FLOAT_DIGITS = 6;
const Z12 = SEMITONES_PER_OCTAVE;

const mod12 = (pc: number): number => ((pc % Z12) + Z12) % Z12;

// ── Test-local oracle ────────────────────────────────────────────────────────
// A major triad is root + 4 + 7 semitones, a minor triad root + 3 + 7 (mod
// 12). Built here with local literals so the kernel's triadPitchClasses and
// transformChord are checked against an independent construction.

type Quality = "major" | "minor";

const oracleTriad = (rootPc: number, quality: Quality): [number, number, number] =>
  quality === "major"
    ? [mod12(rootPc), mod12(rootPc + 4), mod12(rootPc + 7)]
    : [mod12(rootPc), mod12(rootPc + 3), mod12(rootPc + 7)];

const allTwentyFourTriads = (): Set<string> => {
  const keys = new Set<string>();
  for (let r = 0; r < Z12; r++) {
    for (const q of ["major", "minor"] as const) {
      keys.add(oracleTriad(r, q).slice().sort((a, b) => a - b).join(","));
    }
  }
  return keys;
};

const pcKey = (pcs: readonly number[]): string =>
  pcs.slice().sort((a, b) => a - b).join(",");

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

// Same rounded-float hash scheme as space.test.ts (EVENT_FLOAT_DIGITS via a
// JSON replacer; integers pass through unchanged).
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

describe("Phase 2: transform oracle derived from the verified table", () => {
  // The verified table as test data: root motion in pitch classes per
  // (transform, input quality). P/L/R always flip the quality. Expected SETS
  // are derived by constructing the canonical triad on the expected root.
  const TABLE_ROOT_DELTA = {
    P: { major: 0, minor: 0 },
    L: { major: 4, minor: 8 },
    R: { major: 9, minor: 3 },
  } as const;
  const TRANSFORMS = ["P", "L", "R"] as const;

  it("all 12 roots × {P,L,R} × {major,minor}: output is exactly the canonical triad on the table's root", () => {
    for (const transform of TRANSFORMS) {
      for (const quality of ["major", "minor"] as const) {
        for (let rootPc = 0; rootPc < Z12; rootPc++) {
          const label = `${transform} of ${quality} pc${rootPc}`;
          const out = transformChord({ rootPc, quality }, transform);
          const expRoot = mod12(rootPc + TABLE_ROOT_DELTA[transform][quality]);
          const expQuality: Quality = quality === "major" ? "minor" : "major";
          expect(out, label).toEqual({ rootPc: expRoot, quality: expQuality });
          expect(pcKey(triadPitchClasses(out.rootPc, out.quality)), label).toBe(
            pcKey(oracleTriad(expRoot, expQuality)),
          );
        }
      }
    }
  });

  it("every transform keeps exactly two common tones with its input", () => {
    for (const transform of TRANSFORMS) {
      for (const quality of ["major", "minor"] as const) {
        for (let rootPc = 0; rootPc < Z12; rootPc++) {
          const out = transformChord({ rootPc, quality }, transform);
          const inSet = new Set(oracleTriad(rootPc, quality));
          const outSet = new Set(oracleTriad(out.rootPc, out.quality));
          let common = 0;
          for (const pc of inSet) if (outSet.has(pc)) common++;
          expect(common, `${transform} of ${quality} pc${rootPc}`).toBe(2);
        }
      }
    }
  });
});

describe("Phase 2: long chord walk", () => {
  const WALK_STEPS = 1000;
  const WALK_SEED = 424242;

  it("1000 draws never leave the 24 triads; adjacent chords differ unless 'stay' is drawn", () => {
    // Derived from the named weights: the stay branch is the cumulative
    // remainder after P + L + R.
    const stayThreshold =
      HARMONY_TRANSFORM_WEIGHTS.parallel +
      HARMONY_TRANSFORM_WEIGHTS.leading +
      HARMONY_TRANSFORM_WEIGHTS.relative;
    const triads = allTwentyFourTriads();
    expect(triads.size).toBe(24);

    const prng = { rngState: WALK_SEED };
    let chord: ChordState = { rootPc: 0, quality: "major" };
    let stays = 0;
    let moves = 0;
    for (let i = 0; i < WALK_STEPS; i++) {
      const uniform = mulberry32Next(prng);
      const next = applyHarmonyDraw(chord, uniform);
      const nextKey = pcKey(triadPitchClasses(next.rootPc, next.quality));
      expect(triads.has(nextKey), `step ${i} left the 24 triads`).toBe(true);
      const currentKey = pcKey(triadPitchClasses(chord.rootPc, chord.quality));
      if (uniform < stayThreshold) {
        // Draw was P/L/R: the refractory rule — the new chord must differ.
        expect(nextKey, `step ${i} repeated without 'stay'`).not.toBe(currentKey);
        moves++;
      } else {
        expect(nextKey, `step ${i} changed on a 'stay' draw`).toBe(currentKey);
        stays++;
      }
      chord = next;
    }
    expect(stays).toBeGreaterThan(0);
    expect(moves).toBeGreaterThan(0);
  });
});

describe("Phase 2: chord-voiced pad and bass pitch pool", () => {
  const MEMBERSHIP_BEATS = 256; // crosses boundaries 32, 64, …, 224

  it("every pad event is voiced from its beat's chord, bass plays the chord root", () => {
    // The test plays the synthesis-shell role for currentRootHz (the kernel
    // never updates it): snap to targetRootHz after each call, mirroring the
    // shells' end-of-slew state. Chord-relative checks are slew-independent;
    // the absolute check skips boundary beats, where the shells' 600 ms glide
    // legitimately sounds the transition between the old and new chord root.
    const params: EngineParams = { ...baseParams, seed: 42, enableNeoHarmony: true };
    let state = createInitialState(params);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    state = initializeSampleLane(state, params);

    let trackedRootHz = params.rootHz;
    let padCount = 0;
    let bassCount = 0;
    let chordChanges = 0;
    let prevChord: ChordState = {
      rootPc: state.chordRootPc,
      quality: state.chordQuality,
    };

    for (let beat = 0; beat < MEMBERSHIP_BEATS; beat++) {
      const withRoot = { ...state, currentRootHz: trackedRootHz };
      const { events, nextState } = getMusicalEvents(beat, withRoot, params);
      const chord: ChordState = {
        rootPc: nextState.chordRootPc,
        quality: nextState.chordQuality,
      };
      if (
        chord.rootPc !== prevChord.rootPc ||
        chord.quality !== prevChord.quality
      ) {
        chordChanges++;
      }
      // Chord-relative allowed pitch classes (relative to the chord root):
      // the triad itself, plus the declared colour pool.
      const allowedRel = new Set<number>([
        ...oracleTriad(0, chord.quality),
        ...(chord.quality === "major"
          ? MAJOR_COLOUR_INTERVALS
          : MINOR_COLOUR_INTERVALS),
      ]);
      const chordPcs = new Set(triadPitchClasses(chord.rootPc, chord.quality));
      const colourPcs = new Set<number>(
        chord.quality === "major"
          ? MAJOR_COLOUR_INTERVALS
          : MINOR_COLOUR_INTERVALS,
      );

      for (const ev of events) {
        if (ev.hz === undefined) continue;
        const relSemi = Math.round(SEMITONES_PER_OCTAVE * Math.log2(ev.hz / trackedRootHz));
        if (ev.type === "pad") {
          padCount++;
          const relPc = mod12(relSemi);
          expect(
            allowedRel.has(relPc),
            `beat ${beat}: pad relPc ${relPc} outside chord ${chord.quality} pc${chord.rootPc}`,
          ).toBe(true);
          // Absolute pitch class (relative to params.rootHz): belongs to the
          // chord ∪ colour pool except on boundary beats — the 600 ms shell
          // glide sounds the old→new root transition there by design.
          if (!isHarmonicCycleBoundary(beat)) {
            const absolutePc = mod12(chord.rootPc + relPc);
            expect(
              chordPcs.has(absolutePc) || colourPcs.has(absolutePc),
              `beat ${beat}: pad pc ${absolutePc} outside chord ∪ colour`,
            ).toBe(true);
          }
        } else if (ev.type === "bass") {
          bassCount++;
          // Bass plays the chord root (−24 semitones ≡ root pitch class).
          expect(relSemi, `beat ${beat}: bass is not the chord root`).toBe(-24);
          if (!isHarmonicCycleBoundary(beat)) {
            const absolutePc = mod12(chord.rootPc + mod12(relSemi));
            expect(chordPcs.has(absolutePc), `beat ${beat}: bass pc off the chord`).toBe(true);
          }
        }
      }

      state = nextState;
      prevChord = chord;
      trackedRootHz = nextState.targetRootHz;
    }

    expect(padCount).toBeGreaterThan(0);
    expect(bassCount).toBeGreaterThan(0);
    expect(chordChanges, "the chord walk never moved over 256 beats").toBeGreaterThan(0);
  });

  it("draws fire exactly at the harmonic boundary: none before beat 32, one at beat 32", () => {
    // Draw counts are unobservable directly, but mulberry32 advances once per
    // call, so equal rngState after N beats proves equal draw counts. The
    // first boundary is beat HARMONIC_CYCLE_BARS * BEATS_PER_BAR = 32.
    const on = (beats: number): number => {
      const params: EngineParams = { ...baseParams, seed: 42, enableNeoHarmony: true };
      let state = createInitialState(params);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      for (let i = 0; i < beats; i++) state = getMusicalEvents(i, { ...state }, params).nextState;
      return state.rngState >>> 0;
    };
    const off = (beats: number): number => {
      const params: EngineParams = { ...baseParams, seed: 42 };
      let state = createInitialState(params);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      for (let i = 0; i < beats; i++) state = getMusicalEvents(i, { ...state }, params).nextState;
      return state.rngState >>> 0;
    };
    const firstBoundary = HARMONIC_CYCLE_BARS * BEATS_PER_BAR;
    // N calls step beats 0..N-1; the boundary fires on the call whose state
    // beat is 32 — the 33rd call.
    expect(on(firstBoundary)).toBe(off(firstBoundary));
    expect(on(firstBoundary + 1)).not.toBe(off(firstBoundary + 1));
  });
});

describe("Phase 2: determinism and draw-count invariance (flag on)", () => {
  it("two runs with identical params are identical", () => {
    const params: EngineParams = { ...baseParams, seed: 42, enableNeoHarmony: true };
    const a = run256(params);
    const b = run256(params);
    expect(a).toEqual(b);
  });

  it("complexity 0.2 vs 0.8: identical final rngState, differing event streams", () => {
    // Equal end rngState proves equal draw counts: the harmony draw schedule
    // depends only on the beat index, and complexity changes weights, never
    // draw counts. The streams still differ where expected (Markov/melody).
    // Scenes are disabled so params.complexity actually reaches Markov —
    // with scenes on, the scene interpolation overwrites it.
    const low = run256({ ...baseParams, seed: 42, enableNeoHarmony: true, enableScenes: false, complexity: 0.2 });
    const high = run256({ ...baseParams, seed: 42, enableNeoHarmony: true, enableScenes: false, complexity: 0.8 });
    expect(low.rngState).toBe(high.rngState);
    expect(low.sha256).not.toBe(high.sha256);
  });
});

describe("Phase 2: backward compatibility (flag off)", () => {
  // Same contract literals as space.test.ts — captured from the UNMODIFIED
  // pre-Space code (commit 19e4282), 256 beats, full default path. Passing
  // here proves Phase 2 did not touch the flag-off stream either.
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

  it("flag absent matches the pre-change literals for seeds 42/7/99", () => {
    for (const seed of [42, 7, 99] as const) {
      const legacy = LEGACY[seed];
      const run = run256({ ...baseParams, seed });
      expect(run.count, `seed ${seed} event count`).toBe(legacy.events);
      expect(run.rngState, `seed ${seed} final rngState`).toBe(legacy.rngState);
      expect(run.sha256, `seed ${seed} stream hash`).toBe(legacy.sha256);
    }
  });

  it("flag explicitly false equals flag absent (zero draws either way)", () => {
    for (const seed of [42, 7, 99] as const) {
      const absent = run256({ ...baseParams, seed });
      const explicit = run256({ ...baseParams, seed, enableNeoHarmony: false });
      expect(explicit).toEqual(absent);
    }
  });
});

describe("Phase 2: initial chord and root fold", () => {
  // The named tonic-quality mapping, pinned here as the convention:
  // major-tonic scales → major, minor-tonic scales → minor, locrian
  // (diminished tonic) → minor.
  const EXPECTED_TONIC_QUALITY: Record<ScaleName, Quality> = {
    majorPent: "major",
    ionian: "major",
    lydian: "major",
    mixolydian: "major",
    minorPent: "minor",
    dorian: "minor",
    phrygian: "minor",
    aeolian: "minor",
    locrian: "minor",
  };

  it("createInitialState starts on the tonic triad (root pc 0, mapped quality)", () => {
    for (const scale of Object.keys(EXPECTED_TONIC_QUALITY) as ScaleName[]) {
      const state = createInitialState({ ...baseParams, scale });
      expect(state.chordRootPc, scale).toBe(0);
      expect(state.chordQuality, scale).toBe(EXPECTED_TONIC_QUALITY[scale]);
    }
  });

  it("the tonic chord root sounds exactly at params.rootHz, and folds stay within ±6 semitones", () => {
    expect(chordRootHz(220, 0)).toBe(220);
    const FOLD_LIMIT = 6;
    const foldWindowHigh = 220 * Math.pow(2, FOLD_LIMIT / Z12);
    const foldWindowLow = 220 * Math.pow(2, -FOLD_LIMIT / Z12);
    for (let pc = 0; pc < Z12; pc++) {
      const hz = chordRootHz(220, pc);
      expect(hz).toBeGreaterThanOrEqual(foldWindowLow);
      expect(hz).toBeLessThanOrEqual(foldWindowHigh);
    }
  });
});

describe("Phase 2: static-root pin (enableHarmonicLoop === false wins)", () => {
  // Fix regression guard: updateHarmony used to advance the chord at the
  // boundary even when the harmonic loop was disabled — updateHarmonicLoop
  // re-pins targetRootHz/currentRootHz to params.rootHz every beat, so the
  // pad ended up voicing a moving chord over a pinned root.
  const PIN_BEATS = 256; // crosses boundaries 32, 64, …, 224

  const runPinned = () => {
    const params: EngineParams = {
      ...baseParams,
      seed: 42,
      enableNeoHarmony: true,
      enableHarmonicLoop: false,
    };
    let state = createInitialState(params);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    state = initializeSampleLane(state, params);
    const tonicPcs = new Set(oracleTriad(0, SCALE_TONIC_QUALITY[params.scale]));
    let padCount = 0;
    let bassCount = 0;
    for (let beat = 0; beat < PIN_BEATS; beat++) {
      const { events, nextState } = getMusicalEvents(beat, { ...state }, params);
      expect(nextState.chordRootPc, `beat ${beat}: chord root moved under the pin`).toBe(0);
      expect(
        nextState.chordQuality,
        `beat ${beat}: chord quality moved under the pin`,
      ).toBe(SCALE_TONIC_QUALITY[params.scale]);
      expect(nextState.targetRootHz, `beat ${beat}: target root moved under the pin`).toBe(
        params.rootHz,
      );
      for (const ev of events) {
        if (ev.type !== "pad" && ev.type !== "bass") continue;
        expect(ev.hz, `beat ${beat}: ${ev.type} event without hz`).toBeDefined();
        const relPc = mod12(
          Math.round(SEMITONES_PER_OCTAVE * Math.log2(ev.hz! / params.rootHz)),
        );
        expect(
          tonicPcs.has(relPc),
          `beat ${beat}: ${ev.type} pc ${relPc} off the tonic triad`,
        ).toBe(true);
        if (ev.type === "pad") padCount++;
        else bassCount++;
      }
      state = nextState;
    }
    return { padCount, bassCount, rngState: state.rngState >>> 0, params };
  };

  it("chord, quality and target root never move; every pad/bass pitch stays on the tonic triad", () => {
    const { padCount, bassCount } = runPinned();
    expect(padCount).toBeGreaterThan(0);
    expect(bassCount).toBeGreaterThan(0);
  });

  it("the pinned harmony lane draws nothing: final rngState equals the neo-off run", () => {
    const pinned = runPinned();
    const paramsOff: EngineParams = { ...pinned.params, enableNeoHarmony: false };
    let state = createInitialState(paramsOff);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    state = initializeSampleLane(state, paramsOff);
    for (let beat = 0; beat < PIN_BEATS; beat++) {
      state = getMusicalEvents(beat, { ...state }, paramsOff).nextState;
    }
    expect(pinned.rngState).toBe(state.rngState >>> 0);
  });
});
