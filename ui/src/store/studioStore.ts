import { create } from "zustand";
import {
  LogEntry,
  GeneratorState,
  ScaleName,
  DrumStyle,
  DroneLayer,
  DroneLayerParams,
  SampleBankEntry,
} from "@/types";
// Bridge studio-store toasts into the shadcn <Toaster /> (mounted in
// app/layout.tsx). Without this, `showToast()` only updated a Zustand
// field that nothing consumed, so completion/error toasts never
// rendered.
import { toast as shadcnToast } from "@/hooks/use-toast";

const MAX_DRONE_LAYERS = 8;
const DEFAULT_DRONE_HZ = 55;
const DEFAULT_DRONE_AMP = 0.15;
const DEFAULT_DRONE_PAN = 0;
const DEFAULT_DRONE_TIMBRE = "sine" as const;
// ponytail: sample-bank cap of 16; raising it needs more upload-list UI
// real estate plus a decode-time/memory budget check before accepting more.
const MAX_SAMPLE_BANK_ENTRIES = 16;
const BLOB_URL_PREFIX = "blob:";
const TOAST_AUTO_HIDE_MS = 5000;

// ─── Type alias for toasts ──────────────────────────────────────────────
type ToastType = "success" | "error" | "warning" | "info";

function toastVariant(type: ToastType) {
  if (type === "error") return "destructive" as const;
  if (type === "warning") return "warning" as const;
  return "default" as const;
}

function revokeBlobUrl(url: string) {
  if (url.startsWith(BLOB_URL_PREFIX)) {
    URL.revokeObjectURL(url);
  }
}

interface StudioState {
  logs: LogEntry[];

  // Toast notifications
  toastMessage: string | null;
  toastType: ToastType; // ← using type alias

  // Procedural generator state
  generator: GeneratorState;
  generatorExportDuration: number;
  activePlaybackSource: "generator" | null;
  setActivePlaybackSource: (source: "generator" | null) => void;

  // Actions
  addLog: (msg: string, type?: "ok" | "err" | "info" | "") => void;
  clearLog: () => void;

  // Toast actions
  showToast: (
    message: string,
    type?: ToastType, // ← using type alias
  ) => void;
  hideToast: () => void;

  // Procedural generator actions
  setGeneratorRunning: (running: boolean) => void;
  setGeneratorSeed: (seed: number) => void;
  setGeneratorRootHz: (hz: number) => void;
  setGeneratorEnableScenes: (enabled: boolean) => void;
  setGeneratorEnableHarmonicLoop: (enabled: boolean) => void;
  setGeneratorSceneDuration: (bars: number) => void;
  setGeneratorTempo: (bpm: number) => void;
  setGeneratorComplexity: (c: number) => void;
  setGeneratorSpace: (s: number) => void;
  setGeneratorDrumLevel: (d: number) => void;
  setGeneratorScene: (scene: string) => void;
  setGeneratorExportDuration: (minutes: number) => void;
  setGeneratorScale: (scale: ScaleName) => void;
  setGeneratorEnableBeats: (enabled: boolean) => void;
  setGeneratorDrone: (layers: DroneLayer[]) => void;
  addDroneLayer: () => void;
  updateDroneLayer: (id: string, patch: Partial<DroneLayerParams>) => void;
  removeDroneLayer: (id: string) => void;
  setGeneratorSwing: (amount: number) => void;
  setGeneratorDrumStyle: (style: DrumStyle) => void;
  setGeneratorSidechainAmount: (amount: number) => void;
  setGeneratorSampleBank: (entries: SampleBankEntry[]) => void;
  addSampleBankEntry: (entry: SampleBankEntry) => void;
  updateSampleBankEntry: (
    id: string,
    patch: Partial<SampleBankEntry>,
  ) => void;
  removeSampleBankEntry: (id: string) => void;
}

const generateId = () => Math.random().toString(36).substring(2, 11);

