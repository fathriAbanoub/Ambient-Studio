import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  mulberry32Next,
  buildMelodyLadder,
  pickLadderMove,
  snapMelodyLadder,
  nearestDegreeToPitchClass,
  currentScale,
  MARKOV_MOVES,
  MARKOV_UNIFORM_BLEND,
  MELODY_W_CHORD,
  MELODY_W_COLOUR,
  MELODY_REPEAT_REFRACTORY_FACTOR,
  MELODY_PHRASE_PULL_WINDOW_BEATS,
  MELODY_PHRASE_PULL_FACTOR,
  MELODY_ROOT_PITCH_CLASS,
  MELODY_FIFTH_PITCH_CLASS,
  CADENCE_INTERVAL,
  PHRASE_LENGTH,
  CHORD_ROOT_FOLD_SEMITONES,
  HARMONIC_CYCLE_BARS,
  BEATS_PER_BAR,
  poolFifthPitchClass,
  SEMITONES_PER_OCTAVE,
  type EngineParams,
  type MusicalEvent,
  type ChordState,
  type ScaleName,
  type MelodyLadder,
} from "./musicalLogic";

// Melody V2 (enableMelodyV2): the melody lane walks a ladder of pool pitches
// stepwise. Every expectation below is derived independently from the spec'd
// weighting formula — the blended Markov base row, the pool weights, the
// refractory factor, the phrase pull and the ladder bounds — never from
// kernel internals. The kernel's exported constants name the values; the
// derivations recompute them.

const EVENT_FLOAT_DIGITS = 6; // rounded-float hash scheme (same as harmony.test.ts)
const WEIGHT_DECIMALS = 6; // worked-example precision
const MOVE_FREQ_TOLERANCE = 0.02; // empirical vs expected move frequency
const CONTOUR_DRAWS = 20000; // enough that binomial noise stays ≪ tolerance
const EDGE_DRAWS = 2000;
const STREAM_BEATS = 256; // crosses harmonic boundaries 32, 64, …, 224
const MEASUREMENT_BEATS = 2048; // leap statistics over a long run
const MEASUREMENT_SEEDS = [42, 7] as const;
const BIG_LEAP_SEMITONES = 7;
// Locrian is the only scale in the table without the perfect fifth (7); its
// pool fifth is the diminished fifth.
const LOCRIAN_POOL_FIFTH_PC = 6;
// Colour tones must stay a clear minority: the weights predict ≈ 12% of
// ladder visits land on colour steps under uniform position visitation
// (2 colour steps weighted 0.4 vs 3 chord steps weighted 2.0); 0.25 is a
// generous ceiling.
const COLOUR_MAX_FRACTION = 0.25;
const PROBE_SEED = 42;
const NEAR_ONE_UNIFORM = 0.999999;
const PULL_INACTIVE_BEATS = MELODY_PHRASE_PULL_WINDOW_BEATS + 1;

const Z12 = SEMITONES_PER_OCTAVE;
const mod12 = (pc: number): number => ((pc % Z12) + Z12) % Z12;
const round6 = (w: number): number => Number(w.toFixed(WEIGHT_DECIMALS));

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

const neoOn = (overrides: Partial<EngineParams> = {}): EngineParams => ({
  ...baseParams,
  seed: PROBE_SEED,
  enableNeoHarmony: true,
  ...overrides,
});

// ── Independent expectation helpers ──────────────────────────────────────────

/** Blended base row over MARKOV_MOVES, derived from the spec'd blend. */
const blendedRow = (baseRow: readonly number[], complexity: number): number[] =>
  baseRow.map((w) => w * (1 - complexity) + MARKOV_UNIFORM_BLEND * complexity);

/**
 * The normalized move distribution the spec's weighting predicts for one
 * pickLadderMove call: blended base row × destination pool weight ×
 * refractory (move 0) × phrase pull (root/fifth destinations inside the
 * window), zero for off-ladder destinations.
 */
