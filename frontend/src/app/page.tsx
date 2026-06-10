"use client";

import { useEffect, useRef, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { checkHealth } from "@/lib/api";
import { Header } from "@/components/studio/Header";
import { Transport } from "@/components/studio/Transport";
import { TrackCard } from "@/components/studio/TrackCard";
import { ProceduralTrack } from "@/components/studio/ProceduralTrack";
import { EQPanel } from "@/components/studio/EQPanel";
import { BottomDrawer } from "@/components/studio/BottomDrawer";

export default function StudioPage() {
  const { tracks, initTracks, setBackendOnline, addLog, masterGain, eqGains } =
    useStudioStore();
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastBackendStatusRef = useRef<boolean | null>(null);

  const engine = useAudioEngine(tracks, masterGain, eqGains);

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  useEffect(() => {
    initTracks(8);
    const checkBackend = async () => {
      const health = await checkHealth();
      const isOnline = health !== null;
      setBackendOnline(isOnline);
      if (lastBackendStatusRef.current !== isOnline) {
        if (health) addLog(`Backend connected (v${health.version})`, "ok");
        else addLog("Backend offline - WAV export only", "err");
        lastBackendStatusRef.current = isOnline;
      }
    };
    checkBackend();
    const interval = setInterval(checkBackend, 30000);
    return () => {
      clearInterval(interval);
      const ctx = audioContextRef.current;
      if (ctx && ctx.state !== "closed") {
        try {
          ctx.close();
        } catch {
          /* already closed */
        }
      }
    };
  }, [initTracks, setBackendOnline, addLog]);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <Header />
      <Transport engine={engine} />

      <div className="flex-1 flex gap-4 p-4 min-h-0">
        <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
          <ProceduralTrack />
          {tracks.map((track, index) => (
            <TrackCard
              key={track.id}
              track={track}
              index={index}
              getAudioContext={getAudioContext}
            />
          ))}
        </div>

        <div className="w-[280px] shrink-0 relative">
          <div className="absolute left-0 top-0 bottom-0 w-px bg-[var(--border)]" />
          <EQPanel />
        </div>
      </div>

      <BottomDrawer engine={engine} />
    </div>
  );
}
