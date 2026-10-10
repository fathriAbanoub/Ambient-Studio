// recipe.ts — the ONE place the UI's generator state becomes an EngineParams
// recipe. Both the live engine (useProceduralEngine) and the offline WAV
// export consume this, and the MCP/HTTP recipe shape is the same EngineParams
// type on the daemon side — defined once in the shared kernel, imported by
// both. Pure function so it round-trip-tests in node (no DOM).
import type { EngineParams } from "@ambient-engine/index";
import type { GeneratorState } from "@/types";

export function buildEngineParams(g: GeneratorState): EngineParams {
  return {
    scale: g.scale,
    rootHz: g.rootHz,
    bpm: g.tempo,
    complexity: g.complexity,
    mix: g.space,
    sceneDurationBars: g.sceneDuration,
    enableScenes: g.enableScenes,
    enableHarmonicLoop: g.enableHarmonicLoop,
    enableBeats: g.enableBeats,
    drone: g.drone.length > 0 ? { layers: g.drone } : undefined,
    sampleBank: g.sampleBank.length > 0 ? g.sampleBank : undefined,
    swing: g.swing,
    drumStyle: g.drumStyle,
    sidechainAmount: g.sidechainAmount,
    seed: g.seed,
    drumLevel: g.drumLevel,
  };
}