function expectedDistribution(
  baseRow: readonly number[],
  complexity: number,
  currentPos: number,
  ladder: MelodyLadder,
  beatsToPhraseEnd: number,
  fifthPitchClass: number,
): number[] {
  const weighted = MARKOV_MOVES.map((move, i) => {
    const dest = currentPos + move;
    if (dest < 0 || dest >= ladder.offsets.length) return 0;
    let w = blendedRow(baseRow, complexity)[i] * ladder.weights[dest];
    if (move === 0) w *= MELODY_REPEAT_REFRACTORY_FACTOR;
    const destPc = mod12(ladder.offsets[dest]);
    if (
      beatsToPhraseEnd >= 1 &&
      beatsToPhraseEnd <= MELODY_PHRASE_PULL_WINDOW_BEATS &&
      (destPc === MELODY_ROOT_PITCH_CLASS || destPc === fifthPitchClass)
    ) {
      w *= MELODY_PHRASE_PULL_FACTOR;
    }
    return w;
  });
  const sum = weighted.reduce((a, b) => a + b, 0);
  return weighted.map((w) => w / sum);
}

const moveArgs = (
  baseRow: readonly number[],
  currentPos: number,
  ladder: MelodyLadder,
  uniform: number,
) => ({
  baseRow,
  currentPos,
  ladder,
  refractoryFactor: MELODY_REPEAT_REFRACTORY_FACTOR,
  pullFactor: MELODY_PHRASE_PULL_FACTOR,
  pullWindowBeats: MELODY_PHRASE_PULL_WINDOW_BEATS,
  beatsToPhraseEnd: PULL_INACTIVE_BEATS,
  fifthPitchClass: poolFifthPitchClass(ladder.offsets),
  uniform,
});

// ── Stream runner (plays the synthesis-shell role for currentRootHz) ─────────

interface StreamRun {
  melodyEvents: MusicalEvent[];
  /** Sounding root tracked the way the shells end up after each beat's slew. */
  trackedRootHzByBeat: number[];
  chordByBeat: ChordState[];
  rngState: number;
}

function runStream(params: EngineParams, beats: number): StreamRun {
  let state = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  const melodyEvents: MusicalEvent[] = [];
  const trackedRootHzByBeat: number[] = [];
  const chordByBeat: ChordState[] = [];
  let trackedRootHz = params.rootHz;
  for (let beat = 0; beat < beats; beat++) {
    const withRoot = { ...state, currentRootHz: trackedRootHz };
    const { events, nextState } = getMusicalEvents(beat, withRoot, params);
    for (const ev of events) if (ev.type === "melody") melodyEvents.push(ev);
    trackedRootHzByBeat.push(trackedRootHz);
    chordByBeat.push({ rootPc: nextState.chordRootPc, quality: nextState.chordQuality });
    trackedRootHz = nextState.targetRootHz;
    state = nextState;
  }
  return { melodyEvents, trackedRootHzByBeat, chordByBeat, rngState: state.rngState >>> 0 };
}

const relSemitones = (hz: number, rootHz: number): number =>
  Math.round(Z12 * Math.log2(hz / rootHz));

// ── The weighted move ────────────────────────────────────────────────────────

