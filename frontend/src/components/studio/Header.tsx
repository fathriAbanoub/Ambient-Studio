// frontend/src/components/studio/Header.tsx

"use client";

import { useStudioStore } from "@/store/studioStore";
import { PRESETS } from "@/types";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

type BackendStatus = "idle" | "playing" | "exporting" | "offline";

export function Header() {
  // Destructure the `generator` object to access its `isRunning` property
  const {
    isPlaying,
    isExporting,
    backendOnline,
    applyPreset,
    addLog,
    generator,
  } = useStudioStore();

  const getStatus = (): BackendStatus => {
    if (!backendOnline) return "offline";
    if (isExporting) return "exporting";
    // Check both manual and generator playback states
    if (isPlaying || generator.isRunning) return "playing";
    return "idle";
  };

  const status = getStatus();
  const statusConfig: Record<
    BackendStatus,
    { color: string; text: string; pulseClass: string }
  > = {
    idle: { color: "bg-[var(--text-dim)]", text: "IDLE", pulseClass: "" },
    playing: {
      color: "bg-[var(--accent3)]",
      text: "PLAYING",
      pulseClass: "animate-pulse-slow",
    },
    exporting: {
      color: "bg-[var(--warning)]",
      text: "EXPORTING",
      pulseClass: "animate-pulse-fast",
    },
    offline: { color: "bg-red-500", text: "OFFLINE", pulseClass: "" },
  };
  const config = statusConfig[status];

  const handlePreset = (name: string) => {
    const preset = PRESETS[name];
    if (preset) {
      applyPreset(preset.volumes, preset.eq);
      addLog(`Applied preset: ${name}`, "ok");
    }
  };

  return (
    <header className="relative z-10 border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-3">
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
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-dim)] font-mono">
              PRESETS
            </span>
            {Object.keys(PRESETS).map((name) => (
              <Button
                key={name}
                variant="outline"
                size="sm"
                onClick={() => handlePreset(name)}
                data-testid={`preset-${name.toLowerCase()}`}
                className="h-7 text-xs font-mono"
              >
                {name}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)]">
            <span
              className={`w-2 h-2 rounded-full ${config.color} ${config.pulseClass}`}
            />
            <span
              data-testid="status-indicator"
              className="font-mono text-xs text-[var(--text)] tracking-wide"
            >
              {config.text}
            </span>
          </div>
          {/* ✅ Added aria-label for accessibility */}
          <a
            href="https://github.com/fathriAbanoub/Ambient-Studio"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
            className="p-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] hover:bg-[var(--border)] transition-colors"
          >
            <Github className="w-4 h-4 text-[var(--text-dim)]" />
          </a>
        </div>
      </div>
    </header>
  );
}
