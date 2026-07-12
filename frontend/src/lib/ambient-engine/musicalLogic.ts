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
 *
 * Fixes applied:
 *   ✅ FIX (default-enabled flags): enableScenes and enableHarmonicLoop are
 *       documented as default true, but the guards used truthy checks
 *       (`!params.enableScenes` / `!params.enableHarmonicLoop`) which
 *       evaluated to true when the field was omitted (undefined), disabling
 *       the behavior. Switched to explicit `=== false` checks so callers
 *       that omit these optional fields get the documented default-enabled
 *       behavior. Affected: updateSceneEngine(), updateHarmonicLoop(),
 *       getEffectiveSceneParams().
 *   ✅ FIX (beat-0 harmonic advance): updateHarmonicLoop() previously
 *       advanced harmonicLoopIndex on beat 0 because barCount=0 satisfies
 *       `barCount % 8 === 0 && beat % 4 === 0`. This skipped the initial
 *       root segment that createInitialState() set up (harmonicLoopIndex=0,
 *       targetRootHz=params.rootHz, typically A3=220Hz). Added a
 *       `state.beat > 0` guard so the loop only advances after the first
 *       beat cycle has begun — the first advance now fires at beat 32
 *       (bar 8) instead of beat 0. harmonicLoopIndex and targetRootHz
 *       update behavior is unchanged.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type TimbreMode = "sine" | "triangle" | "softsq" | "fm";

export type ScaleName =
  | "majorPent"
  | "minorPent"
  | "ionian"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "aeolian"
  | "locrian";

export type ScenePackName = "default";

export interface DroneLayerParams {
  hz: number;
  detuneCents?: number;
  amp: number;
  pan: number;
  timbre: TimbreMode;
  sweepSec?: number;
}

export interface DroneParams {
  layers: DroneLayerParams[];
}

export interface EngineParams {
  scale: ScaleName;
  rootHz: number;
  bpm: number;
  complexity: number; // 0..1
  mix: number; // 0..1 (delay level)
  scenePack?: ScenePackName; // default "default"
  sceneDurationBars?: number; // default 32
  enableScenes?: boolean; // default true
  enableHarmonicLoop?: boolean; // default true
  enableBeats?: boolean; // default true
  drone?: DroneParams;
  seed?: number;
  drumLevel?: number; // 0..1
}

export interface MusicalEvent {
  type:
    | "melody"
    | "pad"
    | "bass"
    | "bell"
    | "kick"
    | "snare"
    | "hihat"
    | "drone";
  hz?: number; // undefined for drums (kick/snare/hihat)
  amp: number;
  durationSec: number;
  pan: number; // -1 to 1 (for tonal); 0 for drums. Pad events use -1/+1 to signal left/right routing; bell routing is by type, not pan.
  timbre?: TimbreMode; // undefined for drums
  droneLayerIndex?: number;
  detuneCents?: number;
  sweepSec?: number;
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

export const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  majorPent: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

// ponytail: fixed 8-layer drone cap; raising it later means increasing the
// preallocated drone panner/gain/filter arrays in LiveEngine and renderAmbient.
export const MAX_DRONE_LAYERS = 8;

// CodeRabbit nitpick: DRONE_FADE_SEC was duplicated between LiveEngine and
// renderAmbient, allowing live and offline fade shapes to diverge silently.
// Single source of truth here, imported by both shells. The value (1.0s) is
// the fade duration used by both the attack (setTargetAtTime with time
// constant DRONE_FADE_SEC / 3) and the offline release ramp.
export const DRONE_FADE_SEC = 1.0;

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
  scale: ScaleName;
  bpm: number;
  mix: number;
  complexity: number;
  density: number;
  timbre: TimbreMode;
}

export const SCENE_PACKS: Record<ScenePackName, Scene[]> = {
  default: [
    {
      name: "Calm",
      scale: "majorPent",
      bpm: 72,
      mix: 0.4,
      complexity: 0.3,
      density: 0.8,
      timbre: "sine",
    },
    {
      name: "Nocturne",
      scale: "minorPent",
      bpm: 62,
      mix: 0.55,
      complexity: 0.45,
      density: 0.65,
      timbre: "triangle",
    },
    {
      name: "Ether",
      scale: "majorPent",
      bpm: 68,
      mix: 0.65,
      complexity: 0.55,
      density: 0.55,
      timbre: "fm",
    },
  ],
};

