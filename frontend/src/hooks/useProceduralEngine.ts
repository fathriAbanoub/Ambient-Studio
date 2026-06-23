"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useStudioStore } from "@/store/studioStore";
import type { EngineParams, EngineState, RenderProgress } from "@ambient-engine/index";
import { LiveEngine } from "@ambient-engine/LiveEngine";
import { renderAndDownloadWav } from "@ambient-engine/renderAmbient";

export function useProceduralEngine() {
  const engineRef = useRef<LiveEngine | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scenePollRef = useRef<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentScene, setCurrentScene] = useState("Calm");
  const [analyserData, setAnalyserData] = useState<Uint8Array>(new Uint8Array(128));
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
      scale: "majorPent",
      rootHz: 220,
      bpm: generator.tempo,
      complexity: generator.complexity,
      mix: generator.space,
      sceneDurationBars: generator.sceneDuration,
      enableScenes: generator.enableScenes,
      enableHarmonicLoop: true,
      seed: generator.seed,
      drumLevel: generator.drumLevel,
    };
  }, [generator.tempo, generator.complexity, generator.space, generator.sceneDuration, generator.enableScenes, generator.seed, generator.drumLevel]);

  const start = useCallback(async () => {
    if (engineRef.current?.running) return;
    try {
      // LiveEngine constructor now handles full RNG init order internally:
      //   createInitialState → createNoiseBuffer (advances ~22k RNG calls) → initializeBell
      const engine = new LiveEngine(buildParams());
      engineRef.current = engine;
      await engine.start();

      const analyser = engine.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      engine.getMasterNode().connect(analyser);
      analyserRef.current = analyser;

      setIsRunning(true);
      setGeneratorRunning(true);
      setIsPlaying(true);
      addLog("Procedural generator started", "ok");

      scenePollRef.current = window.setInterval(() => {
        if (engine.running) {
          const name = engine.getCurrentSceneName();
          setCurrentScene(name);
          setGeneratorScene(name);
        }
      }, 2000);

      const updateAnalyser = () => {
        if (engine.running && analyserRef.current) {
          try {
            const data = new Uint8Array(analyserRef.current.frequencyBinCount);
            analyserRef.current.getByteFrequencyData(data);
            setAnalyserData(data);
          } catch { /* shutdown race */ }
        }
        if (engine.running) animFrameRef.current = requestAnimationFrame(updateAnalyser);
      };
      updateAnalyser();
    } catch (error) {
      addLog(`Generator start failed: ${error}`, "err");
      showToast(`Generator failed: ${error}`, "error");
    }
  }, [buildParams, setGeneratorRunning, setIsPlaying, addLog, showToast, setGeneratorScene]);

  const stop = useCallback(() => {
    if (scenePollRef.current)  { clearInterval(scenePollRef.current); scenePollRef.current = null; }
    if (animFrameRef.current)  { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    if (analyserRef.current)   { try { analyserRef.current.disconnect(); } catch {} analyserRef.current = null; }

    // ✅ FIX: Call dispose() instead of stop() to tear down the full audio graph
    if (engineRef.current) {
      engineRef.current.dispose();
      engineRef.current = null;
    }

    setIsRunning(false);
    setGeneratorRunning(false);
    setIsPlaying(false);
    setCurrentScene("Calm");
    setGeneratorScene("Calm");
    setAnalyserData(new Uint8Array(128));
    addLog("Procedural generator stopped", "info");
  }, [setGeneratorRunning, setIsPlaying, setGeneratorScene, addLog]);

  const updateParams = useCallback(() => {
    const engine = engineRef.current;
    if (!engine?.running) return;
    engine.setBpm(generator.tempo);
    engine.setComplexity(generator.complexity);
    engine.setMix(generator.space);
    engine.setDrumLevel(generator.drumLevel);
  }, [generator.tempo, generator.complexity, generator.space, generator.drumLevel]);

  const exportWav = useCallback(async (durationMinutes: number) => {
    if (isExporting) return;
    setIsExporting(true);
    setExportProgress(0);
    try {
      const params = buildParams();
      const durationSeconds = durationMinutes * 60;
      // Pass current engine state for continuity — RNG position is already past noise buffer
      const startState: EngineState | undefined = engineRef.current?.getCurrentState();
      addLog(`Exporting generator WAV (${durationMinutes} min)...`, "info");
      await renderAndDownloadWav(
        params,
        durationSeconds,
        `ambient_generation_${generator.seed}.wav`,
        startState,
        (progress: RenderProgress) => setExportProgress(progress.percent)
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
  }, [buildParams, isExporting, generator.seed, addLog, showToast]);

  useEffect(() => {
    if (isRunning && engineRef.current?.running) updateParams();
  }, [isRunning, updateParams]);

  // ✅ FIX: On unmount, dispose the engine to prevent leaks
  useEffect(() => {
    return () => {
      if (scenePollRef.current)  clearInterval(scenePollRef.current);
      if (animFrameRef.current)  cancelAnimationFrame(animFrameRef.current);
      if (analyserRef.current)   { try { analyserRef.current.disconnect(); } catch {} }

      if (engineRef.current) {
        engineRef.current.dispose();
        engineRef.current = null;
      }

      setGeneratorRunning(false);
      setIsPlaying(false);
    };
  }, [setGeneratorRunning, setIsPlaying]);

  return { isRunning, currentScene, start, stop, updateParams, exportWav, analyserData, exportProgress, isExporting };
}