describe("Melody V2: the weighted move (worked example)", () => {
  // complexity 0 → the blend is the identity. Neo-on major ladder: root,
  // ninth (colour), third, fifth, sixth (colour). Current position 1 (the
  // ninth), no phrase pull.
  const baseRow = [0.1, 0.2, 0.4, 0.2, 0.1];
  const ladder: MelodyLadder = {
    offsets: [12, 14, 16, 19, 21],
    weights: [
      MELODY_W_CHORD,
      MELODY_W_COLOUR,
      MELODY_W_CHORD,
      MELODY_W_CHORD,
      MELODY_W_COLOUR,
    ],
  };
  const args = moveArgs(baseRow, 1, ladder, 0.5);

  it("weights match the hand-derived normalization to six decimals", () => {
    const result = pickLadderMove(args);
    // Independent derivation: −2 is off the ladder (weight 0); −1 lands on
    // the root (chord tone); 0 repeats the ninth (colour × refractory);
    // +1 the third and +2 the fifth (both chord tones).
    const raw = [
      0,
      baseRow[1] * MELODY_W_CHORD,
      baseRow[2] * MELODY_W_COLOUR * MELODY_REPEAT_REFRACTORY_FACTOR,
      baseRow[3] * MELODY_W_CHORD,
      baseRow[4] * MELODY_W_CHORD,
    ];
    const sum = raw.reduce((a, b) => a + b, 0);
    const expected = raw.map((w) => round6(w / sum));
    expect(result.weights.map(round6)).toEqual(expected);
    // The hand-computed literals (raw sum 1.056):
    expect(round6(result.weights[0])).toBe(0);
    expect(round6(result.weights[1])).toBe(0.378788);
    expect(round6(result.weights[2])).toBe(0.05303);
    expect(round6(result.weights[3])).toBe(0.378788);
    expect(round6(result.weights[4])).toBe(0.189394);
    expect(result.usedFallback).toBe(false);
  });

  it("the uniform walks the derived distribution: low → root move, near-one → fifth move", () => {
    // Independent walk over the derived distribution — zero-weight slots are
    // skipped (a destination with weight 0 is never chosen, including at an
    // exact r = 0 draw).
    const expected = expectedDistribution(
      baseRow,
      0,
      1,
      ladder,
      PULL_INACTIVE_BEATS,
      poolFifthPitchClass(ladder.offsets),
    );
    const sum = expected.reduce((a, b) => a + b, 0);
    const walk = (uniform: number): number => {
      let r = uniform * sum;
      let idx = 0;
      for (
        ;
        idx < expected.length - 1 && ((r -= expected[idx]) > 0 || expected[idx] === 0);
        idx++
      );
      return idx;
    };
    const low = pickLadderMove({ ...args, uniform: 0 });
    expect(low.move).toBe(MARKOV_MOVES[walk(0)]);
    expect(low.nextPos).toBe(0); // root step
    const high = pickLadderMove({ ...args, uniform: NEAR_ONE_UNIFORM });
    expect(high.move).toBe(MARKOV_MOVES[walk(NEAR_ONE_UNIFORM)]);
    expect(high.nextPos).toBe(3); // fifth step
  });
});

describe("Melody V2: contour", () => {
  const baseRow = [0.1, 0.25, 0.4, 0.2, 0.05];
  const CONTOUR_SEED = 7;
  const ladder = buildMelodyLadder({ rootPc: 0, quality: "major" }, "majorPent");
  const CONTOUR_POS = 2; // the third, mid-ladder: no edge exclusions

  const empiricalFrequencies = (complexity: number): number[] => {
    const prng = { rngState: CONTOUR_SEED };
    const counts = new Array(MARKOV_MOVES.length).fill(0);
    for (let i = 0; i < CONTOUR_DRAWS; i++) {
      const result = pickLadderMove(
        moveArgs(blendedRow(baseRow, complexity), CONTOUR_POS, ladder, mulberry32Next(prng)),
      );
      counts[MARKOV_MOVES.indexOf(result.move)]++;
    }
    return counts.map((c) => c / CONTOUR_DRAWS);
  };

  it("empirical move frequencies match the derived expectation", () => {
    const expected = expectedDistribution(
      baseRow,
      0.35,
      CONTOUR_POS,
      ladder,
      PULL_INACTIVE_BEATS,
      poolFifthPitchClass(ladder.offsets),
    );
    const freqs = empiricalFrequencies(0.35);
    for (let i = 0; i < MARKOV_MOVES.length; i++) {
      expect(
        Math.abs(freqs[i] - expected[i]),
        `move ${MARKOV_MOVES[i]}: freq ${freqs[i]} vs expected ${expected[i]}`,
      ).toBeLessThanOrEqual(MOVE_FREQ_TOLERANCE);
    }
  });

  it("complexity 0.9 shifts the distribution toward uniform the way the blend predicts", () => {
    const low = empiricalFrequencies(0.1);
    const high = empiricalFrequencies(0.9);
    const expectedLow = expectedDistribution(
      baseRow,
      0.1,
      CONTOUR_POS,
      ladder,
      PULL_INACTIVE_BEATS,
      poolFifthPitchClass(ladder.offsets),
    );
    const expectedHigh = expectedDistribution(
      baseRow,
      0.9,
      CONTOUR_POS,
      ladder,
      PULL_INACTIVE_BEATS,
      poolFifthPitchClass(ladder.offsets),
    );
    // Move +2 has the smallest base entry, so the blend RAISES it; move 0 has
    // the largest, so the blend LOWERS it.
    const plusTwo = MARKOV_MOVES.indexOf(2);
    const repeat = MARKOV_MOVES.indexOf(0);
    expect(high[plusTwo]).toBeGreaterThan(low[plusTwo]);
    expect(high[repeat]).toBeLessThan(low[repeat]);
    for (let i = 0; i < MARKOV_MOVES.length; i++) {
      expect(Math.abs(low[i] - expectedLow[i])).toBeLessThanOrEqual(MOVE_FREQ_TOLERANCE);
      expect(Math.abs(high[i] - expectedHigh[i])).toBeLessThanOrEqual(MOVE_FREQ_TOLERANCE);
    }
  });
});

