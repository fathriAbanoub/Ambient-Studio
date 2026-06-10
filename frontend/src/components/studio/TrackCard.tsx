"use client";

import { useCallback, useRef, useEffect } from "react";
import { Track } from "@/types";
import { useStudioStore } from "@/store/studioStore";
import { Volume2, Headphones, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TrackCardProps {
  track: Track;
  index: number;
  getAudioContext: () => AudioContext;
}

function MiniWaveform({
  buffer,
  color,
}: {
  buffer: AudioBuffer | null;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);
    if (!buffer) return;

    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const idx = Math.floor(i * step);
      const sample = Math.abs(data[idx] || 0);
      const y = height / 2 - (sample * height) / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const idx = Math.floor(i * step);
      const sample = Math.abs(data[idx] || 0);
      const y = height / 2 + (sample * height) / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }, [buffer, color]);

  return <canvas ref={canvasRef} className="w-[60px] h-8 opacity-60" />;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function TrackCard({ track, index, getAudioContext }: TrackCardProps) {
  const {
    loadTrackFile,
    unloadTrack,
    setVolume,
    setPan,
    toggleMute,
    toggleSolo,
    addLog,
  } = useStudioStore();
  const hasSolo = useStudioStore((s) =>
    s.tracks.some((t) => t.solo && t.loaded),
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("audio/")) {
        addLog(`Invalid file type: ${file.name}`, "err");
        return;
      }
      try {
        const ctx = getAudioContext();
        const arrayBuffer = await file.arrayBuffer();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        loadTrackFile(index, file, buffer);
        addLog(`Loaded: ${file.name}`, "ok");
      } catch (error) {
        addLog(`Failed to load ${file.name}: ${error}`, "err");
      }
    },
    [getAudioContext, index, loadTrackFile, addLog],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => e.preventDefault(),
    [],
  );
  const handleClick = () => {
    if (!track.loaded) fileInputRef.current?.click();
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    unloadTrack(index);
    addLog(`Removed track ${index + 1}`, "info");
  };

  const isDimmed = track.muted || (hasSolo && !track.solo);

  return (
    <TooltipProvider>
      <div
        ref={dropRef}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={handleClick}
        className={`group relative flex items-center gap-3 p-3 rounded-md border transition-all duration-200 ${
          track.loaded
            ? "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/30"
            : "border-dashed border-[var(--border)] bg-[var(--surface)]/50 hover:border-[var(--accent)]/50 cursor-pointer"
        } ${isDimmed ? "opacity-50" : ""}`}
        style={{
          boxShadow: track.loaded ? `inset 0 0 0 1px ${track.color}15` : "none",
        }}
      >
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center text-sm font-bold shrink-0"
          style={{ backgroundColor: `${track.color}20`, color: track.color }}
        >
          {index + 1}
        </div>

        <div className="flex-1 min-w-0">
          {track.loaded ? (
            <div className="flex items-center gap-2">
              <span className="font-medium text-[var(--text)] truncate">
                {track.name}
              </span>
              <span className="text-xs font-mono bg-[var(--surface-elevated)] px-1.5 py-0.5 rounded-md">
                {formatDuration(track.duration)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                className="h-6 text-xs opacity-0 group-hover:opacity-100 text-[var(--text-dim)] hover:text-[var(--warning)] transition-opacity px-2"
              >
                remove
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center py-2 text-[var(--text-dim)] text-sm">
              <span className="border border-dashed border-[var(--border)] px-4 py-1 rounded-md">
                DROP AUDIO
              </span>
            </div>
          )}
        </div>

        {track.loaded && (
          <div className="flex items-center gap-4 shrink-0">
            <div className="flex items-center gap-2">
              <Volume2 className="w-3.5 h-3.5 text-[var(--text-dim)]" />
              <input
                type="range"
                min="0"
                max="150"
                value={track.volume}
                onChange={(e) => setVolume(index, parseInt(e.target.value))}
                className="w-20"
                style={{ accentColor: track.color }}
              />
              <span className="text-xs font-mono text-[var(--text-dim)] w-6">
                {track.volume}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-xs text-[var(--text-dim)]">L</span>
              <input
                type="range"
                min="-100"
                max="100"
                value={track.pan}
                onChange={(e) => setPan(index, parseInt(e.target.value))}
                className="w-16"
                style={{ accentColor: "var(--accent2)" }}
              />
              <span className="text-xs text-[var(--text-dim)]">R</span>
              <span className="text-xs font-mono text-[var(--text-dim)] w-8">
                {track.pan > 0 ? `+${track.pan}` : track.pan}
              </span>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleMute(index);
                  }}
                  className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${
                    track.muted
                      ? "bg-[var(--warning)]/20 text-[var(--warning)]"
                      : "text-[var(--text-dim)] hover:bg-[var(--surface-elevated)]"
                  }`}
                >
                  {track.muted ? (
                    <MicOff className="w-4 h-4" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{track.muted ? "Unmute" : "Mute"}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSolo(index);
                  }}
                  className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${
                    track.solo
                      ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                      : "text-[var(--text-dim)] hover:bg-[var(--surface-elevated)]"
                  }`}
                >
                  <Headphones className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{track.solo ? "Unsolo" : "Solo"}</TooltipContent>
            </Tooltip>

            <MiniWaveform buffer={track.buffer} color={track.color} />
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelect(file);
          }}
          className="hidden"
        />
      </div>
    </TooltipProvider>
  );
}
