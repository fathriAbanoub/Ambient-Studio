"use client";

import { useStudioStore } from "@/store/studioStore";
import { PRESETS } from "@/types";
import { Trees, Waves, Rocket, Coffee } from "lucide-react";

const presetIcons: Record<string, React.ReactNode> = {
  Forest: <Trees className="w-4 h-4" />,
  Ocean: <Waves className="w-4 h-4" />,
  Space: <Rocket className="w-4 h-4" />,
  Café: <Coffee className="w-4 h-4" />,
};

const presetColors: Record<string, string> = {
  Forest: "#00e676",
  Ocean: "#00e5ff",
  Space: "#7c4dff",
  Café: "#ffd740",
};

export function PresetBar() {
  const { applyPreset, addLog } = useStudioStore();
  
  const handlePreset = (name: string) => {
    const preset = PRESETS[name];
    if (preset) {
      applyPreset(preset.volumes, preset.eq);
      addLog(`Applied preset: ${name}`, "ok");
    }
  };
  
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[var(--text-dim)] font-mono mr-2">PRESETS</span>
      {Object.keys(PRESETS).map((name) => (
        <button
          key={name}
          onClick={() => handlePreset(name)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all hover:scale-105"
          style={{
            borderColor: `${presetColors[name]}40`,
            color: presetColors[name],
          }}
        >
          {presetIcons[name]}
          <span className="text-xs font-medium">{name}</span>
        </button>
      ))}
    </div>
  );
}