describe("Melody V2: ladder edges and fallback", () => {
  const baseRow = [0.1, 0.25, 0.4, 0.2, 0.05];
  const ladder = buildMelodyLadder({ rootPc: 0, quality: "major" }, "majorPent");

  it("at the lowest and highest ladder positions off-ladder destinations are never chosen", () => {
    const prng = { rngState: 11 };
    for (let i = 0; i < EDGE_DRAWS; i++) {
      const u = mulberry32Next(prng);
      const low = pickLadderMove(moveArgs(baseRow, 0, ladder, u));
      expect(low.nextPos).toBeGreaterThanOrEqual(0);
      expect(low.weights[0]).toBe(0); // move −2 off the ladder
      expect(low.weights[1]).toBe(0); // move −1 off the ladder
      const high = pickLadderMove(
        moveArgs(baseRow, ladder.offsets.length - 1, ladder, u),
      );
      expect(high.nextPos).toBeLessThanOrEqual(ladder.offsets.length - 1);
      expect(high.weights[3]).toBe(0); // move +1 off the ladder
      expect(high.weights[4]).toBe(0); // move +2 off the ladder
    }
  });

  it("all-zero weights: no NaN, a valid pick, the same uniform reused, no second draw", () => {
    // Base row concentrated on the two off-ladder moves from position 0: the
    // weighted pass AND the base-row fallback both come out zero, so the
    // in-ladder destinations split uniformly.
    const args = {
      ...moveArgs([0.5, 0.5, 0, 0, 0], 0, ladder, 0.3),
      beatsToPhraseEnd: PULL_INACTIVE_BEATS,
    };
    const result = pickLadderMove(args);
    expect(result.usedFallback).toBe(true);
    for (const w of result.weights) expect(Number.isNaN(w)).toBe(false);
    // moves 0, +1, +2 are the valid destinations → equal thirds
    const third = round6(1 / 3);
    expect(result.weights.map(round6)).toEqual([0, 0, third, third, third]);
    expect(result.nextPos).toBeGreaterThanOrEqual(0);
    expect(result.nextPos).toBeLessThan(ladder.offsets.length);
    // Deterministic in the uniform: nothing else is consumed.
    expect(pickLadderMove(args)).toEqual(result);
    // And the pick matches an independent walk of that uniform over the
    // equal thirds (cumulative: r = 0.3·3 lands on the first positive slot).
    expect(result.move).toBe(0);
  });
});

// ── Boundary snap ────────────────────────────────────────────────────────────

