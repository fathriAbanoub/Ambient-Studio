/**
 * musicalLogic.ts — Pure musical decision engine for ambient music generation.
 *
 * ZERO Web Audio API dependencies. Importable in Node.js with no polyfills.
 * All randomness flows through mulberry32 seeded PRNG — fully deterministic.
 *
 * Architecture: getMusicalEvents(beat, state, params) → { events, nextState }
 * This function is the single source of truth for every musical decision.
 * Both LiveEngine (real-time) and renderAmbient (offline) call this function.
 *
 * RNG ORDER (must match original engine.ts constructor + tick() exactly):
 *   1. createInitialState() sets rngState = seed
 *   2. advanceRngPastNoiseBuffer() consumes ~22,050 calls (matching createNoiseBuffer)
 *   3. initializeBell() consumes 1 call (nextBellBeat)
 *   4. getMusicalEvents() per-beat calls follow
 *
 * HARMONIC SLEW: This module only tracks targetRootHz changes.
 * The 600ms linear slew is handled by the synthesis shells (LiveEngine,
 * renderAmbient) which have access to real or offline AudioContext time.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type TimbreMode = 'sine' | 'triangle' | 'softsq' | 'fm';

export interface EngineParams {
  scale: 'majorPent' | 'minorPent';
  rootHz: number;
  bpm: number;
  complexity: number;       // 0..1
  mix: number;              // 0..1 (delay level)
  sceneDurationBars?: number; // default 32
  enableScenes?: boolean;     // default true
  enableHarmonicLoop?: boolean; // default true
  seed?: number;
  drumLevel?: number;         // 0..1
}

export interface MusicalEvent {
  type: 'melody' | 'pad' | 'bass' | 'bell' | 'kick' | 'snare' | 'hihat';
  hz?: number;              // undefined for drums (kick/snare/hihat)
  amp: number;
  durationSec: number;
  pan: number;              // -1 to 1 (for tonal); 0 for drums (panning via persistent nodes)
  timbre?: TimbreMode;      // undefined for drums
  beatIndex: number;
  /** For snare: true = ghost note (lower amp, shorter) */
  isGhost?: boolean;
  /** For hihat: true = closed (short), false = open (longer) */
  isClosed?: boolean;
  /**
   * FIX C1: Sub-beat offset for drum events (0–3).
   * Drum events must be scheduled at: t0 + (subBeatIndex * sixteenthSec)
   * where sixteenthSec = beatSec / 4.
   * Tonal events always fire at t0 (subBeatIndex = 0).
   */
  subBeatIndex: number;
}

export interface EngineState {
  beat: number;
  degree: number;
  lastInterval: number;
  currentSceneIndex: number;
  sceneStartBeat: number;
  harmonicLoopIndex: number;
  /**
   * currentRootHz: the value the synthesis shell is currently playing/slewing toward.
   * musicalLogic does NOT update this — only the synthesis shell does.
   * musicalLogic only sets targetRootHz when a harmonic change occurs.
   */
  currentRootHz: number;
  /**
   * targetRootHz: set by musicalLogic when a harmonic loop step fires.
   * When targetRootHz !== currentRootHz, the synthesis shell must start a 600ms slew.
   */
  targetRootHz: number;
  /** Mulberry32 internal state */
  rngState: number;
  panDriftPhase: number;
  sixteenthCount: number;
  nextBellBeat: number;
  currentDensity: number;
  currentTimbre: TimbreMode;
}

// ── Constants (verbatim from original engine.ts) ──────────────────────────────

const MAJOR_PENT = [0, 2, 4, 7, 9];
const MINOR_PENT = [0, 3, 5, 7, 10];

const BEATS_PER_BAR = 4;
const BAR_LENGTH = 8;
const BASS_HITS = 3;
const CADENCE_INTERVAL = 16;
const PHRASE_LENGTH = 32;

const DRUM_GHOST_PROBABILITY = 0.25;
const DRUM_SNARE_AMP = 0.45;
const DRUM_KICK_AMP = 0.6;
const DRUM_HAT_AMP = 0.25;
const DRUM_HAT_CLOSED_PROB = 0.85;

export const NOISE_BUFFER_SAMPLES = 22050; // sampleRate(44100) * 0.5s — must match synthesis shells

