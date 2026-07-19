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
  Plus,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MAX_DRONE_LAYERS,
  MAX_SWING,
  type ScaleName,
  type DrumStyle,
  type TimbreMode,
} from "@ambient-engine/index";

const GENERATOR_COLOR = "#00bcd4";
const SEED_FALLBACK = 0;
const SEED_MAX = 999999;
const TEMPO_MIN_BPM = 40;
const TEMPO_MAX_BPM = 120;
const PERCENT = 100;
const MIN_EXPORT_MINUTES = 1;
const MAX_EXPORT_MINUTES = 60;
const MIN_DRONE_HZ = 20;
const MAX_DRONE_HZ = 2000;
const SAMPLE_DEFAULT_GAIN = 1;
const PARSE_INT_RADIX = 10;
const SCENE_BARS_OPTIONS = [16, 32, 64] as const;

const SCALE_OPTIONS: { value: ScaleName; label: string }[] = [
  { value: "majorPent", label: "Major Pentatonic" },
  { value: "minorPent", label: "Minor Pentatonic" },
  { value: "ionian", label: "Ionian" },
  { value: "dorian", label: "Dorian" },
  { value: "phrygian", label: "Phrygian" },
  { value: "lydian", label: "Lydian" },
  { value: "mixolydian", label: "Mixolydian" },
  { value: "aeolian", label: "Aeolian" },
  { value: "locrian", label: "Locrian" },
];

const TIMBRE_OPTIONS: TimbreMode[] = ["sine", "triangle", "softsq", "fm"];

function sampleLabel(id: string): string {
  const sep = id.indexOf("|");
  if (sep > 0 && sep < id.length - 1) return id.slice(sep + 1);
  return id.slice(0, 8);
}

interface ProceduralTrackProps {
  masterGainNode: GainNode | null;
}

