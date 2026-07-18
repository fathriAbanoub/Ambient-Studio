import { describe, it, expect } from "vitest";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
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
  type DrumStyle,
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
    expect(r2).toHaveLength(r1.length);
    for (let i = 0; i < r1.length; i++) {
      expect(pick(r2[i]), `event ${i} diverged`).toEqual(pick(r1[i]));
    }
  });
});

describe("sample bank / soundscape lane", () => {
  const sampleEntry = {
    id: "dummy-1sec",
    url: "/samples/dummy-1sec.wav",
    gain: 0.4,
    pan: -0.25,
  };
  const sampleParams: EngineParams = {
    scale: "majorPent",
    rootHz: 220,
    bpm: 72,
    complexity: 0.35,
    mix: 0.4,
    seed: 42,
    enableScenes: false,
    enableHarmonicLoop: false,
    drumLevel: 0.5,
    sampleBank: [sampleEntry],
  };

  function initializedSampleState(): EngineState {
    let state = createInitialState(sampleParams);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    return initializeSampleLane(state, sampleParams);
  }

  function runSampleLane(): { firstSampleBeat: number; events: MusicalEvent[] } {
    let state = initializedSampleState();
    const firstSampleBeat = state.nextSampleBeat;
    const events: MusicalEvent[] = [];
    for (let i = 0; i <= firstSampleBeat + 48; i++) {
      const result = getMusicalEvents(state.beat, { ...state }, sampleParams);
      events.push(...result.events);
      state = result.nextState;
    }
    return { firstSampleBeat, events };
  }

  it("does not make a non-empty sample bank eligible on beat 0", () => {
    expect(initializedSampleState().nextSampleBeat).toBeGreaterThan(0);
  });

  it("does not emit samples before the initialized lane beat", () => {
    const { firstSampleBeat, events } = runSampleLane();
    expect(
      events
        .filter((event) => event.type === "sample")
        .every((event) => event.beatIndex >= firstSampleBeat),
    ).toBe(true);
  });

  it("emits at least one sample over the eligible window", () => {
    const { events } = runSampleLane();
    const samples = events.filter((event) => event.type === "sample");
    expect(samples.length).toBeGreaterThan(0);
  });

  it("preserves the configured sample payload", () => {
    const { events } = runSampleLane();
    const samples = events.filter((event) => event.type === "sample");
    for (const event of samples) {
      expect(event.sampleId).toBe(sampleEntry.id);
      expect(event.amp).toBe(sampleEntry.gain);
      expect(event.pan).toBe(sampleEntry.pan);
      expect(event.subBeatIndex).toBe(0);
    }
  });

  it("leaves absent and empty sample banks as a no-op", () => {
    for (const sampleBank of [undefined, []]) {
      const params = { ...sampleParams, sampleBank };
      const initial = createInitialState(params);
      expect(initial.nextSampleBeat).toBe(0);
      expect(initializeSampleLane(initial, params).nextSampleBeat).toBe(0);
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

  it("emits only drone events, one per configured layer, on the first beat", () => {
    const startState = createInitialState(beatlessParams);
    const { events } = getMusicalEvents(0, { ...startState }, beatlessParams);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.type === "drone")).toBe(true);
    expect(events.map((event) => event.hz)).toEqual([432, 528, 741]);
  });

  // ✅ ADD (droneLayersStarted latch): beatless mode must emit drone events
  // exactly ONCE (on the first beat) and then latch. Subsequent beats must
  // emit zero events. This is the core of the one-shot drone behavior —
  // without the latch, every beatless beat would re-emit all drone layers,
  // which is wasteful and would confuse the synthesis shells (LiveEngine
  // would re-trigger amp/pan automation every beat; renderAmbient's
  // scheduledLayers set would silently drop them, masking the bug).
  it("latches after the first beat: subsequent beats emit zero drone events", () => {
    const startState = createInitialState(beatlessParams);
    let state = startState;
    const eventsPerBeat: MusicalEvent[][] = [];
    for (let i = 0; i < 5; i++) {
      const { events, nextState } = getMusicalEvents(
        state.beat,
        { ...state },
        beatlessParams,
      );
      eventsPerBeat.push(events);
      state = nextState;
    }
    // Beat 0: 3 drone events (one per layer)
    expect(eventsPerBeat[0]).toHaveLength(3);
    // Beats 1-4: zero events (latched)
    for (let i = 1; i < 5; i++) {
      expect(
        eventsPerBeat[i],
        `beat ${i} should have emitted zero events`,
      ).toHaveLength(0);
    }
    // Latch flag must be true after the first beat
    expect(state.droneLayersStarted).toBe(true);
  });

  // ✅ ADD (droneLayersStarted initial value): createInitialState must
  // initialize the latch to false so the first beatless beat emits drones.
  it("createInitialState initializes droneLayersStarted to false", () => {
    const state = createInitialState(beatlessParams);
    expect(state.droneLayersStarted).toBe(false);
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

  // ✅ ADD (beat advances in beatless mode): beatless mode still increments
  // s.beat so scene/harmonic-loop boundaries continue to fire on the same
  // beat grid as beat-enabled mode. Without this, a beatless render would
  // never trigger scene transitions.
  it("advances beat by 1 per call (beat grid continues in beatless mode)", () => {
    const startState = createInitialState(beatlessParams);
    let state = startState;
    for (let i = 0; i < 4; i++) {
      const { nextState } = getMusicalEvents(
        state.beat,
        { ...state },
        beatlessParams,
      );
      expect(nextState.beat).toBe(state.beat + 1);
      state = nextState;
    }
    expect(state.beat).toBe(startState.beat + 4);
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
    expect(b2).toHaveLength(b1.length);
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

  // ✅ ADD (latch reset on beatless ↔ beat-enabled transition): When the
  // engine transitions from beatless → beat-enabled → beatless, the second
  // beatless phase must re-emit drone events. The beat-enabled path resets
  // s.droneLayersStarted = false so the latch from the first beatless phase
  // doesn't suppress the second. Without that reset, the second beatless
  // phase would emit zero drone events (the latch would stay latched).
  it("re-emits drone events after a beatless → beat-enabled → beatless cycle", () => {
    // Phase 1: beatless. First beat emits 3 drones, then latches.
    let state = createInitialState(beatlessParams);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);

    const phase1 = getMusicalEvents(state.beat, { ...state }, beatlessParams);
    expect(phase1.events).toHaveLength(3);
    expect(phase1.events.every((e) => e.type === "drone")).toBe(true);
    expect(phase1.nextState.droneLayersStarted).toBe(true);
    state = phase1.nextState;

    // Run a couple more beatless beats — should emit zero events (latched).
    const phase1b = getMusicalEvents(state.beat, { ...state }, beatlessParams);
    expect(phase1b.events).toHaveLength(0);
    state = phase1b.nextState;

    // Phase 2: toggle enableBeats back to true. The beat-enabled path must
    // reset droneLayersStarted = false. Beat-enabled beats emit drones every
    // beat (no latch), so we expect at least one drone event here.
    const beatEnabledParams: EngineParams = {
      ...beatlessParams,
      enableBeats: true,
    };
    const phase2 = getMusicalEvents(
      state.beat,
      { ...state },
      beatEnabledParams,
    );
    expect(phase2.nextState.droneLayersStarted).toBe(false);
    const phase2Drones = phase2.events.filter((e) => e.type === "drone");
    expect(phase2Drones.length).toBeGreaterThan(0);
    state = phase2.nextState;

    // Phase 3: toggle enableBeats back to false. The latch was reset in
    // phase 2, so the FIRST beatless beat here must re-emit drones.
    const phase3 = getMusicalEvents(state.beat, { ...state }, beatlessParams);
    const phase3Drones = phase3.events.filter((e) => e.type === "drone");
    expect(phase3Drones).toHaveLength(3);
    expect(phase3Drones.map((e) => e.hz)).toEqual([432, 528, 741]);
    expect(phase3.nextState.droneLayersStarted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ ADD (drum styles): Tests for the new `drumStyle` param.
// "euclideanTrap" (default) preserves the original 5/16 euclidean kick
// pattern. "fourFloor" fires a kick on every quarter note (subBeatIndex 0
// of each beat). Both must coexist with the existing snare/hihat patterns
// unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe("drum styles (drumStyle param)", () => {
  const baseParams: EngineParams = {
    scale: "ionian",
    rootHz: 220,
    bpm: 120,
    complexity: 0.5,
    mix: 0.4,
    seed: 99,
    enableScenes: false,
    enableHarmonicLoop: false,
    drumLevel: 1, // full drum level so we can count kicks reliably
  };

  it("defaults to euclideanTrap when drumStyle is omitted", () => {
    // Run 4 beats with the default (omitted) drumStyle and verify the kick
    // count matches the 5/16 euclidean pattern, NOT the fourFloor pattern
    // (which would be 4 kicks over 4 beats). The 5/16 euclidean pattern
    // over 16 sixteenths fires at steps 0, 4, 7, 10, 13 = 5 kicks.
    const params: EngineParams = { ...baseParams };
    let state = createInitialState(params);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const kicks: MusicalEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const { events, nextState } = getMusicalEvents(
        state.beat,
        { ...state },
        params,
      );
      kicks.push(...events.filter((e) => e.type === "kick"));
      state = nextState;
    }
    // 5/16 euclidean over 16 steps → 5 kicks. fourFloor would give 4.
    expect(kicks).toHaveLength(5);
  });

  it('explicit drumStyle: "euclideanTrap" matches the default (omitted) behavior', () => {
    function runKicks(drumStyle: DrumStyle | undefined): MusicalEvent[] {
      const params: EngineParams = { ...baseParams, drumStyle };
      let state = createInitialState(params);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      const kicks: MusicalEvent[] = [];
      for (let i = 0; i < 4; i++) {
        const { events, nextState } = getMusicalEvents(
          state.beat,
          { ...state },
          params,
        );
        kicks.push(...events.filter((e) => e.type === "kick"));
        state = nextState;
      }
      return kicks;
    }
    const omitted = runKicks(undefined);
    const explicit = runKicks("euclideanTrap");
    expect(explicit).toHaveLength(omitted.length);
    expect(explicit.map((k) => k.subBeatIndex)).toEqual(
      omitted.map((k) => k.subBeatIndex),
    );
  });

  it('drumStyle: "fourFloor" fires exactly one kick per beat on subBeatIndex 0', () => {
    const params: EngineParams = { ...baseParams, drumStyle: "fourFloor" };
    let state = createInitialState(params);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const kicks: MusicalEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const { events, nextState } = getMusicalEvents(
        state.beat,
        { ...state },
        params,
      );
      kicks.push(...events.filter((e) => e.type === "kick"));
      state = nextState;
    }
    // One kick per beat = 4 kicks over 4 beats
    expect(kicks).toHaveLength(4);
    // All kicks must be on the quarter-note grid (subBeatIndex 0)
    expect(kicks.every((k) => k.subBeatIndex === 0)).toBe(true);
  });

  it('drumStyle: "fourFloor" does not alter snare or hihat patterns', () => {
    // The fourFloor change only affects the kick pattern. Snare (on beats
    // 4 and 12 of the 16-step grid) and hihat (9/16 euclidean) must be
    // identical between euclideanTrap and fourFloor.
    function runNonKickEvents(drumStyle: DrumStyle): MusicalEvent[] {
      const params: EngineParams = { ...baseParams, drumStyle };
      let state = createInitialState(params);
      state = advanceRngPastNoiseBuffer(state);
      state = initializeBell(state);
      const nonKick: MusicalEvent[] = [];
      for (let i = 0; i < 4; i++) {
        const { events, nextState } = getMusicalEvents(
          state.beat,
          { ...state },
          params,
        );
        nonKick.push(
          ...events.filter((e) => e.type !== "kick" && e.type !== "drone"),
        );
        state = nextState;
      }
      return nonKick;
    }
    const trapNonKick = runNonKickEvents("euclideanTrap");
    const fourFloorNonKick = runNonKickEvents("fourFloor");

    // Same count of non-kick, non-drone events
    expect(fourFloorNonKick).toHaveLength(trapNonKick.length);
    // Same types in the same order
    expect(
      fourFloorNonKick.map((e) => `${e.type}@${e.subBeatIndex}`).join(","),
    ).toBe(trapNonKick.map((e) => `${e.type}@${e.subBeatIndex}`).join(","));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ ADD (shell-only params are no-ops in musicalLogic): swing and
// sidechainAmount are pure values that musicalLogic does NOT consume. They
// are read by the synthesis shells (LiveEngine, renderAmbient) at the
// subBeatIndex → eventTime conversion (swing) and on the tonal-bus gain
// (sidechain). This test guards against a future edit accidentally reading
// them inside musicalLogic, which would break determinism (the RNG stream
// would advance differently depending on whether swing/sidechain are set).
// ─────────────────────────────────────────────────────────────────────────────

describe("shell-only params (swing, sidechainAmount) are no-ops in musicalLogic", () => {
  const baseParams: EngineParams = {
    scale: "ionian",
    rootHz: 220,
    bpm: 72,
    complexity: 0.35,
    mix: 0.4,
    seed: 42,
    enableScenes: false,
    enableHarmonicLoop: false,
    drumLevel: 0.5,
  };

  function runEvents(params: EngineParams): MusicalEvent[] {
    let state = createInitialState(params);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const all: MusicalEvent[] = [];
    for (let i = 0; i < 16; i++) {
      const { events, nextState } = getMusicalEvents(i, { ...state }, params);
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
    pan: e.pan,
    beatIndex: e.beatIndex,
  });

  it("swing does not change the event stream (it's applied by the shell, not musicalLogic)", () => {
    const withoutSwing = runEvents(baseParams);
    const withSwing = runEvents({ ...baseParams, swing: 0.5 });
    expect(withSwing).toHaveLength(withoutSwing.length);
    for (let i = 0; i < withoutSwing.length; i++) {
      expect(pick(withSwing[i]), `event ${i} diverged`).toEqual(
        pick(withoutSwing[i]),
      );
    }
  });

  it("sidechainAmount does not change the event stream (it's applied by the shell, not musicalLogic)", () => {
    const withoutSidechain = runEvents(baseParams);
    const withSidechain = runEvents({ ...baseParams, sidechainAmount: 0.8 });
    expect(withSidechain).toHaveLength(withoutSidechain.length);
    for (let i = 0; i < withoutSidechain.length; i++) {
      expect(pick(withSidechain[i]), `event ${i} diverged`).toEqual(
        pick(withoutSidechain[i]),
      );
    }
  });

  it("all three new params together do not change the event stream", () => {
    const withoutNew = runEvents(baseParams);
    const withAllNew = runEvents({
      ...baseParams,
      swing: 0.3,
      drumStyle: "euclideanTrap", // default — must not change anything vs omitted
      sidechainAmount: 0.6,
    });
    expect(withAllNew).toHaveLength(withoutNew.length);
    for (let i = 0; i < withoutNew.length; i++) {
      expect(pick(withAllNew[i]), `event ${i} diverged`).toEqual(
        pick(withoutNew[i]),
      );
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
      nextSampleBeat: 0,
      currentDensity: 0.7,
      currentTimbre: "sine",
      // ✅ ADD: droneLayersStarted is now a required field on EngineState.
      // Set to false here — this test doesn't exercise beatless mode, so the
      // latch value is irrelevant to the scene-progress agreement check.
      droneLayersStarted: false,
    };

    const sceneResult = updateSceneEngine(state, params);
    const effResult = getEffectiveSceneParams(state, params);

    expect(sceneResult.params.bpm).toBeCloseTo(effResult.bpm, 9);
    expect(sceneResult.params.mix).toBeCloseTo(effResult.mix, 9);
    expect(sceneResult.params.scale).toBe(effResult.scale);
    expect(sceneResult.params.complexity).toBeCloseTo(effResult.complexity, 9);
  });
});
