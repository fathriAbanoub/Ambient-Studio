/**
 * test/goertzel.ts — shared Goertzel band-power probe for the audio-level
 * audits. Lives in its own module because space_reverb.ts runs its own
 * main() on import, so other tools cannot import from it.
 */

/** Goertzel power at the bin nearest each centre frequency, accumulated over
 * the first `frames` samples of `l`/`r` (summed channel input). The bin
 * frequencies are exact by construction — pass bin frequencies computed from
 * the same sampleRate so a tone lands on its bin. */
export function goertzelBands(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  freqs: number[],
  sampleRate: number,
): number[] {
  const out = new Array(freqs.length).fill(0);
  const w = freqs.map((f) => (2 * Math.PI * f) / sampleRate);
  const coef = w.map((ww) => 2 * Math.cos(ww));
  const s1 = new Array(freqs.length).fill(0);
  const s2 = new Array(freqs.length).fill(0);
  for (let i = 0; i < frames; i++) {
    for (let k = 0; k < freqs.length; k++) {
      const x = l[i] + r[i];
      const s0 = x + coef[k] * s1[k] - s2[k];
      s2[k] = s1[k];
      s1[k] = s0;
    }
  }
  for (let k = 0; k < freqs.length; k++) {
    out[k] = s1[k] * s1[k] + s2[k] * s2[k] - coef[k] * s1[k] * s2[k];
  }
  return out;
}
