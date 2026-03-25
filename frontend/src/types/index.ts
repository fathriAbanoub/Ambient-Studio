// Track and studio types for AMBIENT STUDIO

export interface Track {
  id: string;
  name: string;
  file: File | null;
  buffer: AudioBuffer | null;
  loaded: boolean;
  volume: number; // 0–150 (maps to 0.0–1.5)
  pan: number; // -100 to +100 (maps to -1.0 to 1.0)
  muted: boolean;
  solo: boolean;
  color: string;
  duration: number; // Duration in seconds
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: "ok" | "err" | "info" | "";
}

export interface Preset {
  volumes: number[];
  eq: number[];
}

export const PRESETS: Record<string, Preset> = {
  Forest: {
    volumes: [1.0, 0.8, 0.6, 0.4, 0.3, 0.2, 0.1, 0.0],
    eq: [2, 1, 0, -1, 0, 1, 2],
  },
  Ocean: {
    volumes: [0.9, 1.0, 0.7, 0.5, 0.3, 0.2, 0.1, 0.0],
    eq: [3, 2, 1, 0, -1, 0, 1],
  },
  Space: {
    volumes: [0.5, 0.6, 1.0, 0.8, 0.4, 0.3, 0.2, 0.1],
    eq: [-2, 0, 2, 3, 2, 0, -1],
  },
  Café: {
    volumes: [0.3, 0.4, 0.5, 0.7, 0.9, 0.8, 0.5, 0.2],
    eq: [-1, 0, 1, 2, 1, 0, 0],
  },
};

export const TRACK_COLORS = [
  "#00e5ff", // cyan
  "#7c4dff", // purple
  "#00e676", // green
  "#ff6b35", // orange
  "#ffd740", // yellow
  "#ff4081", // pink
  "#64ffda", // teal
  "#b388ff", // lavender
];

export interface EqBand {
  label: string;
  freq: number;
  type: BiquadFilterType;
}

export const EQ_BANDS: EqBand[] = [
  { label: "Sub", freq: 60, type: "lowshelf" },
  { label: "Bass", freq: 200, type: "peaking" },
  { label: "Low-Mid", freq: 500, type: "peaking" },
  { label: "Mid", freq: 1000, type: "peaking" },
  { label: "Upper-Mid", freq: 3000, type: "peaking" },
  { label: "Presence", freq: 8000, type: "peaking" },
  { label: "Air", freq: 16000, type: "highshelf" },
];

export type BackendStatus = "idle" | "playing" | "exporting" | "offline";

// ── Job-related types ──────────────────────────────────────────────────────────

export interface JobProgress {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  elapsed_seconds: number | null;
  remaining_seconds: number | null;
  queue_position: number;
  error: string | null;
}

export interface JobHistoryItem {
  job_id: string;
  filename: string;
  duration: number;
  file_size: number;
  timestamp: string;
  file_path: string;
}

export interface QueueInfo {
  queue_depth: number;
  active_jobs: number;
  max_concurrent: number;
  queued_jobs: string[];
}

export interface SystemInfo {
  cpu_percent: number;
  ram_used: number;
  ram_total: number;
  ram_percent: number;
  output_folder_size: number;
  output_folder_files: number;
  renders_today: number;
}
