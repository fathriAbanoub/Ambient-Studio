/**
 * LiveEngine.ts — Thin Web Audio shell consuming MusicalEvent[] from musicalLogic.
 *
 * BROWSER ONLY.
 *
 * Fixes applied:
 *   C1: Drum events scheduled at t0 + (subBeatIndex * sixteenthSec)
 *   C2: createNoiseBuffer() consumes from this.state.rngState directly
 *       (main stream advances by ~22k calls, matching original engine.ts order)
 *   C4: 600ms harmonic slew handled here via ctx.currentTime, not in musicalLogic
 *   W1: Persistent StereoPannerNodes for pad/bell with smooth setValueAtTime drift
 *   W2: Melody events routed through melodyBuses[i % 3] for visual analysis
 *   D1: Added dispose() method to disconnect all audio nodes and prevent leakage
 *   G1: Added guard in start() after ctx.resume() to prevent execution on disposed instance
 *   T1: Removed null assignments to audio node fields to maintain type safety
 */

import {
  type EngineParams,
  type EngineState,
  type MusicalEvent,
  type TimbreMode,
  getMusicalEvents,
  createInitialState,
  initializeBell,
  getSceneName,
  getEffectiveSceneParams,
  mulberry32Next,
} from "./musicalLogic";

import { getSharedAudioContext } from "@/lib/audioContext";

const FM_MOD_RATIO = 1.5;
const FM_INDEX = 1.8;

const ADSR_MELODY = { a: 0.02, d: 0.2, s: 0.55, r: 0.25 };
const ADSR_PAD_L = { a: 0.5, d: 0.8, s: 0.7, r: 0.8 };
const ADSR_PAD_R = { a: 0.6, d: 0.8, s: 0.7, r: 0.9 };
const ADSR_BASS = { a: 0.005, d: 0.15, s: 0.25, r: 0.2 };
const ADSR_BELL = { a: 0.01, d: 0.1, s: 0.2, r: 0.15 };

export class LiveEngine {
  ctx: AudioContext;
  private gain: GainNode;
  private delay: DelayNode;
  private fb: GainNode;
  private out: GainNode;
  private filter: BiquadFilterNode;
  private drumBus: GainNode;
  private drumCompressor: DynamicsCompressorNode;
  private noiseBuffer: AudioBuffer;

  // FIX W1: Persistent panner nodes — match original engine.ts exactly
  private padPanL: StereoPannerNode;
  private padPanR: StereoPannerNode;
  private bellPan: StereoPannerNode;

  // FIX W2: Melody buses for visual analysis routing
  melodyBuses: GainNode[] = [];
  private melodyBusIndex = 0;

  running = false;
  params: EngineParams;
  private state: EngineState;
  private schedulerId: number | null = null;

  // FIX C4: Harmonic slew tracking (wall-clock, not beat-relative)
  private harmonicSlewStartHz: number | null = null;
  private harmonicSlewEndHz: number | null = null;
  private harmonicSlewStartTime: number | null = null;
  private harmonicSlewEndTime: number | null = null;
  private readonly SLEW_DURATION = 0.6; // 600ms exact from spec

  // D1: Disposed flag to prevent reuse after cleanup
  private disposed = false;

