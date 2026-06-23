"use client";

import { useStudioStore } from "@/store/studioStore";
import { useProceduralEngine } from "@/hooks/useProceduralEngine";
import {
  Play,
  Square,
  Download,
  Sparkles,
  Disc,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const GENERATOR_COLOR = "#00bcd4";

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
    activePlaybackSource,
    setActivePlaybackSource,
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  const hasManualSolo = useStudioStore((s) =>
    s.tracks.some((t) => t.solo && t.loaded),
  );
  const isDimmed = hasManualSolo;
  const isActive = isRunning && activePlaybackSource === "generator";

  const handlePlayStop = async () => {
    if (isRunning) {
      stop();
      setActivePlaybackSource(null);
    } else {
      try {
        await start();
        setActivePlaybackSource("generator");
      } catch (err) {
        stop();
        setActivePlaybackSource(null);
        console.error("Generator start failed:", err);
      }
    }
  };

  const handleExport = () => exportWav(generatorExportDuration);

  return (
    <div
      data-testid="procedural-track"
      className={`group flex flex-col gap-2 p-3 rounded-md border transition-all duration-200 ${
        isDimmed ? "opacity-50" : ""
      } ${
        isActive
          ? "border-[var(--accent)] shadow-[0_0_12px_var(--glow-cyan)]"
          : "border-[var(--border)]"
      } bg-[var(--surface)]`}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{
            backgroundColor: `${GENERATOR_COLOR}20`,
            color: GENERATOR_COLOR,
          }}
        >
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-mono text-xs tracking-wider text-[var(--text-dim)]">
            PROCEDURAL
          </span>
          {isRunning && (
            <span
              data-testid="current-scene"
              className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-[var(--accent)]/20 text-[var(--accent)]"
            >
              {currentScene}
            </span>
          )}
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isRunning ? "destructive" : "outline"}
                size="sm"
                onClick={handlePlayStop}
                data-testid="generator-play-stop"
                className={`h-8 text-xs font-mono ${
                  isRunning
                    ? "bg-[var(--accent3)]/10 text-[var(--accent3)] border-[var(--accent3)] hover:bg-[var(--accent3)]/20"
                    : ""
                }`}
              >
                {isRunning ? (
                  <Square className="w-3 h-3 mr-1" />
                ) : (
                  <Play className="w-3 h-3 mr-1" />
                )}
                {isRunning ? "STOP" : "PLAY"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isRunning ? "Stop generator" : "Start generator"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          data-testid="generator-expand"
          aria-label={showAdvanced ? "Hide advanced" : "Show advanced"}
          aria-expanded={showAdvanced}
          className="text-[var(--text-dim)] hover:text-[var(--accent)] transition-colors"
        >
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </button>
      </div>

      {showAdvanced && (
        <div className="flex flex-wrap items-center gap-4 mt-2 pt-2 border-t border-[var(--border)]">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[var(--text-dim)] font-mono">
              Seed
            </label>
            <input
              data-testid="generator-seed"
              type="number"
              min={0}
              max={999999}
              value={generator.seed}
              onChange={(e) => setGeneratorSeed(parseInt(e.target.value) || 0)}
              className="w-16 px-1.5 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[var(--text-dim)] font-mono">
              Scenes
            </label>
            <Switch
              data-testid="generator-scenes-toggle"
              checked={generator.enableScenes}
              onCheckedChange={setGeneratorEnableScenes}
              className="data-[state=checked]:bg-[var(--accent3)]"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[var(--text-dim)] font-mono">
              Tempo
            </label>
            <input
              data-testid="generator-tempo"
              type="range"
              min={40}
              max={120}
              step={1}
              value={generator.tempo}
              aria-label="Tempo"
              onChange={(e) => setGeneratorTempo(parseInt(e.target.value))}
              className="w-20"
              style={{ accentColor: GENERATOR_COLOR }}
            />
            <span className="text-xs font-mono w-7">{generator.tempo}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[var(--text-dim)] font-mono">
              Cmplx
            </label>
            <input
              data-testid="generator-complexity"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(generator.complexity * 100)}
              onChange={(e) =>
                setGeneratorComplexity(parseInt(e.target.value) / 100)
              }
              aria-label="Complexity"
              className="w-20"
              style={{ accentColor: GENERATOR_COLOR }}
            />
            <span className="text-xs font-mono w-7">
              {Math.round(generator.complexity * 100)}%
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[var(--text-dim)] font-mono">
              Space
            </label>
            <input
              data-testid="generator-space"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(generator.space * 100)}
              onChange={(e) =>
                setGeneratorSpace(parseInt(e.target.value) / 100)
              }
              aria-label="Space"
              className="w-20"
              style={{ accentColor: GENERATOR_COLOR }}
            />
            <span className="text-xs font-mono w-7">
              {Math.round(generator.space * 100)}%
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Disc className="w-3 h-3 text-[var(--text-dim)]" />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(generator.drumLevel * 100)}
              onChange={(e) =>
                setGeneratorDrumLevel(parseInt(e.target.value) / 100)
              }
              aria-label="Drum Level"
              className="w-20"
              style={{ accentColor: GENERATOR_COLOR }}
            />
            <span className="text-xs font-mono w-7">
              {Math.round(generator.drumLevel * 100)}%
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-[var(--text-dim)] font-mono">
              Scene Bars
            </label>
            <select
              data-testid="generator-scene-duration"
              value={generator.sceneDuration}
              onChange={(e) =>
                setGeneratorSceneDuration(parseInt(e.target.value))
              }
              className="px-1.5 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
            >
              <option value={16}>16</option>
              <option value={32}>32</option>
              <option value={64}>64</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={isExporting}
              data-testid="generator-export-wav"
              className="h-7 text-xs font-mono border-[var(--accent2)] text-[var(--accent2)] hover:bg-[var(--accent2)]/10"
            >
              {isExporting ? (
                `${exportProgress}%`
              ) : (
                <>
                  <Download className="w-3 h-3 mr-1" /> EXPORT WAV
                </>
              )}
            </Button>
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-[var(--text-dim)] font-mono">
                Min
              </label>
              <input
                data-testid="generator-export-duration"
                type="number"
                min={1}
                max={60}
                value={generatorExportDuration}
                onChange={(e) =>
                  setGeneratorExportDuration(
                    Math.max(1, Math.min(60, parseInt(e.target.value) || 1)),
                  )
                }
                className="w-12 px-1 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
              />
            </div>
          </div>
        </div>
      )}

      {isExporting && (
        <div className="mt-1">
          <Progress value={exportProgress} className="h-1.5" />
        </div>
      )}
    </div>
  );
}
