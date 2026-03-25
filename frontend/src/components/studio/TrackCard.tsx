"use client";

import { useCallback, useRef, useEffect } from "react";
import { Track } from "@/types";
import { useStudioStore } from "@/store/studioStore";
import { Volume2, Headphones, Mic, MicOff } from "lucide-react";

interface TrackCardProps {
  track: Track;
  index: number;
  getAudioContext: () => AudioContext;
}

function MiniWaveform({ buffer, color }: { buffer: AudioBuffer | null; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) {
      // Clear canvas if no buffer
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
      return;
    }
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    const width = canvas.width;
    const height = canvas.height;
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    for (let i = 0; i < width; i++) {
      const idx = Math.floor(i * step);
      const sample = Math.abs(data[idx] || 0);
      const y = height / 2 - (sample * height / 2);
      
      if (i === 0) {
        ctx.moveTo(i, y);
      } else {
        ctx.lineTo(i, y);
      }
    }
    
    ctx.stroke();
    
    // Mirror
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const idx = Math.floor(i * step);
      const sample = Math.abs(data[idx] || 0);
      const y = height / 2 + (sample * height / 2);
      
      if (i === 0) {
        ctx.moveTo(i, y);
      } else {
        ctx.lineTo(i, y);
      }
    }
    ctx.stroke();
  }, [buffer, color]);
  
  return (
    <canvas 
      ref={canvasRef} 
      width={60} 
      height={32}
      className="opacity-60"
    />
  );
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
    addLog 
  } = useStudioStore();
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  
  const handleFileSelect = useCallback(async (file: File) => {
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
  }, [getAudioContext, index, loadTrackFile, addLog]);
  
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  
  const handleClick = () => {
    if (!track.loaded) {
      fileInputRef.current?.click();
    }
  };
  
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    unloadTrack(index);
    addLog(`Removed track ${index + 1}`, "info");
  };
  
  const hasSolo = useStudioStore.getState().tracks.some(t => t.solo && t.loaded);
  const isDimmed = track.muted || (hasSolo && !track.solo);
  
  return (
    <div
      ref={dropRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onClick={handleClick}
      className={`
        group relative flex items-center gap-3 p-3 rounded-lg border transition-all duration-200
        ${track.loaded 
          ? "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/30" 
          : "border-dashed border-[var(--border)] bg-[var(--surface)]/50 hover:border-[var(--accent)]/50 cursor-pointer"
        }
        ${isDimmed ? "opacity-50" : ""}
      `}
      style={{
        boxShadow: track.loaded ? `inset 0 0 0 1px ${track.color}15` : "none",
      }}
    >
      {/* Track Number Badge */}
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
        style={{ backgroundColor: `${track.color}20`, color: track.color }}
      >
        {index + 1}
      </div>
      
      {/* File Info / Drop Zone */}
      <div className="flex-1 min-w-0">
        {track.loaded ? (
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] truncate">{track.name}</span>
            <span className="text-xs text-[var(--text-dim)] font-mono bg-[var(--surface2)] px-1.5 py-0.5 rounded">
              {formatDuration(track.duration)}
            </span>
            <button
              onClick={handleRemove}
              className="opacity-0 group-hover:opacity-100 text-xs text-[var(--text-dim)] hover:text-[var(--warn)] transition-opacity"
            >
              remove
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center py-2 text-[var(--text-dim)] text-sm">
            <span className="border border-dashed border-[var(--border)] px-4 py-1 rounded">
              DROP AUDIO
            </span>
          </div>
        )}
      </div>
      
      {/* Controls */}
      {track.loaded && (
        <div className="flex items-center gap-4 shrink-0">
          {/* Volume */}
          <div className="flex items-center gap-2">
            <Volume2 className="w-3.5 h-3.5 text-[var(--text-dim)]" />
            <input
              type="range"
              min="0"
              max="150"
              value={track.volume}
              onChange={(e) => setVolume(index, parseInt(e.target.value))}
              className="w-20 accent-[var(--accent)]"
              style={{ accentColor: track.color }}
            />
            <span className="text-xs font-mono text-[var(--text-dim)] w-6">{track.volume}</span>
          </div>
          
          {/* Pan */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--text-dim)]">L</span>
            <input
              type="range"
              min="-100"
              max="100"
              value={track.pan}
              onChange={(e) => setPan(index, parseInt(e.target.value))}
              className="w-16 accent-[var(--accent2)]"
            />
            <span className="text-xs text-[var(--text-dim)]">R</span>
            <span className="text-xs font-mono text-[var(--text-dim)] w-8">
              {track.pan > 0 ? `+${track.pan}` : track.pan}
            </span>
          </div>
          
          {/* Mute */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleMute(index); }}
            className={`
              w-8 h-8 rounded flex items-center justify-center border transition-all
              ${track.muted 
                ? "bg-[var(--warn)]/20 border-[var(--warn)] text-[var(--warn)]" 
                : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--text-dim)]"
              }
            `}
          >
            {track.muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
          
          {/* Solo */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleSolo(index); }}
            className={`
              w-8 h-8 rounded flex items-center justify-center border transition-all
              ${track.solo 
                ? "bg-[var(--accent)]/20 border-[var(--accent)] text-[var(--accent)]" 
                : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--text-dim)]"
              }
            `}
          >
            <Headphones className="w-4 h-4" />
          </button>
          
          {/* Mini Waveform */}
          <div className="w-[60px] h-8 flex items-center justify-center">
            <MiniWaveform buffer={track.buffer} color={track.color} />
          </div>
        </div>
      )}
      
      {/* Hidden file input */}
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
  );
}
