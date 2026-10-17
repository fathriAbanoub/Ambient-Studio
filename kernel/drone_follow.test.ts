import { describe, it, expect } from "vitest";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  chordRootHz,
  isHarmonicCycleBoundary,
  SEMITONES_PER_OCTAVE,
  type EngineParams,
  type MusicalEvent,
} from "./musicalLogic";

// Drone layers under Neo-Harmony: with the flag on every emitted drone hz is
// scaled by the folded chord-root ratio (chordRootHz / params.rootHz), so a
// fixed drone tracks each 8-bar chord change instead of holding an absolute
// pitch that clashes with 6 of 12 chord roots. These guards pin: verbatim hz
// with the flag off or absent, chord-relative pitch-class invariance with the
// flag on, zero new RNG draws in both modes, and the static-root pin
// (enableHarmonicLoop === false) keeping drones absolute.

const PROBE_SEEDS = [42, 7, 99] as const;
// Long enough to cross several harmonic boundaries (32, 64, …) so the chord
// walk actually retargets the drone mid-run.
const PROBE_BEATS = 256;
const ROOT_HZ = 220;
// Layer set at root, equal-tempered fifth and octave — exact float ratios of
// ROOT_HZ, so flag-off equality can be asserted with ===.
const FIFTH_SEMITONES = 7;
const OCTAVE_SEMITONES = 12;
const FIFTH_HZ = ROOT_HZ * Math.pow(2, FIFTH_SEMITONES / SEMITONES_PER_OCTAVE);
const OCTAVE_HZ = ROOT_HZ * Math.pow(2, OCTAVE_SEMITONES / SEMITONES_PER_OCTAVE);
const DRONE_AMP = 0.15;
const DRONE_PAN = 0;
const LAYERS = [
  { hz: ROOT_HZ, amp: DRONE_AMP, pan: DRONE_PAN, timbre: "sine" as const },
  { hz: FIFTH_HZ, amp: DRONE_AMP, pan: DRONE_PAN, timbre: "sine" as const },
  { hz: OCTAVE_HZ, amp: DRONE_AMP, pan: DRONE_PAN, timbre: "sine" as const },
];

const baseParams: EngineParams = {
  scale: "majorPent",
  rootHz: ROOT_HZ,
  bpm: 72,
  complexity: 0.35,
  mix: 0.4,
  enableScenes: true,
  enableHarmonicLoop: true,
  sceneDurationBars: 32,
  drumLevel: 0.5,
  drone: { layers: LAYERS },
};

