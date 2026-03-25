"use client";

import { useRef, useEffect } from "react";
import { useStudioStore } from "@/store/studioStore";
import { EQ_BANDS } from "@/types";
import { RotateCcw } from "lucide-react";

function FrequencyResponse({ eqGains }: { eqGains: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.clearRect(0, 0, width, height);
    
    // Draw grid
    ctx.strokeStyle = "rgba(30, 45, 66, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    // Draw frequency response curve
    ctx.strokeStyle = "var(--accent2)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const points = EQ_BANDS.map((band, i) => {
      const x = (i / (EQ_BANDS.length - 1)) * width;
      const y = height / 2 - (eqGains[i] / 12) * (height / 2);
      return { x, y };
    });
    
    // Draw smooth curve through points
    points.forEach((point, i) => {
      if (i === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        // Simple line for now
        ctx.lineTo(point.x, point.y);
      }
    });
    
    ctx.stroke();
    
    // Draw points
    points.forEach((point, i) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = EQ_BANDS[i].freq === 1000 ? "var(--accent)" : "var(--accent2)";
      ctx.fill();
    });
  }, [eqGains]);
  
  return (
    <canvas 
      ref={canvasRef} 
      width={240} 
      height={60}
      className="w-full h-[60px] rounded border border-[var(--border)] bg-[var(--surface)]"
    />
  );
}

interface VerticalSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  frequency: number;
}

function VerticalSlider({ value, onChange, label, frequency }: VerticalSliderProps) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  
  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    updateValue(e.clientY);
    
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current) {
        updateValue(e.clientY);
      }
    };
    
    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };
  
  const updateValue = (clientY: number) => {
    if (!sliderRef.current) return;
    const rect = sliderRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const percentage = 1 - (y / rect.height);
    const db = Math.round((percentage * 24 - 12) * 2) / 2;
    onChange(Math.max(-12, Math.min(12, db)));
  };
  
  const percentage = (value + 12) / 24;
  
  return (
    <div className="flex flex-col items-center gap-2">
      {/* dB value */}
      <div className="text-xs font-mono text-[var(--text)] w-8 text-center">
        {value > 0 ? `+${value}` : value}
      </div>
      
      {/* Slider track */}
      <div
        ref={sliderRef}
        onMouseDown={handleMouseDown}
        className="relative w-6 h-32 rounded cursor-pointer bg-[var(--surface2)] border border-[var(--border)]"
      >
        {/* Center line */}
        <div className="absolute left-0 right-0 top-1/2 h-px bg-[var(--text-dim)]/30" />
        
        {/* Fill */}
        <div
          className="absolute bottom-0 left-0 right-0 rounded-b bg-[var(--accent2)]/50"
          style={{
            height: `${percentage * 100}%`,
            top: value < 0 ? "50%" : `${(1 - percentage) * 100}%`,
          }}
        />
        
        {/* Handle */}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-4 h-2 rounded bg-[var(--accent2)] shadow-lg"
          style={{
            top: `${(1 - percentage) * 100}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>
      
      {/* Labels */}
      <div className="text-xs text-[var(--text-dim)] font-mono">{label}</div>
      <div className="text-xs text-[var(--text-dim)]/50">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}Hz</div>
    </div>
  );
}

export function EQPanel() {
  const { eqGains, setEqGain, resetEq } = useStudioStore();
  
  return (
    <div className="flex flex-col h-full p-4 bg-[var(--surface)] rounded-lg border border-[var(--border)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-[var(--text-bright)] tracking-wider">
          MASTER EQ
        </h2>
        <button
          onClick={resetEq}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-dim)] hover:text-[var(--accent2)] border border-[var(--border)] rounded hover:border-[var(--accent2)] transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          RESET
        </button>
      </div>
      
      {/* Frequency Response */}
      <div className="mb-4">
        <FrequencyResponse eqGains={eqGains} />
      </div>
      
      {/* EQ Sliders */}
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
      
      {/* Scale */}
      <div className="flex justify-center mt-4 text-xs text-[var(--text-dim)]">
        <span>-12dB</span>
        <span className="mx-8">0dB</span>
        <span>+12dB</span>
      </div>
    </div>
  );
}
