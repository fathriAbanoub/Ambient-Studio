import { create } from "zustand";
import {
  Track,
  LogEntry,
  TRACK_COLORS,
  JobHistoryItem,
  JobProgress,
} from "@/types";

interface StudioState {
  tracks: Track[];
  isPlaying: boolean;
  masterGain: number;
  eqGains: number[];
  exportDuration: number;
  exportName: string;
  isExporting: boolean;
  exportProgress: number;
  exportLabel: string;
  logs: LogEntry[];
  backendOnline: boolean;

  // Job management state
  currentJobId: string | null;
  jobStatus: JobProgress["status"] | null;
  queuePosition: number;
  elapsedSeconds: number | null;
  remainingSeconds: number | null;
  jobError: string | null;

  // Job history
  jobHistory: JobHistoryItem[];

  // Toast notifications
  toastMessage: string | null;
  toastType: "success" | "error" | "warning" | "info";

  // Actions
  initTracks: (count: number) => void;
  loadTrackFile: (trackIndex: number, file: File, buffer: AudioBuffer) => void;
  unloadTrack: (trackIndex: number) => void;
  setVolume: (trackIndex: number, value: number) => void;
  setPan: (trackIndex: number, value: number) => void;
  toggleMute: (trackIndex: number) => void;
  toggleSolo: (trackIndex: number) => void;
  setMasterGain: (value: number) => void;
  setEqGain: (bandIndex: number, db: number) => void;
  resetEq: () => void;
  setExportDuration: (minutes: number) => void;
  setExportName: (name: string) => void;
  setIsPlaying: (playing: boolean) => void;
  setIsExporting: (exporting: boolean) => void;
  setExportProgress: (progress: number) => void;
  setExportLabel: (label: string) => void;
  setBackendOnline: (online: boolean) => void;
  applyPreset: (volumes: number[], eq: number[]) => void;
  addLog: (msg: string, type?: "ok" | "err" | "info" | "") => void;
  clearLog: () => void;

  // Job management actions
  setCurrentJobId: (jobId: string | null) => void;
  setJobStatus: (status: JobProgress["status"] | null) => void;
  setQueuePosition: (position: number) => void;
  setElapsedSeconds: (seconds: number | null) => void;
  setRemainingSeconds: (seconds: number | null) => void;
  setJobError: (error: string | null) => void;
  updateJobProgress: (progress: JobProgress) => void;
  resetJobState: () => void;

  // Job history actions
  setJobHistory: (history: JobHistoryItem[]) => void;

  // Toast actions
  showToast: (
    message: string,
    type?: "success" | "error" | "warning" | "info",
  ) => void;
  hideToast: () => void;
}

const generateId = () => Math.random().toString(36).substring(2, 11);

const initialJobState = {
  currentJobId: null,
  jobStatus: null,
  queuePosition: 0,
  elapsedSeconds: null,
  remainingSeconds: null,
  jobError: null,
};

