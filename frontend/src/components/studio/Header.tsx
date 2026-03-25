"use client";

import { useStudioStore } from "@/store/studioStore";
import { BackendStatus } from "@/types";
import { Activity } from "lucide-react";

export function Header() {
  const { isPlaying, isExporting, backendOnline } = useStudioStore();
  
  const getStatus = (): BackendStatus => {
    if (!backendOnline) return "offline";
    if (isExporting) return "exporting";
    if (isPlaying) return "playing";
    return "idle";
  };
  
  const status = getStatus();
  
  const statusConfig = {
    idle: {
      color: "bg-[var(--text-dim)]",
      text: "IDLE",
      pulseClass: "",
    },
    playing: {
      color: "bg-[var(--accent3)]",
      text: "PLAYING",
      pulseClass: "animate-pulse-slow",
    },
    exporting: {
      color: "bg-[var(--warn)]",
      text: "EXPORTING",
      pulseClass: "animate-pulse-fast",
    },
    offline: {
      color: "bg-red-500",
      text: "OFFLINE",
      pulseClass: "",
    },
  };
  
  const config = statusConfig[status];
  
  return (
    <header className="relative z-10 border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="font-mono text-xs text-[var(--text-dim)] tracking-widest">
              SOUND MIXER
            </span>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="text-[var(--text-bright)]">AMBIENT</span>
              <span className="text-[var(--accent)]">.STUDIO</span>
            </h1>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div 
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--surface2)]`}
          >
            <span className={`w-2 h-2 rounded-full ${config.color} ${config.pulseClass}`} />
            <span className="font-mono text-xs text-[var(--text)] tracking-wide">
              {config.text}
            </span>
          </div>
          
          <a 
            href="https://github.com" 
            target="_blank" 
            rel="noopener noreferrer"
            className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface2)] hover:bg-[var(--border)] transition-colors"
          >
            <Activity className="w-4 h-4 text-[var(--text-dim)]" />
          </a>
        </div>
      </div>
    </header>
  );
}