export const SCENES: Scene[] = SCENE_PACKS.default;

export function getScenePackScenes(
  params?: Pick<EngineParams, "scenePack">,
): Scene[] {
  // A5: defensive fallback. ScenePackName is currently typed as the literal
  // "default" only, so an unknown name is only reachable via `as any` cast
  // (e.g. a future MCP caller passing a string the type system didn't catch).
  // Without this fallback, SCENE_PACKS[unknownKey] returns undefined and the
  // next access (scenes[0].density) throws. Fall back to the default pack
  // rather than crashing — callers that genuinely need a different pack will
  // notice the wrong scenes immediately, which is better than a TypeError.
  return SCENE_PACKS[params?.scenePack ?? "default"] ?? SCENE_PACKS.default;
}

// ── Seeded PRNG: mulberry32 ───────────────────────────────────────────────────

export function mulberry32Next(state: { rngState: number }): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A2: Single source of truth for scene progress. Both updateSceneEngine() and
 * getEffectiveSceneParams() call this so they cannot drift apart on the
 * `Math.floor(sceneStartBeat / BEATS_PER_BAR)` step. Returns clamped progress
 * in [0, 1]; callers that need to detect the transition boundary compare
 * the unclamped value (computed as barCount - sceneStartBar >= sceneDurationBars)
 * separately — see both call sites.
 */
function computeSceneProgress(
  barCount: number,
  sceneStartBeat: number,
  sceneDurationBars: number,
): number {
  const sceneStartBar = Math.floor(sceneStartBeat / BEATS_PER_BAR);
  return Math.min((barCount - sceneStartBar) / sceneDurationBars, 1.0);
}

function currentScale(scale: ScaleName): number[] {
  return SCALE_INTERVALS[scale];
}

function noteHz(
  degree: number,
  octaveShift: number,
  rootHz: number,
  scale: ScaleName,
): number {
  const intervals = currentScale(scale);
  const semi =
    intervals[
      ((degree % intervals.length) + intervals.length) % intervals.length
    ] +
    12 * octaveShift;
  return rootHz * Math.pow(2, semi / 12);
}