const mod12 = (pc: number): number =>
  ((pc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;

interface DroneRun {
  /** Drone events per beat (empty arrays where the lane is silent). */
  droneEventsByBeat: MusicalEvent[][];
  /** Post-update chord root pitch class per beat. */
  chordRootPcByBeat: number[];
  rngState: number;
}

function runDrones(params: EngineParams, beats: number): DroneRun {
  let state = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  const droneEventsByBeat: MusicalEvent[][] = [];
  const chordRootPcByBeat: number[] = [];
  for (let beat = 0; beat < beats; beat++) {
    const { events, nextState } = getMusicalEvents(beat, { ...state }, params);
    droneEventsByBeat.push(events.filter((ev) => ev.type === "drone"));
    chordRootPcByBeat.push(nextState.chordRootPc);
    state = nextState;
  }
  return { droneEventsByBeat, chordRootPcByBeat, rngState: state.rngState >>> 0 };
}

const allDroneEvents = (run: DroneRun): Array<MusicalEvent & { hz: number }> => {
  const out: Array<MusicalEvent & { hz: number }> = [];
  for (const evs of run.droneEventsByBeat) {
    for (const ev of evs) {
      if (ev.hz !== undefined) out.push(ev as MusicalEvent & { hz: number });
    }
  }
  return out;
};

describe("drone layers: flag off and absent emit the layer hz verbatim", () => {
  for (const seed of PROBE_SEEDS) {
    it(`seed ${seed}: every drone event hz === its layer hz`, () => {
      for (const neo of [undefined, false] as const) {
        const params: EngineParams =
          neo === undefined
            ? { ...baseParams, seed }
            : { ...baseParams, seed, enableNeoHarmony: neo };
        const run = runDrones(params, PROBE_BEATS);
        const events = allDroneEvents(run);
        expect(events.length, "the drone lane produced events").toBeGreaterThan(0);
        for (const ev of events) {
          const layer = LAYERS[ev.droneLayerIndex ?? -1];
          expect(layer, `layer index ${ev.droneLayerIndex}`).toBeDefined();
          expect(
            ev.hz,
            `beat ${ev.beatIndex} layer ${ev.droneLayerIndex}`,
          ).toBe(layer.hz);
        }
      }
    });
  }
});

describe("drone layers: flag on follows the chord root", () => {
  const expectedLayerPcs = LAYERS.map((layer) =>
    mod12(
      Math.round(
        SEMITONES_PER_OCTAVE * Math.log2(layer.hz / chordRootHz(ROOT_HZ, 0)),
      ),
    ),
  );

  for (const seed of PROBE_SEEDS) {
    it(`seed ${seed}: pitch class relative to the chord root is beat-0-invariant off the boundary beats`, () => {
      const params: EngineParams = { ...baseParams, seed, enableNeoHarmony: true };
      const run = runDrones(params, PROBE_BEATS);
      const events = allDroneEvents(run);
      expect(events.length, "the drone lane produced events").toBeGreaterThan(0);

      for (const ev of events) {
        const chordPc = run.chordRootPcByBeat[ev.beatIndex];
        const relPc = mod12(
          Math.round(
            SEMITONES_PER_OCTAVE *
              Math.log2(ev.hz / chordRootHz(ROOT_HZ, chordPc)),
          ),
        );
        // Boundary beats are exempt: the shells' 600 ms root slew sounds the
        // old→new transition there by design (same exemption as the pad/bass
        // pool audits).
        if (isHarmonicCycleBoundary(ev.beatIndex)) continue;
        expect(
          relPc,
          `beat ${ev.beatIndex} layer ${ev.droneLayerIndex} vs chord pc ${chordPc}`,
        ).toBe(expectedLayerPcs[ev.droneLayerIndex ?? -1]);
      }

      // Not vacuous: the chord walk moved, and the fold actually retargeted
      // at least one drone event away from its absolute layer hz.
      expect(new Set(run.chordRootPcByBeat).size, "the chord walk moved").toBeGreaterThan(1);
      expect(
        events.some((ev) => ev.hz !== LAYERS[ev.droneLayerIndex ?? -1].hz),
        "no drone event was ever retargeted",
      ).toBe(true);
    });
  }

  it("zero new draws: final rngState equals a run without drone layers (flag on and off)", () => {
    for (const neo of [true, false] as const) {
      const withLayers = runDrones({ ...baseParams, seed: 42, enableNeoHarmony: neo }, PROBE_BEATS);
      const noLayers = runDrones(
        { ...baseParams, drone: undefined, seed: 42, enableNeoHarmony: neo },
        PROBE_BEATS,
      );
      expect(withLayers.rngState, `enableNeoHarmony ${neo}`).toBe(noLayers.rngState);
    }
  });

  it("enableHarmonicLoop === false with neo on: chord pinned to the tonic, drones stay absolute", () => {
    const params: EngineParams = {
      ...baseParams,
      seed: 42,
      enableNeoHarmony: true,
      enableHarmonicLoop: false,
    };
    const run = runDrones(params, PROBE_BEATS);
    const events = allDroneEvents(run);
    expect(events.length, "the drone lane produced events").toBeGreaterThan(0);
    for (const pc of run.chordRootPcByBeat) {
      expect(pc, "the chord root pitch class under the static-root pin").toBe(0);
    }
    for (const ev of events) {
      expect(ev.hz, `beat ${ev.beatIndex} layer ${ev.droneLayerIndex}`).toBe(
        LAYERS[ev.droneLayerIndex ?? -1].hz,
      );
    }
  });
});
