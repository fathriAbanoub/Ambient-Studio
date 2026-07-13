import { describe, it, expect } from "vitest";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  getScenePackScenes,
  getEffectiveSceneParams,
  updateSceneEngine,
  currentScale,
  SCALE_INTERVALS,
  SCENE_PACKS,
  MAX_DRONE_LAYERS,
  type EngineParams,
  type EngineState,
  type MusicalEvent,
  type ScaleName,
  type TimbreMode,
} from "./musicalLogic";

// Moved from two self-executing IIFEs (testDeterminism, testNewMusicalLogic)
// that previously lived at the bottom of musicalLogic.ts and ran on every
// import. See musicalLogic.ts's header comment at their old location for
// why: a hardcoded scale-interval oracle table kept getting flagged by
// SonarCloud as duplicating SCALE_INTERVALS, "fixed" by referencing
// SCALE_INTERVALS on both sides (which made the test tautological), then
// flagged again for that. Test files are excluded from duplication
// analysis, so the independent oracle table below can live here safely.

describe("determinism", () => {
  it("produces identical event sequences across two runs with the same seed", () => {
    const testParams: EngineParams = {
      scale: "majorPent",
      rootHz: 220,
      bpm: 72,
      complexity: 0.35,
      mix: 0.4,
      seed: 42,
      enableScenes: true,
      enableHarmonicLoop: true,
      sceneDurationBars: 32,
      drumLevel: 0.5,
    };

    function runOnce(): MusicalEvent[] {
      let state = createInitialState(testParams);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      const all: MusicalEvent[] = [];
      for (let i = 0; i < 64; i++) {
        const { events, nextState } = getMusicalEvents(
          i,
          { ...state },
          testParams,
        );
        all.push(...events);
        state = nextState;
      }
      return all;
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

    const r1 = runOnce();
    const r2 = runOnce();
    expect(r2.length).toBe(r1.length);
    for (let i = 0; i < r1.length; i++) {
      expect(pick(r2[i]), `event ${i} diverged`).toEqual(pick(r1[i]));
    }
  });
});

describe("scale intervals", () => {
  // Independent oracle — deliberately NOT derived from SCALE_INTERVALS.
  // Restating these catches the bug where someone edits SCALE_INTERVALS
  // incorrectly (e.g. swaps two rows); referencing SCALE_INTERVALS on both
  // sides here would make this test pass under any permutation.
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

  it.each(Object.entries(expectedModes) as Array<[ScaleName, number[]]>)(
    "currentScale(%s) matches the independent oracle",
    (name, expected) => {
      expect(currentScale(name)).toEqual(expected);
    },
  );

  it("currentScale() returns the canonical SCALE_INTERVALS entry (no defensive copy)", () => {
    for (const name of Object.keys(SCALE_INTERVALS) as ScaleName[]) {
      expect(currentScale(name)).toBe(SCALE_INTERVALS[name]);
    }
  });
});

describe("beatless mode (enableBeats: false)", () => {
  const beatlessParams: EngineParams = {
    scale: "ionian",
    rootHz: 220,
    bpm: 60,
    complexity: 1,
    mix: 0.4,
    seed: 7,
    enableScenes: false,
    enableHarmonicLoop: false,
    enableBeats: false,
    drone: {
      layers: [
        { hz: 432, amp: 0.2, pan: -0.5, timbre: "sine" },
        { hz: 528, amp: 0.2, pan: 0, timbre: "triangle" },
        { hz: 741, amp: 0.2, pan: 0.5, timbre: "fm" },
      ],
    },
  };

  it("emits only drone events, one per configured layer", () => {
    const startState = createInitialState(beatlessParams);
    const { events } = getMusicalEvents(0, { ...startState }, beatlessParams);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.type === "drone")).toBe(true);
    expect(events.map((event) => event.hz)).toEqual([432, 528, 741]);
  });

  it("does not advance melodic degree but does advance sixteenthCount by 4 per beat", () => {
    // A1: beatless mode must NOT advance degree (no melodic decisions) but
    // MUST advance sixteenthCount by 4 so a future enableBeats=true toggle
    // resumes the drum grid from the correct phase.
    const startState = createInitialState(beatlessParams);
    const { nextState } = getMusicalEvents(
      0,
      { ...startState },
      beatlessParams,
    );
    expect(nextState.degree).toBe(startState.degree);
    expect(nextState.sixteenthCount).toBe(startState.sixteenthCount + 4);
  });

  it("advances sixteenthCount by exactly 4 per beat across multiple beats", () => {
    let s = createInitialState(beatlessParams);
    const initial = s.sixteenthCount;
    for (let i = 0; i < 5; i++) {
      const { nextState: ns } = getMusicalEvents(i, { ...s }, beatlessParams);
      s = ns;
      expect(s.sixteenthCount, `drift on beat ${i + 1}`).toBe(
        initial + 4 * (i + 1),
      );
    }
  });

  it("clamps drone layer count silently at MAX_DRONE_LAYERS", () => {
    const overParams: EngineParams = {
      ...beatlessParams,
      drone: {
        layers: Array.from({ length: MAX_DRONE_LAYERS + 5 }, (_, k) => ({
          hz: 100 + k,
          amp: 0.1,
          pan: 0,
          timbre: "sine" as TimbreMode,
        })),
      },
    };
    const overState = createInitialState(overParams);
    const { events: overEvents } = getMusicalEvents(
      0,
      { ...overState },
      overParams,
    );
    expect(overEvents).toHaveLength(MAX_DRONE_LAYERS);
    expect(
      overEvents.every((e) => (e.droneLayerIndex ?? 0) < MAX_DRONE_LAYERS),
    ).toBe(true);
  });

  it("filters invalid drone params (NaN hz, negative amp, hz<=0) and falls back NaN pan to 0", () => {
    const invalidParams: EngineParams = {
      ...beatlessParams,
      drone: {
        layers: [
          { hz: Number.NaN, amp: 0.2, pan: 0, timbre: "sine" }, // NaN hz → filtered
          { hz: 432, amp: -0.1, pan: 0, timbre: "sine" }, // negative amp → filtered
          { hz: 528, amp: 0.2, pan: Number.NaN, timbre: "sine" }, // NaN pan → pan falls back to 0, NOT filtered
          { hz: 0, amp: 0.2, pan: 0, timbre: "sine" }, // hz=0 → filtered (layer.hz <= 0)
          { hz: 741, amp: 0.2, pan: 0.5, timbre: "fm" }, // valid
        ],
      },
    };
    const invalidState = createInitialState(invalidParams);
    const { events: invalidEvents } = getMusicalEvents(
      0,
      { ...invalidState },
      invalidParams,
    );
    expect(invalidEvents).toHaveLength(2);
    expect(invalidEvents.map((e) => e.hz)).toEqual([528, 741]);
    const survivorWithNaNPan = invalidEvents.find((e) => e.hz === 528);
    expect(survivorWithNaNPan?.pan).toBe(0);
  });

  it("is deterministic across two runs (mirrors the top-level determinism test for enableBeats: false)", () => {
    function runBeatlessOnce(): MusicalEvent[] {
      let s = createInitialState(beatlessParams);
      s = advanceRngPastNoiseBuffer(s);
      s = initializeBell(s);
      const all: MusicalEvent[] = [];
      for (let i = 0; i < 16; i++) {
        const { events: ev, nextState: ns } = getMusicalEvents(
          i,
          { ...s },
          beatlessParams,
        );
        all.push(...ev);
        s = ns;
      }
      return all;
    }
    const b1 = runBeatlessOnce();
    const b2 = runBeatlessOnce();
    expect(b2.length).toBe(b1.length);
    const pick = (e: MusicalEvent) => ({
      type: e.type,
      hz: e.hz,
      amp: e.amp,
      pan: e.pan,
      beatIndex: e.beatIndex,
    });
    for (let i = 0; i < b1.length; i++) {
      expect(pick(b2[i]), `event ${i} diverged`).toEqual(pick(b1[i]));
    }
  });
});

