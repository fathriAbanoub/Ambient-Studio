"use client";

import { useStudioStore } from "@/store/studioStore";
import { useProceduralEngine } from "@/hooks/useProceduralEngine";
import {
  Play,
  Square,
  Download,
  Sparkles,
  Loader2,
  Drum,
} from "lucide-react";

const GENERATOR_COLOR = "#00bcd4";

// FIX 4: Pre-compute style objects so dynamic color values work at runtime.
// Tailwind cannot resolve interpolated class names like `bg-[${COLOR}]/20` —
// those classes are never emitted in the CSS bundle. All dynamic color
// styling must use inline style props.
function makeStyles(color: string, isRunning: boolean) {
  return {
    card: {
      borderColor: isRunning ? `${color}60` : "var(--border)",
      background: isRunning
        ? `linear-gradient(135deg, ${color}08, ${color}04)`
        : "var(--surface)",
      boxShadow: isRunning
        ? `0 0 20px ${color}15, inset 0 0 0 1px ${color}20`
        : "none",
    } as React.CSSProperties,
    badge: {
      backgroundColor: `${color}20`,
      color,
    } as React.CSSProperties,
    sceneBadge: {
      backgroundColor: `${color}15`,
      color,
      border: `1px solid ${color}30`,
    } as React.CSSProperties,
    label: { color } as React.CSSProperties,
    playButtonActive: {
      backgroundColor: `${color}20`,
      color,
      borderColor: `${color}60`,
    } as React.CSSProperties,
    playButtonIdle: {
      backgroundColor: "var(--surface2)",
      color: "var(--text-dim)",
      borderColor: "var(--border)",
    } as React.CSSProperties,
    progressBar: {
      background: `linear-gradient(to right, ${color}, var(--accent2))`,
    } as React.CSSProperties,
    ping: { backgroundColor: color } as React.CSSProperties,
    dot: { backgroundColor: color } as React.CSSProperties,
    rangeAccent: { accentColor: color } as React.CSSProperties,
  };
}

