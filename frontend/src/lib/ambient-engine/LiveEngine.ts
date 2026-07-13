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
 *   ✅ FIX: Added `starting` flag to prevent concurrent start() calls
 *   ✅ FIX: stop() cancels in-flight start, start() checks starting flag after resume
 *   ✅ FIX (CodeRabbit): start() guard now also checks `starting` so concurrent
 *       calls cannot both pass the gate and double-tick. A monotonic start token
 *       would additionally cover start→stop→start; left as a future improvement.
 *   ✅ FIX (monotonic token): Replaced the `starting` boolean with a monotonic
 *       `startToken` counter. Each start() call captures the current token and
 *       re-checks it after `await this.ctx.resume()`. stop() and dispose()
 *       increment the token, invalidating any older in-flight start. This closes
 *       the start→stop→start race where the shared `starting` flag could be
 *       reused by a newer start(), letting the older start() pass the post-resume
 *       guard and double-tick. The `starting` field is removed entirely because
 *       the token subsumes both the concurrent-start guard and the race guard.
 *   ✅ FIX (NOISE_BUFFER_SAMPLES): createNoiseBuffer() now uses the shared
 *       NOISE_BUFFER_SAMPLES constant (imported from musicalLogic.ts) instead
 *       of computing bufferSize from this.ctx.sampleRate. The live AudioContext
 *       may run at 48000 Hz (24000 samples) while the offline renderer
 *       hardcodes 44100 Hz (22050 samples), causing mulberry32Next to advance
 *       by different amounts and desyncing all downstream RNG-dependent
 *       decisions (drum patterns, melody intervals, harmonic changes). With
 *       the fixed sample count, the RNG stream advances identically in live
 *       and offline modes. The buffer is still created at this.ctx.sampleRate
 *       so it plays at the correct speed — only the sample COUNT is fixed.
 *       The constant is imported (not redefined locally) so there is a single
 *       source of truth shared with renderAmbient.ts.
 *   ✅ FIX (look-ahead scheduler): Replaced chained window.setTimeout in tick()
 *       with a look-ahead scheduler. start() initializes nextBeatTime and
 *       starts a setInterval polling at LOOKAHEAD_INTERVAL (25ms); each poll
 *       schedules any beats that fall within SCHEDULE_AHEAD_TIME (100ms) of
 *       ctx.currentTime. tick() now takes an absolute time argument instead
 *       of reading ctx.currentTime fresh each call. This is immune to
 *       background-tab setTimeout throttling (which can delay ticks to ≥1s
 *       with no catch-up) and keeps the beat grid locked to AudioContext
 *       time, which is the spec-correct anchor for Web Audio scheduling.
 *   ✅ FIX (masterDestination): Constructor accepts an optional
 *       masterDestination: AudioNode | null. When provided (e.g. by
 *       useAudioEngine routing the output through a shared master gain),
 *       this.out connects to it instead of ctx.destination. Falls back to
 *       ctx.destination to preserve existing behaviour when omitted.
 *
 * Layered additions (swing / sidechain / beatless drone latch reset):
 *   ✅ ADD (scheduling helpers): Imports getSubBeatEventTime() and
 *       getSidechainDuckShape() from ./scheduling. The single live
 *       subBeatIndex → eventTime conversion now goes through
 *       getSubBeatEventTime() so swing is applied uniformly to every odd
 *       sixteenth. Sidechain duck shape is computed once per kick and
 *       applied to this.gain (the tonal bus), not this.out (the master)
 *       — ducking the master would also duck the kick that triggered the
 *       sidechain, defeating the purpose.
 *   ✅ ADD (droneLayersStarted reset): start() now resets
 *       `this.state.droneLayersStarted = false` so a stopped/restarted
 *       beatless playback re-fires the drone oscillators. Without this
 *       reset, the latch in musicalLogic would stay true after the first
 *       run and the second run would emit zero drone events.
 *   ✅ ADD (tonal-bus duck on kick): Kick events trigger applySidechain()
 *       which cancels in-flight gain automation on this.gain.gain, ducks
 *       to TONAL_BUS_GAIN * duckGainMultiplier over SIDECHAIN_ATTACK_SEC,
 *       then ramps back to TONAL_BUS_GAIN over SIDECHAIN_RELEASE_SEC.
 *       Sidechain is a no-op when params.sidechainAmount is undefined or 0
 *       (getSidechainDuckShape returns null).
 *   ✅ ADD (TONAL_BUS_GAIN constant): The 0.3 tonal-bus gain was a magic
 *       number; it is now named TONAL_BUS_GAIN so the sidechain code can
 *       reference the same value as the constructor. Both the constructor
 *       init and applySidechain() use this constant — changing it changes
 *       both the steady-state tonal-bus level and the sidechain return
 *       level, which is the intended coupling.
 */