describe("scene pack lookup", () => {
  // ScenePackName is currently the literal "default" only, so unknown packs
  // are only reachable via an `as any` cast — confirm getScenePackScenes()
  // falls back to the default pack rather than crashing, since a future MCP
  // caller could pass an unrecognized pack name the type system hasn't been
  // widened to accept yet.
  it("returns the default pack for scenePack: 'default'", () => {
    expect(getScenePackScenes({ scenePack: "default" })).toBe(
      SCENE_PACKS.default,
    );
  });

  it("falls back to the default pack when scenePack is omitted", () => {
    expect(getScenePackScenes({})).toBe(SCENE_PACKS.default);
  });

  it("falls back to the default pack for an unrecognized pack name", () => {
    expect(getScenePackScenes({ scenePack: "nonexistent" as any })).toBe(
      SCENE_PACKS.default,
    );
  });
});

describe("scene progress agreement (updateSceneEngine vs getEffectiveSceneParams)", () => {
  // A2/B2: confirm the two functions agree on bpm/mix/scale/complexity even
  // when sceneStartBeat is a non-multiple of BEATS_PER_BAR — the case that
  // used to silently diverge before computeSceneProgress() was extracted as
  // a single shared helper.
  it("agrees on bpm, mix, scale, and complexity for a non-bar-aligned sceneStartBeat", () => {
    const params: EngineParams = {
      scale: "ionian",
      rootHz: 220,
      bpm: 72,
      complexity: 0.35,
      mix: 0.4,
      seed: 11,
      enableScenes: true,
      enableHarmonicLoop: false,
      sceneDurationBars: 8,
    };
    const state: EngineState = {
      beat: 13, // bar 3, beat 1 — non-bar-aligned
      degree: 0,
      lastInterval: 0,
      currentSceneIndex: 0,
      sceneStartBeat: 5, // ← deliberately NOT a multiple of BEATS_PER_BAR
      harmonicLoopIndex: 0,
      currentRootHz: 220,
      targetRootHz: 220,
      rngState: 999,
      panDriftPhase: 0,
      sixteenthCount: 52,
      nextBellBeat: 100,
      currentDensity: 0.7,
      currentTimbre: "sine",
    };

    const sceneResult = updateSceneEngine(state, params);
    const effResult = getEffectiveSceneParams(state, params);

    expect(sceneResult.params.bpm).toBeCloseTo(effResult.bpm, 9);
    expect(sceneResult.params.mix).toBeCloseTo(effResult.mix, 9);
    expect(sceneResult.params.scale).toBe(effResult.scale);
    expect(sceneResult.params.complexity).toBeCloseTo(effResult.complexity, 9);
  });
});
