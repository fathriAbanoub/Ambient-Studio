// Studio types for AMBIENT STUDIO — live-play generative UI only.
// (The manual multitrack mixer / FastAPI job types were removed with Product B.)

import type {
  ScaleName,
  DrumStyle,
  DroneLayerParams,
  SampleBankEntry,
} from "@ambient-engine/index";

export interface LogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: "ok" | "err" | "info" | "";
}

/**
 * UI-only `id` for React keys / store lookups.
 * Engine code must keep reading only the DroneLayerParams fields and must not
 * assume `id` exists on layers it receives.
 */
export type DroneLayer = DroneLayerParams & { id: string };

export interface GeneratorState {
  isRunning: boolean;
  seed: number;
  rootHz: number; // tuning anchor frequency (kernel EngineParams.rootHz)
  enableScenes: boolean;
  enableHarmonicLoop: boolean; // kernel EngineParams.enableHarmonicLoop
  sceneDuration: number; // bars: 16, 32, 64
  tempo: number; // 40-120 BPM
  complexity: number; // 0-1
  space: number; // 0-1 (mix/delay)
  drumLevel: number; // 0-1
  currentScene: string;
  scale: ScaleName;
  enableBeats: boolean;
  drone: DroneLayer[];
  swing: number; // 0..MAX_SWING
  drumStyle: DrumStyle;
  sidechainAmount: number; // 0..1
  sampleBank: SampleBankEntry[];
}

export type {
  ScaleName,
  DrumStyle,
  DroneLayerParams,
  SampleBankEntry,
};
