"use strict";
(() => {
  // scripts/delay_probe_harness.ts
  var SR = 44100;
  function complexAmpAt(buf, ch, hz) {
    const d = buf.getChannelData(ch);
    const seg = d.slice(d.length - SR);
    let re = 0, im = 0;
    for (let i = 0; i < seg.length; i++) {
      const x = seg[i];
      re += x * Math.cos(-2 * Math.PI * hz * i / SR);
      im += x * Math.sin(-2 * Math.PI * hz * i / SR);
    }
    return { amp: 2 * Math.sqrt(re * re + im * im) / seg.length, phase: Math.atan2(im, re) };
  }
  async function render(build, seconds = 4) {
    const ctx = new OfflineAudioContext(2, SR * seconds, SR);
    const input = ctx.createOscillator();
    input.frequency.value = 110;
    const head = build(ctx, input);
    input.connect(head);
    head.connect(ctx.destination);
    input.start(0);
    return ctx.startRendering();
  }
  async function probeLoop() {
    return render((ctx, input) => {
      const out = ctx.createGain();
      const delay = ctx.createDelay(2);
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
  async function probeFull(delayOn) {
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
      masterFilter.Q.value = 1;
      const out = ctx.createGain();
      input.connect(droneFilter);
      droneFilter.connect(g);
      g.connect(pan);
      pan.connect(bus);
      bus.connect(masterFilter);
      masterFilter.connect(out);
      if (delayOn) {
        const delay = ctx.createDelay(2);
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
  function peakOf(b) {
    const d = b.getChannelData(0);
    let p = 0;
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
    return p;
  }
  async function probeGainOnly() {
    return render((_ctx, input) => {
      const g = _ctx.createGain();
      g.gain.value = 0.5;
      void input;
      return g;
    }).then((b) => ({ L: complexAmpAt(b, 0, 110), R: complexAmpAt(b, 1, 110), peak: peakOf(b) }));
  }
  window.__delayProbe = { loop: probeLoop, full: () => probeFull(true), dry: () => probeFull(false), gainOnly: probeGainOnly };
})();
