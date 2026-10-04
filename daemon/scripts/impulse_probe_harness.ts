/**
 * impulse_probe_harness.ts — impulse response of the DelayNode feedback
 * cycle in Chromium's OfflineAudioContext. A single-sample impulse feeds:
 *   (a) delay(0.46) -> out                     [no cycle: one echo at 0.46 s]
 *   (b) delay(0.46) -> out, delay -> fb(0.4) -> delay   [echo train 1, .4, .16...]
 *   (c) full drone chain graph, impulse at chain head
 * The echo times/gains reveal the ACTUAL loop delay (including any extra
 * render-quantum latency) and feedback gain, no sinusoid fitting needed.
 */
const SR = 44100;

function makeImpulse(ctx: OfflineAudioContext): AudioBuffer {
  const b = ctx.createBuffer(1, 8, SR);
  b.getChannelData(0)[0] = 1;
  return b;
}

async function renderGraph(build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => AudioNode, seconds: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
  const src = ctx.createBufferSource();
  src.buffer = makeImpulse(ctx);
  const tail = build(ctx, src);
  src.connect(tail).connect(ctx.destination);
  src.start(0);
  const buf = await ctx.startRendering();
  return buf.getChannelData(0).slice();
}

/** Find echo peaks: (index, value) pairs where |x| > 1e-3, collapsed. */
function echoes(x: Float32Array): Array<{ at: string; v: number }> {
  const out: Array<{ at: string; v: number }> = [];
  let i = 0;
  while (i < x.length) {
    if (Math.abs(x[i]) > 1e-3) {
      let j = i;
      let best = i;
      while (j < x.length && j - i < 64) {
        if (Math.abs(x[j]) > Math.abs(x[best])) best = j;
        j++;
      }
      out.push({ at: `${best} (${(best / SR * 1000).toFixed(2)}ms)`, v: Number(x[best].toFixed(5)) });
      i = best + 64;
    } else i++;
  }
  return out;
}

declare global {
  interface Window {
    __impulse: () => Promise<{ a: string[]; b: string[]; c: string[]; rawB: number[] }>;
  }
}

window.__impulse = async () => {
  // (a) plain delay, no cycle
  const a = await renderGraph((ctx, src) => {
    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = 0.46;
    src.connect(delay);
    return delay;
  }, 1.2);
  // (b) delay + feedback cycle
  const b = await renderGraph((ctx, src) => {
    const out = ctx.createGain();
    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = 0.46;
    const fb = ctx.createGain();
    fb.gain.value = 0.4;
    src.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(out);
    return out;
  }, 1.6);
  // (c) the full drone chain with the delay network (mix=0.4 constants)
  const c = await renderGraph((ctx, src) => {
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 3600;
    droneFilter.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0;
    const bus = ctx.createGain();
    bus.gain.value = 0.3;
    const masterFilter = ctx.createBiquadFilter();
    masterFilter.type = "lowpass";
    masterFilter.frequency.value = 6600;
    masterFilter.Q.value = 1.0;
    const out = ctx.createGain();
    src.connect(droneFilter);
    droneFilter.connect(g);
    g.connect(pan);
    pan.connect(bus);
    bus.connect(masterFilter);
    masterFilter.connect(out);
    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = 0.46;
    const fb = ctx.createGain();
    fb.gain.value = 0.4;
    masterFilter.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(out);
    return out;
  }, 1.6);
  return {
    a: echoes(a).map((e) => `${e.at} v=${e.v}`),
    b: echoes(b).map((e) => `${e.at} v=${e.v}`),
    c: echoes(c).map((e) => `${e.at} v=${e.v}`),
    rawB: Array.from(b.slice(0, 300)).filter((v) => v !== 0),
  };
};