describe("Melody V2: boundary snap", () => {
  const ALL_CHORDS: ChordState[] = [];
  for (let pc = 0; pc < Z12; pc++) {
    for (const quality of ["major", "minor"] as const) {
      ALL_CHORDS.push({ rootPc: pc, quality });
    }
  }
  const ladderFor = (c: ChordState): MelodyLadder => buildMelodyLadder(c, "majorPent");

  // Independent oracle: the spec'd ±CHORD_ROOT_FOLD_SEMITONES root fold plus a nearest-step
  // search with ties to the lower step, both written out here.
  const oracleFold = (pc: number): number => {
    const p = mod12(pc);
    return p <= CHORD_ROOT_FOLD_SEMITONES ? p : p - Z12;
  };
  const oracleSnap = (oldC: ChordState, newC: ChordState, pos: number): number => {
    const pitch =
      ladderFor(oldC).offsets[pos] +
      oracleFold(oldC.rootPc) -
      oracleFold(newC.rootPc);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < ladderFor(newC).offsets.length; i++) {
      const d = Math.abs(ladderFor(newC).offsets[i] - pitch);
      if (d < bestDist || (d === bestDist && ladderFor(newC).offsets[i] < ladderFor(newC).offsets[best])) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  };

  it("identity when the chord is unchanged (all 24 chords × all positions)", () => {
    for (const chord of ALL_CHORDS) {
      const ladder = ladderFor(chord);
      for (let pos = 0; pos < ladder.offsets.length; pos++) {
        expect(
          snapMelodyLadder({
            oldLadder: ladder,
            newLadder: ladder,
            oldRootPc: chord.rootPc,
            newRootPc: chord.rootPc,
            pos,
          }),
          `${chord.quality} pc${chord.rootPc} pos ${pos}`,
        ).toBe(pos);
      }
    }
  });

  it("every chord pair × every position matches the independent oracle", () => {
    for (const a of ALL_CHORDS) {
      for (const b of ALL_CHORDS) {
        const ladder = ladderFor(a);
        for (let pos = 0; pos < ladder.offsets.length; pos++) {
          expect(
            snapMelodyLadder({
              oldLadder: ladder,
              newLadder: ladderFor(b),
              oldRootPc: a.rootPc,
              newRootPc: b.rootPc,
              pos,
            }),
            `${a.quality} pc${a.rootPc} → ${b.quality} pc${b.rootPc} pos ${pos}`,
          ).toBe(oracleSnap(a, b, pos));
        }
      }
    }
  });

  it("canonical example: the third of A major snaps to the fifth of F# minor", () => {
    // A major over rootHz 220 (A = pc 0): its third C# sits at +16 semitones.
    // F# minor has root pc 9 (folded −3); C# is F# minor's fifth (+7).
    const aMajor: ChordState = { rootPc: 0, quality: "major" };
    const fsMinor: ChordState = { rootPc: 9, quality: "minor" };
    const thirdPos = ladderFor(aMajor).offsets.indexOf(16);
    expect(thirdPos).toBeGreaterThanOrEqual(0);
    const snapped = snapMelodyLadder({
      oldLadder: ladderFor(aMajor),
      newLadder: ladderFor(fsMinor),
      oldRootPc: aMajor.rootPc,
      newRootPc: fsMinor.rootPc,
      pos: thirdPos,
    });
    expect(mod12(ladderFor(fsMinor).offsets[snapped])).toBe(MELODY_FIFTH_PITCH_CLASS);
  });
});

// ── Shadow degree ────────────────────────────────────────────────────────────

describe("Melody V2: shadow degree", () => {
  // majorPent = [0, 2, 4, 7, 9]
  it("nearest scale degree by circular pitch-class distance, ties to the lowest degree", () => {
    expect(nearestDegreeToPitchClass(0, "majorPent")).toBe(0); // root
    expect(nearestDegreeToPitchClass(7, "majorPent")).toBe(3); // fifth
    expect(nearestDegreeToPitchClass(11, "majorPent")).toBe(0); // wraps to 0 (dist 1) vs 9 (dist 2)
    expect(nearestDegreeToPitchClass(1, "majorPent")).toBe(0); // dist 1 to degrees 0 and 1 → lowest
    expect(nearestDegreeToPitchClass(6, "majorPent")).toBe(3); // dist 1 to 7 vs 2 to 4
  });
});

// ── Streams ──────────────────────────────────────────────────────────────────

