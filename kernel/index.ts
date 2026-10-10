/**
 * @ambient-engine/core — Pure musical logic + synthesis shells for ambient music generation.
 *
 * Three-layer architecture:
 *   1. musicalLogic.ts — Pure algorithm, zero Web Audio deps, fully deterministic
 *   2. LiveEngine.ts   — Browser real-time playback via Web Audio API
 *   3. renderAmbient.ts — Browser offline WAV export via OfflineAudioContext
 *
 * Layered additions (swing / drumStyle / sidechain / scheduling helpers):
 *   ✅ ADD (DrumStyle type export): Surfaced as a public type export so
 *       callers can name the literal union without re-declaring it.
 *       EngineParams.swing / drumStyle / sidechainAmount are already
 *       exported via `type EngineParams` — no separate export needed.
 *   ✅ ADD (scheduling helpers re-export): The pure shell-side helpers in
 *       ./scheduling (getSubBeatEventTime, getSidechainDuckShape, plus
 *       the MAX_SWING / SIDECHAIN_* constants and the SidechainDuckShape
 *       type) are re-exported here so external callers can import them
 *       from the package root. Both LiveEngine and renderAmbient import
 *       them directly from ./scheduling for clarity, but the public
 *       surface should also expose them.
 */

// Pure logic (importable in Node.js)
export {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  playableSampleEntries,
  getSceneName,
  getEffectiveSceneParams,
  getScenePackScenes,
  mulberry32Next,
  SCENES,
  SCENE_PACKS,
  SCALE_INTERVALS,
  MAX_DRONE_LAYERS,
  DRONE_FADE_SEC,
  NOISE_BUFFER_SAMPLES,
  type EngineParams,
  type EngineState,
  type MusicalEvent,
  type TimbreMode,
  type ScaleName,
  type ScenePackName,
  // ✅ ADD (DrumStyle): named type export so callers can name the literal
  // union without re-declaring it. Used by EngineParams.drumStyle.
  type DrumStyle,
  type DroneParams,
  type DroneLayerParams,
  type SampleBankEntry,
  type Scene,
} from "./musicalLogic";

export {
  decodeSampleBank,
  decodeNewSampleBankEntries,
  getDecodedSampleBuffer,
  scheduleSamplePlayback,
  type DecodedSampleBank,
} from "./sampleBank";

// ✅ ADD (scheduling helpers): pure shell-side timing helpers used by
// LiveEngine and renderAmbient. Re-exported here for external callers.
export {
  getSwingOffsetSec,
  getSubBeatEventTime,
  getSidechainDuckShape,
  MAX_SWING,
  SIDECHAIN_MAX_DUCK_DB,
  SIDECHAIN_ATTACK_SEC,
  SIDECHAIN_RELEASE_SEC,
  TONAL_BUS_GAIN,
  ADSR_MELODY,
  ADSR_PAD_L,
  ADSR_PAD_R,
  ADSR_BASS,
  ADSR_BELL,
  resolveToneEnvelope,
  type SidechainDuckShape,
  type ToneEnvelope,
} from "./scheduling";

// Browser-only shells
export { LiveEngine } from "./LiveEngine";
export {
  renderAmbient,
  audioBufferToWav,
  renderAndDownloadWav,
  type RenderProgress,
} from "./renderAmbient";