  constructor(params: EngineParams, injectedCtx?: AudioContext) {
    // Use injected context if provided, otherwise use shared singleton
    this.ctx = injectedCtx || getSharedAudioContext();
    this.params = { ...params };

    // ── Audio graph ──
    this.out = this.ctx.createGain();
    this.gain = this.ctx.createGain();
    this.delay = this.ctx.createDelay(2.0);
    this.fb = this.ctx.createGain();
    this.filter = this.ctx.createBiquadFilter();

    this.gain.gain.value = 0.3;
    this.delay.delayTime.value = 0.45;
    this.fb.gain.value = 0.35;
    this.filter.type = "lowpass";
    this.filter.frequency.value = 2000;
    this.filter.Q.value = 1.0;

    this.gain.connect(this.filter);
    this.filter.connect(this.delay);
    this.delay.connect(this.fb);
    this.fb.connect(this.delay);
    this.delay.connect(this.out);
    this.filter.connect(this.out);
    this.out.connect(this.ctx.destination);

    // ── Drum bus ──
    this.drumBus = this.ctx.createGain();
    this.drumCompressor = this.ctx.createDynamicsCompressor();
    this.drumCompressor.threshold.value = -20;
    this.drumCompressor.ratio.value = 3;
    this.drumCompressor.attack.value = 0.003;
    this.drumCompressor.release.value = 0.25;
    this.drumBus.connect(this.drumCompressor);
    this.drumCompressor.connect(this.out);

    // FIX W1: Create persistent panner nodes, connected to main gain
    this.padPanL = this.ctx.createStereoPanner();
    this.padPanR = this.ctx.createStereoPanner();
    this.bellPan = this.ctx.createStereoPanner();
    this.padPanL.pan.value = 0;
    this.padPanR.pan.value = 0;
    this.bellPan.pan.value = 0;
    this.padPanL.connect(this.gain);
    this.padPanR.connect(this.gain);
    this.bellPan.connect(this.gain);

    // FIX W2: Melody buses
    for (let i = 0; i < 3; i++) {
      const bus = this.ctx.createGain();
      bus.connect(this.gain);
      this.melodyBuses.push(bus);
    }

    // ── FIX C2: RNG init order matches original engine.ts constructor ──
    this.state = createInitialState(params);
    this.noiseBuffer = this.createNoiseBuffer();
    this.state = initializeBell(this.state);

    this.setMix(params.mix);
  }

  async start(): Promise<void> {
    if (this.running || this.disposed) return;
    await this.ctx.resume();

    // ✅ Guard: re-check disposed status after async resume
    if (this.disposed) return;

    this.running = true;
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    if (this.schedulerId !== null) window.clearTimeout(this.schedulerId);
    this.schedulerId = null;
    this.running = false;
  }