describe("Melody V2: streams (neo on)", () => {
  const run = runStream(neoOn({ enableMelodyV2: true }), STREAM_BEATS);
  const ladderFor = (c: ChordState): MelodyLadder => buildMelodyLadder(c, "majorPent");
  const poolPcs = (c: ChordState): Set<number> =>
    new Set([...ladderFor(c).offsets.map((o) => mod12(o))]);
  const triadPcs = (c: ChordState): Set<number> => {
    const l = ladderFor(c);
    return new Set(
      l.offsets
        .filter((_o, i) => l.weights[i] === MELODY_W_CHORD)
        .map((o) => mod12(o)),
    );
  };

  it("every melody pitch lies on its chord's ladder", () => {
    expect(run.melodyEvents.length).toBeGreaterThan(0);
    // No boundary exemption is needed here: membership is measured relative
    // to the tracked sounding root (the shells' end-of-slew value), and the
    // kernel emits melody hz as currentRootHz · 2^(ladderOffset/12) — the
    // ladder-frame relation is exact even on boundary beats, where only the
    // ABSOLUTE pitch (old root × new-frame offset) sounds transitional.
    for (const ev of run.melodyEvents) {
      const chord = run.chordByBeat[ev.beatIndex];
      const relPc = mod12(relSemitones(ev.hz!, run.trackedRootHzByBeat[ev.beatIndex]));
      expect(
        poolPcs(chord).has(relPc),
        `beat ${ev.beatIndex}: melody pc ${relPc} outside ${chord.quality} pc${chord.rootPc}`,
      ).toBe(true);
    }
  });

  it("phrase ends land on the root or the fifth", () => {
    let landings = 0;
    for (const ev of run.melodyEvents) {
      if (ev.beatIndex % PHRASE_LENGTH !== PHRASE_LENGTH - 1) continue;
      const relPc = mod12(
        relSemitones(ev.hz!, run.trackedRootHzByBeat[ev.beatIndex]),
      );
      expect(
        relPc === MELODY_ROOT_PITCH_CLASS || relPc === MELODY_FIFTH_PITCH_CLASS,
        `phrase-end beat ${ev.beatIndex}: melody pc ${relPc} is not root/fifth`,
      ).toBe(true);
      landings++;
    }
    expect(landings, "the stream contains phrase-end melody events").toBeGreaterThan(0);
  });

  it("colour tones are a clear minority of the melody", () => {
    expect(run.melodyEvents.length).toBeGreaterThan(0);
    let colour = 0;
    for (const ev of run.melodyEvents) {
      const chord = run.chordByBeat[ev.beatIndex];
      const relPc = mod12(relSemitones(ev.hz!, run.trackedRootHzByBeat[ev.beatIndex]));
      if (!triadPcs(chord).has(relPc)) colour++;
    }
    const fraction = colour / run.melodyEvents.length;
    expect(fraction).toBeLessThanOrEqual(COLOUR_MAX_FRACTION);
  });

  it("two runs with identical params are identical", () => {
    const a = runStream(neoOn({ enableMelodyV2: true }), STREAM_BEATS);
    const b = runStream(neoOn({ enableMelodyV2: true }), STREAM_BEATS);
    expect(a.melodyEvents).toEqual(b.melodyEvents);
    expect(a.rngState).toBe(b.rngState);
  });

  it("V2 adds no draws: final rngState equals V2 off (neo on and neo off)", () => {
    for (const neo of [true, false] as const) {
      const on = runStream(neoOn({ enableNeoHarmony: neo, enableMelodyV2: true }), STREAM_BEATS);
      const off = runStream(neoOn({ enableNeoHarmony: neo, enableMelodyV2: false }), STREAM_BEATS);
      expect(on.rngState, `enableNeoHarmony ${neo}`).toBe(off.rngState);
    }
  });
});

