// recipe.test.ts — round-trip check for every generator parameter: drive the
// real store actions, build the real recipe, assert the EngineParams surface.
// This is the "control actually reaches the render" guarantee at logic level;
// the DOM→store hop is covered by tests/round-trip.spec.ts (Playwright).
import { describe, it, expect, beforeEach } from "vitest";
import { useStudioStore } from "@/store/studioStore";
import { buildEngineParams } from "@/lib/recipe";
import { MAX_DRONE_LAYERS, MAX_SWING } from "@ambient-engine/index";

describe("buildEngineParams round-trip", () => {
  beforeEach(() => {
    useStudioStore.setState({
      generator: {
        isRunning: false,
        seed: 42,
        rootHz: 220,
        enableScenes: true,
        enableHarmonicLoop: true,
        sceneDuration: 32,
        tempo: 72,
        complexity: 0.35,
        space: 0.4,
        drumLevel: 0.5,
        currentScene: "Calm",
        scale: "majorPent",
        enableBeats: true,
        drone: [],
        swing: 0,
        drumStyle: "euclideanTrap",
        sidechainAmount: 0,
        sampleBank: [],
      },
    });
  });

  it("defaults map to the documented kernel defaults", () => {
    const p = buildEngineParams(useStudioStore.getState().generator);
    expect(p).toMatchObject({
      scale: "majorPent",
      rootHz: 220,
      bpm: 72,
      complexity: 0.35,
      mix: 0.4,
      sceneDurationBars: 32,
      enableScenes: true,
      enableHarmonicLoop: true,
      enableBeats: true,
      swing: 0,
      drumStyle: "euclideanTrap",
      sidechainAmount: 0,
      seed: 42,
      drumLevel: 0.5,
    });
    expect(p.drone).toBeUndefined();
    expect(p.sampleBank).toBeUndefined();
  });

  it("every previously-hidden EngineParams field round-trips through store actions", () => {
    const s = useStudioStore.getState();
    s.setGeneratorRootHz(196);
    s.setGeneratorEnableHarmonicLoop(false);
    const p = buildEngineParams(useStudioStore.getState().generator);
    expect(p.rootHz).toBe(196);
    expect(p.enableHarmonicLoop).toBe(false);
  });

  it("drone layer detuneCents and sweepSec round-trip", () => {
    const s = useStudioStore.getState();
    s.addDroneLayer();
    const layer = useStudioStore.getState().generator.drone[0];
    s.updateDroneLayer(layer.id, { hz: 110, detuneCents: -7, sweepSec: 3.5 });
    const p = buildEngineParams(useStudioStore.getState().generator);
    expect(p.drone?.layers[0]).toMatchObject({ hz: 110, detuneCents: -7, sweepSec: 3.5 });
  });

  it("sample bank entry gain and pan round-trip", () => {
    const s = useStudioStore.getState();
    s.addSampleBankEntry({ id: "test|tone.wav", url: "blob:fake", gain: 1, pan: 0 });
    s.updateSampleBankEntry("test|tone.wav", { gain: 1.25, pan: -0.4 });
    const p = buildEngineParams(useStudioStore.getState().generator);
    expect(p.sampleBank?.[0]).toMatchObject({ id: "test|tone.wav", gain: 1.25, pan: -0.4 });
  });

  it("all long-standing controls still round-trip", () => {
    const s = useStudioStore.getState();
    s.setGeneratorSeed(777);
    s.setGeneratorScale("locrian");
    s.setGeneratorTempo(96);
    s.setGeneratorComplexity(0.8);
    s.setGeneratorSpace(0.15);
    s.setGeneratorDrumLevel(0.9);
    s.setGeneratorSceneDuration(64);
    s.setGeneratorEnableScenes(false);
    s.setGeneratorEnableBeats(false);
    s.setGeneratorSwing(MAX_SWING);
    s.setGeneratorDrumStyle("fourFloor");
    s.setGeneratorSidechainAmount(0.7);
    const p = buildEngineParams(useStudioStore.getState().generator);
    expect(p).toMatchObject({
      seed: 777,
      scale: "locrian",
      bpm: 96,
      complexity: 0.8,
      mix: 0.15,
      drumLevel: 0.9,
      sceneDurationBars: 64,
      enableScenes: false,
      enableBeats: false,
      swing: MAX_SWING,
      drumStyle: "fourFloor",
      sidechainAmount: 0.7,
    });
  });

  it("respects the kernel's MAX_DRONE_LAYERS cap", () => {
    const s = useStudioStore.getState();
    for (let i = 0; i < MAX_DRONE_LAYERS + 2; i++) s.addDroneLayer();
    expect(useStudioStore.getState().generator.drone.length).toBe(MAX_DRONE_LAYERS);
  });
});
