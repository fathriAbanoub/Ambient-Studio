"use client";

import { Header } from "@/components/studio/Header";
import { ProceduralTrack } from "@/components/studio/ProceduralTrack";
import { LogConsole } from "@/components/studio/LogConsole";

export default function StudioPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <Header />

      <div className="flex-1 flex flex-col gap-2 p-4 min-h-0 overflow-y-auto">
        <ProceduralTrack masterGainNode={null} />
      </div>

      <LogConsole />
    </div>
  );
}