describe("Melody V2: scale mode (neo off)", () => {
  // Independent scale oracle — same table shape as the musicalLogic.test.ts
  // oracle, restated here so a bad SCALE_INTERVALS row cannot pass silently.
  const expectedModes: Record<ScaleName, number[]> = {
    majorPent: [0, 2, 4, 7, 9],
    minorPent: [0, 3, 5, 7, 10],
    ionian: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
  };

  for (const [scaleName, scalePcs] of Object.entries(expectedModes) as Array<[ScaleName, number[]]>) {
    it(`${scaleName}: every melody pitch class is in the scale`, () => {
      // Scenes off so params.scale is the pool source for the whole run.
      const params = neoOn({
        scale: scaleName,
        enableNeoHarmony: false,
        enableMelodyV2: true,
        enableScenes: false,
      });
      const run = runStream(params, STREAM_BEATS);
      expect(run.melodyEvents.length, `${scaleName}: melody events`).toBeGreaterThan(0);
      const inScale = new Set(scalePcs);
      for (const ev of run.melodyEvents) {
        const relPc = mod12(relSemitones(ev.hz!, run.trackedRootHzByBeat[ev.beatIndex]));
        expect(
          inScale.has(relPc),
          `beat ${ev.beatIndex}: melody pc ${relPc} outside ${scaleName}`,
        ).toBe(true);
      }
      expect(currentScale(scaleName)).toEqual(scalePcs);
    });
  }

  it("poolFifthPitchClass picks the pool's nearest pitch class to the perfect fifth", () => {
    for (const [scaleName, scalePcs] of Object.entries(expectedModes) as Array<[ScaleName, number[]]>) {
      const expected = scalePcs.includes(MELODY_FIFTH_PITCH_CLASS)
        ? MELODY_FIFTH_PITCH_CLASS
        : LOCRIAN_POOL_FIFTH_PC;
      expect(poolFifthPitchClass(scalePcs), scaleName).toBe(expected);
    }
  });

  it("poolFifthPitchClass breaks equal-distance ties by the lower pitch class, regardless of offsets order", () => {
    // Both are distance 1 from the perfect-fifth target: lower below, higher above.
    const lower = mod12(MELODY_FIFTH_PITCH_CLASS - 1);
    const higher = mod12(MELODY_FIFTH_PITCH_CLASS + 1);
    expect(poolFifthPitchClass([higher, lower])).toBe(lower);
    expect(poolFifthPitchClass([lower, higher])).toBe(lower);
  });
});

describe("Melody V2: locrian cadence landing", () => {
  it("every cadence-beat melody pitch class is the root or the diminished fifth", () => {
    const params = neoOn({
      scale: "locrian",
      enableNeoHarmony: false,
      enableMelodyV2: true,
      enableScenes: false,
    });
    const run = runStream(params, STREAM_BEATS);
    let cadenceNotes = 0;
    for (const ev of run.melodyEvents) {
      if (ev.beatIndex % CADENCE_INTERVAL !== CADENCE_INTERVAL - 1) continue;
      const relPc = mod12(relSemitones(ev.hz!, run.trackedRootHzByBeat[ev.beatIndex]));
      expect(
        relPc === MELODY_ROOT_PITCH_CLASS || relPc === LOCRIAN_POOL_FIFTH_PC,
        `beat ${ev.beatIndex}: cadence pc ${relPc}`,
      ).toBe(true);
      cadenceNotes++;
    }
    expect(cadenceNotes, "cadence-beat melody events").toBeGreaterThan(0);
  });
});

// ── Acceptance and backward compatibility ────────────────────────────────────

