"use client";

import { useEffect, useRef, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import { checkHealth } from "@/lib/api";
import { Header } from "@/components/studio/Header";
import { Transport } from "@/components/studio/Transport";
import { TrackCard } from "@/components/studio/TrackCard";
import { EQPanel } from "@/components/studio/EQPanel";
import { ExportPanel } from "@/components/studio/ExportPanel";
import { PresetBar } from "@/components/studio/PresetBar";
import { LogConsole } from "@/components/studio/LogConsole";

export default function StudioPage() {
  const { tracks, initTracks, setBackendOnline, addLog } = useStudioStore();
  const audioContextRef = useRef<AudioContext | null>(null);
  
  // Get or create audio context (used by TrackCard for decoding)
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);
  
  // Initialize tracks on mount
  useEffect(() => {
    initTracks(8);
    
    // Check backend health
    const checkBackend = async () => {
      const health = await checkHealth();
      setBackendOnline(health !== null);
      if (health) {
        addLog(`Backend connected (v${health.version})`, "ok");
      } else {
        addLog("Backend offline - WAV export only", "err");
      }
    };
    
    checkBackend();
    
    // Periodic health check
    const interval = setInterval(checkBackend, 30000);
    
    return () => {
      clearInterval(interval);
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, [initTracks, setBackendOnline, addLog]);
  
  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <Header />
      
      <Transport />
      
      {/* Preset Bar */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)]/60 px-6 py-2">
        <PresetBar />
      </div>
      
      {/* Main Content */}
      <div className="flex-1 flex gap-4 p-4 min-h-0">
        {/* Track List */}
        <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
          {tracks.map((track, index) => (
            <TrackCard
              key={track.id}
              track={track}
              index={index}
              getAudioContext={getAudioContext}
            />
          ))}
        </div>
        
        {/* EQ Panel */}
        <div className="w-[280px] shrink-0">
          <EQPanel />
        </div>
      </div>
      
      <ExportPanel />
      
      <LogConsole />
    </div>
  );
}