export const useStudioStore = create<StudioState>((set, get) => ({
  tracks: [],
  isPlaying: false,
  masterGain: 1.0,
  eqGains: [0, 0, 0, 0, 0, 0, 0],
  exportDuration: 5,
  exportName: "ambient_mix",
  isExporting: false,
  exportProgress: 0,
  exportLabel: "",
  logs: [],
  backendOnline: false,
  jobHistory: [],
  toastMessage: null,
  toastType: "info",
  ...initialJobState,

  initTracks: (count: number) => {
    const tracks: Track[] = Array.from({ length: count }, (_, i) => ({
      id: generateId(),
      name: "",
      file: null,
      buffer: null,
      loaded: false,
      volume: 100,
      pan: 0,
      muted: false,
      solo: false,
      color: TRACK_COLORS[i % TRACK_COLORS.length],
      duration: 0,
    }));
    set({ tracks });
  },

  loadTrackFile: (trackIndex: number, file: File, buffer: AudioBuffer) => {
    set((state) => {
      const tracks = [...state.tracks];
      if (tracks[trackIndex]) {
        const name = file.name.replace(/\.[^/.]+$/, "");
        tracks[trackIndex] = {
          ...tracks[trackIndex],
          name,
          file,
          buffer,
          loaded: true,
          duration: buffer.duration,
        };
      }
      return { tracks };
    });
  },

  unloadTrack: (trackIndex: number) => {
    set((state) => {
      const tracks = [...state.tracks];
      if (tracks[trackIndex]) {
        tracks[trackIndex] = {
          ...tracks[trackIndex],
          name: "",
          file: null,
          buffer: null,
          loaded: false,
          duration: 0,
        };
      }
      return { tracks };
    });
  },

  setVolume: (trackIndex: number, value: number) => {
    set((state) => {
      const tracks = [...state.tracks];
      if (tracks[trackIndex]) {
        tracks[trackIndex] = { ...tracks[trackIndex], volume: value };
      }
      return { tracks };
    });
  },

  setPan: (trackIndex: number, value: number) => {
    set((state) => {
      const tracks = [...state.tracks];
      if (tracks[trackIndex]) {
        tracks[trackIndex] = { ...tracks[trackIndex], pan: value };
      }
      return { tracks };
    });
  },

  toggleMute: (trackIndex: number) => {
    set((state) => {
      const tracks = [...state.tracks];
      if (tracks[trackIndex]) {
        tracks[trackIndex] = {
          ...tracks[trackIndex],
          muted: !tracks[trackIndex].muted,
        };
      }
      return { tracks };
    });
  },

  toggleSolo: (trackIndex: number) => {
    set((state) => {
      const tracks = [...state.tracks];
      if (tracks[trackIndex]) {
        tracks[trackIndex] = {
          ...tracks[trackIndex],
          solo: !tracks[trackIndex].solo,
        };
      }
      return { tracks };
    });
  },

  setMasterGain: (value: number) => set({ masterGain: value }),

  setEqGain: (bandIndex: number, db: number) => {
    set((state) => {
      const eqGains = [...state.eqGains];
      eqGains[bandIndex] = db;
      return { eqGains };
    });
  },

  resetEq: () => set({ eqGains: [0, 0, 0, 0, 0, 0, 0] }),

  setExportDuration: (minutes: number) => set({ exportDuration: minutes }),

  setExportName: (name: string) => set({ exportName: name }),

  setIsPlaying: (playing: boolean) => set({ isPlaying: playing }),

  setIsExporting: (exporting: boolean) => set({ isExporting: exporting }),

  setExportProgress: (progress: number) => set({ exportProgress: progress }),

  setExportLabel: (label: string) => set({ exportLabel: label }),

  setBackendOnline: (online: boolean) => set({ backendOnline: online }),

  applyPreset: (volumes: number[], eq: number[]) => {
    set((state) => {
      const tracks = state.tracks.map((track, i) => ({
        ...track,
        volume: Math.round(volumes[i] * 100),
      }));
      return { tracks, eqGains: eq };
    });
  },

  addLog: (msg: string, type: "ok" | "err" | "info" | "" = "") => {
    const entry: LogEntry = {
      id: generateId(),
      timestamp: new Date(),
      message: msg,
      type,
    };
    set((state) => ({ logs: [...state.logs, entry] }));
  },

  clearLog: () => set({ logs: [] }),

  // Job management actions
  setCurrentJobId: (jobId) => set({ currentJobId: jobId }),
  setJobStatus: (status) => set({ jobStatus: status }),
  setQueuePosition: (position) => set({ queuePosition: position }),
  setElapsedSeconds: (seconds) => set({ elapsedSeconds: seconds }),
  setRemainingSeconds: (seconds) => set({ remainingSeconds: seconds }),
  setJobError: (error) => set({ jobError: error }),

  updateJobProgress: (progress) => {
    set({
      jobStatus: progress.status,
      exportProgress: progress.progress,
      queuePosition: progress.queue_position,
      elapsedSeconds: progress.elapsed_seconds,
      remainingSeconds: progress.remaining_seconds,
      jobError: progress.error,
    });
  },

  resetJobState: () => set(initialJobState),

  // Job history actions
  setJobHistory: (history) => set({ jobHistory: history }),

  // Toast actions
  showToast: (message, type = "info") => {
    set({ toastMessage: message, toastType: type });
    // Auto-hide after 5 seconds
    setTimeout(() => {
      set({ toastMessage: null });
    }, 5000);
  },

  hideToast: () => set({ toastMessage: null }),
}));