function wrapDegree(degree: number, scaleLength: number): number {
  return ((degree % scaleLength) + scaleLength) % scaleLength;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function droneEvents(
  params: EngineParams,
  beat: number,
  beatSec: number,
): MusicalEvent[] {
  const layers = params.drone?.layers ?? [];
  return layers.slice(0, MAX_DRONE_LAYERS).flatMap((layer, index) => {
    if (
      !Number.isFinite(layer.hz) ||
      layer.hz <= 0 ||
      !Number.isFinite(layer.amp) ||
      layer.amp <= 0
    ) {
      return [];
    }

    const detuneCents = layer.detuneCents;
    const sweepSec = layer.sweepSec;
    return [
      {
        type: "drone" as const,
        hz: layer.hz,
        amp: clamp(layer.amp, 0, 1),
        durationSec: beatSec,
        pan: Number.isFinite(layer.pan) ? clamp(layer.pan, -1, 1) : 0,
        timbre: layer.timbre,
        droneLayerIndex: index,
        detuneCents:
          detuneCents !== undefined && Number.isFinite(detuneCents)
            ? detuneCents
            : undefined,
        sweepSec:
          sweepSec !== undefined && Number.isFinite(sweepSec) && sweepSec > 0
            ? sweepSec
            : undefined,
        beatIndex: beat,
        subBeatIndex: 0,
      },
    ];
  });
}

function euclideanRhythm(step: number, pulses: number, steps: number): boolean {
  return (step * pulses) % steps < pulses;
}

function markovStep(
  lastInterval: number,
  complexity: number,
  rng: () => number,
): number {
  const intervals = [-2, -1, 0, 1, 2];
  const baseWeights = [
    [0.1, 0.25, 0.4, 0.2, 0.05],
    [0.05, 0.25, 0.45, 0.2, 0.05],
    [0.1, 0.2, 0.4, 0.2, 0.1],
    [0.05, 0.2, 0.45, 0.25, 0.05],
    [0.05, 0.2, 0.4, 0.25, 0.1],
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
  params: EngineParams,
): { params: EngineParams; state: Partial<EngineState> } {
  // ✅ FIX (default-enabled flags): enableScenes defaults to true. Use
  // explicit `=== false` so callers that omit the field get the documented
  // default-enabled behavior. Previously `!params.enableScenes` was true
  // when the field was undefined, disabling scenes silently.
  if (params.enableScenes === false) return { params, state: {} };

  const barCount = Math.floor(state.beat / BEATS_PER_BAR);
  const sceneDurationBars = params.sceneDurationBars ?? 32;
  const scenes = getScenePackScenes(params);

  let newSceneIndex = state.currentSceneIndex % scenes.length;
  let newSceneStartBeat = state.sceneStartBeat;

  // A2: use computeSceneProgress for the transition boundary check so the
  // floor-of-sceneStartBeat lives in one place. The check compares the
  // unclamped bar count delta against sceneDurationBars; the helper clamps
  // to [0,1] which we don't want here (we need to detect >= 1.0 exactly).
  const sceneStartBar = Math.floor(state.sceneStartBeat / BEATS_PER_BAR);
  if (barCount - sceneStartBar >= sceneDurationBars) {
    newSceneIndex = (newSceneIndex + 1) % scenes.length;
    newSceneStartBeat = state.beat;
  }

  const currentScene = scenes[newSceneIndex];
  const nextScene = scenes[(newSceneIndex + 1) % scenes.length];
  const progress = computeSceneProgress(
    barCount,
    newSceneStartBeat,
    sceneDurationBars,
  );
  const t =
    progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;

  const newParams = { ...params };
  newParams.bpm = currentScene.bpm + (nextScene.bpm - currentScene.bpm) * t;
  newParams.mix = currentScene.mix + (nextScene.mix - currentScene.mix) * t;
  newParams.complexity =
    currentScene.complexity +
    (nextScene.complexity - currentScene.complexity) * t;
  const newDensity =
    currentScene.density + (nextScene.density - currentScene.density) * t;
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
 *
 * ✅ FIX (default-enabled flags): enableHarmonicLoop defaults to true. Use
 * explicit `=== false` so callers that omit the field get the documented
 * default-enabled behavior.
 *
 * ✅ FIX (beat-0 harmonic advance): Added `state.beat > 0` to the boundary
 * condition. Previously beat 0 satisfied `barCount % 8 === 0 && beat % 4 === 0`
 * (since 0 % 8 === 0 and 0 % 4 === 0), causing the loop to advance from
 * harmonicLoopIndex 0 → 1 on the very first beat. This skipped the initial
 * root segment that createInitialState() set up (harmonicLoopIndex=0,
 * targetRootHz=params.rootHz, typically A3=220Hz). With the guard, the
 * first advance fires at beat 32 (bar 8) instead, giving the initial root
 * a full 8-bar cycle before the first change. harmonicLoopIndex and
 * targetRootHz update behavior is unchanged.
 */
function updateHarmonicLoop(
  state: EngineState,
  params: EngineParams,
): Partial<EngineState> {
  // ✅ FIX (default-enabled flags): enableHarmonicLoop defaults to true.
  if (params.enableHarmonicLoop === false) {
    return {
      targetRootHz: params.rootHz,
      currentRootHz: params.rootHz,
    };
  }

  const barCount = Math.floor(state.beat / BEATS_PER_BAR);

  // ✅ FIX (beat-0 harmonic advance): `state.beat > 0` prevents the first
  // beat from advancing the loop. The boundary check still fires every 8
  // bars (beat 32, 64, 96, ...), preserving the original cadence after
  // the initial cycle.
  if (
    state.beat > 0 &&
    barCount % 8 === 0 &&
    state.beat % BEATS_PER_BAR === 0
  ) {
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
  params: EngineParams,
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
  const scaleLength = currentScale(currentScaleName).length;
  const currentTimbre = s.currentTimbre;
  const currentDensity = s.currentDensity;
  const drumLevel = effectiveParams.drumLevel ?? 0.5;

  if (effectiveParams.enableBeats === false) {
    events.push(...droneEvents(effectiveParams, beat, beatSec));
    // A1: advance the drum-grid phase even when no drum events are emitted,
    // so a future toggle of enableBeats from false → true mid-stream resumes
    // the euclidean kick/snare/hat patterns from the correct phase instead
    // of a stale one. The normal path advances sixteenthCount by 4 below.
    s.sixteenthCount += 4;
    s.beat++;
    return { events, nextState: s };
  }

  // 4. Drums — FIX C1: set subBeatIndex (0–3) on each drum event
  for (let i = 0; i < 4; i++) {
    const sixteenthStep = s.sixteenthCount + i;

    if (drumLevel > 0 && euclideanRhythm(sixteenthStep % 16, 5, 16)) {
      events.push({
        type: "kick",
        amp: DRUM_KICK_AMP * drumLevel,
        durationSec: 0.3,
        pan: 0,
        beatIndex: beat,
        subBeatIndex: i, // FIX C1
      });
    }

    if (drumLevel > 0) {
      const beatStep = sixteenthStep % 16;
      if (beatStep === 4 || beatStep === 12) {
        events.push({
          type: "snare",
          amp: DRUM_SNARE_AMP * drumLevel,
          durationSec: 0.12,
          pan: 0,
          beatIndex: beat,
          subBeatIndex: i, // FIX C1
          isGhost: false,
        });
      } else if (
        euclideanRhythm(sixteenthStep % 16, 2, 16) &&
        rng() < DRUM_GHOST_PROBABILITY
      ) {
        events.push({
          type: "snare",
          amp: DRUM_SNARE_AMP * 0.3 * drumLevel,
          durationSec: 0.06,
          pan: 0,
          beatIndex: beat,
          subBeatIndex: i, // FIX C1
          isGhost: true,
        });
      }
    }

    if (drumLevel > 0 && euclideanRhythm(sixteenthStep % 16, 9, 16)) {
      const isClosed = rng() < DRUM_HAT_CLOSED_PROB;
      events.push({
        type: "hihat",
        amp: (isClosed ? DRUM_HAT_AMP : DRUM_HAT_AMP * 0.7) * drumLevel,
        durationSec: isClosed ? 0.03 : 0.08,
        pan: 0,
        beatIndex: beat,
        subBeatIndex: i, // FIX C1
        isClosed,
      });
    }
  }
  s.sixteenthCount += 4;

  // 5. Section offsets
  // ponytail: these section offsets are still fixed pentatonic-era magic
  // degree moves; upgrading this later means mapping harmonic functions per
  // scale/mode instead of scaling numeric offsets by scale length.
  const sectionOffsets = [0, -3, -1, 2];
  const barIndex = Math.floor(s.beat / BEATS_PER_BAR);
  const sectionOffset = sectionOffsets[barIndex % sectionOffsets.length];

  // 6. Cadence / Markov
  const isCadence = s.beat % CADENCE_INTERVAL === CADENCE_INTERVAL - 1;
  if (isCadence) {
    // ponytail: cadence keeps the old 0-or-2 degree landing; upgrading this
    // needs per-mode cadence targets rather than a raw degree number.
    s.degree = rng() < 0.6 ? 0 : 2;
    s.lastInterval = 0;
  } else {
    const interval = markovStep(
      s.lastInterval,
      effectiveParams.complexity,
      rng,
    );
    s.lastInterval = interval;
    s.degree = wrapDegree(s.degree + interval, scaleLength);
  }

  // 7. Melody
  if (rng() < currentDensity) {
    const isPhraseEnd = s.beat % PHRASE_LENGTH === PHRASE_LENGTH - 1;
    const octaveShift = isPhraseEnd && rng() < 0.3 ? 2 : 1;
    const fMel = noteHz(s.degree, octaveShift, currentRootHz, currentScaleName);
    events.push({
      type: "melody",
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
  const padDegree = wrapDegree(s.degree + 2 + sectionOffset, scaleLength);
  const fPad = noteHz(padDegree, 2, currentRootHz, currentScaleName);
  events.push({
    type: "pad",
    hz: fPad * 0.995,
    amp: 0.12,
    durationSec: beatSec * 1.0,
    pan: -1, // signals "left pad" → use padPanL node and ADSR_PAD_L
    timbre: currentTimbre,
    beatIndex: beat,
    subBeatIndex: 0,
  });
  events.push({
    type: "pad",
    hz: fPad * 1.005,
    amp: 0.12,
    durationSec: beatSec * 1.0,
    pan: 1, // signals "right pad" → use padPanR node and ADSR_PAD_R
    timbre: currentTimbre,
    beatIndex: beat,
    subBeatIndex: 0,
  });

  // 9. Bass
  const beatInBar = s.beat % BAR_LENGTH;
  if (euclideanRhythm(beatInBar, BASS_HITS, BAR_LENGTH)) {
    const bassDegree = wrapDegree(s.degree + sectionOffset, scaleLength);
    const fBass = noteHz(bassDegree, -1, currentRootHz, currentScaleName) / 2;
    events.push({
      type: "bass",
      hz: fBass,
      amp: 0.18,
      durationSec: beatSec * 0.7,
      pan: 0,
      timbre: "sine",
      beatIndex: beat,
      subBeatIndex: 0,
    });
  }

  // 10. Bell
  if (s.beat >= s.nextBellBeat) {
    const bellOctave = 2 + Math.floor(rng() * 2);
    const bellDegree = Math.floor(rng() * scaleLength);
    const fBell = noteHz(
      bellDegree,
      bellOctave,
      currentRootHz,
      currentScaleName,
    );
    events.push({
      type: "bell",
      hz: fBell,
      amp: 0.15,
      durationSec: beatSec * 0.3,
      pan: 0, // A3: bell routing is by type === "bell" in both shells; pan is unused for bells (bellPan node receives its own drift automation)
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
  const scenes = getScenePackScenes(params);
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
    currentDensity: scenes[0].density,
    currentTimbre: scenes[0].timbre,
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

export function getSceneName(
  state: EngineState,
  params?: Pick<EngineParams, "scenePack">,
): string {
  const scenes = getScenePackScenes(params);
  return scenes[state.currentSceneIndex % scenes.length].name;
}

/**
 * Returns the scene-interpolated BPM and mix for the given state and params.
 * Used by LiveEngine.tick() to wire scene BPM to the scheduler and scene mix
 * to setMix(), and by renderAmbient to animate mix during offline rendering.
 * Mirrors the interpolation inside updateSceneEngine() exactly.
 *
 * ✅ FIX (default-enabled flags): enableScenes defaults to true. Use
 * explicit `=== false` so callers that omit the field get the documented
 * default-enabled behavior.
 *
 * A4: No enableBeats guard here, deliberately. When enableBeats === false
 * the engine still emits drone events whose scheduling (beatSec = 60/bpm)
 * and audio routing (through the delay/feedback mix chain) depend on the
 * scene-interpolated bpm and mix. So scene BPM/mix must continue to animate
 * even in drone-only mode. enableScenes gates this function because when
 * scenes are disabled there is no interpolation to perform; enableBeats
 * gates event emission, not parameter animation.
 */
export function getEffectiveSceneParams(
  state: EngineState,
  params: EngineParams,
): {
  bpm: number;
  mix: number;
  scale: ScaleName;
  complexity: number;
} {
  // ✅ FIX (default-enabled flags): enableScenes defaults to true.
  if (params.enableScenes === false) {
    return {
      bpm: params.bpm,
      mix: params.mix,
      scale: params.scale,
      complexity: params.complexity,
    };
  }

  const sceneDurationBars = params.sceneDurationBars ?? 32;
  const scenes = getScenePackScenes(params);
  const barCount = Math.floor(state.beat / BEATS_PER_BAR);

  // A2: mirror updateSceneEngine's transition check exactly, using the same
  // floor-of-sceneStartBeat step. After a transition, sceneStartBeat becomes
  // barCount * BEATS_PER_BAR so progress recomputes to 0.
  let sceneIndex = state.currentSceneIndex % scenes.length;
  let sceneStartBar = Math.floor(state.sceneStartBeat / BEATS_PER_BAR);
  if (barCount - sceneStartBar >= sceneDurationBars) {
    sceneIndex = (sceneIndex + 1) % scenes.length;
    sceneStartBar = barCount;
  }

  const currentScene = scenes[sceneIndex];
  const nextScene = scenes[(sceneIndex + 1) % scenes.length];
  const progress = computeSceneProgress(
    barCount,
    sceneStartBar * BEATS_PER_BAR,
    sceneDurationBars,
  );
  const t =
    progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;

  // B2: surface scale and complexity so LiveEngine.tick() can write them
  // back into this.params for UI display. density and timbre are already on
  // EngineState (currentDensity/currentTimbre) and don't need to round-trip
  // through params.
  return {
    bpm: currentScene.bpm + (nextScene.bpm - currentScene.bpm) * t,
    mix: currentScene.mix + (nextScene.mix - currentScene.mix) * t,
    scale: progress < 0.5 ? currentScene.scale : nextScene.scale,
    complexity:
      currentScene.complexity +
      (nextScene.complexity - currentScene.complexity) * t,
  };
}

// ── Determinism test ──────────────────────────────────────────────────────────

(function testDeterminism() {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production")
    return;

  const testParams: EngineParams = {
    scale: "majorPent",
    rootHz: 220,
    bpm: 72,
    complexity: 0.35,
    mix: 0.4,
    seed: 42,
    enableScenes: true,
    enableHarmonicLoop: true,
    sceneDurationBars: 32,
    drumLevel: 0.5,
  };

  function runOnce(): MusicalEvent[] {
    let state = createInitialState(testParams);
    state = advanceRngPastNoiseBuffer(state);
    state = initializeBell(state);
    const all: MusicalEvent[] = [];
    for (let i = 0; i < 64; i++) {
      const { events, nextState } = getMusicalEvents(
        i,
        { ...state },
        testParams,
      );
      all.push(...events);
      state = nextState;
    }
    return all;
  }

  const r1 = runOnce();
  const r2 = runOnce();
  let match = r1.length === r2.length;
  for (let i = 0; match && i < r1.length; i++) {
    const a = r1[i],
      b = r2[i];
    if (
      a.type !== b.type ||
      a.hz !== b.hz ||
      a.amp !== b.amp ||
      a.subBeatIndex !== b.subBeatIndex ||
      a.isGhost !== b.isGhost ||
      a.isClosed !== b.isClosed ||
      a.durationSec !== b.durationSec ||
      a.pan !== b.pan ||
      a.timbre !== b.timbre ||
      a.beatIndex !== b.beatIndex
    ) {
      match = false;
    }
  }
  if (!match) console.error("[ambient-engine] DETERMINISM TEST FAILED");
})();

(function testNewMusicalLogic() {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production")
    return;

  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`[ambient-engine] ${message}`);
  };

  // SonarCloud: previously duplicated SCALE_INTERVALS here as `expectedModes`,
  // which meant any change to the source would have to be made in two places.
  // Reference the exported constant directly instead — the test now catches
  // accidental edits to SCALE_INTERVALS by checking each entry against
  // currentScale()'s lookup, without restating the values.
  for (const name of Object.keys(SCALE_INTERVALS) as ScaleName[]) {
    const intervals = SCALE_INTERVALS[name];
    assert(
      currentScale(name).join(",") === intervals.join(","),
      `scale interval check failed for ${name}`,
    );
    // Sanity: the lookup must return the same array reference (no copy).
    assert(
      currentScale(name) === intervals,
      `currentScale(${name}) did not return the canonical SCALE_INTERVALS entry`,
    );
  }

  const beatlessParams: EngineParams = {
    scale: "ionian",
    rootHz: 220,
    bpm: 60,
    complexity: 1,
    mix: 0.4,
    seed: 7,
    enableScenes: false,
    enableHarmonicLoop: false,
    enableBeats: false,
    drone: {
      layers: [
        { hz: 432, amp: 0.2, pan: -0.5, timbre: "sine" },
        { hz: 528, amp: 0.2, pan: 0, timbre: "triangle" },
        { hz: 741, amp: 0.2, pan: 0.5, timbre: "fm" },
      ],
    },
  };
  const startState = createInitialState(beatlessParams);
  const { events, nextState } = getMusicalEvents(
    0,
    { ...startState },
    beatlessParams,
  );
  assert(events.length === 3, "drone layer count check failed");
  assert(
    events.every((event) => event.type === "drone"),
    "beatless mode emitted non-drone events",
  );
  assert(
    events.map((event) => event.hz).join(",") === "432,528,741",
    "drone frequency assignment check failed",
  );
  // A1: beatless mode must NOT advance degree (no melodic decisions) but MUST
  // advance sixteenthCount by 4 so a future enableBeats=true toggle resumes
  // the drum grid from the correct phase.
  assert(
    nextState.degree === startState.degree,
    "beatless mode advanced melodic degree",
  );
  assert(
    nextState.sixteenthCount === startState.sixteenthCount + 4,
    "beatless mode did not advance sixteenthCount by 4 per beat",
  );

  // A1 (continued): run multiple beatless beats, confirm sixteenthCount
  // advances by 4 per beat exactly as the normal path would.
  {
    let s = createInitialState(beatlessParams);
    const initial = s.sixteenthCount;
    for (let i = 0; i < 5; i++) {
      const { nextState: ns } = getMusicalEvents(i, { ...s }, beatlessParams);
      s = ns;
      assert(
        s.sixteenthCount === initial + 4 * (i + 1),
        `beatless sixteenthCount drift on beat ${i + 1}`,
      );
    }
  }

  // A5: drone layer count > MAX_DRONE_LAYERS clamps silently.
  {
    const overParams: EngineParams = {
      ...beatlessParams,
      drone: {
        layers: Array.from({ length: MAX_DRONE_LAYERS + 5 }, (_, k) => ({
          hz: 100 + k,
          amp: 0.1,
          pan: 0,
          timbre: "sine" as TimbreMode,
        })),
      },
    };
    const overState = createInitialState(overParams);
    const { events: overEvents } = getMusicalEvents(
      0,
      { ...overState },
      overParams,
    );
    assert(
      overEvents.length === MAX_DRONE_LAYERS,
      "drone layer overflow did not clamp to MAX_DRONE_LAYERS",
    );
    assert(
      overEvents.every((e) => (e.droneLayerIndex ?? 0) < MAX_DRONE_LAYERS),
      "drone layer index exceeded MAX_DRONE_LAYERS after clamp",
    );
  }

  // A5: invalid drone params (NaN hz, negative amp, NaN pan) are filtered
  // out via the Number.isFinite guards in droneEvents().
  {
    const invalidParams: EngineParams = {
      ...beatlessParams,
      drone: {
        layers: [
          { hz: Number.NaN, amp: 0.2, pan: 0, timbre: "sine" }, // NaN hz → filtered
          { hz: 432, amp: -0.1, pan: 0, timbre: "sine" }, // negative amp → filtered
          { hz: 528, amp: 0.2, pan: Number.NaN, timbre: "sine" }, // NaN pan → pan falls back to 0, layer NOT filtered
          { hz: 0, amp: 0.2, pan: 0, timbre: "sine" }, // hz=0 → filtered (layer.hz <= 0)
          { hz: 741, amp: 0.2, pan: 0.5, timbre: "fm" }, // valid
        ],
      },
    };
    const invalidState = createInitialState(invalidParams);
    const { events: invalidEvents } = getMusicalEvents(
      0,
      { ...invalidState },
      invalidParams,
    );
    assert(
      invalidEvents.length === 2,
      `invalid-drone filter expected 2 surviving layers, got ${invalidEvents.length}`,
    );
    assert(
      invalidEvents.map((e) => e.hz).join(",") === "528,741",
      "invalid-drone filter let wrong layers through",
    );
    const survivorWithNaNPan = invalidEvents.find((e) => e.hz === 528);
    assert(
      survivorWithNaNPan?.pan === 0,
      "NaN pan did not fall back to 0 on a surviving layer",
    );
  }

  // A5: beatless-mode determinism — run twice with the same seed, compare.
  // Mirrors testDeterminism() but exercises the enableBeats=false path,
  // which that test does not cover.
  {
    function runBeatlessOnce(): MusicalEvent[] {
      let s = createInitialState(beatlessParams);
      s = advanceRngPastNoiseBuffer(s);
      s = initializeBell(s);
      const all: MusicalEvent[] = [];
      for (let i = 0; i < 16; i++) {
        const { events: ev, nextState: ns } = getMusicalEvents(
          i,
          { ...s },
          beatlessParams,
        );
        all.push(...ev);
        s = ns;
      }
      return all;
    }
    const b1 = runBeatlessOnce();
    const b2 = runBeatlessOnce();
    let beatlessMatch = b1.length === b2.length;
    for (let i = 0; beatlessMatch && i < b1.length; i++) {
      const a = b1[i],
        b = b2[i];
      if (
        a.type !== b.type ||
        a.hz !== b.hz ||
        a.amp !== b.amp ||
        a.pan !== b.pan ||
        a.beatIndex !== b.beatIndex
      ) {
        beatlessMatch = false;
      }
    }
    assert(beatlessMatch, "beatless mode is not deterministic across runs");
  }

  // A5: scene pack lookup. ScenePackName is currently the literal "default"
  // only, so unknown packs are only reachable via `as any` cast — confirm
  // the fallback in getScenePackScenes() returns the default pack rather
  // than crashing.
  {
    const defaultScenes = getScenePackScenes({ scenePack: "default" });
    assert(
      defaultScenes === SCENE_PACKS.default,
      'getScenePackScenes({ scenePack: "default" }) did not return default pack',
    );
    const omittedScenes = getScenePackScenes({});
    assert(
      omittedScenes === SCENE_PACKS.default,
      "getScenePackScenes({}) did not fall back to default pack",
    );
    // `as any` cast simulates a future MCP caller passing an unrecognized
    // pack name that the type system hasn't been widened to accept yet.
    const unknownScenes = getScenePackScenes({
      scenePack: "nonexistent" as any,
    });
    assert(
      unknownScenes === SCENE_PACKS.default,
      "getScenePackScenes() did not fall back to default for unknown pack name",
    );
  }

  // A2: confirm updateSceneEngine() and getEffectiveSceneParams() agree on
  // bpm/mix even when sceneStartBeat is a non-multiple of BEATS_PER_BAR
  // (the case that used to silently diverge before the shared helper).
  {
    const a2Params: EngineParams = {
      scale: "ionian",
      rootHz: 220,
      bpm: 72,
      complexity: 0.35,
      mix: 0.4,
      seed: 11,
      enableScenes: true,
      enableHarmonicLoop: false,
      sceneDurationBars: 8,
    };
    const a2State: EngineState = {
      beat: 13, // bar 3, beat 1 — non-bar-aligned
      degree: 0,
      lastInterval: 0,
      currentSceneIndex: 0,
      sceneStartBeat: 5, // ← deliberately NOT a multiple of BEATS_PER_BAR
      harmonicLoopIndex: 0,
      currentRootHz: 220,
      targetRootHz: 220,
      rngState: 999,
      panDriftPhase: 0,
      sixteenthCount: 52,
      nextBellBeat: 100,
      currentDensity: 0.7,
      currentTimbre: "sine",
    };
    const sceneResult = updateSceneEngine(a2State, a2Params);
    const effResult = getEffectiveSceneParams(a2State, a2Params);
    assert(
      Math.abs(sceneResult.params.bpm - effResult.bpm) < 1e-9,
      `A2: bpm diverges (updateSceneEngine=${sceneResult.params.bpm}, getEffectiveSceneParams=${effResult.bpm})`,
    );
    assert(
      Math.abs(sceneResult.params.mix - effResult.mix) < 1e-9,
      `A2: mix diverges (updateSceneEngine=${sceneResult.params.mix}, getEffectiveSceneParams=${effResult.mix})`,
    );
    // Also confirm scale and complexity now round-trip (B2 extension).
    assert(
      sceneResult.params.scale === effResult.scale,
      "A2/B2: scale diverges between updateSceneEngine and getEffectiveSceneParams",
    );
    assert(
      Math.abs(sceneResult.params.complexity - effResult.complexity) < 1e-9,
      "A2/B2: complexity diverges between updateSceneEngine and getEffectiveSceneParams",
    );
  }
})();
