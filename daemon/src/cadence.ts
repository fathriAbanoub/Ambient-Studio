/**
 * cadence.ts — cadence-snapped export: round the requested duration to the
 * nearest musical bar of the recipe's own BPM (4/4, the kernel's grid), clamp
 * to at least one bar, and apply a short linear outro fade so long exports
 * end on a phrase instead of a hard cut mid-phrase.
 *
 * Pure integer frame math: bars → framesPerBar → totalFrames, so the same
 * (bpm, sr, duration) always yields the identical frame count, and the fade
 * is a pure function of the absolute frame index (block-size invariant, D4-safe).
 */
import type { SynthSink } from "./blockSynth";

export const BEATS_PER_BAR = 4; // kernel is 4/4 (subBeatIndex 0..3)

export interface SnapResult {
  bars: number;
  framesPerBar: number;
  snappedSec: number;
  totalFrames: number;
  requestedSec: number;
}

export function snapToBar(durationSec: number, bpm: number, sampleRate: number): SnapResult {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`duration_sec must be > 0, got ${durationSec}`);
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error(`bpm must be > 0, got ${bpm}`);
  const barSec = (BEATS_PER_BAR * 60) / bpm;
  // Edge case: duration shorter than one bar → snap UP to one bar (round would give 0).
  const bars = Math.max(1, Math.round(durationSec / barSec));
  const framesPerBar = Math.round(barSec * sampleRate); // integer per-bar frames
  const totalFrames = bars * framesPerBar;
  return {
    bars,
    framesPerBar,
    snappedSec: totalFrames / sampleRate,
    totalFrames,
    requestedSec: durationSec,
  };
}

/**
 * Outro fade sink wrapper — multiplies the last `fadeSec` of audio by a
 * linear ramp 1→0 before handing blocks to the inner sink. Pure function of
 * absolute output frame; adds no state beyond the running frame counter.
 * Fade is capped at 10% of the render so previews stay audible.
 */
export function makeFadeSink(inner: SynthSink, totalFrames: number, fadeSec: number, sampleRate: number): SynthSink {
  const fadeFrames = Math.min(Math.round(fadeSec * sampleRate), Math.floor(totalFrames / 10));
  let written = 0;
  return {
    writeBlock(l: Float32Array, r: Float32Array, frames: number): void {
      if (fadeFrames > 0) {
        const fadeStart = totalFrames - fadeFrames;
        for (let i = 0; i < frames; i++) {
          const f = written + i;
          if (f >= fadeStart) {
            const g = 1 - (f - fadeStart) / fadeFrames;
            l[i] *= g;
            r[i] *= g;
          }
        }
      }
      written += frames;
      inner.writeBlock(l, r, frames);
    },
    // round2: forward the inner sink's backpressure hook — BlockSynth awaits
    // drain() on the OUTERMOST sink it is handed.
    drain: inner.drain?.bind(inner),
  };
}
