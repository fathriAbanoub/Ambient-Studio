/**
 * bench/B/engine_exports.ts — bundle entry that re-exports the REAL,
 * unmodified offline renderer so B harnesses (browser + Node) can import it
 * without touching the source files.
 */
export {
  renderAmbient,
  audioBufferToWav,
} from "../../kernel/renderAmbient";
export type { RenderProgress } from "../../kernel/renderAmbient";
export type { EngineParams } from "../../kernel/musicalLogic";

// Bench-side copy of the store defaults (frontend/src/store/studioStore.ts:214,
// useProceduralEngine.ts:13) — the params the UI would actually send.
export const REPO_DEFAULT_PARAMS = {
  scale: "majorPent" as const,
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
