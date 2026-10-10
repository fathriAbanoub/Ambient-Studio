/**
 * browser_ref_harness.ts — in-page ground-truth harness (round 2
 * investigation). Bundled to an IIFE by browser_ref.mjs and injected into a
 * Playwright page; exposes window.__ref with:
 *
 *   renderRecipe(paramsJson, durationSec)
 *     → runs the REAL, unmodified renderAmbient.ts (imported straight from
 *       the repo — single shared kernel copy) in a real
 *       OfflineAudioContext and returns the WAV (via the repo's own
 *       audioBufferToWav) as base64. This is reference (a): the exact signal
 *       path the browser "Export WAV" button produces.
 *
 *   freqResponse(f0, q, freqsJson)
 *     → BiquadFilterNode.getFrequencyResponse magnitudes — settles the Q
 *       convention question (dB-Q vs linear-Q) empirically, no spec
 *       archaeology.
 */
import {
  renderAmbient,
  audioBufferToWav,
} from "../../kernel/renderAmbient";

async function renderRecipe(
  paramsJson: string,
  durationSec: number,
): Promise<{ wav_b64: string; frames: number; sampleRate: number }> {
  const params = JSON.parse(paramsJson);
  const buf = await renderAmbient(params, durationSec, undefined);
  const blob = audioBufferToWav(buf);
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return { wav_b64: btoa(bin), frames: buf.length, sampleRate: buf.sampleRate };
}

function freqResponse(
  type: string,
  f0: number,
  q: number,
  freqsJson: string,
): { mag: number[]; phase: number[] } {
  const ctx = new OfflineAudioContext(1, 128, 44100);
  const biq = ctx.createBiquadFilter();
  biq.type = type as BiquadFilterType;
  biq.frequency.value = f0;
  biq.Q.value = q;
  const freqs = Float32Array.from(JSON.parse(freqsJson) as number[]);
  const mag = new Float32Array(freqs.length);
  const ph = new Float32Array(freqs.length);
  biq.getFrequencyResponse(freqs, mag, ph);
  return { mag: Array.from(mag), phase: Array.from(ph) };
}

declare global {
  interface Window {
    __ref: {
      renderRecipe: typeof renderRecipe;
      freqResponse: typeof freqResponse;
    };
  }
}
window.__ref = { renderRecipe, freqResponse };
