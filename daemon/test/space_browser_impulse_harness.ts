/**
 * space_browser_impulse_harness.ts — page side of the Space browser-parity
 * check (daemon/test/space_browser_impulse.mjs drives it). Builds ONE comb
 * and ONE allpass stage in a real OfflineAudioContext with the EXACT topology
 * of LiveEngine.buildSpace()/renderAmbient.ts; constants are imported from
 * kernel/space.ts (nothing retyped). A 1-sample stereo impulse is rendered
 * and the full output streams are returned for sample-by-sample comparison
 * against the daemon's SpaceComb / SpaceAllpass ports.
 */
import {
  REVERB_COMB_DELAY_SAMPLES,
  REVERB_COMB_FEEDBACK,
  REVERB_ALLPASS_DELAY_SAMPLES,
  REVERB_ALLPASS_GAIN,
  SPACE_REFERENCE_SAMPLE_RATE as SR,
} from "../../kernel/space";

const FRAMES = 16384;

function impulse(ctx: OfflineAudioContext): AudioBuffer {
  const b = ctx.createBuffer(2, 1, SR);
  b.getChannelData(0)[0] = 1;
  b.getChannelData(1)[0] = 1;
  return b;
}

async function render(build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => AudioNode): Promise<{ l: number[]; r: number[] }> {
  const ctx = new OfflineAudioContext(2, FRAMES, SR);
  const src = ctx.createBufferSource();
  src.buffer = impulse(ctx);
  // build() wires src into its internal graph and returns the OUTPUT node —
  // do NOT src.connect(out) here: that would add a dry edge into the graph.
  const out = build(ctx, src);
  out.connect(ctx.destination);
  src.start(0);
  const buf = await ctx.startRendering();
  return { l: Array.from(buf.getChannelData(0)), r: Array.from(buf.getChannelData(1)) };
}

declare global {
  interface Window {
    __spaceImpulse: () => Promise<{
      comb: { l: number[]; r: number[] };
      allpass: { l: number[]; r: number[] };
      constants: { combD: number; combG: number; apD: number; apG: number; sr: number };
    }>;
  }
}

window.__spaceImpulse = async () => {
  const combD = REVERB_COMB_DELAY_SAMPLES[0];
  const combG = REVERB_COMB_FEEDBACK[0];
  const comb = await render((ctx, src) => {
    const dl = ctx.createDelay(combD / SR);
    dl.delayTime.value = combD / SR;
    const fb = ctx.createGain();
    fb.gain.value = combG;
    src.connect(dl);
    dl.connect(fb);
    fb.connect(dl); // feedback cycle — re-enters one render quantum late
    return dl; // tap = the delay output, Freeverb-style
  });

  const apD = REVERB_ALLPASS_DELAY_SAMPLES[0];
  const apG = REVERB_ALLPASS_GAIN;
  const allpass = await render((ctx, src) => {
    const ff = ctx.createDelay(apD / SR);
    ff.delayTime.value = apD / SR;
    const fbk = ctx.createDelay(apD / SR);
    fbk.delayTime.value = apD / SR;
    const neg = ctx.createGain();
    neg.gain.value = -apG;
    const pos = ctx.createGain();
    pos.gain.value = apG;
    const sum = ctx.createGain();
    src.connect(ff);
    ff.connect(sum);
    src.connect(neg);
    neg.connect(sum);
    sum.connect(fbk);
    fbk.connect(pos);
    pos.connect(sum); // feedback cycle — re-enters one render quantum late
    return sum;
  });

  return { comb, allpass, constants: { combD, combG, apD, apG, sr: SR } };
};
