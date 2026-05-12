"use client";

import { useEffect, useRef, useState } from "react";
import { useStudioStore } from "@/store/studioStore";
import { PRESETS } from "@/types";
import { Trees, Waves, Rocket, Coffee, Save, Trash2, ChevronDown } from "lucide-react";

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
  const { applyPreset, addLog, customPresets, saveCustomPreset, deleteCustomPreset, loadCustomPresets } =
    useStudioStore();

  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadCustomPresets();
  }, [loadCustomPresets]);

  useEffect(() => {
    if (saving) inputRef.current?.focus();
  }, [saving]);

  const handlePreset = (name: string) => {
    const preset = PRESETS[name];
    if (preset) {
      applyPreset(preset.volumes, preset.eq);
      addLog(`Applied preset: ${name}`, "ok");
    }
  };

  const handleSave = () => {
    const name = newName.trim();
    if (!name) return;
    saveCustomPreset(name);
    addLog(`Saved preset: ${name}`, "ok");
    setNewName("");
    setSaving(false);
  };

  const handleDelete = (name: string) => {
    deleteCustomPreset(name);
    addLog(`Deleted preset: ${name}`, "info");
  };

  const handleApplyCustom = (name: string) => {
    const preset = customPresets.find((p) => p.name === name);
    if (preset) {
      applyPreset(preset.volumes, preset.eq);
      addLog(`Applied preset: ${name}`, "ok");
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-[var(--text-dim)] font-mono mr-2">PRESETS</span>

      {/* Built-in presets */}
      {Object.keys(PRESETS).map((name) => (
        <button
          key={name}
          onClick={() => handlePreset(name)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all hover:scale-105"
          style={{ borderColor: `${presetColors[name]}40`, color: presetColors[name] }}
        >
          {presetIcons[name]}
          <span className="text-xs font-medium">{name}</span>
        </button>
      ))}

      <div className="w-px h-5 bg-[var(--border)] mx-1" />

      {/* Custom presets dropdown */}
      {customPresets.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setShowCustom((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all text-xs"
          >
            MY PRESETS
            <ChevronDown className={`w-3 h-3 transition-transform ${showCustom ? "rotate-180" : ""}`} />
          </button>

          {showCustom && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl min-w-[160px] py-1">
              {customPresets.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center justify-between px-3 py-1.5 hover:bg-[var(--surface2)] group"
                >
                  <button
                    onClick={() => { handleApplyCustom(p.name); setShowCustom(false); }}
                    className="flex-1 text-left text-xs text-[var(--text)] hover:text-[var(--accent)] transition-colors truncate"
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => handleDelete(p.name)}
                    className="opacity-0 group-hover:opacity-100 ml-2 text-[var(--text-dim)] hover:text-[var(--warn)] transition-all"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Save current mix as preset */}
      {saving ? (
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") { setSaving(false); setNewName(""); }
            }}
            placeholder="Preset name..."
            className="px-2 py-1 text-xs bg-[var(--surface2)] border border-[var(--accent)] rounded text-[var(--text)] focus:outline-none w-32"
          />
          <button
            onClick={handleSave}
            disabled={!newName.trim()}
            className="px-2 py-1 text-xs bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)] rounded hover:bg-[var(--accent)]/30 disabled:opacity-40 transition-colors"
          >
            Save
          </button>
          <button
            onClick={() => { setSaving(false); setNewName(""); }}
            className="px-2 py-1 text-xs text-[var(--text-dim)] border border-[var(--border)] rounded hover:border-[var(--text-dim)] transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setSaving(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent3)] hover:text-[var(--accent3)] transition-all text-xs"
        >
          <Save className="w-3.5 h-3.5" />
          SAVE
        </button>
      )}
    </div>
  );
}
