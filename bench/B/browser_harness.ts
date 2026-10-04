/**
 * bench/B/browser_harness.ts — in-page measurement harness for the
 * ground-truth environment (headless Chromium via Playwright).
 * Exposes window.__bench; run_B.mjs drives it and wraps results.
 *
 * Memory source: performance.memory (Chromium-specific) sampled at
 * B_HEAP_POLL_INTERVAL_MS; the poller is also used to catch peak heap.
 */
import { renderAmbient, audioBufferToWav, REPO_DEFAULT_PARAMS } from "./engine_exports";

const HEAP_POLL_MS = Number(process.env.BENCH_B_HEAP_POLL_MS ?? 100);

interface PhaseStamp { phase: string; percent: number; t_ms: number }

async function peakHeapDuring<T>(fn: () => Promise<T>): Promise<{ value: T; peak_heap_bytes: number; heap_source: string }> {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  let peak = 0;
  const timer = setInterval(() => {
    if (mem) peak = Math.max(peak, mem.usedJSHeapSize);
  }, HEAP_POLL_MS);
  try {
    const value = await fn();
    if (mem) peak = Math.max(peak, mem.usedJSHeapSize);
    return { value, peak_heap_bytes: peak, heap_source: mem ? "performance.memory.usedJSHeapSize" : "unavailable" };
  } finally {
    clearInterval(timer);
  }
}

export interface SweepPoint {
  duration_minutes: number;
  scheduling_wall_ms: number;
  startRendering_wall_ms: number;
  total_wall_ms: number;
  trim_wall_ms: number;
  peak_heap_bytes: number;
  heap_source: string;
  output_frames: number;
  wav_encode_ms: number | null;
  wav_bytes: number | null;
  outcome: "ok" | "error";
  error?: string;
}

export async function runSweep(durationsMinutes: number[]): Promise<SweepPoint[]> {
  const points: SweepPoint[] = [];
  for (const minutes of durationsMinutes) {
    const durationSeconds = minutes * 60;
    let phases: PhaseStamp[] = [];
    try {
      const { value: buf, peak_heap_bytes, heap_source } = await peakHeapDuring(async () => {
        const t0 = performance.now();
        phases = [];
        const buffer = await renderAmbient(
          { ...REPO_DEFAULT_PARAMS },
          durationSeconds,
          undefined,
          (p) => phases.push({ ...p, t_ms: performance.now() - t0 }),
        );
        return buffer;
      });
      // B3: WAV encode step timed in isolation from the render.
      let wavEncodeMs: number | null = null;
      let wavBytes: number | null = null;
      try {
        const t0 = performance.now();
        const blob = audioBufferToWav(buf);
        wavEncodeMs = performance.now() - t0;
        wavBytes = blob.size;
      } catch (e) {
        void e; // WAV encode failure must not erase the render measurement
      }
      const renderingStart = phases.find((p) => p.phase === "rendering");
      const encodingStart = phases.find((p) => p.percent === 85);
      const schedulingEnd = renderingStart?.t_ms ?? NaN;
      const renderEnd = encodingStart?.t_ms ?? NaN;
      points.push({
        duration_minutes: minutes,
        scheduling_wall_ms: schedulingEnd,
        startRendering_wall_ms: Math.max(0, renderEnd - schedulingEnd),
        total_wall_ms: phases.length ? phases[phases.length - 1].t_ms : NaN,
        trim_wall_ms: NaN, // trim is inside renderAmbient after percent 100; not separable
        peak_heap_bytes,
        heap_source,
        output_frames: buf.length,
        wav_encode_ms: wavEncodeMs,
        wav_bytes: wavBytes,
        outcome: "ok",
      });
    } catch (err) {
      points.push({
        duration_minutes: minutes,
        scheduling_wall_ms: NaN, startRendering_wall_ms: NaN, total_wall_ms: NaN, trim_wall_ms: NaN,
        peak_heap_bytes: NaN, heap_source: "unavailable", output_frames: 0,
        wav_encode_ms: null, wav_bytes: null,
        outcome: "error",
        error: String((err as Error)?.message ?? err),
      });
      break; // a crashed/failed render invalidates longer points; keep shorter results
    }
  }
  return points;
}

declare global {
  interface Window {
    __bench: { runSweep: typeof runSweep };
  }
}
window.__bench = { runSweep };