export const useStudioStore = create<StudioState>((set, get) => {
  return {
    logs: [],
    toastMessage: null,
    toastType: "info",
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
    generatorExportDuration: 5,
    activePlaybackSource: null,

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

    // Toast actions
    showToast: (message, type = "info") => {
      set({ toastMessage: message, toastType: type });
      // Auto-hide the (legacy, mostly unused) Zustand field after 5s.
      setTimeout(() => {
        set({ toastMessage: null });
      }, TOAST_AUTO_HIDE_MS);
      // ALSO push into the shadcn toast system so the <Toaster /> mounted
      // in app/layout.tsx actually renders the message.
      try {
        shadcnToast({
          description: message,
          variant: toastVariant(type),
        });
      } catch {
        // If shadcn toast reducer isn't initialized yet (e.g. SSR),
        // silently no-op. The Zustand field above is still set.
      }
    },

    hideToast: () => set({ toastMessage: null }),

    // Procedural generator actions
    setGeneratorRunning: (running) =>
      set((state) => ({
        generator: { ...state.generator, isRunning: running },
      })),
    setGeneratorSeed: (seed) =>
      set((state) => ({ generator: { ...state.generator, seed } })),
    setGeneratorRootHz: (hz) =>
      set((state) => ({ generator: { ...state.generator, rootHz: hz } })),
    setGeneratorEnableScenes: (enabled) =>
      set((state) => ({
        generator: { ...state.generator, enableScenes: enabled },
      })),
    setGeneratorEnableHarmonicLoop: (enabled) =>
      set((state) => ({
        generator: { ...state.generator, enableHarmonicLoop: enabled },
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
              {
                id: crypto.randomUUID(),
                hz: DEFAULT_DRONE_HZ,
                amp: DEFAULT_DRONE_AMP,
                pan: DEFAULT_DRONE_PAN,
                timbre: DEFAULT_DRONE_TIMBRE,
              },
            ],
          },
        };
      }),
    updateDroneLayer: (id, patch) =>
      set((state) => {
        const drone = state.generator.drone.map((layer) =>
          layer.id === id ? { ...layer, ...patch } : layer,
        );
        return { generator: { ...state.generator, drone } };
      }),
    removeDroneLayer: (id) =>
      set((state) => ({
        generator: {
          ...state.generator,
          drone: state.generator.drone.filter((layer) => layer.id !== id),
        },
      })),
    setGeneratorSwing: (amount) =>
      set((state) => ({ generator: { ...state.generator, swing: amount } })),
    setGeneratorDrumStyle: (style) =>
      set((state) => ({ generator: { ...state.generator, drumStyle: style } })),
    setGeneratorSidechainAmount: (amount) =>
      set((state) => ({
        generator: { ...state.generator, sidechainAmount: amount },
      })),
    setGeneratorSampleBank: (entries) =>
      set((state) => {
        const next = entries.slice(0, MAX_SAMPLE_BANK_ENTRIES);
        const nextIds = new Set(next.map((e) => e.id));
        for (const entry of state.generator.sampleBank) {
          if (!nextIds.has(entry.id)) {
            revokeBlobUrl(entry.url);
          }
        }
        for (const entry of entries.slice(MAX_SAMPLE_BANK_ENTRIES)) {
          if (!nextIds.has(entry.id)) {
            revokeBlobUrl(entry.url);
          }
        }
        return {
          generator: { ...state.generator, sampleBank: next },
        };
      }),
    addSampleBankEntry: (entry) =>
      set((state) => {
        if (state.generator.sampleBank.length >= MAX_SAMPLE_BANK_ENTRIES) {
          return state;
        }
        return {
          generator: {
            ...state.generator,
            sampleBank: [...state.generator.sampleBank, entry],
          },
        };
      }),
    updateSampleBankEntry: (id, patch) =>
      set((state) => {
        const sampleBank = state.generator.sampleBank.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        );
        return { generator: { ...state.generator, sampleBank } };
      }),
    removeSampleBankEntry: (id) =>
      set((state) => {
        const removed = state.generator.sampleBank.find((e) => e.id === id);
        if (removed) {
          revokeBlobUrl(removed.url);
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
