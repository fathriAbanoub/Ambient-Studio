"use client";

import { useRef, useEffect } from "react";
import { useStudioStore } from "@/store/studioStore";
import { Trash2 } from "lucide-react";

function formatTimestamp(date: Date): string {
  const hrs = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  const secs = date.getSeconds().toString().padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

export function LogConsole() {
  const { logs, clearLog } = useStudioStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);
  
  const getLogColor = (type: string) => {
    switch (type) {
      case "ok": return "text-[var(--accent3)]";
      case "err": return "text-[var(--warn)]";
      case "info": return "text-[var(--accent)]";
      default: return "text-[var(--text)]";
    }
  };
  
  return (
    <div className="relative z-10 border-t border-[var(--border)] bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
        <span className="text-xs font-mono text-[var(--text-dim)]">CONSOLE</span>
        <button
          onClick={clearLog}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--warn)] transition-colors"
        >
          <Trash2 className="w-3 h-3" />
          Clear
        </button>
      </div>
      
      {/* Log entries */}
      <div
        ref={scrollRef}
        className="h-24 overflow-y-auto p-2 font-mono text-xs space-y-0.5"
      >
        {logs.length === 0 ? (
          <div className="text-[var(--text-dim)] opacity-50 py-2 text-center">
            Ready. Drop audio files to begin.
          </div>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className="flex gap-2">
              <span className="text-[var(--text-dim)] shrink-0">[{formatTimestamp(entry.timestamp)}]</span>
              <span className={getLogColor(entry.type)}>{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