const ROOT_LOOP_HZ = [220, 185, 147, 165]; // A3 → F#3 → D3 → E3

export interface Scene {
  name: string;
  scale: 'majorPent' | 'minorPent';
  bpm: number;
  mix: number;
  complexity: number;
  density: number;
  timbre: TimbreMode;
}

export const SCENES: Scene[] = [
  { name: 'Calm',     scale: 'majorPent', bpm: 72, mix: 0.4,  complexity: 0.30, density: 0.80, timbre: 'sine' },
  { name: 'Nocturne', scale: 'minorPent', bpm: 62, mix: 0.55, complexity: 0.45, density: 0.65, timbre: 'triangle' },
  { name: 'Ether',    scale: 'majorPent', bpm: 68, mix: 0.65, complexity: 0.55, density: 0.55, timbre: 'fm' },
];

// ── Seeded PRNG: mulberry32 ───────────────────────────────────────────────────

export function mulberry32Next(state: { rngState: number }): number {
  let t = (state.rngState += 0x6D2B79F5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentScale(scale: 'majorPent' | 'minorPent'): number[] {
  return scale === 'majorPent' ? MAJOR_PENT : MINOR_PENT;
}

function noteHz(degree: number, octaveShift: number, rootHz: number, scale: 'majorPent' | 'minorPent'): number {
  const semi = currentScale(scale)[((degree % 5) + 5) % 5] + 12 * octaveShift;
  return rootHz * Math.pow(2, semi / 12);
}

function euclideanRhythm(step: number, pulses: number, steps: number): boolean {
  return (step * pulses) % steps < pulses;
}

function markovStep(lastInterval: number, complexity: number, rng: () => number): number {
  const intervals = [-2, -1, 0, 1, 2];
  const baseWeights = [
    [0.10, 0.25, 0.40, 0.20, 0.05],
    [0.05, 0.25, 0.45, 0.20, 0.05],
    [0.10, 0.20, 0.40, 0.20, 0.10],
    [0.05, 0.20, 0.45, 0.25, 0.05],
    [0.05, 0.20, 0.40, 0.25, 0.10],
  ];
  const lastIdx = intervals.indexOf(lastInterval);
  const row = lastIdx >= 0 ? baseWeights[lastIdx] : baseWeights[2];
  const uniform = 0.2;
  const weights = row.map((w) => w * (1 - complexity) + uniform * complexity);
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  let idx = 0;
  for (; idx < weights.length - 1 && (r -= weights[idx]) > 0; idx++);
  return intervals[idx];
}

function updateSceneEngine(
  state: EngineState,
  params: EngineParams
): { params: EngineParams; state: Partial<EngineState> } {
  if (!params.enableScenes) return { params, state: {} };

  const barCount = Math.floor(state.beat / BEATS_PER_BAR);
  const barsIntoScene = barCount - state.sceneStartBeat / BEATS_PER_BAR;
  const sceneDurationBars = params.sceneDurationBars ?? 32;

  let newSceneIndex = state.currentSceneIndex;
  let newSceneStartBeat = state.sceneStartBeat;

  if (barsIntoScene >= sceneDurationBars) {
    newSceneIndex = (state.currentSceneIndex + 1) % SCENES.length;
    newSceneStartBeat = state.beat;
  }

  const currentScene = SCENES[newSceneIndex];
  const nextScene = SCENES[(newSceneIndex + 1) % SCENES.length];
  const progress = Math.min(
    (barCount - newSceneStartBeat / BEATS_PER_BAR) / sceneDurationBars,
    1.0
  );
  const t = progress < 0.5
    ? 2 * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 2) / 2;

  const newParams = { ...params };
  newParams.bpm = currentScene.bpm + (nextScene.bpm - currentScene.bpm) * t;
  newParams.mix = currentScene.mix + (nextScene.mix - currentScene.mix) * t;
  newParams.complexity = currentScene.complexity + (nextScene.complexity - currentScene.complexity) * t;
  const newDensity = currentScene.density + (nextScene.density - currentScene.density) * t;
  newParams.scale = progress < 0.5 ? currentScene.scale : nextScene.scale;
  const newTimbre = progress < 0.5 ? currentScene.timbre : nextScene.timbre;

  return {
    params: newParams,
    state: {
      currentSceneIndex: newSceneIndex,
      sceneStartBeat: newSceneStartBeat,
      currentDensity: newDensity,
      currentTimbre: newTimbre,
    },
  };
}

/**
 * FIX C4: Harmonic loop only sets targetRootHz.
 * The synthesis shell detects when targetRootHz changes and applies the 600ms slew.
 * currentRootHz is NOT updated here — the shell owns that.
 */
function updateHarmonicLoop(
  state: EngineState,
  params: EngineParams
): Partial<EngineState> {
  if (!params.enableHarmonicLoop) {
    return {
      targetRootHz: params.rootHz,
      currentRootHz: params.rootHz,
    };
  }

  const barCount = Math.floor(state.beat / BEATS_PER_BAR);

  if (barCount % 8 === 0 && state.beat % BEATS_PER_BAR === 0) {
    const newLoopIndex = (state.harmonicLoopIndex + 1) % ROOT_LOOP_HZ.length;
    const newTarget = ROOT_LOOP_HZ[newLoopIndex];
    if (newTarget !== state.targetRootHz) {
      return {
        harmonicLoopIndex: newLoopIndex,
        targetRootHz: newTarget,
        // currentRootHz intentionally NOT updated here — synthesis shell slews to it
      };
    }
  }

  return {};
}

// ── Main: getMusicalEvents ────────────────────────────────────────────────────

export function getMusicalEvents(
  beat: number,
  state: EngineState,
  params: EngineParams
): { events: MusicalEvent[]; nextState: EngineState } {
  const s: EngineState = { ...state };
  const events: MusicalEvent[] = [];
  const rng = () => mulberry32Next(s);

  // 1. Scene engine
  const sceneResult = updateSceneEngine(s, params);
  const effectiveParams = sceneResult.params;
  Object.assign(s, sceneResult.state);

  // 2. Harmonic loop — sets targetRootHz if a change fires this beat
  const harmonicUpdates = updateHarmonicLoop(s, effectiveParams);
  Object.assign(s, harmonicUpdates);

  // 3. Pan drift (phase only — actual panner scheduling is in synthesis shell)
  s.panDriftPhase += 0.01;

  const beatSec = 60 / effectiveParams.bpm;
  // currentRootHz is owned by synthesis shell; musicalLogic uses it read-only for note freq
  const currentRootHz = s.currentRootHz;
  const currentScaleName = effectiveParams.scale;
  const currentTimbre = s.currentTimbre;
  const currentDensity = s.currentDensity;
  const drumLevel = effectiveParams.drumLevel ?? 0.5;

  // 4. Drums — FIX C1: set subBeatIndex (0–3) on each drum event
  for (let i = 0; i < 4; i++) {
    const sixteenthStep = s.sixteenthCount + i;

    if (drumLevel > 0 && euclideanRhythm(sixteenthStep % 16, 5, 16)) {
      events.push({
        type: 'kick',
        amp: DRUM_KICK_AMP * drumLevel,
        durationSec: 0.3,
        pan: 0,
        beatIndex: beat,
        subBeatIndex: i,   // FIX C1
      });
    }

    if (drumLevel > 0) {
      const beatStep = sixteenthStep % 16;
      if (beatStep === 4 || beatStep === 12) {
        events.push({
          type: 'snare',
          amp: DRUM_SNARE_AMP * drumLevel,
          durationSec: 0.12,
          pan: 0,
          beatIndex: beat,
          subBeatIndex: i,   // FIX C1
          isGhost: false,
        });
      } else if (euclideanRhythm(sixteenthStep % 16, 2, 16) && rng() < DRUM_GHOST_PROBABILITY) {
        events.push({
          type: 'snare',
          amp: DRUM_SNARE_AMP * 0.3 * drumLevel,
          durationSec: 0.06,
          pan: 0,
          beatIndex: beat,
          subBeatIndex: i,   // FIX C1
          isGhost: true,
        });
      }
    }

    if (drumLevel > 0 && euclideanRhythm(sixteenthStep % 16, 9, 16)) {
      const isClosed = rng() < DRUM_HAT_CLOSED_PROB;
      events.push({
        type: 'hihat',
        amp: (isClosed ? DRUM_HAT_AMP : DRUM_HAT_AMP * 0.7) * drumLevel,
        durationSec: isClosed ? 0.03 : 0.08,
        pan: 0,
        beatIndex: beat,
        subBeatIndex: i,   // FIX C1
        isClosed,
      });
    }
  }
  s.sixteenthCount += 4;

  // 5. Section offsets
  const sectionOffsets = [0, -3, -1, 2];
  const barIndex = Math.floor(s.beat / BEATS_PER_BAR);
  const sectionOffset = sectionOffsets[barIndex % sectionOffsets.length];

  // 6. Cadence / Markov
  const isCadence = s.beat % CADENCE_INTERVAL === (CADENCE_INTERVAL - 1);
  if (isCadence) {
    s.degree = rng() < 0.6 ? 0 : 2;
    s.lastInterval = 0;
  } else {
    const interval = markovStep(s.lastInterval, effectiveParams.complexity, rng);
    s.lastInterval = interval;
    s.degree = (s.degree + interval + 5) % 5;
  }

  // 7. Melody
  if (rng() < currentDensity) {
    const isPhraseEnd = s.beat % PHRASE_LENGTH === (PHRASE_LENGTH - 1);
    const octaveShift = isPhraseEnd && rng() < 0.3 ? 2 : 1;
    const fMel = noteHz(s.degree, octaveShift, currentRootHz, currentScaleName);
    events.push({
      type: 'melody',
      hz: fMel,
      amp: 0.22,
      durationSec: beatSec * 0.85,
      pan: 0,
      timbre: currentTimbre,
      beatIndex: beat,
      subBeatIndex: 0,
    });
  }

  // 8. Pad (dual detuned — pan is cosmetic hint for ADSR selection, actual pan via persistent nodes)
  const padDegree = (s.degree + 2 + sectionOffset + 5) % 5;
  const fPad = noteHz(padDegree, 2, currentRootHz, currentScaleName);
  events.push({
    type: 'pad',
    hz: fPad * 0.995,
    amp: 0.12,
    durationSec: beatSec * 1.0,
    pan: -1,  // signals "left pad" → use padPanL node and ADSR_PAD_L
    timbre: currentTimbre,
    beatIndex: beat,
    subBeatIndex: 0,
  });
  events.push({
    type: 'pad',
    hz: fPad * 1.005,
    amp: 0.12,
    durationSec: beatSec * 1.0,
    pan: 1,   // signals "right pad" → use padPanR node and ADSR_PAD_R
    timbre: currentTimbre,
    beatIndex: beat,
    subBeatIndex: 0,
  });

  // 9. Bass
  const beatInBar = s.beat % BAR_LENGTH;
  if (euclideanRhythm(beatInBar, BASS_HITS, BAR_LENGTH)) {
    const bassDegree = (s.degree + sectionOffset + 5) % 5;
    const fBass = noteHz(bassDegree, -1, currentRootHz, currentScaleName) / 2;
    events.push({
      type: 'bass',
      hz: fBass,
      amp: 0.18,
      durationSec: beatSec * 0.7,
      pan: 0,
      timbre: 'sine',
      beatIndex: beat,
      subBeatIndex: 0,
    });
  }

  // 10. Bell
  if (s.beat >= s.nextBellBeat) {
    const bellOctave = 2 + Math.floor(rng() * 2);
    const bellDegree = Math.floor(rng() * 5);
    const fBell = noteHz(bellDegree, bellOctave, currentRootHz, currentScaleName);
    events.push({
      type: 'bell',
      hz: fBell,
      amp: 0.15,
      durationSec: beatSec * 0.3,
      pan: 2,  // signals "bell" → use bellPan node
      timbre: currentTimbre,
      beatIndex: beat,
      subBeatIndex: 0,
    });
    s.nextBellBeat = s.beat + Math.floor(rng() * 9) + 8;
  }

  s.beat++;
  return { events, nextState: s };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createInitialState(params: EngineParams): EngineState {
  const seed = params.seed ?? Math.floor(Math.random() * 1000000);
  return {
    beat: 0,
    degree: 0,
    lastInterval: 0,
    currentSceneIndex: 0,
    sceneStartBeat: 0,
    harmonicLoopIndex: 0,
    currentRootHz: params.rootHz,
    targetRootHz: params.rootHz,
    rngState: seed,
    panDriftPhase: 0,
    sixteenthCount: 0,
    nextBellBeat: 0,
    currentDensity: SCENES[0].density,
    currentTimbre: SCENES[0].timbre,
  };
}

/**
 * FIX C2: Advance the RNG by exactly NOISE_BUFFER_SAMPLES calls to match
 * the original engine.ts createNoiseBuffer() which consumed from the same
 * this.rng() stream. This must be called after createInitialState() and
 * before initializeBell(), matching original constructor order:
 *   1. this.rng = mulberry32(seed)
 *   2. this.noiseBuffer = this.createNoiseBuffer()  ← ~22k calls
 *   3. this.nextBellBeat = Math.floor(this.rng() * 8) + 8  ← 1 call
 */
export function advanceRngPastNoiseBuffer(state: EngineState): EngineState {
  const s = { ...state };
  for (let i = 0; i < NOISE_BUFFER_SAMPLES; i++) {
    mulberry32Next(s);
  }
  return s;
}

/** Initialize nextBellBeat — call after advanceRngPastNoiseBuffer */
export function initializeBell(state: EngineState): EngineState {
  const s = { ...state };
  s.nextBellBeat = Math.floor(mulberry32Next(s) * 8) + 8;
  return s;
}

export function getSceneName(state: EngineState): string {
  return SCENES[state.currentSceneIndex % SCENES.length].name;
}

/**
 * Returns the scene-interpolated BPM and mix for the given state and params.
 * Used by LiveEngine.tick() to wire scene BPM to the scheduler and scene mix
 * to setMix(), and by renderAmbient to animate mix during offline rendering.
 * Mirrors the interpolation inside updateSceneEngine() exactly.
 */
export function getEffectiveSceneParams(
  state: EngineState,
  params: EngineParams
): { bpm: number; mix: number } {
  if (!params.enableScenes) {
    return { bpm: params.bpm, mix: params.mix };
  }

  const sceneDurationBars = params.sceneDurationBars ?? 32;
  const barCount = Math.floor(state.beat / BEATS_PER_BAR);

  // Mirror scene transition check
  let sceneIndex = state.currentSceneIndex;
  let sceneStartBar = Math.floor(state.sceneStartBeat / BEATS_PER_BAR);
  const barsIntoScene = barCount - sceneStartBar;
  if (barsIntoScene >= sceneDurationBars) {
    sceneIndex = (sceneIndex + 1) % SCENES.length;
    sceneStartBar = barCount;
  }

  const currentScene = SCENES[sceneIndex];
  const nextScene = SCENES[(sceneIndex + 1) % SCENES.length];
  const progress = Math.min((barCount - sceneStartBar) / sceneDurationBars, 1.0);
  const t = progress < 0.5
    ? 2 * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 2) / 2;

  return {
    bpm: currentScene.bpm + (nextScene.bpm - currentScene.bpm) * t,
    mix: currentScene.mix + (nextScene.mix - currentScene.mix) * t,
  };
}

// ── Determinism test ──────────────────────────────────────────────────────────

(function testDeterminism() {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return;

  const testParams: EngineParams = {
    scale: 'majorPent', rootHz: 220, bpm: 72, complexity: 0.35,
    mix: 0.4, seed: 42, enableScenes: true, enableHarmonicLoop: true,
    sceneDurationBars: 32, drumLevel: 0.5,
  };

  function runOnce(): MusicalEvent[] {
    let state = createInitialState(testParams);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const all: MusicalEvent[] = [];
    for (let i = 0; i < 64; i++) {
      const { events, nextState } = getMusicalEvents(i, { ...state }, testParams);
      all.push(...events);
      state = nextState;
    }
    return all;
  }

  const r1 = runOnce();
  const r2 = runOnce();
  let match = r1.length === r2.length;
  for (let i = 0; match && i < r1.length; i++) {
    const a = r1[i], b = r2[i];
    if (a.type !== b.type || a.hz !== b.hz || a.amp !== b.amp ||
        a.subBeatIndex !== b.subBeatIndex || a.isGhost !== b.isGhost || a.isClosed !== b.isClosed) {
      match = false;
    }
  }
  if (!match) console.error('[ambient-engine] DETERMINISM TEST FAILED');
})();
