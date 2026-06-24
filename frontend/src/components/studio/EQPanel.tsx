"use client";

import { useRef, useEffect } from "react";
import { useStudioStore } from "@/store/studioStore";
import { EQ_BANDS } from "@/types";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

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
          data-testid="eq-reset"
          className="h-7 text-xs font-mono text-[var(--text-dim)] hover:text-[var(--accent2)] border-[var(--border)] hover:border-[var(--accent2)]"
        >
          <RotateCcw className="w-3 h-3 mr-1" /> RESET
        </Button>
      </div>

      <div className="mb-4">
        <FrequencyResponse eqGains={eqGains} />
      </div>

      <div className="flex-1 flex justify-around">
        {EQ_BANDS.map((band, i) => {
          const value = eqGains[i];
          const percentage = (value + 12) / 24;
          const thumbPercent = (1 - percentage) * 100;
          const centerPercent = 50;
          const fillTop = value >= 0 ? thumbPercent : centerPercent;
          const fillHeight = Math.abs(thumbPercent - centerPercent);

          return (
            <div
              key={band.label}
              className="flex flex-col items-center gap-2"
              role="group"
              aria-label={`EQ band ${band.label}`}
            >
              {/* Value display */}
              <div
                className="text-xs font-mono text-[var(--text)] w-8 text-center"
                aria-live="polite"
              >
                {value > 0 ? `+${value}` : value}
              </div>

              {/* Slider container */}
              <div className="relative w-6 h-32 rounded-md bg-[var(--surface-elevated)] border border-[var(--border)]">
                {/* Center line */}
                <div className="absolute left-0 right-0 top-1/2 h-px bg-[var(--text-dim)]/30 pointer-events-none" />

                {/* Custom fill (from center to thumb) */}
                <div
                  className="absolute left-0 right-0 bg-[var(--accent2)]/50 transition-all pointer-events-none"
                  style={{
                    height: `${fillHeight}%`,
                    top: `${fillTop}%`,
                  }}
                />

                {/* Radix Slider */}
                <Slider
                  orientation="vertical"
                  min={-12}
                  max={12}
                  step={1}
                  value={[value]}
                  onValueChange={([val]) => setEqGain(i, val)}
                  data-testid="eq-slider"
                  aria-label={`${band.label} gain`}
                  className={cn(
                    "absolute inset-0",
                    // Hide default track and range
                    "[&_[data-slot=slider-track]]:bg-transparent",
                    "[&_[data-slot=slider-range]]:hidden",
                    // Style the thumb as a horizontal bar
                    "[&_[data-slot=slider-thumb]]:w-4",
                    "[&_[data-slot=slider-thumb]]:h-2",
                    "[&_[data-slot=slider-thumb]]:rounded-md",
                    "[&_[data-slot=slider-thumb]]:bg-[var(--accent2)]",
                    "[&_[data-slot=slider-thumb]]:shadow-md",
                    "[&_[data-slot=slider-thumb]]:border-0",
                    "[&_[data-slot=slider-thumb]]:ring-0",
                    "[&_[data-slot=slider-thumb]]:focus-visible:ring-2",
                    "[&_[data-slot=slider-thumb]]:focus-visible:ring-[var(--accent)]",
                    "[&_[data-slot=slider-thumb]]:left-1/2",
                    "[&_[data-slot=slider-thumb]]:-translate-x-1/2",
                    "[&_[data-slot=slider-thumb]]:m-0",
                  )}
                />
              </div>

              {/* Label */}
              <div
                data-testid={`eq-label-${band.label}`}
                className="text-xs text-[var(--text-dim)] font-mono"
              >
                {band.label}
              </div>

              {/* Frequency */}
              <div className="text-xs text-[var(--text-dim)]/50">
                {band.freq >= 1000 ? `${band.freq / 1000}k` : band.freq}Hz
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-center mt-4 text-xs text-[var(--text-dim)]">
        <span>-12dB</span>
        <span className="mx-8">0dB</span>
        <span>+12dB</span>
      </div>
    </div>
  );
}