import {
  type EngineParams,
  type EngineState,
  type MusicalEvent,
  type ScaleName,
  type TimbreMode,
  getMusicalEvents,
  createInitialState,
  initializeBell,
  getSceneName,
  getEffectiveSceneParams,
  mulberry32Next,
  MAX_DRONE_LAYERS,
  DRONE_FADE_SEC,
  NOISE_BUFFER_SAMPLES,
} from "./musicalLogic";
import {
  getSidechainDuckShape,
  getSubBeatEventTime,
  TONAL_BUS_GAIN,
} from "./scheduling";

import { getSharedAudioContext } from "@/lib/audioContext";

const FM_MOD_RATIO = 1.5;
const FM_INDEX = 1.8;

const ADSR_MELODY = { a: 0.02, d: 0.2, s: 0.55, r: 0.25 };
const ADSR_PAD_L = { a: 0.5, d: 0.8, s: 0.7, r: 0.8 };
const ADSR_PAD_R = { a: 0.6, d: 0.8, s: 0.7, r: 0.9 };
const ADSR_BASS = { a: 0.005, d: 0.15, s: 0.25, r: 0.2 };
const ADSR_BELL = { a: 0.01, d: 0.1, s: 0.2, r: 0.15 };
// CodeRabbit nitpick: DRONE_FADE_SEC now imported from musicalLogic.ts
// (single source of truth shared with renderAmbient).
// TONAL_BUS_GAIN is imported from ./scheduling (single source of truth
// shared with renderAmbient) — see scheduling.ts for why it lives there.

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

  // ponytail: fixed 8-layer drone cap; raising it later requires increasing
  // MAX_DRONE_LAYERS and preallocating matching persistent nodes here/offline.
  // SonarCloud: marked readonly — these arrays are populated once in the
  // constructor and never reassigned.
  private readonly dronePans: StereoPannerNode[] = [];
  private readonly droneGains: GainNode[] = [];
  private readonly droneFilters: BiquadFilterNode[] = [];
  private droneOscs: Array<OscillatorNode | null> = [];
  private droneModOscs: Array<OscillatorNode | null> = [];
  private droneLfos: Array<OscillatorNode | null> = [];

  // FIX W2: Melody buses for visual analysis routing
  melodyBuses: GainNode[] = [];
  private melodyBusIndex = 0;

  running = false;
  params: EngineParams;
  private state: EngineState;

  // ✅ FIX (look-ahead scheduler): Replaces the chained-setTimeout id. The
  // scheduler now polls on a fixed short interval and schedules upcoming
  // beats against ctx.currentTime, rather than each tick re-arming a
  // setTimeout anchored to "now". Immune to background-tab throttling.
  private schedulerTimerId: number | null = null;
  private nextBeatTime: number = 0;
  private readonly SCHEDULE_AHEAD_TIME = 0.1; // Schedule 100ms ahead
  private readonly LOOKAHEAD_INTERVAL = 25; // Check every 25ms

  // FIX C4: Harmonic slew tracking (wall-clock, not beat-relative)
  private harmonicSlewStartHz: number | null = null;
  private harmonicSlewEndHz: number | null = null;
  private harmonicSlewStartTime: number | null = null;
  private harmonicSlewEndTime: number | null = null;
  private readonly SLEW_DURATION = 0.6; // 600ms exact from spec

  // D1: Disposed flag to prevent reuse after cleanup
  private disposed = false;

  // ✅ FIX (monotonic token): Replaces the `starting` boolean. Each start()
  // call increments this counter and captures the new value. After
  // `await this.ctx.resume()`, the call checks whether its captured token
  // still matches this.startToken. If stop() or dispose() was called in the
  // interim (or a newer start() superseded it), the token will have been
  // incremented and the older start() bails out without setting running or
  // calling tick(). This closes the start→stop→start race.
  private startToken = 0;

  constructor(
    params: EngineParams,
    injectedCtx?: AudioContext,
    masterDestination?: AudioNode | null,
  ) {
    // Use injected context if provided, otherwise use shared singleton
    this.ctx = injectedCtx || getSharedAudioContext();
    this.params = { ...params };

    // ── Audio graph ──
    this.out = this.ctx.createGain();
    this.gain = this.ctx.createGain();
    this.delay = this.ctx.createDelay(2.0);
    this.fb = this.ctx.createGain();
    this.filter = this.ctx.createBiquadFilter();

    // ✅ ADD (TONAL_BUS_GAIN): named constant instead of the magic 0.3.
    this.gain.gain.value = TONAL_BUS_GAIN;
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

    // ✅ FIX (masterDestination): Connect to the provided master destination
    // (e.g. from useAudioEngine) so external mixers/meters can tap the engine
    // output. Falls back to ctx.destination when omitted, preserving the
    // previous behaviour for callers that don't supply a destination.
    this.out.connect(masterDestination || this.ctx.destination);

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

    for (let i = 0; i < MAX_DRONE_LAYERS; i++) {
      const pan = this.ctx.createStereoPanner();
      const g = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      pan.pan.value = 0;
      g.gain.value = 0;
      filter.type = "lowpass";
      filter.frequency.value = 3600;
      filter.Q.value = 0.7;
      filter.connect(g);
      g.connect(pan);
      pan.connect(this.gain);
      this.dronePans.push(pan);
      this.droneGains.push(g);
      this.droneFilters.push(filter);
      this.droneOscs.push(null);
      this.droneModOscs.push(null);
      this.droneLfos.push(null);
    }

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
    if (this.disposed || this.running) return;

    // ✅ FIX (monotonic token): Capture a per-call token. stop() and dispose()
    // increment this.startToken, as does any newer start() call. After the
    // await below, we re-check: if our token no longer matches, someone
    // invalidated us and we must NOT set running or calling tick().
    const myToken = ++this.startToken;

    await this.ctx.resume();

    // Only the latest start() should proceed. If stop(), dispose(), or a
    // newer start() was called during the await, myToken will be stale.
    if (this.disposed || myToken !== this.startToken) return;

    this.running = true;

    // ✅ ADD (droneLayersStarted reset): musicalLogic latches drone emission
    // once droneLayersStarted is true (beatless mode). A stopped/restarted
    // beatless playback must re-fire the drone oscillators, so reset the
    // latch here. This is a no-op for beat-enabled mode (the flag is unused
    // there) but cheap and correct in both cases.
    this.state = { ...this.state, droneLayersStarted: false };

    // ✅ FIX (look-ahead scheduler): Initialize the absolute beat grid to
    // ctx.currentTime and start the look-ahead poller. The scheduler will
    // catch up any beats that fall within SCHEDULE_AHEAD_TIME on each tick,
    // so a delayed setInterval firing (e.g. background tab) does not cause
    // drift — it simply schedules the missed beats against the now-current
    // ctx.currentTime. This replaces the old `this.tick()` call.
    this.nextBeatTime = this.ctx.currentTime;
    this.schedulerTimerId = window.setInterval(
      () => this.scheduler(),
      this.LOOKAHEAD_INTERVAL,
    );
  }

  stop(): void {
    // ✅ FIX (monotonic token): Increment the token to invalidate any
    // in-flight start() that captured an older value. That start() will
    // see the mismatch after resume() and bail out without calling tick().
    ++this.startToken;

    // ✅ FIX (look-ahead scheduler): Clear the look-ahead scheduler
    // interval instead of a single setTimeout id. No in-flight beats will
    // be cancelled (they're already scheduled on ctx.currentTime), but no
    // further beats will be queued.
    if (this.schedulerTimerId !== null) {
      window.clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
    this.stopDroneLayers(this.ctx.currentTime);
    this.running = false;
  }

  /**
   * ✅ FIX (look-ahead scheduler): Polls every LOOKAHEAD_INTERVAL ms and
   * schedules any beats that fall within SCHEDULE_AHEAD_TIME of
   * ctx.currentTime. Each beat is scheduled at its absolute time on the
   * AudioContext clock, so background-tab throttling of setInterval only
   * delays the *scheduling* — once scheduled, the Web Audio engine fires
   * the beat on time regardless of tab visibility. If the tab was
   * throttled and many beats slipped into the look-ahead window, they
   * are all scheduled in one pass (no drift, no skip).
   *
   * ✅ FIX (fresh beatSec): beatSec is recomputed INSIDE the loop, after
   * tick() returns. tick() may update this.params.bpm via the scene engine
   * (scene transitions, tempo overrides) and we want the very next beat to
   * use the new tempo. Computing beatSec once before the loop would apply
   * the BPM change one beat late — a real problem when multiple beats fall
   * inside SCHEDULE_AHEAD_TIME (e.g. 100ms window at 120 BPM schedules
   * ~2 beats per pass, and a scene change on beat 1 would not affect the
   * spacing of beat 2 within the same pass).
   */
  private scheduler(): void {
    if (this.disposed || !this.running) return;
    while (
      this.nextBeatTime <
      this.ctx.currentTime + this.SCHEDULE_AHEAD_TIME
    ) {
      this.tick(this.nextBeatTime);
      // ✅ FIX: Recalculate beatSec AFTER tick() so scene-driven BPM changes
      // take effect immediately on the very next beat, not one beat late.
      this.nextBeatTime += 60 / this.params.bpm;
    }
  }

  /**
   * D1: Dispose all audio nodes to prevent leakage.
   * Call this after stop() when the engine is no longer needed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // ✅ FIX (monotonic token): stop() increments the token, invalidating
    // any in-flight start(). No separate `starting = false` needed.
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
      ...this.dronePans,
      ...this.droneGains,
      ...this.droneFilters,
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

  /**
   * B1: setMix now accepts an optional absolute AudioContext time `t0`.
   * When called from tick(t0), pass the beat's scheduled time so the ramp
   * is pinned to the beat grid rather than ctx.currentTime (which may be
   * up to SCHEDULE_AHEAD_TIME earlier than the scheduled beat due to the
   * look-ahead scheduler). External callers that omit t0 fall back to
   * ctx.currentTime, preserving the previous behavior.
   *
   * CodeRabbit #3: cancelAndHoldAtTime(startTime) before the new ramp so the
   * previous in-flight ramp's current value is preserved as the anchor for
   * the new ramp. Previously we read filter.frequency.value, which is the
   * *last setTargetAtTime/setValueAtTime target*, NOT the current automated
   * value at startTime — so a new ramp starting mid-flight would jump back
   * to the previous target instead of continuing from where the curve had
   * actually reached.
   *
   * ponytail: live keeps a 0.5s linearRampToValueAtTime for filter cutoff
   * to avoid zipper noise during continuous scene transitions; offline
   * (renderAmbient) uses instant setValueAtTime per beat. Unifying would
   * mean either scheduling per-beat ramp segments offline (more complex
   * automation bookkeeping) or accepting zipper noise live (worse audio).
   * Accept the divergence — both shells already diverge similarly on
   * drone-fade shape, see renderAmbient.scheduleDrone.
   */
  setMix(mix: number, t0?: number): void {
    if (this.disposed) return;
    this.params.mix = mix;
    const startTime = t0 ?? this.ctx.currentTime;
    this.delay.delayTime.setValueAtTime(0.3 + 0.4 * mix, startTime);
    this.fb.gain.setValueAtTime(0.2 + 0.5 * mix, startTime);
    const cutoff = 5000 + mix * 4000;
    // Hold the previous automation at startTime so the new ramp anchors to
    // the actual current automated value, not the stale .value target. See
    // cancelAndHold()'s doc comment for the fallback rationale.
    const freqParam = this.filter.frequency;
    this.cancelAndHold(freqParam, startTime);
    freqParam.linearRampToValueAtTime(cutoff, startTime + 0.5);
  }

  /**
   * Cancels all scheduled future automation on `param` and holds its value
   * at `t`, so a subsequent setValueAtTime/linearRampToValueAtTime call
   * anchors to what the param actually was at `t` instead of jumping to
   * whatever target a prior, now-superseded ramp was heading toward.
   *
   * cancelAndHoldAtTime is the spec-correct primitive for this but shipped
   * late in Firefox (v92, Sep 2021) — older Firefox and any engine missing
   * it would throw TypeError. Feature-detect at runtime and fall back to
   * cancelScheduledValues + setValueAtTime(.value, t), which is lossy
   * (jumps to the last explicit target rather than the true interpolated
   * value — Web Audio has no public API to read the interpolated value) but
   * never crashes and keeps the caller's next automation call anchored to
   * *something* deterministic.
   *
   * Used by setMix() (filter cutoff ramp) and stopDroneLayers() (gain
   * fade-to-zero, which must cancel any look-ahead-scheduled
   * setTargetAtTime(event.amp, futureT0, ...) calls queued by playDrone()
   * before the fade-to-zero, or the drone can audibly blip back up mid-fade).
   *
   * ponytail: this fallback's jump-back-to-target is audible if a previous
   * ramp was mid-flight; upgrading means dropping support for engines
   * without cancelAndHoldAtTime, since there's no public API to read the
   * true interpolated value to polyfill it properly.
   */
  private cancelAndHold(param: AudioParam, t: number): void {
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
    }
  }

  setBpm(bpm: number): void {
    if (!this.disposed) this.params.bpm = bpm;
  }
  setComplexity(c: number): void {
    if (!this.disposed) this.params.complexity = c;
  }
  setScale(s: ScaleName): void {
    if (!this.disposed) this.params.scale = s;
  }
  setRootHz(hz: number): void {
    if (!this.disposed) this.params.rootHz = hz;
  }
  setDrumLevel(d: number): void {
    if (!this.disposed) this.params.drumLevel = d;
  }

  getCurrentState(): EngineState {
    return { ...this.state };
  }
  getParams(): EngineParams {
    return { ...this.params };
  }

  // ✅ Returns AudioNode (never null) – safe because it's never called after dispose()
  getMasterNode(): AudioNode {
    return this.out;
  }

  getCurrentSceneName(): string {
    return getSceneName(this.state, this.params);
  }

  /**
   * ✅ FIX (look-ahead scheduler): tick() now takes an absolute AudioContext
   * time `t0` (the beat's scheduled playback time) instead of reading
   * ctx.currentTime itself. This decouples event scheduling from "now" so
   * the look-ahead scheduler can queue future beats deterministically.
   * The self-arming `window.setTimeout` at the end has been removed — the
   * scheduler() poller is now the only thing that calls tick().
   */
  private tick(t0: number): void {
    if (this.disposed || !this.running) return;

    const preTickParams = getEffectiveSceneParams(this.state, this.params);
    this.params.bpm = preTickParams.bpm;
    // B2: sync scene-interpolated scale and complexity back into this.params
    // so engine.getParams() reflects what's actually playing during a scene
    // transition. density/timbre live on EngineState (currentDensity/
    // currentTimbre) and are already updated via nextState assignment below.
    this.params.scale = preTickParams.scale;
    this.params.complexity = preTickParams.complexity;
    // B1: anchor the mix ramp to the beat's scheduled time, not ctx.currentTime.
    this.setMix(preTickParams.mix, t0);

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
      // ✅ ADD (swing): single live subBeatIndex → eventTime conversion now
      // goes through getSubBeatEventTime() so params.swing is applied to
      // every odd sixteenth uniformly. Tonal events have subBeatIndex 0,
      // so swing (which only offsets odd sub-beats) leaves them at t0.
      const eventTime = getSubBeatEventTime(
        t0,
        event.subBeatIndex,
        sixteenthSec,
        this.params.swing,
      );
      this.scheduleSynthEvent(event, eventTime);
    }

    // ✅ FIX (look-ahead scheduler): No self-scheduling setTimeout here.
    // The scheduler() poller owns beat spacing; it calls tick() with the
    // absolute time for the next beat. Removing this also eliminates the
    // last setTimeout-based drift source in the engine.
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
      case "kick":
        this.playKick(t0, event.amp);
        // ✅ ADD (tonal-bus duck on kick): Trigger sidechain AFTER the kick
        // is scheduled so the duck attack lines up with the kick hit. Ducks
        // this.gain (tonal bus) — NOT this.out (master) — so the kick itself
        // stays at full level. No-op when params.sidechainAmount is 0/undefined.
        this.applySidechain(t0);
        break;
      case "snare":
        this.playSnare(t0, event.amp, event.isGhost ?? false);
        break;
      case "hihat":
        this.playHat(t0, event.amp, event.isClosed ?? true);
        break;
      case "drone":
        this.playDrone(event, t0);
        break;
      case "melody":
        this.playTonal(event, t0, true);
        break;
      case "pad":
      case "bass":
      case "bell":
        this.playTonal(event, t0, false);
        break;
    }
  }

  /**
   * ✅ ADD (tonal-bus sidechain duck): Called from scheduleSynthEvent() on
   * every kick. Computes the duck shape via getSidechainDuckShape() (pure,
   * shell-side helper from ./scheduling) and applies a 3-segment gain
   * automation on this.gain.gain:
   *
   *   1. setValueAtTime(TONAL_BUS_GAIN, t0)           — anchor to steady level
   *   2. linearRampToValueAtTime(ducked, attackTime)   — duck over 10ms
   *   3. linearRampToValueAtTime(TONAL_BUS_GAIN, releaseTime) — return over 180ms
   *
   * cancelScheduledValues(t0) first so any in-flight setMix() ramp on the
   * filter (separate param) or any prior sidechain curve doesn't fight this
   * one. We don't use cancelAndHold here because we explicitly want to
   * reset to TONAL_BUS_GAIN at t0 — the duck is a per-kick absolute shape,
   * not a relative continuation.
   *
   * Why this.gain and not this.out: this.gain is the tonal bus that feeds
   * the delay/feedback/filter chain and then into this.out. Ducking this.out
   * would also duck the drum bus (connected to this.out) which would
   * silence the kick that triggered the sidechain — defeating the purpose.
   * The drum bus joins the graph at this.out, downstream of this.gain, so
   * ducking this.gain leaves drums untouched.
   *
   * ponytail: cancelScheduledValues(t0) on this.gain.gain will also wipe
   * any queued setMix() ramp on this.gain? No — setMix() automates
   * this.filter.frequency, this.delay.delayTime, and this.fb.gain, NOT
   * this.gain.gain. So this is safe. If a future change moves mix onto
   * this.gain, this cancel call would need to switch to cancelAndHold.
   */
  private applySidechain(t0: number): void {
    const shape = getSidechainDuckShape(t0, this.params.sidechainAmount);
    if (!shape) return;

    const param = this.gain.gain;
    param.cancelScheduledValues(t0);
    param.setValueAtTime(TONAL_BUS_GAIN, t0);
    param.linearRampToValueAtTime(
      TONAL_BUS_GAIN * shape.duckGainMultiplier,
      shape.attackTime,
    );
    param.linearRampToValueAtTime(TONAL_BUS_GAIN, shape.releaseTime);
  }

  private playDrone(event: MusicalEvent, t0: number): void {
    if (this.disposed || event.hz === undefined) return;
    const layerIndex = event.droneLayerIndex ?? 0;
    if (layerIndex < 0 || layerIndex >= MAX_DRONE_LAYERS) return;

    const pan = this.dronePans[layerIndex];
    const gain = this.droneGains[layerIndex];
    const filter = this.droneFilters[layerIndex];
    pan.pan.setTargetAtTime(event.pan, t0, 0.25);
    filter.frequency.setTargetAtTime(3600, t0, 0.5);

    if (!this.droneOscs[layerIndex]) {
      const [osc, modOsc] = this.createOscillator(
        event.hz,
        event.timbre ?? "sine",
      );
      osc.detune.setValueAtTime(event.detuneCents ?? 0, t0);
      osc.connect(filter);
      if (modOsc) {
        modOsc.start(t0);
        this.droneModOscs[layerIndex] = modOsc;
      }

      if (event.sweepSec) {
        // ponytail: naive sine filter sweep only; upgrading means a real per-layer
        // modulation matrix shared by live and offline renderers.
        const lfo = this.ctx.createOscillator();
        const lfoGain = this.ctx.createGain();
        lfo.frequency.value = 1 / event.sweepSec;
        lfoGain.gain.value = 800;
        lfo.connect(lfoGain).connect(filter.frequency);
        lfo.start(t0);
        this.droneLfos[layerIndex] = lfo;
      }

      osc.start(t0);
      this.droneOscs[layerIndex] = osc;
    } else {
      this.droneOscs[layerIndex]?.frequency.setTargetAtTime(event.hz, t0, 0.5);
      this.droneOscs[layerIndex]?.detune.setTargetAtTime(
        event.detuneCents ?? 0,
        t0,
        0.5,
      );
      // CodeRabbit #1: when the carrier frequency changes on an existing
      // FM-modulated drone layer, the modulator must track it to preserve
      // the mod-to-carrier ratio (FM_MOD_RATIO = 1.5) established by
      // createOscillator. Without this, a drone layer whose hz changes
      // mid-playback would keep the original modulator frequency, breaking
      // the timbre. Guard when no modulator exists (non-fm timbres).
      const modOsc = this.droneModOscs[layerIndex];
      if (modOsc) {
        modOsc.frequency.setTargetAtTime(event.hz * FM_MOD_RATIO, t0, 0.5);
        // ponytail: this update only adjusts the modulator's *frequency*.
        // The FM mod index (depth, set as modGain.gain.value = freq * FM_INDEX
        // at creation in createOscillator) is NOT re-scaled here because the
        // per-layer modGain node isn't retained. Upgrading means storing
        // modGain nodes alongside droneModOscs and scaling them in lockstep
        // with the carrier frequency so the index tracks freq changes too.
      }
    }

    gain.gain.setTargetAtTime(event.amp, t0, DRONE_FADE_SEC / 3);
  }

  private stopDroneLayers(t0: number): void {
    for (let i = 0; i < MAX_DRONE_LAYERS; i++) {
      const gainParam = this.droneGains[i]?.gain;
      if (gainParam) {
        // Cancel and hold the gain automation at t0 BEFORE the fade-to-zero.
        // The look-ahead scheduler can queue beats up to SCHEDULE_AHEAD_TIME
        // (100ms) ahead of ctx.currentTime, and those queued beats may have
        // already scheduled setTargetAtTime(event.amp, futureT0,
        // DRONE_FADE_SEC / 3) on this same gain node. Without cancel-and-hold,
        // those queued event.amp re-assertions could fire mid-fade (e.g. at
        // t0 + 50ms), causing the drone to blip back to its sustain level
        // before osc.stop(t0 + 0.25) silences it. See cancelAndHold()'s doc
        // comment for the fallback rationale.
        this.cancelAndHold(gainParam, t0);
        gainParam.setTargetAtTime(0, t0, 0.1);
      }
      for (const osc of [
        this.droneOscs[i],
        this.droneModOscs[i],
        this.droneLfos[i],
      ]) {
        if (!osc) continue;
        // CodeRabbit #2: schedule osc.stop(t0 + 0.25) so the gain envelope
        // above (0.1s time constant) has time to fade out before the node
        // is actually stopped. Previously we also called osc.disconnect()
        // here, which immediately severs the audio path mid-fade and causes
        // an audible click. Let osc.stop() handle the lifecycle — the node
        // will be GC'd after it stops. disconnect() is still needed to
        // release the graph reference, but doing it at stop time (not before)
        // would require an onended handler; the current approach is simpler
        // and the click is gone. ponytail: if oscillator graph leakage ever
        // shows up in profiling, add osc.onended = () => osc.disconnect().
        try {
          osc.stop(t0 + 0.25);
        } catch {
          // Ignore already-stopped drone nodes.
        }
      }
      this.droneOscs[i] = null;
      this.droneModOscs[i] = null;
      this.droneLfos[i] = null;
    }
  }

  private playTonal(event: MusicalEvent, t0: number, isMelody: boolean): void {
    if (this.disposed) return;
    const { hz, amp, durationSec, pan, timbre, type } = event;
    if (hz === undefined) return;

    let env: { a: number; d: number; s: number; r: number };
    let vibratoAmount: number | undefined;

    switch (type) {
      case "melody":
        env = ADSR_MELODY;
        vibratoAmount = 1.5;
        break;
      case "pad":
        env = pan < 0 ? ADSR_PAD_L : ADSR_PAD_R;
        break;
      case "bass":
        env = ADSR_BASS;
        break;
      case "bell":
        env = ADSR_BELL;
        break;
      default:
        env = ADSR_PAD_L;
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
    g.gain.setValueAtTime(
      amp * env.s,
      t0 + Math.max(env.a + env.d, durationSec),
    );
    g.gain.linearRampToValueAtTime(
      0.0001,
      t0 + Math.max(env.a + env.d, durationSec) + env.r,
    );

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
    if (modOsc) {
      modOsc.start(t0);
      modOsc.stop(stopTime);
    }
    osc.start(t0);
    osc.stop(stopTime);
  }

  private createOscillator(
    freq: number,
    timbre: TimbreMode,
  ): [OscillatorNode, OscillatorNode | null] {
    const osc = this.ctx.createOscillator();
    let modOsc: OscillatorNode | null = null;
    switch (timbre) {
      case "sine":
        osc.type = "sine";
        break;
      case "triangle":
        osc.type = "triangle";
        break;
      case "softsq":
        osc.type = "square";
        break;
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

  // ✅ FIX (NOISE_BUFFER_SAMPLES): Uses the shared NOISE_BUFFER_SAMPLES
  // constant (imported from musicalLogic.ts) instead of
  // Math.floor(this.ctx.sampleRate * 0.5). The live AudioContext may run at
  // 48000 Hz (yielding 24000 samples) while the offline renderer hardcodes
  // 44100 Hz (yielding 22050 samples). This mismatch caused mulberry32Next
  // to advance by different amounts, desyncing the RNG stream between live
  // and offline modes. The buffer is still created at this.ctx.sampleRate
  // so it plays at the correct speed — only the sample COUNT is fixed.
  // Importing (rather than redefining) ensures a single source of truth
  // shared with renderAmbient.ts.
  private createNoiseBuffer(): AudioBuffer {
    const buffer = this.ctx.createBuffer(
      1,
      NOISE_BUFFER_SAMPLES,
      this.ctx.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < NOISE_BUFFER_SAMPLES; i++) {
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
