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
    isPlaying: storeIsPlaying,
  } = useStudioStore();

  const {
    isPlaying: engineIsPlaying,
    play,
    stop,
    getAnalyserData,
    initAudio,
  } = engine;

  const isPlaybackActive = storeIsPlaying || engineIsPlaying;

  const timerRef = useRef<HTMLDivElement>(null);
  const vuBarsRef = useRef<(HTMLDivElement | null)[]>([]);

  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const getAnalyserDataRef = useRef(getAnalyserData);
  useEffect(() => {
    getAnalyserDataRef.current = getAnalyserData;
  }, [getAnalyserData]);

  const resumePendingRef = useRef(false);

  const update = useCallback(() => {
    // ✅ FIX: Guard against AudioContext unavailability
    let ctx: AudioContext | null = null;
    try {
      ctx = getSharedAudioContext();
    } catch {
      ctx = null;
    }
    if (ctx && ctx.state !== "closed") {
      if (ctx.state === "suspended") {
        if (!resumePendingRef.current) {
          resumePendingRef.current = true;
          ctx
            .resume()
            .catch(() => {})
            .finally(() => {
              resumePendingRef.current = false;
            });
        }
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
        bar.style.backgroundColor = isHigh
          ? "var(--warning)"
          : isMid
            ? "#ffd740"
            : "var(--accent3)";
        bar.style.opacity = height > 10 ? "1" : "0.3";
      }
    }

    animationRef.current = requestAnimationFrame(update);
  }, []);

  useEffect(() => {
    if (isPlaybackActive) {
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
  }, [isPlaybackActive, update]);

  const handlePlay = async () => {
    setIsPlaying(true);
    setActivePlaybackSource("manual");

    try {
      await initAudio();
    } catch (err) {
      console.error("initAudio failed:", err);
    }

    let ctx: AudioContext | null = null;
    try {
      ctx = getSharedAudioContext();
    } catch {
      // AudioContext not available in this environment
    }
    if (ctx) {
      startTimeRef.current = ctx.currentTime;
    } else {
      startTimeRef.current = 0;
    }

    try {
      await play();
    } catch (err) {
      console.error("Playback failed:", err);
    }
  };

  const handleStop = () => {
    stop();
    setIsPlaying(false);
    setActivePlaybackSource(null);
  };

  const isManualActive = activePlaybackSource === "manual" && isPlaybackActive;

  return (
    <div className="relative z-10 border-b border-[var(--border)] bg-[var(--surface)]/60 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-3 gap-6">
        <div className="flex items-center gap-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="transport-play-stop"
                  aria-label={
                    isPlaybackActive ? "Stop playback" : "Start playback"
                  }
                  onClick={isPlaybackActive ? handleStop : handlePlay}
                  className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                    isManualActive
                      ? "border-[var(--accent)] shadow-[0_0_12px_var(--glow-cyan)] bg-[var(--accent)]/20"
                      : "border-[var(--border)] hover:border-[var(--accent)]"
                  }`}
                >
                  {isPlaybackActive ? (
                    <Square className="w-5 h-5 text-[var(--accent)]" />
                  ) : (
                    <Play className="w-5 h-5 text-[var(--accent)] ml-0.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {isPlaybackActive ? "Stop" : "Play"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {isPlaybackActive && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleStop}
                    data-testid="force-stop"
                    aria-label="Force stop playback"
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
              aria-label="Master volume"
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
                ref={(el) => {
                  vuBarsRef.current[i] = el;
                }}
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
