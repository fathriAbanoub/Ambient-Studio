"use client";

import { useStudioStore } from "@/store/studioStore";
import { Github } from "lucide-react";

type StudioStatus = "idle" | "playing";

export function Header() {
  const { generator } = useStudioStore();

  const status: StudioStatus = generator.isRunning ? "playing" : "idle";
  const statusConfig: Record<
    StudioStatus,
    { color: string; text: string; pulseClass: string }
  > = {
    idle: { color: "bg-[var(--text-dim)]", text: "IDLE", pulseClass: "" },
    playing: {
      color: "bg-[var(--accent3)]",
      text: "PLAYING",
      pulseClass: "animate-pulse-slow",
    },
  };
  const config = statusConfig[status];

  return (
    <header className="relative z-10 border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="font-mono text-xs text-[var(--text-dim)] tracking-widest">
              GENERATIVE ENGINE
            </span>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="text-[var(--text-bright)]">AMBIENT</span>
              <span className="text-[var(--accent)]">.STUDIO</span>
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-4">
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
