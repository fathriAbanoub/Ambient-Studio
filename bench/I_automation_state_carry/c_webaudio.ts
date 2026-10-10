/**
 * c_webaudio.ts — single-pass OfflineAudioContext reference of the exact
 * category-C graph (node-web-audio-api), ported from bench/C/run_C.mjs's
 * buildGraph with offsetSec=0 and chunkLen=totalSec. This is the same-engine
 * ground truth that C compared its chunks against.
 *
 * Exposed as a function returning the rendered AudioBuffer; the runner
 * compares my block-synth stream against it sample-by-sample. The reference
 * buffer is materialized by the Web Audio API itself (bounded: 120 s stereo
 * float32 ≈ 42 MB — reported in the result, this is the one materializing
 * verification in the suite).
 */

export interface CWebAudioConstants {
  sampleRate: number;
  totalSec: number;
  carrierHz: number; subHz: number; subGain: number;
  filterStartHz: number; filterEndHz: number; filterQ: number;
  delayStartSec: number; delayEndSec: number; delayMaxSec: number; feedbackGain: number;
  masterGain: number;
  panPeriodSec: number; panTargetTcSec: number;
}

export async function renderCGraphWebAudio(C: CWebAudioConstants, OfflineAudioContextCtor: unknown): Promise<{ left: Float32Array; right: Float32Array; frames: number; wallSec: number }> {
  const OfflineAudioContext = OfflineAudioContextCtor as new (ch: number, len: number, sr: number) => {
    createOscillator(): { type: string; frequency: { value: number; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): unknown; start(t: number): void; stop(t: number): void };
    createGain(): { gain: { value: number; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): unknown };
    createBiquadFilter(): { type: string; frequency: { value: number; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }; Q: { value: number }; connect(n: unknown): unknown };
    createDelay(max: number): { delayTime: { value: number; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): unknown };
    createStereoPanner(): { pan: { value: number; setValueAtTime(v: number, t: number): void; setTargetAtTime(v: number, t: number, tc: number): void }; connect(n: unknown): unknown };
    destination: unknown;
    startRendering(): Promise<{ length: number; getChannelData(ch: number): Float32Array; numberOfChannels: number; sampleRate: number }>;
  };
  const frames = Math.ceil(C.totalSec * C.sampleRate);
  const ctx = new OfflineAudioContext(2, frames, C.sampleRate);

  // buildGraph — single-pass shape, absolute timeline (port of run_C.mjs:64-135
  // with offsetSec=0, chunkLen=totalSec).
  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = C.carrierHz;
  const sub = ctx.createOscillator();
  sub.type = "triangle";
  sub.frequency.value = C.subHz;
  const subGain = ctx.createGain();
  subGain.gain.value = C.subGain;
  sub.connect(subGain);

  const mix = ctx.createGain();
  mix.gain.value = 1.0;
  carrier.connect(mix);
  subGain.connect(mix);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = C.filterQ;
  mix.connect(filter);

  const delay = ctx.createDelay(C.delayMaxSec);
  const feedback = ctx.createGain();
  feedback.gain.value = C.feedbackGain;
  filter.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);

  const master = ctx.createGain();
  master.gain.value = C.masterGain;
  filter.connect(master);
  delay.connect(master);

  const panner = ctx.createStereoPanner();
  master.connect(panner);
  panner.connect(ctx.destination);

  filter.frequency.setValueAtTime(C.filterStartHz, 0);
  filter.frequency.linearRampToValueAtTime(C.filterEndHz, C.totalSec);
  delay.delayTime.setValueAtTime(C.delayStartSec, 0);
  delay.delayTime.linearRampToValueAtTime(C.delayEndSec, C.totalSec);
  master.gain.setValueAtTime(C.masterGain * 0.2, 0);
  master.gain.linearRampToValueAtTime(C.masterGain, 0.5);

  // Exponential pan automation on the absolute timeline (C's loop, unshifted).
  for (let tAbs = 0; tAbs <= C.totalSec + C.panPeriodSec; tAbs += C.panPeriodSec / 2) {
    const target = Math.floor(tAbs / C.panPeriodSec) % 2 === 0 ? -0.8 : 0.8;
    if (tAbs === 0) panner.pan.setValueAtTime(target, 0);
    else panner.pan.setTargetAtTime(target, tAbs, C.panTargetTcSec);
  }

  carrier.start(0);
  sub.start(0);
  carrier.stop(C.totalSec);
  sub.stop(C.totalSec);

  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return {
    left: buf.getChannelData(0).slice(),
    right: buf.getChannelData(1).slice(),
    frames: buf.length,
    wallSec: (performance.now() - t0) / 1000,
  };
}