export function ProceduralTrack() {
  const {
    generator,
    setGeneratorSeed,
    setGeneratorEnableScenes,
    setGeneratorSceneDuration,
    setGeneratorTempo,
    setGeneratorComplexity,
    setGeneratorSpace,
    setGeneratorDrumLevel,
    generatorExportDuration,
    setGeneratorExportDuration,
  } = useStudioStore();

  const {
    isRunning,
    currentScene,
    start,
    stop,
    exportWav,
    exportProgress,
    isExporting,
  } = useProceduralEngine();

  const styles = makeStyles(GENERATOR_COLOR, isRunning);

  const handlePlayStop = async () => {
    if (isRunning) {
      stop();
    } else {
      await start();
    }
  };

  const handleExport = () => {
    exportWav(generatorExportDuration);
  };

  return (
    <div
      className="relative flex flex-col gap-2 p-3 rounded-lg border transition-all duration-200"
      style={styles.card}
    >
      {/* Top Row: Badge + Label + Scene */}
      <div className="flex items-center gap-3">
        {/* Generator Badge */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={styles.badge}
        >
          <Sparkles className="w-4 h-4" />
        </div>

        {/* Label */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="font-bold text-xs tracking-widest"
              style={styles.label}
            >
              PROCEDURAL GENERATOR
            </span>
            {isRunning && (
              <span className="relative flex h-2 w-2">
                <span
                  className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                  style={styles.ping}
                />
                <span
                  className="relative inline-flex rounded-full h-2 w-2"
                  style={styles.dot}
                />
              </span>
            )}
          </div>
        </div>

        {/* Current Scene Badge */}
        <div
          className="px-2.5 py-1 rounded text-xs font-mono font-bold"
          style={styles.sceneBadge}
        >
          {currentScene}
        </div>
      </div>

      {/* Middle Row: Inline Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Seed */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Seed
          </label>
          <input
            type="number"
            min={0}
            max={999999}
            value={generator.seed}
            onChange={(e) => setGeneratorSeed(parseInt(e.target.value) || 0)}
            className="w-16 px-1.5 py-1 bg-[var(--surface2)] border border-[var(--border)] rounded text-xs text-[var(--text)] font-mono focus:outline-none focus:border-[var(--accent)]"
          />
        </div>

        {/* Scene Toggle */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Scenes
          </label>
          <button
            onClick={() => setGeneratorEnableScenes(!generator.enableScenes)}
            className="px-2 py-1 rounded text-xs font-mono border transition-all"
            style={
              generator.enableScenes
                ? {
                    borderColor: "var(--accent3)",
                    backgroundColor: "color-mix(in srgb, var(--accent3) 20%, transparent)",
                    color: "var(--accent3)",
                  }
                : {
                    borderColor: "var(--border)",
                    color: "var(--text-dim)",
                  }
            }
          >
            {generator.enableScenes ? "ON" : "OFF"}
          </button>
        </div>

        {/* Tempo */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Tempo
          </label>
          <input
            type="range"
            min={40}
            max={120}
            step={1}
            value={generator.tempo}
            onChange={(e) => setGeneratorTempo(parseInt(e.target.value))}
            className="w-16"
            style={styles.rangeAccent}
          />
          <span className="text-xs font-mono text-[var(--text-dim)] w-7">
            {generator.tempo}
          </span>
        </div>

        {/* Complexity */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Cmplx
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(generator.complexity * 100)}
            onChange={(e) => setGeneratorComplexity(parseInt(e.target.value) / 100)}
            className="w-16"
            style={styles.rangeAccent}
          />
          <span className="text-xs font-mono text-[var(--text-dim)] w-7">
            {Math.round(generator.complexity * 100)}%
          </span>
        </div>

        {/* Space */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Space
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(generator.space * 100)}
            onChange={(e) => setGeneratorSpace(parseInt(e.target.value) / 100)}
            className="w-16"
            style={styles.rangeAccent}
          />
          <span className="text-xs font-mono text-[var(--text-dim)] w-7">
            {Math.round(generator.space * 100)}%
          </span>
        </div>
      </div>

      {/* Bottom Row: Play/Stop, Export, Drum Level, Scene Duration */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Play / Stop Button */}
        <button
          onClick={handlePlayStop}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded font-medium text-xs border transition-all"
          style={isRunning ? styles.playButtonActive : styles.playButtonIdle}
        >
          {isRunning ? (
            <>
              <Square className="w-3.5 h-3.5" />
              STOP
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              PLAY
            </>
          )}
        </button>

        {/* Export WAV Button */}
        <button
          onClick={handleExport}
          disabled={isExporting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded font-medium text-xs border transition-all"
          style={
            isExporting
              ? {
                  backgroundColor: "var(--surface2)",
                  color: "var(--text-dim)",
                  borderColor: "var(--border)",
                  cursor: "not-allowed",
                }
              : {
                  backgroundColor: "color-mix(in srgb, var(--accent2) 20%, transparent)",
                  color: "var(--accent2)",
                  borderColor: "color-mix(in srgb, var(--accent2) 60%, transparent)",
                }
          }
        >
          {isExporting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {exportProgress}%
            </>
          ) : (
            <>
              <Download className="w-3.5 h-3.5" />
              EXPORT WAV
            </>
          )}
        </button>

        {/* Export Duration */}
        <div className="flex items-center gap-1">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Min
          </label>
          <input
            type="number"
            min={1}
            max={60}
            value={generatorExportDuration}
            onChange={(e) =>
              setGeneratorExportDuration(
                Math.max(1, Math.min(60, parseInt(e.target.value) || 1))
              )
            }
            className="w-12 px-1.5 py-1 bg-[var(--surface2)] border border-[var(--border)] rounded text-xs text-[var(--text)] font-mono focus:outline-none focus:border-[var(--accent)]"
          />
        </div>

        {/* Drum Level */}
        <div className="flex items-center gap-1.5">
          <Drum className="w-3 h-3 text-[var(--text-dim)]" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(generator.drumLevel * 100)}
            onChange={(e) => setGeneratorDrumLevel(parseInt(e.target.value) / 100)}
            className="w-16"
            style={styles.rangeAccent}
          />
          <span className="text-xs font-mono text-[var(--text-dim)] w-7">
            {Math.round(generator.drumLevel * 100)}%
          </span>
        </div>

        {/* Scene Duration Select */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-[var(--text-dim)] font-mono uppercase tracking-wider">
            Scene Bars
          </label>
          <select
            value={generator.sceneDuration}
            onChange={(e) => setGeneratorSceneDuration(parseInt(e.target.value))}
            className="px-1.5 py-1 bg-[var(--surface2)] border border-[var(--border)] rounded text-xs text-[var(--text)] font-mono focus:outline-none focus:border-[var(--accent)]"
          >
            <option value={16}>16</option>
            <option value={32}>32</option>
            <option value={64}>64</option>
          </select>
        </div>
      </div>

      {/* Export Progress Bar */}
      {isExporting && (
        <div className="mt-1">
          <div className="h-1.5 bg-[var(--surface2)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${exportProgress}%`,
                ...styles.progressBar,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
