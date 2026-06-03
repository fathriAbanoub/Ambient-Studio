/**
 * @ambient-engine/core — Pure musical logic + synthesis shells for ambient music generation.
 *
 * Two-layer architecture:
 *   1. musicalLogic.ts — Pure algorithm, zero Web Audio deps, fully deterministic
 *   2. LiveEngine.ts   — Browser real-time playback via Web Audio API
 *   3. renderAmbient.ts — Browser offline WAV export via OfflineAudioContext
 */

// Pure logic (importable in Node.js)
export {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  getSceneName,
  getEffectiveSceneParams,
  mulberry32Next,
  SCENES,
  NOISE_BUFFER_SAMPLES,
  type EngineParams,
  type EngineState,
  type MusicalEvent,
  type TimbreMode,
  type Scene,
} from './musicalLogic';

// Browser-only shells
export { LiveEngine } from './LiveEngine';
export {
  renderAmbient,
  audioBufferToWav,
  renderAndDownloadWav,
  type RenderProgress,
} from './renderAmbient';
