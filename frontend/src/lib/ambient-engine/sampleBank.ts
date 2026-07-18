/**
 * sampleBank.ts — Synthesis-shell helpers for reference-based sample playback.
 *
 * EngineParams stays plain JSON; this file is where URL references become
 * decoded AudioBuffers for the live/offline Web Audio shells.
 */

import {
  playableSampleEntries,
  type SampleBankEntry,
} from "./musicalLogic";

export type DecodedSampleBank = Map<string, AudioBuffer>;
const SAMPLE_FETCH_TIMEOUT_MS = 15000;

export async function decodeSampleBank(
  ctx: BaseAudioContext,
  sampleBank?: SampleBankEntry[],
): Promise<DecodedSampleBank> {
  const buffers: DecodedSampleBank = new Map();
  const entries = playableSampleEntries(sampleBank);
  if (!entries.length) return buffers;

  await Promise.all(
    entries.map(async (entry) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        SAMPLE_FETCH_TIMEOUT_MS,
      );
      try {
        const response = await fetch(entry.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(data.slice(0));
        buffers.set(entry.id, buffer);
      } catch (error) {
        // ponytail: failed sample fetch/decode skips that sample for this run;
        // upgrading means retry/backoff and caller-visible per-sample load state.
        console.warn(`[ambient-engine] sample decode failed: ${entry.id}`, error);
      } finally {
        clearTimeout(timeoutId);
      }
    }),
  );

  return buffers;
}

export function getDecodedSampleBuffer(
  buffers: DecodedSampleBank,
  sampleId?: string,
): AudioBuffer | undefined {
  if (!sampleId) return undefined;
  return buffers.get(sampleId);
}

export function scheduleSamplePlayback(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  amp: number,
  pan: number,
  t0: number,
  destination: AudioNode,
  fadeSec: number,
): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  const g = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  const clampedFade = Math.min(fadeSec, buffer.duration / 2);

  source.buffer = buffer;
  panNode.pan.setValueAtTime(pan, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(amp, t0 + clampedFade);
  g.gain.setValueAtTime(
    amp,
    Math.max(t0 + clampedFade, t0 + buffer.duration - clampedFade),
  );
  g.gain.linearRampToValueAtTime(0.0001, t0 + buffer.duration);

  source.connect(g);
  g.connect(panNode);
  panNode.connect(destination);
  source.start(t0);
  source.stop(t0 + buffer.duration + 0.05);
  return source;
}
