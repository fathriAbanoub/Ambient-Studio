"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import { Play, Square, Volume2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getSharedAudioContext } from "@/lib/audioContext";

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

interface TransportEngine {
  isPlaying: boolean;
  play: () => Promise<void>;
  stop: () => void;
  getAnalyserData: () => Uint8Array;
  initAudio: () => Promise<void>;
}

export function Transport({ engine }: { engine: TransportEngine }) {
  const {
    masterGain,
    setMasterGain,
    setIsPlaying,
    setActivePlaybackSource,
    activePlaybackSource,
  } = useStudioStore();

  const { isPlaying, play, stop, getAnalyserData, initAudio } = engine;

  const timerRef = useRef<HTMLDivElement>(null);
  const vuBarsRef = useRef<(HTMLDivElement | null)[]>([]);

  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const getAnalyserDataRef = useRef(getAnalyserData);
  useEffect(() => {
    getAnalyserDataRef.current = getAnalyserData;
  }, [getAnalyserData]);

  const update = useCallback(() => {
    const ctx = getSharedAudioContext();
    if (ctx && ctx.state !== "closed") {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      } else {
        const elapsed = ctx.currentTime - startTimeRef.current;
        if (timerRef.current) {
          timerRef.current.textContent = formatTime(Math.max(0, elapsed));
        }
      }
    }

    const data = getAnalyserDataRef.current();
    const bars = 16;
    for (let i = 0; i < bars; i++) {
      const start = Math.floor((i / bars) * data.length);
      const end = Math.floor(((i + 1) / bars) * data.length);
      const slice = data.slice(start, end);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      const height = Math.min(100, (avg / 255) * 100);

      const bar = vuBarsRef.current[i];
      if (bar) {
        bar.style.height = `${Math.max(4, height * 0.4)}px`;
        const isHigh = i >= 12;
        const isMid = i >= 8 && i < 12;
        bar.style.backgroundColor = isHigh ? "var(--warning)" : isMid ? "#ffd740" : "var(--accent3)";
        bar.style.opacity = height > 10 ? "1" : "0.3";
      }
    }

    animationRef.current = requestAnimationFrame(update);
  }, []);

  useEffect(() => {
    if (isPlaying) {
      update();
    } else {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      if (timerRef.current) {
        timerRef.current.textContent = "00:00:00";
      }
      vuBarsRef.current.forEach((bar) => {
        if (bar) {
          bar.style.height = "4px";
          bar.style.opacity = "0.3";
        }
      });
    }
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, update]);

  const handlePlay = async () => {
    try {
      await initAudio();
    } catch (err) {
      console.error("initAudio failed:", err);
      return;
    }

    const ctx = getSharedAudioContext();
    if (ctx) {
      startTimeRef.current = ctx.currentTime;
    } else {
      console.warn("AudioContext not available");
      startTimeRef.current = 0;
    }

    try {
      await play();
      setIsPlaying(true);
      setActivePlaybackSource("manual");
    } catch (err) {
      console.error("Playback failed:", err);
    }
  };

  const handleStop = () => {
    stop();
    setIsPlaying(false);
    setActivePlaybackSource(null);
  };

  const isManualActive = activePlaybackSource === "manual" && isPlaying;

  return (
    <div className="relative z-10 border-b border-[var(--border)] bg-[var(--surface)]/60 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-3 gap-6">
        <div className="flex items-center gap-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="transport-play-stop"
                  onClick={isPlaying ? handleStop : handlePlay}
                  className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                    isManualActive
                      ? "border-[var(--accent)] shadow-[0_0_12px_var(--glow-cyan)] bg-[var(--accent)]/20"
                      : "border-[var(--border)] hover:border-[var(--accent)]"
                  }`}
                >
                  {isPlaying ? (
                    <Square className="w-5 h-5 text-[var(--accent)]" />
                  ) : (
                    <Play className="w-5 h-5 text-[var(--accent)] ml-0.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{isPlaying ? "Stop" : "Play"}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {isPlaying && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleStop}
                    className="w-10 h-10 rounded-md border border-[var(--warning)] bg-[var(--surface-elevated)] flex items-center justify-center hover:bg-[var(--warning)]/20 transition-colors"
                  >
                    <Square className="w-4 h-4 text-[var(--warning)]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Force Stop</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        <div className="flex-1 flex justify-center">
          <div
            ref={timerRef}
            data-testid="timer"
            className="font-mono text-2xl tracking-wider text-[var(--text-bright)] bg-[var(--surface-elevated)] px-4 py-1 rounded-md border border-[var(--border)]"
          >
            00:00:00
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <Volume2 className="w-4 h-4 text-[var(--text-dim)]" />
            <input
              data-testid="master-volume"
              type="range"
              min="0"
              max="200"
              value={masterGain * 100}
              onChange={(e) => setMasterGain(parseInt(e.target.value) / 100)}
              className="w-24"
              style={{ accentColor: "var(--accent)" }}
            />
            <span
              data-testid="master-volume-value"
              className="font-mono text-xs text-[var(--text-dim)] w-8"
            >
              {Math.round(masterGain * 100)}%
            </span>
          </div>
          <div className="w-px h-6 bg-[var(--border)]" />

          <div className="flex items-end gap-0.5 h-8">
            {Array.from({ length: 16 }).map((_, i) => (
              <div
                key={i}
                ref={(el) => { vuBarsRef.current[i] = el; }}
                className="w-1.5 rounded-sm"
                style={{
                  height: "4px",
                  backgroundColor: "var(--accent3)",
                  opacity: 0.3,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