  /**
   * D1: Dispose all audio nodes to prevent leakage.
   * Call this after stop() when the engine is no longer needed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Stop any ongoing playback and clear scheduler
    this.stop();

    // Disconnect all audio nodes from the graph (this is sufficient for cleanup)
    const nodes: AudioNode[] = [
      this.out,
      this.gain,
      this.delay,
      this.fb,
      this.filter,
      this.drumBus,
      this.drumCompressor,
      this.padPanL,
      this.padPanR,
      this.bellPan,
      ...this.melodyBuses,
    ];

    for (const node of nodes) {
      try {
        node.disconnect();
      } catch (_) {
        // Ignore errors if node already disconnected
      }
    }

    // Note: we do NOT set fields to null to maintain type safety.
    // The engine instance will be garbage collected when references are dropped.
  }

  setMix(mix: number): void {
    if (this.disposed) return;
    this.params.mix = mix;
    const t0 = this.ctx.currentTime;
    this.delay.delayTime.setValueAtTime(0.3 + 0.4 * mix, t0);
    this.fb.gain.setValueAtTime(0.2 + 0.5 * mix, t0);
    const cutoff = 5000 + mix * 4000;
    this.filter.frequency.setValueAtTime(this.filter.frequency.value, t0);
    this.filter.frequency.linearRampToValueAtTime(cutoff, t0 + 0.5);
  }

  setBpm(bpm: number): void { if (!this.disposed) this.params.bpm = bpm; }
  setComplexity(c: number): void { if (!this.disposed) this.params.complexity = c; }
  setScale(s: "majorPent" | "minorPent"): void { if (!this.disposed) this.params.scale = s; }
  setRootHz(hz: number): void { if (!this.disposed) this.params.rootHz = hz; }
  setDrumLevel(d: number): void { if (!this.disposed) this.params.drumLevel = d; }

  getCurrentState(): EngineState { return { ...this.state }; }
  getParams(): EngineParams { return { ...this.params }; }

  // ✅ Returns AudioNode (never null) – safe because it's never called after dispose()
  getMasterNode(): AudioNode {
    return this.out;
  }

  getCurrentSceneName(): string { return getSceneName(this.state); }

  private tick(): void {
    if (this.disposed || !this.running) return;
    const t0 = this.ctx.currentTime;

    const preTickParams = getEffectiveSceneParams(this.state, this.params);
    this.params.bpm = preTickParams.bpm;
    this.setMix(preTickParams.mix);

    const prevTargetRootHz = this.state.targetRootHz;
    const stateBeforeSlew = { ...this.state };
    const slewedHz = this.getSlewedRootHz(t0);
    const stateForBeat = { ...stateBeforeSlew, currentRootHz: slewedHz };

    const { events, nextState } = getMusicalEvents(
      stateForBeat.beat,
      stateForBeat,
      this.params,
    );
    this.state = nextState;

    if (this.state.targetRootHz !== prevTargetRootHz) {
      this.harmonicSlewStartHz = slewedHz;
      this.harmonicSlewEndHz = this.state.targetRootHz;
      this.harmonicSlewStartTime = t0;
      this.harmonicSlewEndTime = t0 + this.SLEW_DURATION;
    }

    const beatSec = 60 / preTickParams.bpm;
    const sixteenthSec = beatSec / 4;

    const panValue = Math.sin(this.state.panDriftPhase) * 0.1;
    this.padPanL.pan.setValueAtTime(-panValue, t0);
    this.padPanR.pan.setValueAtTime(panValue, t0);
    this.bellPan.pan.setValueAtTime(
      Math.sin(this.state.panDriftPhase * 1.3) * 0.15,
      t0,
    );

    for (const event of events) {
      const eventTime = t0 + event.subBeatIndex * sixteenthSec;
      this.scheduleSynthEvent(event, eventTime);
    }

    this.schedulerId = window.setTimeout(() => this.tick(), beatSec * 1000);
  }

  private getSlewedRootHz(now: number): number {
    if (
      this.harmonicSlewStartTime === null ||
      this.harmonicSlewEndTime === null
    ) {
      return this.state.currentRootHz;
    }
    if (now >= this.harmonicSlewEndTime) {
      this.harmonicSlewStartTime = null;
      this.harmonicSlewEndTime = null;
      return this.harmonicSlewEndHz!;
    }
    const progress = (now - this.harmonicSlewStartTime) / this.SLEW_DURATION;
    return (
      this.harmonicSlewStartHz! +
      (this.harmonicSlewEndHz! - this.harmonicSlewStartHz!) * progress
    );
  }

  private scheduleSynthEvent(event: MusicalEvent, t0: number): void {
    if (this.disposed) return;
    switch (event.type) {
      case "kick": this.playKick(t0, event.amp); break;
      case "snare": this.playSnare(t0, event.amp, event.isGhost ?? false); break;
      case "hihat": this.playHat(t0, event.amp, event.isClosed ?? true); break;
      case "melody": this.playTonal(event, t0, true); break;
      case "pad":
      case "bass":
      case "bell": this.playTonal(event, t0, false); break;
    }
  }

  private playTonal(event: MusicalEvent, t0: number, isMelody: boolean): void {
    if (this.disposed) return;
    const { hz, amp, durationSec, pan, timbre, type } = event;
    if (hz === undefined) return;

    let env: { a: number; d: number; s: number; r: number };
    let vibratoAmount: number | undefined;

    switch (type) {
      case "melody": env = ADSR_MELODY; vibratoAmount = 1.5; break;
      case "pad": env = pan < 0 ? ADSR_PAD_L : ADSR_PAD_R; break;
      case "bass": env = ADSR_BASS; break;
      case "bell": env = ADSR_BELL; break;
      default: env = ADSR_PAD_L;
    }

    const [osc, modOsc] = this.createOscillator(hz, timbre ?? "sine");
    const g = this.ctx.createGain();

    let filterNode: BiquadFilterNode | null = null;
    if (timbre === "softsq") {
      filterNode = this.ctx.createBiquadFilter();
      filterNode.type = "lowpass";
      filterNode.frequency.value = 3200;
      filterNode.Q.value = 0.7;
    }

    if (vibratoAmount) {
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.value = 4.5;
      lfoGain.gain.value = vibratoAmount;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + durationSec + env.r + 0.05);
    }

    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + env.a);
    g.gain.linearRampToValueAtTime(amp * env.s, t0 + env.a + env.d);
    g.gain.setValueAtTime(amp * env.s, t0 + Math.max(env.a + env.d, durationSec));
    g.gain.linearRampToValueAtTime(0.0001, t0 + Math.max(env.a + env.d, durationSec) + env.r);

    if (filterNode) {
      osc.connect(filterNode);
      filterNode.connect(g);
    } else {
      osc.connect(g);
    }

    let destination: AudioNode;
    if (type === "pad" && pan < 0) destination = this.padPanL;
    else if (type === "pad" && pan > 0) destination = this.padPanR;
    else if (type === "bell") destination = this.bellPan;
    else if (isMelody) {
      destination = this.melodyBuses[this.melodyBusIndex % 3];
      this.melodyBusIndex++;
    } else {
      destination = this.gain;
    }

    g.connect(destination);

    const stopTime = t0 + Math.max(env.a + env.d, durationSec) + env.r + 0.05;
    if (modOsc) { modOsc.start(t0); modOsc.stop(stopTime); }
    osc.start(t0);
    osc.stop(stopTime);
  }

  private createOscillator(freq: number, timbre: TimbreMode): [OscillatorNode, OscillatorNode | null] {
    const osc = this.ctx.createOscillator();
    let modOsc: OscillatorNode | null = null;
    switch (timbre) {
      case "sine": osc.type = "sine"; break;
      case "triangle": osc.type = "triangle"; break;
      case "softsq": osc.type = "square"; break;
      case "fm": {
        osc.type = "sine";
        modOsc = this.ctx.createOscillator();
        const modGain = this.ctx.createGain();
        modOsc.frequency.value = freq * FM_MOD_RATIO;
        modGain.gain.value = freq * FM_INDEX;
        modOsc.connect(modGain).connect(osc.frequency);
        break;
      }
    }
    osc.frequency.value = freq;
    return [osc, modOsc];
  }

  private createNoiseBuffer(): AudioBuffer {
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.5);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = mulberry32Next(this.state) * 2 - 1;
    }
    return buffer;
  }

  private playKick(t0: number, amp: number): void {
    if (this.disposed) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.05);
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  }

  private playSnare(t0: number, amp: number, isGhost: boolean): void {
    if (this.disposed) return;
    const noise = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    noise.buffer = this.noiseBuffer;
    filter.type = "bandpass";
    filter.frequency.value = 2000;
    filter.Q.value = 1.5;
    const dur = isGhost ? 0.06 : 0.12;
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    noise.connect(filter);
    filter.connect(g);
    g.connect(this.drumBus);
    noise.start(t0);
    noise.stop(t0 + dur);
  }

  private playHat(t0: number, amp: number, closed: boolean): void {
    if (this.disposed) return;
    const noise = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    noise.buffer = this.noiseBuffer;
    filter.type = "highpass";
    filter.frequency.value = 7000;
    filter.Q.value = 1.0;
    const dur = closed ? 0.03 : 0.08;
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    noise.connect(filter);
    filter.connect(g);
    g.connect(this.drumBus);
    noise.start(t0);
    noise.stop(t0 + dur);
  }
}
