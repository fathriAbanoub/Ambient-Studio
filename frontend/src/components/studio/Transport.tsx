"use client";

import { useEffect, useRef, useState } from "react";
import { useStudioStore } from "@/store/studioStore";
import { Play, Square, Volume2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function VUMeter({ analyserData }: { analyserData: Uint8Array }) {
  const bars = 16;
  const barHeights = Array.from({ length: bars }, (_, i) => {
    const start = Math.floor((i / bars) * analyserData.length);
    const end = Math.floor(((i + 1) / bars) * analyserData.length);
    const slice = analyserData.slice(start, end);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return Math.min(100, (avg / 255) * 100);
  });
  return (
    <div className="flex items-end gap-0.5 h-8">
      {barHeights.map((height, i) => {
        const isHigh = i >= 12;
        const isMid = i >= 8 && i < 12;
        return (
          <div
            key={i}
            className="w-1.5 rounded-sm transition-all duration-75"
            style={{
              height: `${Math.max(4, height * 0.4)}px`,
              backgroundColor: isHigh ? "var(--warning)" : isMid ? "#ffd740" : "var(--accent3)",
              opacity: height > 10 ? 1 : 0.3,
            }}
          />
        );
      })}
    </div>
  );
}

export function Transport({ engine }: { engine: any }) {
  const { masterGain, setMasterGain, setIsPlaying, setActivePlaybackSource, activePlaybackSource } = useStudioStore();
  const { isPlaying, play, stop, getAnalyserData, initAudio } = engine;
  const [analyserData, setAnalyserData] = useState<Uint8Array>(new Uint8Array(128));
  const [time, setTime] = useState(0);
  const animationRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (engine.audioContextRef) {
      audioContextRef.current = engine.audioContextRef.current;
    }
  }, [engine]);

  useEffect(() => {
    if (isPlaying) {
      const update = () => {
        const ctx = audioContextRef.current;
        if (ctx && ctx.state !== "closed") {
          setTime(Math.max(0, ctx.currentTime - startTimeRef.current));
        }
        const data = getAnalyserData();
        setAnalyserData(data);
        animationRef.current = requestAnimationFrame(update);
      };
      update();
    } else {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      setTime(0);
      setAnalyserData(new Uint8Array(128));
    }
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, getAnalyserData]);

  const handlePlay = async () => {
    await initAudio();
    const ctx = audioContextRef.current;
    if (ctx) startTimeRef.current = ctx.currentTime;
    play();
    setIsPlaying(true);
    setActivePlaybackSource("manual");
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
          <div className="font-mono text-2xl tracking-wider text-[var(--text-bright)] bg-[var(--surface-elevated)] px-4 py-1 rounded-md border border-[var(--border)]">
            {formatTime(time)}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <Volume2 className="w-4 h-4 text-[var(--text-dim)]" />
            <input
              type="range"
              min="0"
              max="200"
              value={masterGain * 100}
              onChange={(e) => setMasterGain(parseInt(e.target.value) / 100)}
              className="w-24"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="font-mono text-xs text-[var(--text-dim)] w-8">
              {Math.round(masterGain * 100)}%
            </span>
          </div>
          <div className="w-px h-6 bg-[var(--border)]" />
          <VUMeter analyserData={analyserData} />
        </div>
      </div>
    </div>
  );
}
