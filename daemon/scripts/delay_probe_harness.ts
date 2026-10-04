/**
 * delay_probe_harness.ts — minimal in-page probe of Web Audio's feedback-
 * cycle semantics for DelayNode (the one primitive blockSynth's delay ring
 * must match). Builds the exact graphs renderAmbient.ts:159-189 builds, fed
 * by a plain OscillatorNode instead of the kernel:
 *
 *   probe1 "loop_only":  sine(110, amp1) -> [delay(0.46) -> out] + [delay -> fb(0.4) -> delay]
 *   probe2 "full_chain": sine -> droneFilter(3600,Q0.7) -> g(0.5) -> pan(0) -> bus(0.3)
 *                        -> masterFilter(6600,Q1.0) -> {out, delay(0.46)->fb(0.4)->delay->out}
 *   probe3 "dry":        probe2's graph WITHOUT the delay connections.
 * Each renders 4 s offline (settled), returns the 110 Hz complex amplitude
 * over the last second.
 */
const SR = 44100;

function complexAmpAt(buf: AudioBuffer, ch: 0 | 1, hz: number): { amp: number; phase: number } {
  const d = buf.getChannelData(ch);
  const seg = d.slice(d.length - SR);
  let re = 0, im = 0;
  for (let i = 0; i < seg.length; i++) {
    const x = seg[i];
    re += x * Math.cos((-2 * Math.PI * hz * i) / SR);
    im += x * Math.sin((-2 * Math.PI * hz * i) / SR);
  }
  return { amp: (2 * Math.sqrt(re * re + im * im)) / seg.length, phase: Math.atan2(im, re) };
}

async function render(build: (ctx: OfflineAudioContext, input: OscillatorNode) => AudioNode, seconds = 4): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, SR * seconds, SR);
  const input = ctx.createOscillator();
  input.frequency.value = 110;
  const head = build(ctx, input);
  input.connect(head);
  head.connect(ctx.destination);
  input.start(0);
  return ctx.startRendering();
}

async function probeLoop(): Promise<ProbeOut> {
  return render((ctx, input) => {
    const out = ctx.createGain();
    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = 0.46;
    const fb = ctx.createGain();
    fb.gain.value = 0.4;
    input.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(out);
    return out;
  }).then((b) => ({ L: complexAmpAt(b, 0, 110), R: complexAmpAt(b, 1, 110), peak: peakOf(b) }));
}

async function probeFull(delayOn: boolean): Promise<ProbeOut> {
  return render((ctx, input) => {
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
    input.connect(droneFilter);
    droneFilter.connect(g);
    g.connect(pan);
    pan.connect(bus);
    bus.connect(masterFilter);
    masterFilter.connect(out);
    if (delayOn) {
      const delay = ctx.createDelay(2.0);
      delay.delayTime.value = 0.46;
      const fb = ctx.createGain();
      fb.gain.value = 0.4;
      masterFilter.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(out);
    }
    return out;
  }).then((b) => ({ L: complexAmpAt(b, 0, 110), R: complexAmpAt(b, 1, 110), peak: peakOf(b) }));
}

function peakOf(b: AudioBuffer): number {
  const d = b.getChannelData(0);
  let p = 0;
  for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  return p;
}

async function probeGainOnly(): Promise<ProbeOut> {
  return render((_ctx, input) => {
    const g = _ctx.createGain();
    g.gain.value = 0.5;
    void input;
    return g;
  }).then((b) => ({ L: complexAmpAt(b, 0, 110), R: complexAmpAt(b, 1, 110), peak: peakOf(b) }));
}

interface ProbeOut { L: { amp: number; phase: number }; R: { amp: number; phase: number }; peak: number }

declare global {
  interface Window {
    __delayProbe: {
      loop: typeof probeLoop;
      full: typeof probeFull;
      dry: typeof probeFull;
      gainOnly: typeof probeGainOnly;
    };
  }
}
window.__delayProbe = { loop: probeLoop, full: () => probeFull(true), dry: () => probeFull(false), gainOnly: probeGainOnly };
