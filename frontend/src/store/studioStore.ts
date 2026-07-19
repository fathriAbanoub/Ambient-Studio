import { create } from "zustand";
import {
  Track,
  LogEntry,
  TRACK_COLORS,
  JobHistoryItem,
  JobProgress,
  CustomPreset,
  LoopAnalysis,
  GeneratorState,
  ScaleName,
  DrumStyle,
  DroneLayerParams,
  SampleBankEntry,
} from "@/types";

const MAX_DRONE_LAYERS = 8;
// Bridge studio-store toasts into the shadcn <Toaster /> (mounted in
// app/layout.tsx). Without this, `showToast()` only updated a Zustand
// field that nothing consumed, so completion/error toasts never
// rendered — which broke studio.spec.ts › Audio Export / Video Export
// "completion" assertions that wait for "Audio render completed!" /
// "Video render completed!" to appear in the DOM.
import { toast as shadcnToast } from "@/hooks/use-toast";

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

  // Custom presets
  customPresets: CustomPreset[];

  // Video options
  showVisualizer: boolean;
  useGpuEncoding: boolean;

  // Loop analysis state
  loopAnalysis: LoopAnalysis | null;
  isAnalyzingLoop: boolean;
  loopAnalysisError: string | null;

  // Procedural generator state
  generator: GeneratorState;
  generatorExportDuration: number;
  activePlaybackSource: "manual" | "generator" | null;
  setActivePlaybackSource: (source: "manual" | "generator" | null) => void;

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

  // Custom preset actions
  saveCustomPreset: (name: string) => void;
  deleteCustomPreset: (name: string) => void;
  loadCustomPresets: () => void;

  // Video options actions
  setShowVisualizer: (show: boolean) => void;
  setUseGpuEncoding: (useGpu: boolean) => void;

  // Loop analysis actions
  setLoopAnalysis: (analysis: LoopAnalysis | null) => void;
  setIsAnalyzingLoop: (analyzing: boolean) => void;
  setLoopAnalysisError: (error: string | null) => void;

  // Procedural generator actions
  setGeneratorRunning: (running: boolean) => void;
  setGeneratorSeed: (seed: number) => void;
  setGeneratorEnableScenes: (enabled: boolean) => void;
  setGeneratorSceneDuration: (bars: number) => void;
  setGeneratorTempo: (bpm: number) => void;
  setGeneratorComplexity: (c: number) => void;
  setGeneratorSpace: (s: number) => void;
  setGeneratorDrumLevel: (d: number) => void;
  setGeneratorScene: (scene: string) => void;
  setGeneratorExportDuration: (minutes: number) => void;
  setGeneratorScale: (scale: ScaleName) => void;
  setGeneratorEnableBeats: (enabled: boolean) => void;
  setGeneratorDrone: (layers: DroneLayerParams[]) => void;
  addDroneLayer: () => void;
  updateDroneLayer: (index: number, patch: Partial<DroneLayerParams>) => void;
  removeDroneLayer: (index: number) => void;
  setGeneratorSwing: (amount: number) => void;
  setGeneratorDrumStyle: (style: DrumStyle) => void;
  setGeneratorSidechainAmount: (amount: number) => void;
  setGeneratorSampleBank: (entries: SampleBankEntry[]) => void;
  addSampleBankEntry: (entry: SampleBankEntry) => void;
  removeSampleBankEntry: (id: string) => void;
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

const initialLoopAnalysisState = {
  loopAnalysis: null,
  isAnalyzingLoop: false,
  loopAnalysisError: null,
};

