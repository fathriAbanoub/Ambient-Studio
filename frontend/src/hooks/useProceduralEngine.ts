"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useStudioStore } from "@/store/studioStore";
import type {
  EngineParams,
  EngineState,
  RenderProgress,
} from "@ambient-engine/index";
import { LiveEngine } from "@ambient-engine/LiveEngine";
import { renderAndDownloadWav } from "@ambient-engine/renderAmbient";

const DEFAULT_ROOT_HZ = 220;
const ANALYSER_FFT_SIZE = 256;
const ANALYSER_SMOOTHING = 0.8;
const ANALYSER_DATA_BINS = 128;
const SCENE_POLL_INTERVAL_MS = 2000;
const SECONDS_PER_MINUTE = 60;

// ponytail: compares id membership only, not order or content — an in-place

// edit to an existing layer/sample (e.g. changing Hz) keeps the same id set

// and intentionally skips resync, since that change already takes effect via

// the plain engine.params.drone/sampleBank assignment above. Upgrading to

// detect in-place changes would mean diffing full objects, not just ids.

function idSetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

export function useProceduralEngine(
  masterDestination: AudioNode | null = null,
) {
  const engineRef = useRef<LiveEngine | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scenePollRef = useRef<number | null>(null);
  const prevDroneIdsRef = useRef<string[]>([]);
  const prevSampleIdsRef = useRef<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentScene, setCurrentScene] = useState("Calm");
  const [analyserData, setAnalyserData] = useState<Uint8Array>(
    new Uint8Array(ANALYSER_DATA_BINS),
  );
  const animFrameRef = useRef<number | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [isExporting, setIsExporting] = useState(false);

  const {
    generator,
    setGeneratorRunning,
    setGeneratorScene,
    addLog,
    setIsPlaying,
    showToast,
  } = useStudioStore();

  const buildParams = useCallback((): EngineParams => {
    return {
      scale: generator.scale,
      rootHz: DEFAULT_ROOT_HZ,
      bpm: generator.tempo,
      complexity: generator.complexity,
      mix: generator.space,
      sceneDurationBars: generator.sceneDuration,
      enableScenes: generator.enableScenes,
      enableHarmonicLoop: true,
      enableBeats: generator.enableBeats,
      drone:
        generator.drone.length > 0 ? { layers: generator.drone } : undefined,
      sampleBank:
        generator.sampleBank.length > 0 ? generator.sampleBank : undefined,
      swing: generator.swing,
      drumStyle: generator.drumStyle,
      sidechainAmount: generator.sidechainAmount,
      seed: generator.seed,
      drumLevel: generator.drumLevel,
    };
  }, [
    generator.scale,
    generator.tempo,
    generator.complexity,
    generator.space,
    generator.sceneDuration,
    generator.enableScenes,
    generator.enableBeats,
    generator.drone,
    generator.sampleBank,
    generator.swing,
    generator.drumStyle,
    generator.sidechainAmount,
    generator.seed,
    generator.drumLevel,
  ]);

  // ✅ FIX (CodeRabbit): Shared teardown used by both start() and stop() so
  // failure paths leave scenePollRef / animFrameRef / analyserRef / isRunning /
  // store flags consistent. Previously start() only disposed engineRef.current
  // and bypassed this cleanup, leaking the scene poll interval and leaving
  // isRunning/setGeneratorRunning/setIsPlaying stuck at true if LiveEngine
  // construction or start() threw.
  const performTeardown = useCallback(() => {
    if (scenePollRef.current) {
      clearInterval(scenePollRef.current);
      scenePollRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {}
      analyserRef.current = null;
    }
    if (engineRef.current) {
      try {
        engineRef.current.dispose();
      } catch {
        /* best-effort cleanup */
      }
      engineRef.current = null;
    }
    prevDroneIdsRef.current = [];
    prevSampleIdsRef.current = [];
    setIsRunning(false);
    setGeneratorRunning(false);
    setIsPlaying(false);
  }, [setGeneratorRunning, setIsPlaying]);

  // ✅ FIX: start() now returns Promise<boolean> — true on success, false on
  // failure (thrown error OR early-return when the engine was disposed during
  // the async start). Previously start() swallowed errors internally, so
  // ProceduralTrack.handlePlayStop's catch never fired and
  // setActivePlaybackSource("generator") was called unconditionally even when
  // the engine failed to start.
  const start = useCallback(async (): Promise<boolean> => {
    // ✅ FIX (CodeRabbit): Full teardown of any previous engine so state is
    // consistent even if LiveEngine construction or start() throws downstream.
    performTeardown();

    // ✅ Cleanup helper for a newly created engine that failed to start
    let engine: LiveEngine | null = null;
    const cleanupStartedEngine = () => {
      if (!engine) return;
      const ownsEngine = engineRef.current === engine;
      if (ownsEngine || engine.running) {
        try {
          engine.dispose();
        } catch {
          /* best-effort cleanup */
        }
      }
      if (ownsEngine) {
        engineRef.current = null;
      }
    };

    try {
      // ✅ FIX: Use a const for TypeScript narrowing across the await boundary
      const newEngine = new LiveEngine(
        buildParams(),
        undefined,
        masterDestination,
      );

      // Assign to the outer let so cleanupStartedEngine can still access it
      engine = newEngine;
      engineRef.current = newEngine;

      await newEngine.start();

      // ✅ Guard: ensure we weren't stopped/disposed during the async start
      if (engineRef.current !== newEngine || !newEngine.running) {
        cleanupStartedEngine();
        return false;
      }

      const analyser = newEngine.ctx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
      newEngine.getMasterNode().connect(analyser);
      analyserRef.current = analyser;

      prevDroneIdsRef.current = generator.drone.map((layer) => layer.id);
      prevSampleIdsRef.current = generator.sampleBank.map((entry) => entry.id);

      setIsRunning(true);
      setGeneratorRunning(true);
      setIsPlaying(true);
      addLog("Procedural generator started", "ok");

      scenePollRef.current = window.setInterval(() => {
        // ✅ TypeScript now knows newEngine is never null
        if (newEngine.running) {
          const name = newEngine.getCurrentSceneName();
          setCurrentScene(name);
          setGeneratorScene(name);
        }
      }, SCENE_POLL_INTERVAL_MS);

      const updateAnalyser = () => {
        // ✅ TypeScript now knows newEngine is never null
        if (newEngine.running && analyserRef.current) {
          try {
            const data = new Uint8Array(analyserRef.current.frequencyBinCount);
            analyserRef.current.getByteFrequencyData(data);
            setAnalyserData(data);
          } catch {
            /* shutdown race */
          }
        }
        if (newEngine.running)
          animFrameRef.current = requestAnimationFrame(updateAnalyser);
      };
      updateAnalyser();

      return true;
    } catch (error) {
      cleanupStartedEngine();
      // ✅ performTeardown() at the top already reset isRunning / store flags /
      // scenePollRef / animFrameRef, so the UI stays consistent on failure.
      addLog(`Generator start failed: ${error}`, "err");
      showToast(`Generator failed: ${error}`, "error");
      return false;
    }
  }, [
    buildParams,
    performTeardown,
    setGeneratorRunning,
    setIsPlaying,
    addLog,
    showToast,
    setGeneratorScene,
    masterDestination,
    generator.drone,
    generator.sampleBank,
  ]);

  const stop = useCallback(() => {
    performTeardown();
    setCurrentScene("Calm");
    setGeneratorScene("Calm");
    setAnalyserData(new Uint8Array(ANALYSER_DATA_BINS));
    addLog("Procedural generator stopped", "info");
  }, [performTeardown, setGeneratorScene, addLog]);

  const updateParams = useCallback(() => {
    const engine = engineRef.current;
    if (!engine?.running) return;
    engine.setBpm(generator.tempo);
    engine.setComplexity(generator.complexity);
    engine.setMix(generator.space);
    engine.setDrumLevel(generator.drumLevel);
    engine.setScale(generator.scale);
    // LiveEngine.params is public — mutate remaining fields so mid-playback
    // UI changes take effect on the next beat without restarting.
    engine.params.enableBeats = generator.enableBeats;
    engine.params.swing = generator.swing;
    engine.params.drumStyle = generator.drumStyle;
    engine.params.sidechainAmount = generator.sidechainAmount;
    engine.params.drone =
      generator.drone.length > 0 ? { layers: generator.drone } : undefined;
    engine.params.sampleBank =
      generator.sampleBank.length > 0 ? generator.sampleBank : undefined;

    const droneIds = generator.drone.map((layer) => layer.id);
    if (!idSetEqual(droneIds, prevDroneIdsRef.current)) {
      engine.resyncDroneLayers();
      prevDroneIdsRef.current = droneIds;
    }

    const sampleIds = generator.sampleBank.map((entry) => entry.id);
    if (!idSetEqual(sampleIds, prevSampleIdsRef.current)) {
      void engine.reloadSampleBank(generator.sampleBank);
      prevSampleIdsRef.current = sampleIds;
    }
  }, [
    generator.tempo,
    generator.complexity,
    generator.space,
    generator.drumLevel,
    generator.scale,
    generator.enableBeats,
    generator.swing,
    generator.drumStyle,
    generator.sidechainAmount,
    generator.drone,
    generator.sampleBank,
  ]);

  const exportWav = useCallback(
    async (durationMinutes: number) => {
      if (isExporting) return;
      setIsExporting(true);
      setExportProgress(0);
      try {
        const params = buildParams();
        const durationSeconds = durationMinutes * SECONDS_PER_MINUTE;
        // Pass current engine state for continuity — RNG position is already past noise buffer
        const startState: EngineState | undefined =
          engineRef.current?.getCurrentState();
        addLog(`Exporting generator WAV (${durationMinutes} min)...`, "info");
        await renderAndDownloadWav(
          params,
          durationSeconds,
          `ambient_generation_${generator.seed}.wav`,
          startState,
          (progress: RenderProgress) => setExportProgress(progress.percent),
        );
        addLog("Generator WAV export complete", "ok");
        showToast("Generator WAV exported!", "success");
      } catch (error) {
        addLog(`Generator export failed: ${error}`, "err");
        showToast(`Export failed: ${error}`, "error");
      } finally {
        setIsExporting(false);
        setExportProgress(0);
      }
    },
    [buildParams, isExporting, generator.seed, addLog, showToast],
  );

  useEffect(() => {
    if (isRunning && engineRef.current?.running) updateParams();
  }, [isRunning, updateParams]);

  // ✅ FIX: On unmount, reuse performTeardown to prevent logic duplication
  useEffect(() => {
    return () => {
      performTeardown();
    };
  }, [performTeardown]);

  return {
    isRunning,
    currentScene,
    start,
    stop,
    updateParams,
    exportWav,
    analyserData,
    exportProgress,
    isExporting,
  };
}
