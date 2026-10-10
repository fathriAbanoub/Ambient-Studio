
window.__bp = (type, f0, q, freqs) => {
  const ctx = new OfflineAudioContext(1, 128, 44100);
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f0; b.Q.value = q;
  const fr = Float32Array.from(freqs), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
  b.getFrequencyResponse(fr, mag, ph);
  return Array.from(mag);
};
