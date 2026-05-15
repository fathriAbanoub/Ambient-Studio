"use client";

import { useRef, useEffect, useState } from "react";
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
  const [height, setHeight] = useState(96); // Default 96px (h-24)
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startY: number; startHeight: number }>({ startY: 0, startHeight: 0 });
  
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
  
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = {
      startY: e.clientY,
      startHeight: height
    };
  };
  
  useEffect(() => {
    if (!isResizing) return;

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = resizeRef.current.startY - e.clientY;
      const newHeight = Math.max(96, Math.min(600, resizeRef.current.startHeight + deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isResizing]);
  
  return (
    <div className="relative border-t border-[var(--border)] bg-[var(--bg)]">
      {/* Resize handle - at the very top */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 left-0 right-0 h-3 -mt-1.5 cursor-ns-resize hover:bg-[var(--accent)]/20 transition-colors flex items-center justify-center group z-50"
      >
        <div className="w-16 h-1 bg-[var(--text-dim)]/30 rounded-full group-hover:bg-[var(--accent)] group-hover:h-1.5 transition-all" />
      </div>
      
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
        className="overflow-y-auto p-2 font-mono text-xs space-y-0.5"
        style={{ height: `${height}px` }}
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