export const useStudioStore = create<StudioState>((set, get) => {
  return {
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
    customPresets: [],
    showVisualizer: false,
    useGpuEncoding: true,
    generator: {
      isRunning: false,
      seed: 42,
      enableScenes: true,
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
    generatorExportDuration: 5,
    activePlaybackSource: null,
    ...initialJobState,
    ...initialLoopAnalysisState,

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
      // Auto-hide the (legacy, mostly unused) Zustand field after 5s.
      setTimeout(() => {
        set({ toastMessage: null });
      }, 5000);
      // ALSO push into the shadcn toast system so the <Toaster /> mounted
      // in app/layout.tsx actually renders the message. This is what
      // Playwright can see and assert on.
      try {
        shadcnToast({
          description: message,
          variant:
            type === "error"
              ? "destructive"
              : type === "warning"
                ? "destructive"
                : "default",
        });
      } catch {
        // If shadcn toast reducer isn't initialized yet (e.g. SSR),
        // silently no-op. The Zustand field above is still set.
      }
    },

    hideToast: () => set({ toastMessage: null }),

    // Custom preset actions
    loadCustomPresets: () => {
      try {
        const raw = localStorage.getItem("ambient_studio_presets");
        const presets: CustomPreset[] = raw ? JSON.parse(raw) : [];
        set({ customPresets: presets });
      } catch {
        set({ customPresets: [] });
      }
    },

    saveCustomPreset: (name: string) => {
      const { tracks, eqGains, customPresets } = get();
      const volumes = tracks.map((t) => t.volume / 100);
      const preset: CustomPreset = {
        name,
        volumes,
        eq: eqGains,
        createdAt: Date.now(),
      };
      const updated = [...customPresets.filter((p) => p.name !== name), preset];
      localStorage.setItem("ambient_studio_presets", JSON.stringify(updated));
      set({ customPresets: updated });
    },

    deleteCustomPreset: (name: string) => {
      const { customPresets } = get();
      const updated = customPresets.filter((p) => p.name !== name);
      localStorage.setItem("ambient_studio_presets", JSON.stringify(updated));
      set({ customPresets: updated });
    },

    // Video options actions
    setShowVisualizer: (show: boolean) => set({ showVisualizer: show }),
    setUseGpuEncoding: (useGpu: boolean) => set({ useGpuEncoding: useGpu }),

    // Loop analysis actions
    setLoopAnalysis: (analysis) => set({ loopAnalysis: analysis }),
    setIsAnalyzingLoop: (analyzing) => set({ isAnalyzingLoop: analyzing }),
    setLoopAnalysisError: (error) => set({ loopAnalysisError: error }),

    // Procedural generator actions
    setGeneratorRunning: (running) =>
      set((state) => ({
        generator: { ...state.generator, isRunning: running },
      })),
    setGeneratorSeed: (seed) =>
      set((state) => ({ generator: { ...state.generator, seed } })),
    setGeneratorEnableScenes: (enabled) =>
      set((state) => ({
        generator: { ...state.generator, enableScenes: enabled },
      })),
    setGeneratorSceneDuration: (bars) =>
      set((state) => ({
        generator: { ...state.generator, sceneDuration: bars },
      })),
    setGeneratorTempo: (bpm) =>
      set((state) => ({ generator: { ...state.generator, tempo: bpm } })),
    setGeneratorComplexity: (c) =>
      set((state) => ({ generator: { ...state.generator, complexity: c } })),
    setGeneratorSpace: (s) =>
      set((state) => ({ generator: { ...state.generator, space: s } })),
    setGeneratorDrumLevel: (d) =>
      set((state) => ({ generator: { ...state.generator, drumLevel: d } })),
    setGeneratorScene: (scene) =>
      set((state) => ({
        generator: { ...state.generator, currentScene: scene },
      })),
    setGeneratorExportDuration: (minutes) =>
      set({ generatorExportDuration: minutes }),
    setGeneratorScale: (scale) =>
      set((state) => ({ generator: { ...state.generator, scale } })),
    setGeneratorEnableBeats: (enabled) =>
      set((state) => ({
        generator: { ...state.generator, enableBeats: enabled },
      })),
    setGeneratorDrone: (layers) =>
      set((state) => ({
        generator: {
          ...state.generator,
          drone: layers.slice(0, MAX_DRONE_LAYERS),
        },
      })),
    addDroneLayer: () =>
      set((state) => {
        if (state.generator.drone.length >= MAX_DRONE_LAYERS) return state;
        return {
          generator: {
            ...state.generator,
            drone: [
              ...state.generator.drone,
              { hz: 55, amp: 0.15, pan: 0, timbre: "sine" as const },
            ],
          },
        };
      }),
    updateDroneLayer: (index, patch) =>
      set((state) => {
        if (index < 0 || index >= state.generator.drone.length) return state;
        const drone = state.generator.drone.map((layer, i) =>
          i === index ? { ...layer, ...patch } : layer,
        );
        return { generator: { ...state.generator, drone } };
      }),
    removeDroneLayer: (index) =>
      set((state) => {
        if (index < 0 || index >= state.generator.drone.length) return state;
        return {
          generator: {
            ...state.generator,
            drone: state.generator.drone.filter((_, i) => i !== index),
          },
        };
      }),
    setGeneratorSwing: (amount) =>
      set((state) => ({ generator: { ...state.generator, swing: amount } })),
    setGeneratorDrumStyle: (style) =>
      set((state) => ({ generator: { ...state.generator, drumStyle: style } })),
    setGeneratorSidechainAmount: (amount) =>
      set((state) => ({
        generator: { ...state.generator, sidechainAmount: amount },
      })),
    setGeneratorSampleBank: (entries) =>
      set((state) => ({
        generator: { ...state.generator, sampleBank: entries },
      })),
    addSampleBankEntry: (entry) =>
      set((state) => ({
        generator: {
          ...state.generator,
          sampleBank: [...state.generator.sampleBank, entry],
        },
      })),
    removeSampleBankEntry: (id) =>
      set((state) => {
        const removed = state.generator.sampleBank.find((e) => e.id === id);
        if (removed?.url.startsWith("blob:")) {
          URL.revokeObjectURL(removed.url);
        }
        return {
          generator: {
            ...state.generator,
            sampleBank: state.generator.sampleBank.filter((e) => e.id !== id),
          },
        };
      }),
    setActivePlaybackSource: (source) => set({ activePlaybackSource: source }),
  };
});

if (typeof window !== "undefined") {
  useStudioStore.getState().loadCustomPresets();
}
