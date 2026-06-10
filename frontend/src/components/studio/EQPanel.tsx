"use client";

import { useRef, useEffect, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import { EQ_BANDS } from "@/types";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function FrequencyResponse({ eqGains }: { eqGains: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(30, 45, 66, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const accent2 = getCSSVar("--accent2") || "#7c4dff";
    const accent = getCSSVar("--accent") || "#00e5ff";

    ctx.strokeStyle = accent2;
    ctx.lineWidth = 2;
    ctx.beginPath();

    const points = EQ_BANDS.map((band, i) => {
      const x = (i / (EQ_BANDS.length - 1)) * width;
      const y = height / 2 - (eqGains[i] / 12) * (height / 2);
      return { x, y };
    });

    points.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    points.forEach((point, i) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = EQ_BANDS[i].freq === 1000 ? accent : accent2;
      ctx.fill();
    });
  }, [eqGains]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-[60px] rounded-md border border-[var(--border)] bg-[var(--surface)]"
    />
  );
}

interface VerticalSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  frequency: number;
}

function VerticalSlider({
  value,
  onChange,
  label,
  frequency,
}: VerticalSliderProps) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const updateValue = useCallback(
    (clientY: number) => {
      if (!sliderRef.current) return;
      const rect = sliderRef.current.getBoundingClientRect();
      const y = clientY - rect.top;
      const percentage = 1 - Math.min(1, Math.max(0, y / rect.height));
      const db = Math.round((percentage * 24 - 12) * 2) / 2;
      onChange(Math.max(-12, Math.min(12, db)));
    },
    [onChange],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    updateValue(e.clientY);
    const handleMove = (e: MouseEvent) => {
      if (isDragging.current) updateValue(e.clientY);
    };
    const handleUp = () => {
      isDragging.current = false;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const touch = e.touches[0];
    updateValue(touch.clientY);
    const handleMove = (e: TouchEvent) => {
      if (isDragging.current && e.touches[0]) updateValue(e.touches[0].clientY);
    };
    const handleEnd = () => {
      isDragging.current = false;
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };
    window.addEventListener("touchmove", handleMove);
    window.addEventListener("touchend", handleEnd);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onChange(Math.min(12, value + 1));
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onChange(Math.max(-12, value - 1));
    }
  };

  const percentage = (value + 12) / 24;
  const thumbPercent = (1 - percentage) * 100;
  const centerPercent = 50;
  const fillTop = value >= 0 ? thumbPercent : centerPercent;
  const fillHeight = Math.abs(thumbPercent - centerPercent);

  return (
    <div
      className="flex flex-col items-center gap-2"
      role="group"
      aria-label={`EQ band ${label}`}
    >
      <div
        className="text-xs font-mono text-[var(--text)] w-8 text-center"
        aria-live="polite"
      >
        {value > 0 ? `+${value}` : value}
      </div>
      <div
        ref={sliderRef}
        role="slider"
        aria-valuemin={-12}
        aria-valuemax={12}
        aria-valuenow={value}
        aria-label={`${label} gain`}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleKeyDown}
        className="relative w-6 h-32 rounded-md cursor-pointer bg-[var(--surface-elevated)] border border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <div className="absolute left-0 right-0 top-1/2 h-px bg-[var(--text-dim)]/30" />
        <div
          className="absolute left-0 right-0 bg-[var(--accent2)]/50 transition-all"
          style={{ height: `${fillHeight}%`, top: `${fillTop}%` }}
        />
        <div
          className="absolute left-1/2 w-4 h-2 rounded-md bg-[var(--accent2)] shadow-md -translate-x-1/2"
          style={{
            top: `${thumbPercent}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>
      <div className="text-xs text-[var(--text-dim)] font-mono">{label}</div>
      <div className="text-xs text-[var(--text-dim)]/50">
        {frequency >= 1000 ? `${frequency / 1000}k` : frequency}Hz
      </div>
    </div>
  );
}

export function EQPanel() {
  const { eqGains, setEqGain, resetEq } = useStudioStore();
  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-[var(--text-bright)] tracking-wider">
          MASTER EQ
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={resetEq}
          className="h-7 text-xs font-mono text-[var(--text-dim)] hover:text-[var(--accent2)] border-[var(--border)] hover:border-[var(--accent2)]"
        >
          <RotateCcw className="w-3 h-3 mr-1" /> RESET
        </Button>
      </div>
      <div className="mb-4">
        <FrequencyResponse eqGains={eqGains} />
      </div>
      <div className="flex-1 flex justify-around">
        {EQ_BANDS.map((band, i) => (
          <VerticalSlider
            key={band.label}
            value={eqGains[i]}
            onChange={(db) => setEqGain(i, db)}
            label={band.label}
            frequency={band.freq}
          />
        ))}
      </div>
      <div className="flex justify-center mt-4 text-xs text-[var(--text-dim)]">
        <span>-12dB</span>
        <span className="mx-8">0dB</span>
        <span>+12dB</span>
      </div>
    </div>
  );
}
