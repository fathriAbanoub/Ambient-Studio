"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import { Play, Square, Monitor, X } from "lucide-react";

interface VideoPreviewProps {
  backgroundImage: File | null;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function VideoPreview({ backgroundImage }: VideoPreviewProps) {
  const { tracks, masterGain, eqGains } = useStudioStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const bgImageRef = useRef<HTMLImageElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(false);

  const loadedTracks = tracks.filter((t) => t.loaded && t.buffer);

  // Load background image whenever it changes
  useEffect(() => {
    if (!backgroundImage) {
      bgImageRef.current = null;
      return;
    }
    const url = URL.createObjectURL(backgroundImage);
    const img = new Image();
    img.onload = () => { bgImageRef.current = img; };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [backgroundImage]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Background
    if (bgImageRef.current) {
      ctx.drawImage(bgImageRef.current, 0, 0, w, h);
    } else {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#0a0f1a");
      grad.addColorStop(1, "#0d1b2a");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // VU bars overlay at bottom
    if (analyserRef.current) {
      const data = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(data);
      const barCount = 48;
      const barW = w / barCount - 1;
      const step = Math.floor(data.length / barCount);

      ctx.save();
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < barCount; i++) {
        const val = data[i * step] / 255;
        const barH = val * (h * 0.35);
        const hue = 180 + val * 60;
        ctx.fillStyle = `hsl(${hue}, 90%, 60%)`;
        ctx.fillRect(i * (barW + 1), h - barH, barW, barH);
      }
      ctx.restore();
    }

    // Elapsed time overlay
    if (audioCtxRef.current && isPlaying) {
      const t = audioCtxRef.current.currentTime - startTimeRef.current;
      setElapsed(t);
      ctx.save();
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(formatTime(t), 10, h - 10);
      ctx.restore();
    }
  }, [isPlaying]);

  const renderLoop = useCallback(() => {
    drawFrame();
    animFrameRef.current = requestAnimationFrame(renderLoop);
  }, [drawFrame]);

  const stopAudio = useCallback(() => {
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch {} });
    sourcesRef.current = [];
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    setIsPlaying(false);
    setElapsed(0);
  }, []);

  // Draw one last static frame after stopping
  useEffect(() => {
    if (!isPlaying) {
      drawFrame();
    }
  }, [isPlaying, drawFrame]);

  const startPreview = useCallback(async () => {
    if (!loadedTracks.length) return;

    // Stop any existing playback first
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch {} });
    sourcesRef.current = [];
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    // Create fresh AudioContext
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      try {
        await audioCtxRef.current.close();
      } catch (e) {
        // Ignore if already closed
      }
    }
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    // Analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    analyserRef.current = analyser;

    // Master gain
    const master = ctx.createGain();
    master.gain.value = masterGain;
    master.connect(analyser);
    analyser.connect(ctx.destination);

    const hasSolo = tracks.some((t) => t.solo && t.loaded);

    tracks.forEach((track) => {
      if (!track.buffer || !track.loaded) return;
      if (track.muted || (hasSolo && !track.solo)) return;

      const gainNode = ctx.createGain();
      gainNode.gain.value = track.volume / 100;
      const panner = ctx.createStereoPanner();
      panner.pan.value = track.pan / 100;

      gainNode.connect(panner);
      panner.connect(master);

      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.loop = true;
      source.loopStart = Math.random() * track.buffer.duration;
      source.connect(gainNode);
      source.start(0, source.loopStart);
      sourcesRef.current.push(source);
    });

    startTimeRef.current = ctx.currentTime;
    setIsPlaying(true);
    renderLoop();
  }, [loadedTracks, tracks, masterGain, renderLoop]);

  // Stop when closed
  useEffect(() => {
    if (!open && isPlaying) stopAudio();
  }, [open, isPlaying, stopAudio]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudio();
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {
          // Ignore errors if already closed
        });
      }
    };
  }, [stopAudio]);

  // Draw static frame when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(drawFrame);
    }
  }, [open, drawFrame, backgroundImage]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={loadedTracks.length === 0}
        title={loadedTracks.length === 0 ? "Load tracks to preview" : "Preview video"}
        aria-label="Open video preview"
        className="flex items-center gap-2 px-3 py-2 rounded border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent2)] hover:text-[var(--accent2)] transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Monitor className="w-4 h-4" />
        Preview
      </button>
    );
  }

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--surface)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--surface2)]">
        <div className="flex items-center gap-2 text-xs text-[var(--text-dim)] font-mono">
          <Monitor className="w-3.5 h-3.5" />
          VIDEO PREVIEW
          {isPlaying && (
            <span className="text-[var(--accent3)] animate-pulse">● LIVE</span>
          )}
        </div>
        <button
          onClick={() => { stopAudio(); setOpen(false); }}
          aria-label="Close video preview"
          className="text-[var(--text-dim)] hover:text-[var(--warn)] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Canvas */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={480}
          height={270}
          className="w-full block"
          style={{ aspectRatio: "16/9" }}
        />

        {/* Play/Stop overlay */}
        {!isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <button
              onClick={startPreview}
              disabled={loadedTracks.length === 0}
              aria-label="Play video preview"
              className="w-14 h-14 rounded-full bg-[var(--accent)]/80 hover:bg-[var(--accent)] flex items-center justify-center transition-all hover:scale-110 disabled:opacity-40"
            >
              <Play className="w-6 h-6 text-black ml-1" />
            </button>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface2)]">
        <span className="font-mono text-xs text-[var(--text-dim)]">
          {formatTime(elapsed)}
        </span>
        {isPlaying ? (
          <button
            onClick={stopAudio}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)]/20 transition-colors"
          >
            <Square className="w-3 h-3" />
            Stop
          </button>
        ) : (
          <button
            onClick={startPreview}
            disabled={loadedTracks.length === 0}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-40"
          >
            <Play className="w-3 h-3" />
            Play
          </button>
        )}
        <span className="text-xs text-[var(--text-dim)]">
          {loadedTracks.length} track{loadedTracks.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