describe("Melody V2: acceptance (leap statistics)", () => {
  const leapStats = (params: EngineParams, beats: number) => {
    const run = runStream(params, beats);
    const hzs = run.melodyEvents.map((ev) => ev.hz!);
    let sum = 0;
    let big = 0;
    for (let i = 1; i < hzs.length; i++) {
      const semi = Math.abs(Z12 * Math.log2(hzs[i] / hzs[i - 1]));
      sum += semi;
      if (semi >= BIG_LEAP_SEMITONES) big++;
    }
    return { mean: sum / (hzs.length - 1), bigFraction: big / (hzs.length - 1), notes: hzs.length };
  };

  it("V2's mean |leap| is not larger than legacy's, and ≥7-semitone leaps are not more frequent", () => {
    for (const seed of MEASUREMENT_SEEDS) {
      const legacy = leapStats(neoOn({ seed, enableMelodyV2: false }), MEASUREMENT_BEATS);
      const v2 = leapStats(neoOn({ seed, enableMelodyV2: true }), MEASUREMENT_BEATS);
      expect(v2.notes).toBeGreaterThan(0);
      expect(
        v2.mean,
        `seed ${seed}: V2 mean |leap| ${v2.mean.toFixed(3)} vs legacy ${legacy.mean.toFixed(3)}`,
      ).toBeLessThanOrEqual(legacy.mean);
      expect(
        v2.bigFraction,
        `seed ${seed}: V2 ≥${BIG_LEAP_SEMITONES}-semitone fraction ${v2.bigFraction.toFixed(4)} vs legacy ${legacy.bigFraction.toFixed(4)}`,
      ).toBeLessThanOrEqual(legacy.bigFraction);
    }
  });
});

describe("Melody V2: backward compatibility (flag off)", () => {
  // Same contract literals as harmony.test.ts (256 beats, full default path,
  // rounded-float hash scheme). V2 off/absent must not move them.
  const PRE_V2: Record<number, { events: number; rngState: number; sha256: string }> = {
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

  const roundFloats = (_key: string, value: unknown): unknown =>
    typeof value === "number" && !Number.isInteger(value)
      ? Number(value.toFixed(EVENT_FLOAT_DIGITS))
      : value;

  const run256 = (params: EngineParams) => {
    const seeded: EngineParams = { ...params, seed: params.seed };
    let state = createInitialState(seeded);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const all: MusicalEvent[] = [];
    for (let i = 0; i < STREAM_BEATS; i++) {
      const { events, nextState } = getMusicalEvents(i, { ...state }, seeded);
      all.push(...events);
      state = nextState;
    }
    const pick = (e: MusicalEvent) => ({
      type: e.type, hz: e.hz, amp: e.amp, subBeatIndex: e.subBeatIndex,
      isGhost: e.isGhost, isClosed: e.isClosed, durationSec: e.durationSec,
      pan: e.pan, timbre: e.timbre, beatIndex: e.beatIndex,
    });
    const h = createHash("sha256");
    for (const e of all) h.update(JSON.stringify(pick(e), roundFloats));
    return { count: all.length, rngState: state.rngState >>> 0, sha256: h.digest("hex") };
  };

  it("flag absent matches the pre-V2 literals for seeds 42/7/99", () => {
    for (const seed of [42, 7, 99] as const) {
      const legacy = PRE_V2[seed];
      const run = run256({ ...baseParams, seed });
      expect(run.count, `seed ${seed} event count`).toBe(legacy.events);
      expect(run.rngState, `seed ${seed} final rngState`).toBe(legacy.rngState);
      expect(run.sha256, `seed ${seed} stream hash`).toBe(legacy.sha256);
    }
  });

  it("flag explicitly false equals flag absent (zero draws either way)", () => {
    for (const seed of [42, 7, 99] as const) {
      const absent = run256({ ...baseParams, seed });
      const explicit = run256({ ...baseParams, seed, enableMelodyV2: false });
      expect(explicit).toEqual(absent);
    }
  });

  it("under V2 the harmony draw still fires exactly at the harmonic boundary", () => {
    // With V2 on, the stream still only diverges from the neo-off stream at
    // the boundary beat (the harmony draw); the V2 lane itself adds no
    // draws anywhere.
    const finalState = (neo: boolean, beats: number): number => {
      const params = neoOn({ enableNeoHarmony: neo, enableMelodyV2: true });
      let state = createInitialState(params);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      for (let i = 0; i < beats; i++) {
        state = getMusicalEvents(i, { ...state }, params).nextState;
      }
      return state.rngState >>> 0;
    };
    const firstBoundary = HARMONIC_CYCLE_BARS * BEATS_PER_BAR;
    expect(finalState(true, firstBoundary)).toBe(finalState(false, firstBoundary));
    expect(finalState(true, firstBoundary + 1)).not.toBe(finalState(false, firstBoundary + 1));
  });
});
