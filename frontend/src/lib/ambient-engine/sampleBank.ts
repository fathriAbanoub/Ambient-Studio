/**
 * sampleBank.ts — Synthesis-shell helpers for reference-based sample playback.
 *
 * EngineParams stays plain JSON; this file is where URL references become
 * decoded AudioBuffers for the live/offline Web Audio shells.
 */

import type { SampleBankEntry } from "./musicalLogic";

export type DecodedSampleBank = Map<string, AudioBuffer>;

function isUsableSampleEntry(entry: SampleBankEntry): boolean {
  return (
    typeof entry?.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.url === "string" &&
    entry.url.length > 0
  );
}

export async function decodeSampleBank(
  ctx: BaseAudioContext,
  sampleBank?: SampleBankEntry[],
): Promise<DecodedSampleBank> {
  const buffers: DecodedSampleBank = new Map();
  if (!sampleBank?.length) return buffers;

  await Promise.all(
    sampleBank.map(async (entry) => {
      if (!isUsableSampleEntry(entry) || buffers.has(entry.id)) return;

      try {
        const response = await fetch(entry.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(data.slice(0));
        buffers.set(entry.id, buffer);
      } catch (error) {
        // ponytail: failed sample fetch/decode skips that sample for this run;
        // upgrading means retry/backoff and caller-visible per-sample load state.
        console.warn(`[ambient-engine] sample decode failed: ${entry.id}`, error);
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