export function ProceduralTrack({ masterGainNode }: ProceduralTrackProps) {
  const {
    generator,
    setGeneratorSeed,
    setGeneratorEnableScenes,
    setGeneratorSceneDuration,
    setGeneratorTempo,
    setGeneratorComplexity,
    setGeneratorSpace,
    setGeneratorDrumLevel,
    setGeneratorScale,
    setGeneratorEnableBeats,
    setGeneratorSwing,
    setGeneratorDrumStyle,
    setGeneratorSidechainAmount,
    addDroneLayer,
    updateDroneLayer,
    removeDroneLayer,
    addSampleBankEntry,
    removeSampleBankEntry,
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
  } = useProceduralEngine(masterGainNode);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const sampleInputRef = useRef<HTMLInputElement>(null);

  const hasManualSolo = useStudioStore((s) =>
    s.tracks.some((t) => t.solo && t.loaded),
  );
  const isDimmed = hasManualSolo;
  const isActive = isRunning && activePlaybackSource === "generator";
  const beatless = !generator.enableBeats;
  const drumsDisabled = beatless;

  // ✅ FIX: start() now returns Promise<boolean> — true only on confirmed
  // successful engine start, false on any failure (thrown error or the
  // early-return path when the engine was disposed during async start).
  // Previously start() swallowed errors internally, so this catch never fired
  // and setActivePlaybackSource("generator") was called unconditionally —
  // showing a generator glow even when the engine wasn't actually running.
  // Now we only set the active source after a confirmed success.
  //
  // ponytail: Removed the `else { stop(); }` branch on failure. start() already
  // runs cleanupStartedEngine() on failure internally. Calling stop() here
  // would tear down a newer engine if the user clicked Stop -> Play while the
  // first start was still pending (Start A's failure resolution would call
  // stop() and destroy Start B's newly running engine).
  const handlePlayStop = async () => {
    if (isRunning) {
      stop();
      setActivePlaybackSource(null);
    } else {
      const success = await start();
      if (success) {
        setActivePlaybackSource("generator");
      }
      // No else branch — start() handles its own cleanup on failure.
    }
  };

  const handleExport = () => exportWav(generatorExportDuration);

  const handleSampleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
      addSampleBankEntry({
        id: `${crypto.randomUUID()}|${file.name}`,
        url,
        gain: SAMPLE_DEFAULT_GAIN,
      });
    }
    e.target.value = "";
  };

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
                type="button"
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
          type="button"
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
        <div className="flex flex-col gap-3 mt-2 pt-2 border-t border-[var(--border)]">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-seed"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Seed
              </label>
              <input
                id="generator-seed"
                data-testid="generator-seed"
                type="number"
                min={SEED_FALLBACK}
                max={SEED_MAX}
                value={generator.seed}
                onChange={(e) =>
                  setGeneratorSeed(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX) || SEED_FALLBACK,
                  )
                }
                className="w-16 px-1.5 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono focus:outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-scenes-toggle"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Scenes
              </label>
              <Switch
                id="generator-scenes-toggle"
                data-testid="generator-scenes-toggle"
                checked={generator.enableScenes}
                onCheckedChange={setGeneratorEnableScenes}
                className="data-[state=checked]:bg-[var(--accent3)]"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-tempo"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Tempo
              </label>
              <input
                id="generator-tempo"
                data-testid="generator-tempo"
                type="range"
                min={TEMPO_MIN_BPM}
                max={TEMPO_MAX_BPM}
                step={1}
                value={generator.tempo}
                aria-label="Tempo"
                onChange={(e) =>
                  setGeneratorTempo(Number.parseInt(e.target.value, PARSE_INT_RADIX))
                }
                className="w-20"
                style={{ accentColor: GENERATOR_COLOR }}
              />
              <span className="text-xs font-mono w-7">{generator.tempo}</span>
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-complexity"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Cmplx
              </label>
              <input
                id="generator-complexity"
                data-testid="generator-complexity"
                type="range"
                min={0}
                max={PERCENT}
                step={1}
                value={Math.round(generator.complexity * PERCENT)}
                onChange={(e) =>
                  setGeneratorComplexity(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                  )
                }
                aria-label="Complexity"
                className="w-20"
                style={{ accentColor: GENERATOR_COLOR }}
              />
              <span
                data-testid="generator-complexity-value"
                className="text-xs font-mono w-7"
              >
                {Math.round(generator.complexity * PERCENT)}%
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-space"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Space
              </label>
              <input
                id="generator-space"
                data-testid="generator-space"
                type="range"
                min={0}
                max={PERCENT}
                step={1}
                value={Math.round(generator.space * PERCENT)}
                onChange={(e) =>
                  setGeneratorSpace(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                  )
                }
                aria-label="Space"
                className="w-20"
                style={{ accentColor: GENERATOR_COLOR }}
              />
              <span
                data-testid="generator-space-value"
                className="text-xs font-mono w-7"
              >
                {Math.round(generator.space * PERCENT)}%
              </span>
            </div>

            <div
              className={`flex items-center gap-1.5 ${drumsDisabled ? "opacity-40 pointer-events-none" : ""}`}
            >
              <Disc className="w-3 h-3 text-[var(--text-dim)]" />
              <input
                id="generator-drum-level"
                data-testid="generator-drum-level"
                type="range"
                min={0}
                max={PERCENT}
                step={1}
                value={Math.round(generator.drumLevel * PERCENT)}
                onChange={(e) =>
                  setGeneratorDrumLevel(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                  )
                }
                aria-label="Drum Level"
                disabled={drumsDisabled}
                className="w-20"
                style={{ accentColor: GENERATOR_COLOR }}
              />
              <span className="text-xs font-mono w-7">
                {Math.round(generator.drumLevel * PERCENT)}%
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-scene-duration"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Scene Bars
              </label>
              <select
                id="generator-scene-duration"
                data-testid="generator-scene-duration"
                value={generator.sceneDuration}
                onChange={(e) =>
                  setGeneratorSceneDuration(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX),
                  )
                }
                className="px-1.5 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
              >
                {SCENE_BARS_OPTIONS.map((bars) => (
                  <option key={bars} value={bars}>
                    {bars}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
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
                <label
                  htmlFor="generator-export-duration"
                  className="text-[10px] text-[var(--text-dim)] font-mono"
                >
                  Min
                </label>
                <input
                  id="generator-export-duration"
                  data-testid="generator-export-duration"
                  type="number"
                  min={MIN_EXPORT_MINUTES}
                  max={MAX_EXPORT_MINUTES}
                  value={generatorExportDuration}
                  onChange={(e) =>
                    setGeneratorExportDuration(
                      Math.max(
                        MIN_EXPORT_MINUTES,
                        Math.min(
                          MAX_EXPORT_MINUTES,
                          Number.parseInt(e.target.value, PARSE_INT_RADIX) ||
                            MIN_EXPORT_MINUTES,
                        ),
                      ),
                    )
                  }
                  className="w-12 px-1 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
                />
              </div>
            </div>
          </div>

          <div className="w-full border-t border-[var(--border)] my-1" />
          <span className="text-[10px] text-[var(--text-dim)] font-mono tracking-wider">
            SYNTHESIS
          </span>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-scale"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Scale
              </label>
              <select
                id="generator-scale"
                data-testid="generator-scale"
                value={generator.scale}
                onChange={(e) =>
                  setGeneratorScale(e.target.value as ScaleName)
                }
                className="px-1.5 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono max-w-[140px]"
              >
                {SCALE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <label
                htmlFor="generator-beatless-toggle"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Beatless
              </label>
              <Switch
                id="generator-beatless-toggle"
                data-testid="generator-beatless-toggle"
                checked={beatless}
                onCheckedChange={(checked) =>
                  setGeneratorEnableBeats(!checked)
                }
                className="data-[state=checked]:bg-[var(--accent3)]"
              />
            </div>

            <div
              className={`flex items-center gap-1.5 ${drumsDisabled ? "opacity-40 pointer-events-none" : ""}`}
            >
              <label
                htmlFor="generator-drum-style"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Drums
              </label>
              <select
                id="generator-drum-style"
                data-testid="generator-drum-style"
                value={generator.drumStyle}
                disabled={drumsDisabled}
                onChange={(e) =>
                  setGeneratorDrumStyle(e.target.value as DrumStyle)
                }
                className="px-1.5 py-1 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
              >
                <option value="euclideanTrap">Euclidean</option>
                <option value="fourFloor">4-on-Floor</option>
              </select>
            </div>

            <div
              className={`flex items-center gap-1.5 ${drumsDisabled ? "opacity-40 pointer-events-none" : ""}`}
            >
              <label
                htmlFor="generator-swing"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Swing
              </label>
              <input
                id="generator-swing"
                data-testid="generator-swing"
                type="range"
                min={0}
                max={Math.round(MAX_SWING * PERCENT)}
                step={1}
                value={Math.round(generator.swing * PERCENT)}
                disabled={drumsDisabled}
                onChange={(e) =>
                  setGeneratorSwing(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                  )
                }
                aria-label="Swing"
                className="w-20"
                style={{ accentColor: GENERATOR_COLOR }}
              />
              <span
                data-testid="generator-swing-value"
                className="text-xs font-mono w-7"
              >
                {Math.round(generator.swing * PERCENT)}%
              </span>
            </div>

            <div
              className={`flex items-center gap-1.5 ${drumsDisabled ? "opacity-40 pointer-events-none" : ""}`}
            >
              <label
                htmlFor="generator-sidechain"
                className="text-[10px] text-[var(--text-dim)] font-mono"
              >
                Duck
              </label>
              <input
                id="generator-sidechain"
                data-testid="generator-sidechain"
                type="range"
                min={0}
                max={PERCENT}
                step={1}
                value={Math.round(generator.sidechainAmount * PERCENT)}
                disabled={drumsDisabled}
                onChange={(e) =>
                  setGeneratorSidechainAmount(
                    Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                  )
                }
                aria-label="Sidechain"
                className="w-20"
                style={{ accentColor: GENERATOR_COLOR }}
              />
              <span
                data-testid="generator-sidechain-value"
                className="text-xs font-mono w-7"
              >
                {Math.round(generator.sidechainAmount * PERCENT)}%
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-dim)] font-mono tracking-wider">
                DRONE LAYERS
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="generator-drone-add"
                disabled={generator.drone.length >= MAX_DRONE_LAYERS}
                onClick={addDroneLayer}
                className="h-6 px-2 text-[10px] font-mono"
              >
                <Plus className="w-3 h-3 mr-0.5" /> ADD
              </Button>
              <span className="text-[10px] font-mono text-[var(--text-dim)]">
                {generator.drone.length}/{MAX_DRONE_LAYERS}
              </span>
            </div>
            {generator.drone.map((layer, index) => (
              <div
                key={layer.id}
                data-testid={`generator-drone-layer-${index}`}
                className="flex flex-wrap items-center gap-2 pl-1"
              >
                <span className="text-[10px] font-mono text-[var(--text-dim)] w-4">
                  {index + 1}
                </span>
                <div className="flex items-center gap-1">
                  <label
                    htmlFor={`drone-hz-${layer.id}`}
                    className="text-[10px] text-[var(--text-dim)] font-mono"
                  >
                    Hz
                  </label>
                  <input
                    id={`drone-hz-${layer.id}`}
                    data-testid={`generator-drone-hz-${index}`}
                    type="number"
                    min={MIN_DRONE_HZ}
                    max={MAX_DRONE_HZ}
                    step={1}
                    value={layer.hz}
                    onChange={(e) =>
                      updateDroneLayer(layer.id, {
                        hz: Math.max(
                          MIN_DRONE_HZ,
                          Number.parseFloat(e.target.value) || MIN_DRONE_HZ,
                        ),
                      })
                    }
                    className="w-14 px-1 py-0.5 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <label
                    htmlFor={`drone-amp-${layer.id}`}
                    className="text-[10px] text-[var(--text-dim)] font-mono"
                  >
                    Amp
                  </label>
                  <input
                    id={`drone-amp-${layer.id}`}
                    data-testid={`generator-drone-amp-${index}`}
                    type="range"
                    min={0}
                    max={PERCENT}
                    step={1}
                    value={Math.round(layer.amp * PERCENT)}
                    onChange={(e) =>
                      updateDroneLayer(layer.id, {
                        amp: Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                      })
                    }
                    className="w-16"
                    style={{ accentColor: GENERATOR_COLOR }}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <label
                    htmlFor={`drone-pan-${layer.id}`}
                    className="text-[10px] text-[var(--text-dim)] font-mono"
                  >
                    Pan
                  </label>
                  <input
                    id={`drone-pan-${layer.id}`}
                    data-testid={`generator-drone-pan-${index}`}
                    type="range"
                    min={-PERCENT}
                    max={PERCENT}
                    step={1}
                    value={Math.round(layer.pan * PERCENT)}
                    onChange={(e) =>
                      updateDroneLayer(layer.id, {
                        pan: Number.parseInt(e.target.value, PARSE_INT_RADIX) / PERCENT,
                      })
                    }
                    className="w-16"
                    style={{ accentColor: GENERATOR_COLOR }}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <label
                    htmlFor={`drone-timbre-${layer.id}`}
                    className="text-[10px] text-[var(--text-dim)] font-mono"
                  >
                    Timbre
                  </label>
                  <select
                    id={`drone-timbre-${layer.id}`}
                    data-testid={`generator-drone-timbre-${index}`}
                    value={layer.timbre}
                    onChange={(e) =>
                      updateDroneLayer(layer.id, {
                        timbre: e.target.value as TimbreMode,
                      })
                    }
                    className="px-1 py-0.5 bg-[var(--surface-elevated)] border border-[var(--border)] rounded-md text-xs font-mono"
                  >
                    {TIMBRE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  data-testid={`generator-drone-remove-${index}`}
                  onClick={() => removeDroneLayer(layer.id)}
                  aria-label={`Remove drone layer ${index + 1}`}
                  className="text-[var(--text-dim)] hover:text-[var(--accent3)] transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-dim)] font-mono tracking-wider">
                SAMPLE BANK
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="generator-sample-upload-btn"
                onClick={() => sampleInputRef.current?.click()}
                className="h-6 px-2 text-[10px] font-mono"
              >
                <Plus className="w-3 h-3 mr-0.5" /> ADD
              </Button>
              <input
                ref={sampleInputRef}
                data-testid="generator-sample-upload"
                type="file"
                accept="audio/*"
                multiple
                className="hidden"
                onChange={handleSampleUpload}
              />
            </div>
            {generator.sampleBank.length > 0 && (
              <div
                data-testid="generator-sample-bank-list"
                className="flex flex-wrap gap-1.5"
              >
                {generator.sampleBank.map((entry) => (
                  <div
                    key={entry.id}
                    data-testid={`generator-sample-${entry.id}`}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--surface-elevated)] border border-[var(--border)]"
                  >
                    <span className="text-[10px] font-mono text-[var(--text-dim)] max-w-[120px] truncate">
                      {sampleLabel(entry.id)}
                    </span>
                    <button
                      type="button"
                      data-testid={`generator-sample-remove-${entry.id}`}
                      onClick={() => removeSampleBankEntry(entry.id)}
                      aria-label={`Remove sample ${sampleLabel(entry.id)}`}
                      className="text-[var(--text-dim)] hover:text-[var(--accent3)] transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
