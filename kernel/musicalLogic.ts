/**
 * musicalLogic.ts — Pure musical decision engine for ambient music generation.
 * ZERO Web Audio API dependencies. Importable in Node.js with no polyfills.
 * All randomness flows through mulberry32 seeded PRNG — fully deterministic.
 *
 * Architecture: getMusicalEvents(beat, state, params) → { events, nextState }
 * This function is the single source of truth for every musical decision.
 * Both LiveEngine (real-time) and renderAmbient (offline) call this function.
 *
 * RNG ORDER (must match original engine.ts constructor + tick() exactly):
 * - createInitialState() sets rngState = seed
 * - advanceRngPastNoiseBuffer() consumes ~22,050 calls (matching createNoiseBuffer)
 * - initializeBell() consumes 1 call (nextBellBeat)
 * - initializeSampleLane() consumes 1 call only when sampleBank contains an
 *   entry that passes playableSampleEntries() validation
 * - getMusicalEvents() per-beat calls follow, lane by lane in code order.
 *   Per-lane draw schedules (draw-then-decide: a value is consumed, then
 *   branched on):
 *     drums     — conditional probes on their euclidean hits only: ghost-snare
 *                 gate, then closed-hat gate
 *     cadence   — 1 draw on cadence beats, else 1 Markov draw (1 per beat)
 *     melody    — 1 gate draw per beat, +1 only on phrase-end octave lifts
 *                 Melody V2 reuses this exact schedule (the cadence draw is
 *                 the landing, the Markov draw is the weighted ladder move),
 *                 so V2 adds no draws
 *     bell      — 3 draws when due (octave, degree, next due beat)
 *     samples   — 2–3 draws when its gate is open (trigger, pick, next gap)
 *
 * NEO-HARMONY (Phase 2, enableNeoHarmony): with the flag OFF or absent,
 * updateHarmony() returns before any rng() call and the stream is bit-exact
 * with pre-Phase-2 builds (guarded by the backward-compat literals in
 * space.test.ts / harmony.test.ts). With the flag ON, exactly ONE extra draw
 * fires per harmonic boundary (beat > 0 and
 * beat % (HARMONIC_CYCLE_BARS * BEATS_PER_BAR) === 0 — every 8 bars), taken
 * before the drum lanes; the per-call draw count depends only on the beat
 * index and fixed constants. Static-root exception: with
 * enableHarmonicLoop === false the chord stays on its tonic triad and the
 * harmony lane draws NOTHING (the pin guard returns before rng()), so a
 * loop-off + neo-on run has the same draw schedule as neo-off — pinned by an
 * rngState-equality check in harmony.test.ts.
 *
 * HARMONIC SLEW: This module only tracks targetRootHz changes.
 * The 600ms linear slew is handled by the synthesis shells (LiveEngine,
 * renderAmbient) which have access to real or offline AudioContext time.
 *
 * Fixes applied:
 *   ✅ FIX (default-enabled flags): enableScenes and enableHarmonicLoop are
 *     documented as default true, but the guards used truthy checks
 *     (`!params.enableScenes` / `!params.enableHarmonicLoop`) which
 *     evaluated to true when the field was omitted (undefined), disabling
 *     the behavior. Switched to explicit `=== false` checks so callers
 *     that omit these optional fields get the documented default-enabled
 *     behavior. Affected: updateSceneEngine(), updateHarmonicLoop(),
 *     getEffectiveSceneParams().
 *   ✅ FIX (beat-0 harmonic advance): updateHarmonicLoop() previously
 *     advanced harmonicLoopIndex on beat 0 because barCount=0 satisfies
 *     `barCount % 8 === 0 && beat % 4 === 0`. This skipped the initial
 *     root segment that createInitialState() set up (harmonicLoopIndex=0,
 *     targetRootHz=params.rootHz, typically A3=220Hz). Added a
 *     `state.beat > 0` guard so the loop only advances after the first
 *     beat cycle has begun — the first advance now fires at beat 32
 *     (bar 8) instead of beat 0. harmonicLoopIndex and targetRootHz
 *     update behavior is unchanged.
 *
 * Layered additions (swing / drumStyle / sidechain / beatless drone latch):
 *   ✅ ADD (DrumStyle): New `DrumStyle` named type — `"euclideanTrap" |
 *     "fourFloor"`. Surfaced as a public type export so callers (and
 *     index.ts) can name it without re-declaring the literal union.
 *   ✅ ADD (EngineParams swing / drumStyle / sidechainAmount): Three new
 *     optional fields. `swing` (0..0.6) and `sidechainAmount` (0..1) are
 *     pure values — they are NOT consumed inside this module. The
 *     synthesis shells (LiveEngine, renderAmbient) read them and apply
 *     them at the `subBeatIndex → eventTime` conversion (swing) and on
 *     the tonal-bus gain (sidechain). Keeping them on EngineParams means
 *     a single object describes the musical request end-to-end.
 *   ✅ ADD (EngineState.droneLayersStarted): New boolean latch. In beatless
 *     mode (`enableBeats === false`) the engine now emits drone events
 *     exactly once per layer (on the first beatless beat) and then
 *     latches. The synthesis shells reset this flag on `start()` (live)
 *     and on the `startState` clone (offline) so a stopped/restarted
 *     beatless playback re-fires the drone oscillators. In beat-enabled
 *     mode the flag is unused — drones are re-emitted every beat there
 *     so the shells can re-trigger amp/pan/filter automation.
 *   ✅ ADD (fourFloor kicks): `drumStyle === "fourFloor"` fires a kick on
 *     every quarter note (subBeatIndex 0 of each beat). The original
 *     `euclideanTrap` behavior (5/16 euclidean pattern) is preserved as
 *     the default when `drumStyle` is omitted.
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

// ✅ ADD (DrumStyle): Named type so callers (and index.ts) can name the
// literal union without re-declaring it. Defaults to "euclideanTrap" when
// omitted — see getMusicalEvents().
export type DrumStyle = "euclideanTrap" | "fourFloor";

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

export interface SampleBankEntry {
  id: string;
  url: string;
  gain?: number;
  pan?: number;
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
  sampleBank?: SampleBankEntry[];
  // ✅ ADD: swing amount 0..0.6 — applied by synthesis shells at the
  // subBeatIndex → eventTime conversion. NOT consumed inside this module.
  swing?: number;
  // ✅ ADD: drum style. Default "euclideanTrap" preserves the original
  // 5/16 euclidean kick pattern. "fourFloor" fires a kick on every quarter
  // note. Read inside getMusicalEvents() to choose the kick pattern.
  drumStyle?: DrumStyle;
  // ✅ ADD: sidechain depth 0..1 — applied by synthesis shells as a tonal-
  // bus gain duck on every kick. NOT consumed inside this module.
  sidechainAmount?: number;
  // Reverb wet level 0..1 — applied by the synthesis
  // shells as a 4-comb + 2-allpass reverb on the tonal bus (wet return into
  // the master out) plus a looped noise bed at the master out. NOT consumed
  // inside this module (zero RNG draws — guarded by space.test.ts). Default
  // 0: shells never construct any reverb/bed node, so the render path is
  // sample-identical to pre-Space builds. See kernel/space.ts.
  reverbLevel?: number;
  // When true, a Z12 chord state walks the
  // Neo-Riemannian P/L/R transforms (plus "stay") with exactly ONE uniform
  // draw per HARMONIC_CYCLE_BARS boundary, and the pad/bass become
  // chord-voiced; the chord + declared colour pool replaces the selected
  // scale as the pitch pool for those lanes. Melody/bell stay scale-based
  // (Phase 3 rewrites them). Default off: absent or false returns before any
  // new code or rng() call, so legacy seeds replay bit-identically. See
  // kernel/harmony.test.ts for the transform oracle and stream guards.
  enableNeoHarmony?: boolean;
  // When true, the melody lane walks a ladder of pool
  // pitches stepwise — the chord triad plus its declared colour tones under
  // Neo-Harmony (weights MELODY_W_CHORD / MELODY_W_COLOUR), the selected
  // scale otherwise (weight 1) — with cadence landings on the root/fifth and
  // phrase pull toward them on the approach to a phrase end. The draw
  // schedule is unchanged: the cadence draw becomes the landing choice and
  // the Markov draw becomes the weighted ladder move; V2 adds no random
  // draws and the final rngState equals V2 off. Default off: absent or false
  // runs the legacy lane bit-identically (guarded by the backward-compat
  // literals). See kernel/melody.test.ts.
  enableMelodyV2?: boolean;
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
    | "drone"
    | "sample";
  hz?: number; // undefined for drums (kick/snare/hihat)
  amp: number;
  durationSec: number;
  pan: number; // -1 to 1 (for tonal); 0 for drums. Pad events use -1/+1 to signal left/right routing; bell routing is by type, not pan.
  timbre?: TimbreMode; // undefined for drums
  droneLayerIndex?: number;
  detuneCents?: number;
  sweepSec?: number;
  sampleId?: string;
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

export type ChordQuality = "major" | "minor";

/**
 * A Z12 triad: root pitch class (0..11, relative to params.rootHz) plus
 * quality. The full pitch-class set derives via triadPitchClasses(); only the
 * (rootPc, quality) pair is stored so chord identity comparison (the
 * refractory rule) stays exact.
 */
export interface ChordState {
  rootPc: number;
  quality: ChordQuality;
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
  nextSampleBeat: number;
  currentDensity: number;
  currentTimbre: TimbreMode;
  /**
   * ✅ ADD (beatless drone latch): Boolean latch used only when
   * `enableBeats === false`. The first beatless beat emits drone events
   * for every configured layer, sets this flag true, and never emits them
   * again until the flag is reset (by LiveEngine.start() or by the
   * startState clone in renderAmbient). In beat-enabled mode this flag is
   * unused — drones are re-emitted every beat so the shells can re-trigger
   * amp/pan/filter automation.
   */
  droneLayersStarted: boolean;
  /**
   * The current triad in Z12 relative to
   * params.rootHz — root pitch class (0..11) plus quality; the triad's pitch
   * classes derive via triadPitchClasses(). Advanced only at the harmonic
   * boundary when enableNeoHarmony is on (updateHarmony); initialized to the
   * tonic triad of the selected scale unconditionally so every EngineState is
   * total — a pure table lookup, zero RNG draws, flag-off streams unchanged.
   */
  chordRootPc: number;
  chordQuality: ChordQuality;
  /**
   * Index of the melody lane's position on the pool
   * ladder (buildMelodyLadder) — advanced every beat by the weighted move or
   * the cadence landing, re-anchored by the boundary snap when the chord
   * changes under it. Present unconditionally so every EngineState is total;
   * the legacy lane ignores it (zero draws either way).
   */
  melodyLadderPos: number;
}

// ── Constants (verbatim from original engine.ts) ──────────────────────────────

export const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
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

// DRONE_FADE_SEC was duplicated between LiveEngine and renderAmbient,
// allowing live and offline fade shapes to diverge silently. Single source
// of truth here, imported by both shells. The value (1.0s) is the fade
// duration used by both the attack (setTargetAtTime with time constant
// DRONE_FADE_SEC / 3) and the offline release ramp.
export const DRONE_FADE_SEC = 1.0;

/**
 * Beats per bar — the kernel's grid unit. Exported because the synthesis
 * shells and their tests derive beat times from it (pre-roll length, bar
 * arithmetic) and must not keep private copies that can drift.
 */
export const BEATS_PER_BAR = 4;
const BAR_LENGTH = 8;
const BASS_HITS = 3;
// Exported for the melody tests: the cadence and phrase cadences are part of
// the Melody V2 contract (cadence landings, phrase pull, phrase-end
// behaviour), and the tests derive their expectations from these names
// instead of copying the numbers.
export const CADENCE_INTERVAL = 16;
export const PHRASE_LENGTH = 32;
const DRUM_GHOST_PROBABILITY = 0.25;
const DRUM_SNARE_AMP = 0.45;
const DRUM_KICK_AMP = 0.6;
const DRUM_HAT_AMP = 0.25;
const DRUM_HAT_CLOSED_PROB = 0.85;
const SAMPLE_TRIGGER_PROBABILITY = 0.35;
const SAMPLE_MIN_GAP_BEATS = 8;
const SAMPLE_JITTER_BEATS = 9;
const SAMPLE_DEFAULT_GAIN = 0.25;
export const NOISE_BUFFER_SAMPLES = 22050; // sampleRate(44100) * 0.5s — must match synthesis shells
const ROOT_LOOP_HZ = [220, 185, 147, 165]; // A3 → F#3 → D3 → E3

// ── Neo-Harmony constants (Phase 2) ───────────────────────────────────────────

export const SEMITONES_PER_OCTAVE = 12;

// Chord decisions fire on the existing 8-bar harmonic boundary (beats 32, 64,
// …). Named here and shared by updateHarmonicLoop, whose bare `% 8` it
// replaces, so the two root engines cannot drift apart.
export const HARMONIC_CYCLE_BARS = 8;

// One uniform draw per boundary picks P / L / R / stay via cumulative
// thresholds: P < 0.40, L < 0.75, R < 0.90, else stay. Weights as specified
// for this phase (L and R keep two common tones — the smoothest motion).
export const HARMONY_TRANSFORM_WEIGHTS = {
  parallel: 0.4,
  leading: 0.35,
  relative: 0.15,
  stay: 0.1,
} as const;

// Triad definitions in semitones from the root (mod 12). The transform sets
// in the verified table are exactly these canonical forms on the transformed
// root, e.g. L of major{r} = minor triad on r+4 = {r-1, r+4, r+7} mod 12.
export const MAJOR_TRIAD_INTERVALS = [0, 4, 7] as const;
export const MINOR_TRIAD_INTERVALS = [0, 3, 7] as const;

// Declared colour tones per quality, semitones from the chord root (mod 12):
// minor adds the 9th (+14 ≡ +2) and flat 7th (+10); major adds the 9th (+2)
// and the 6th (+9). Declared this phase; the Phase 3 melody rewrite consumes
// them, and harmony.test.ts already treats chord ∪ colour as the pad/bass
// pitch pool.
export const MINOR_COLOUR_INTERVALS = [2, 10] as const;
export const MAJOR_COLOUR_INTERVALS = [2, 9] as const;

// Initial chord = tonic triad of the selected scale: scales whose tonic
// triad is major map to major, minor-tonic scales to minor; locrian's tonic
// triad is diminished and maps to minor (its conventional minor-family
// treatment). Pure table lookup — no new param, no RNG.
export const SCALE_TONIC_QUALITY: Record<ScaleName, ChordQuality> = {
  majorPent: "major",
  ionian: "major",
  lydian: "major",
  mixolydian: "major",
  minorPent: "minor",
  dorian: "minor",
  phrygian: "minor",
  aeolian: "minor",
  locrian: "minor",
};

// The chord root slews the sounding root to the chord root pitched within
// ±CHORD_ROOT_FOLD_SEMITONES of params.rootHz (nearest-octave fold), so an
// 8-bar root motion never exceeds ~6 semitones — a colour shift, not a
// register jump.
export const CHORD_ROOT_FOLD_SEMITONES = 6;

/**
 * Shell-side fallback when a caller passes a falsy bpm (JS callers can reach
 * the shells past the type system via the MCP passthrough). 72 = the Calm
 * scene's bpm. Convention: the value the shells have always fallen back to.
 */
export const DEFAULT_BPM = 72;

/**
 * Offline pre-roll length in bars: renderAmbient and BlockSynth.buildTimeline
 * both render this many extra bars before t = 0 (so delay/reverb tails and
 * the first scheduled beats are warm) and then trim them. Single source so
 * the two shells and their tests cannot drift — the same role DRONE_FADE_SEC
 * plays for drone fades.
 */
export const PRE_ROLL_BARS = 4;

// Chord-voiced pad register: two octaves above the sounding root — the
// legacy pad register (noteHz(padDegree, 2, …) sits at [24, 31] semitones).
// Chord tones land in [24, 31]: root +24, third +27/+28, fifth +31.
const PAD_VOICE_OCTAVES_ABOVE_ROOT = 2;
// Three voices × PAD_CHORD_AMP = 0.24 = the legacy pad's 2 × 0.12 total, and
// the ADSR sustain (0.7) is per voice, so sustained pad energy is unchanged —
// the mix does not jump when the flag turns on.
const PAD_CHORD_AMP = 0.08;
// Bass plays the chord root two octaves down — the legacy bass register for
// degree 0 (noteHz(0, -1, root) / 2 = root / 4 = −24 semitones).
const BASS_ROOT_SEMITONES = -24;

export interface Scene {
  readonly name: string;
  readonly scale: ScaleName;
  readonly bpm: number;
  readonly mix: number;
  readonly complexity: number;
  readonly density: number;
  readonly timbre: TimbreMode;
}

export const SCENE_PACKS: Record<ScenePackName, readonly Scene[]> = {
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

export const SCENES: readonly Scene[] = SCENE_PACKS.default;

export function getScenePackScenes(
  params?: Pick<EngineParams, "scenePack">,
): readonly Scene[] {
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

// Exported for musicalLogic.test.ts — the scale-interval test asserts
// against currentScale() directly rather than SCALE_INTERVALS to avoid a
// tautological check (see test file for details).
export function currentScale(scale: ScaleName): readonly number[] {
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
    SEMITONES_PER_OCTAVE * octaveShift;
  return rootHz * Math.pow(2, semi / SEMITONES_PER_OCTAVE);
}

function wrapDegree(degree: number, scaleLength: number): number {
  return ((degree % scaleLength) + scaleLength) % scaleLength;
}

// ── Neo-Harmony (Phase 2) ───────────────────────────────────────────────────

/** Canonical pitch classes of a triad, ascending-interval order from the root. */
export function triadPitchClasses(
  rootPc: number,
  quality: ChordQuality,
): [number, number, number] {
  const r = ((rootPc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;
  const iv = quality === "major" ? MAJOR_TRIAD_INTERVALS : MINOR_TRIAD_INTERVALS;
  return [
    r,
    (r + iv[1]) % SEMITONES_PER_OCTAVE,
    (r + iv[2]) % SEMITONES_PER_OCTAVE,
  ];
}

/**
 * The declared colour intervals as absolute pitch classes (relative to
 * params.rootHz), transposed by the chord root and folded mod 12.
 */
export function absoluteColourPcs(rootPc: number, quality: ChordQuality): Set<number> {
  const intervals =
    quality === "major" ? MAJOR_COLOUR_INTERVALS : MINOR_COLOUR_INTERVALS;
  return new Set(intervals.map((iv) => modPitchClass(rootPc + iv)));
}

// The verified Neo-Riemannian table as data: root motion in pitch classes per
// (transform, input quality); every transform flips the quality.
//   P: major{r} ↔ minor{r}
//   L: major{r} → minor{r+4}  ({r-1, r+4, r+7});  minor{r} → major{r+8} ({r, r+3, r+8})
//   R: major{r} → minor{r+9};                    minor{r} → major{r+3}
const TRANSFORM_ROOT_DELTA: Record<"P" | "L" | "R", Record<ChordQuality, number>> = {
  P: { major: 0, minor: 0 },
  L: { major: 4, minor: 8 },
  R: { major: 9, minor: 3 },
};

export type HarmonyTransform = "P" | "L" | "R";

export function transformChord(chord: ChordState, transform: HarmonyTransform): ChordState {
  const rootPc =
    (chord.rootPc + TRANSFORM_ROOT_DELTA[transform][chord.quality]) % SEMITONES_PER_OCTAVE;
  return { rootPc, quality: chord.quality === "major" ? "minor" : "major" };
}

function pickHarmonyTransform(uniform: number): HarmonyTransform | "stay" {
  const w = HARMONY_TRANSFORM_WEIGHTS;
  if (uniform < w.parallel) return "P";
  if (uniform < w.parallel + w.leading) return "L";
  if (uniform < w.parallel + w.leading + w.relative) return "R";
  return "stay";
}

/**
 * Draw-then-decide: the caller consumes exactly ONE uniform from the shared
 * stream and hands it here; this maps it through the weighted table. "stay"
 * returns the input chord unchanged — the only way a chord repeats on
 * consecutive boundaries (P/L/R mathematically never return the input triad;
 * asserted exhaustively and over a long walk in harmony.test.ts).
 */
export function applyHarmonyDraw(chord: ChordState, uniform: number): ChordState {
  const t = pickHarmonyTransform(uniform);
  return t === "stay" ? chord : transformChord(chord, t);
}

/**
 * The sounding root for a chord: params.rootHz transposed by the chord root
 * pitch class, folded into the nearest octave so it stays within
 * ±CHORD_ROOT_FOLD_SEMITONES of params.rootHz.
 */
export function chordRootHz(rootHz: number, rootPc: number): number {
  let hz = rootHz * Math.pow(2, rootPc / SEMITONES_PER_OCTAVE);
  const up =
    rootHz * Math.pow(2, CHORD_ROOT_FOLD_SEMITONES / SEMITONES_PER_OCTAVE);
  const down =
    rootHz * Math.pow(2, -CHORD_ROOT_FOLD_SEMITONES / SEMITONES_PER_OCTAVE);
  while (hz > up) hz /= 2;
  while (hz < down) hz *= 2;
  return hz;
}

/**
 * The shared 8-bar boundary: beats 32, 64, 96, …. Equivalent to the original
 * updateHarmonicLoop condition (beat > 0 && floor(beat/4) % 8 === 0 &&
 * beat % 4 === 0) — beat % (HARMONIC_CYCLE_BARS * BEATS_PER_BAR) === 0
 * already implies both the bar and beat alignment.
 */
export function isHarmonicCycleBoundary(beat: number): boolean {
  return (
    beat > 0 && beat % (HARMONIC_CYCLE_BARS * BEATS_PER_BAR) === 0
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const modPitchClass = (pc: number): number =>
  ((pc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;

// ── Melody V2 (enableMelodyV2) ────────────────────────────────────────────

// Pool weights for the chord pool: chord tones are the favoured material and
// the declared colour tones appear sparsely. Nothing else is in the pool.
export const MELODY_W_CHORD = 2.0;
export const MELODY_W_COLOUR = 0.4;

// Repeating the current pitch (move 0) is demoted so the line keeps moving.
export const MELODY_REPEAT_REFRACTORY_FACTOR = 0.35;

// On the approach to a phrase end, root and fifth destinations are boosted so
// the line lands harmonically at the cadence.
export const MELODY_PHRASE_PULL_WINDOW_BEATS = 2;
export const MELODY_PHRASE_PULL_FACTOR = 4;

// The cadence draw becomes the V2 landing: root with this probability,
// otherwise the fifth — the same split the legacy lane's 0-or-2 degree
// landing used.
export const CADENCE_ROOT_PROBABILITY = 0.6;

// The legacy phrase-end octave-lift probability. The draw keeps its place in
// the schedule under V2 (consumed, result ignored) and still drives the
// register lift in the legacy lane.
export const PHRASE_END_OCTAVE_PROBABILITY = 0.3;

// Ladder register: ascending pool tones above the sounding root, starting
// MELODY_LADDER_LOW_SEMITONES above it — the legacy melody sits roughly 12–23
// semitones above the root — and spanning MELODY_LADDER_OCTAVES octaves.
// Design note: one octave measured better than two over 2048-beat neo-on
// runs (seeds 42/7): mean |leap| 2.71/2.65 vs 3.06/2.96 semitones, ≥7-semitone
// leaps 7.8%/9.2% vs 8.9%/9.4%; legacy melody 22.0%/19.3%.
export const MELODY_LADDER_LOW_SEMITONES = 12;
export const MELODY_LADDER_OCTAVES = 1;

// Phrase-pull destinations: the root and the pool's fifth pitch class.
export const MELODY_ROOT_PITCH_CLASS = 0;
// The perfect-fifth target the pool's fifth is measured against.
export const MELODY_FIFTH_PITCH_CLASS = 7;

export interface MelodyLadder {
  /** Ascending semitone offsets above the sounding root. */
  offsets: readonly number[];
  /** Pool weight per step (MELODY_W_CHORD / MELODY_W_COLOUR / 1). */
  weights: readonly number[];
}

/**
 * The melody pool laid out as a ladder. Neo-Harmony on: the current chord's
 * triad plus its declared colour tones (weighted). Neo-Harmony off: the
 * selected scale (every in-scale tone weight 1), so V2 still gets contour,
 * refractory and phrase pull. Zero draws — a pure table build.
 */
export function buildMelodyLadder(
  chord: ChordState | null,
  scale: ScaleName,
): MelodyLadder {
  const poolPcs = new Map<number, number>();
  if (chord) {
    for (const pc of triadPitchClasses(0, chord.quality)) {
      poolPcs.set(pc, MELODY_W_CHORD);
    }
    for (const iv of chord.quality === "major"
      ? MAJOR_COLOUR_INTERVALS
      : MINOR_COLOUR_INTERVALS) {
      poolPcs.set(iv, MELODY_W_COLOUR);
    }
  } else {
    for (const iv of currentScale(scale)) poolPcs.set(iv, 1);
  }
  const offsets: number[] = [];
  const weights: number[] = [];
  const sortedPcs = [...poolPcs.keys()].sort((a, b) => a - b);
  for (let o = 0; o < MELODY_LADDER_OCTAVES; o++) {
    for (const pc of sortedPcs) {
      offsets.push(MELODY_LADDER_LOW_SEMITONES + pc + o * SEMITONES_PER_OCTAVE);
      weights.push(poolPcs.get(pc)!);
    }
  }
  return { offsets, weights };
}

/**
 * The pool's "fifth": the pool pitch class nearest the perfect-fifth target by
 * circular pitch-class distance, ties to the lower pitch class. Locrian has no
 * pitch class 7, so its pool fifth is 6.
 */
export function poolFifthPitchClass(offsets: readonly number[]): number {
  const poolPcs = [...new Set(offsets.map(modPitchClass))];
  let best = poolPcs[0] ?? MELODY_FIFTH_PITCH_CLASS;
  let bestDist = Infinity;
  for (const pc of poolPcs) {
    const dist = Math.min(
      modPitchClass(pc - MELODY_FIFTH_PITCH_CLASS),
      modPitchClass(MELODY_FIFTH_PITCH_CLASS - pc),
    );
    if (dist < bestDist) {
      best = pc;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Semitone form of the chordRootHz fold: chordRootHz(rootHz, pc) equals
 * rootHz · 2^(foldedChordSemitones(pc) / SEMITONES_PER_OCTAVE) — the chord
 * root pitch class folded into (−6..+6] semitones of pc 0.
 */
export function foldedChordSemitones(pc: number): number {
  const p = modPitchClass(pc);
  return p <= CHORD_ROOT_FOLD_SEMITONES ? p : p - SEMITONES_PER_OCTAVE;
}

/**
 * Nearest ladder step whose pitch class equals `targetPc`, measured from
 * `fromOffset` in semitones. Offsets ascend, so the first step that attains
 * the minimum distance wins and ties go to the lower step. Returns -1 when
 * the ladder has no such step — defensive only: the root and the pool's
 * fifth always have a step.
 */
export function nearestLadderStepWithPitchClass(
  offsets: readonly number[],
  fromOffset: number,
  targetPc: number,
): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < offsets.length; i++) {
    if (modPitchClass(offsets[i]) !== targetPc) continue;
    const dist = Math.abs(offsets[i] - fromOffset);
    if (dist < bestDist) {
      bestIdx = i;
      bestDist = dist;
    }
  }
  return bestIdx;
}

export interface MelodySnapArgs {
  oldLadder: MelodyLadder;
  newLadder: MelodyLadder;
  /** Chord root pitch class the old ladder is framed on. */
  oldRootPc: number;
  /** Chord root pitch class the new ladder is framed on. */
  newRootPc: number;
  /** Position on the old ladder. */
  pos: number;
}

/**
 * Re-anchor a melody ladder position across a chord change. Zero draws. The
 * stored position names a pitch oldLadder.offsets[pos] semitones above the
 * old chord root; the same absolute pitch sits foldedChordSemitones(old) −
 * foldedChordSemitones(new) semitones higher above the new root — the fold
 * the sounding root itself moves by — so the nearest step of the new ladder
 * is measured from that value. Ties break to the lower step. Identity when
 * the chord did not change: same pool builds the same ladder, the root delta
 * is 0, and the current step is its own nearest step.
 */
export function snapMelodyLadder(args: MelodySnapArgs): number {
  const oldOffset = args.oldLadder.offsets[args.pos];
  const pitchInNewFrame =
    oldOffset +
    foldedChordSemitones(args.oldRootPc) -
    foldedChordSemitones(args.newRootPc);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < args.newLadder.offsets.length; i++) {
    const dist = Math.abs(args.newLadder.offsets[i] - pitchInNewFrame);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export interface LadderMoveArgs {
  /** Blended Markov base row over MARKOV_MOVES (see blendedMarkovRow). */
  baseRow: readonly number[];
  currentPos: number;
  ladder: MelodyLadder;
  refractoryFactor: number;
  pullFactor: number;
  pullWindowBeats: number;
  /** Beats from the current beat to the next phrase end (0 = the phrase-end
   * beat itself, which the cadence lane owns). */
  beatsToPhraseEnd: number;
  /** The pool's fifth pitch class (poolFifthPitchClass(ladder.offsets)). */
  fifthPitchClass: number;
  /** The single uniform this decision consumes. */
  uniform: number;
}

export interface LadderMoveResult {
  move: number;
  nextPos: number;
  usedFallback: boolean;
  /** The normalized distribution the uniform was applied to. */
  weights: readonly number[];
}

function pickWeightedIndex(weights: readonly number[], uniform: number): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = uniform * sum;
  let idx = 0;
  // Walk the cumulative weights; zero-weight slots are skipped so an exact
  // r = 0 (mulberry32 can draw exactly 0) never lands on an off-ladder
  // destination. markovStep keeps its own all-positive row loop.
  for (
    ;
    idx < weights.length - 1 && ((r -= weights[idx]) > 0 || weights[idx] === 0);
    idx++
  );
  return idx;
}

const normalizeWeights = (weights: readonly number[]): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / sum);
};

/**
 * One weighted melody move on the ladder, consuming exactly ONE uniform —
 * the same draw the legacy Markov step uses. The destination ladder position
 * is pos + move; its weight is the blended base row entry × the
 * destination's pool weight × (refractory factor when the move repeats the
 * current pitch) × (phrase pull factor for root/pool-fifth destinations while
 * the phrase end is within the pull window). Off-ladder destinations get weight
 * 0. If every weighted weight is zero, the unweighted blended base row over
 * the in-ladder destinations is used with the SAME uniform (no second draw,
 * no NaN); if that is zero too, the in-ladder destinations split uniformly.
 * `currentPos` must be a valid ladder index (move 0 is then always
 * in-ladder, so a destination always exists).
 */
export function pickLadderMove(args: LadderMoveArgs): LadderMoveResult {
  const { offsets, weights: poolWeights } = args.ladder;
  const dests = MARKOV_MOVES.map((m) => args.currentPos + m);
  const inBounds = dests.map((d) => d >= 0 && d < offsets.length);
  const baseWeights = MARKOV_MOVES.map((_move, i) =>
    inBounds[i] ? args.baseRow[i] : 0,
  );
  const weighted = MARKOV_MOVES.map((move, i) => {
    if (baseWeights[i] === 0) return 0;
    let w = baseWeights[i] * poolWeights[dests[i]];
    if (move === 0) w *= args.refractoryFactor;
    const destPc = modPitchClass(offsets[dests[i]]);
    if (
      args.beatsToPhraseEnd >= 1 &&
      args.beatsToPhraseEnd <= args.pullWindowBeats &&
      (destPc === MELODY_ROOT_PITCH_CLASS || destPc === args.fifthPitchClass)
    ) {
      w *= args.pullFactor;
    }
    return w;
  });
  if (weighted.some((w) => w > 0)) {
    const idx = pickWeightedIndex(weighted, args.uniform);
    return {
      move: MARKOV_MOVES[idx],
      nextPos: dests[idx],
      usedFallback: false,
      weights: normalizeWeights(weighted),
    };
  }
  if (baseWeights.some((w) => w > 0)) {
    // Fallback: unweighted blended base row over the in-ladder destinations,
    // reusing the same uniform.
    const idx = pickWeightedIndex(baseWeights, args.uniform);
    return {
      move: MARKOV_MOVES[idx],
      nextPos: dests[idx],
      usedFallback: true,
      weights: normalizeWeights(baseWeights),
    };
  }
  // Degenerate input (base row all zero): uniform split over the in-ladder
  // destinations, same uniform. Unreachable with the kernel's Markov rows.
  const equal = inBounds.map((ok) => (ok ? 1 : 0));
  const idx = pickWeightedIndex(equal, args.uniform);
  return {
    move: MARKOV_MOVES[idx],
    nextPos: dests[idx],
    usedFallback: true,
    weights: normalizeWeights(equal),
  };
}

/**
 * V2 shadow degree: the scale degree whose pitch class is nearest the ladder
 * pitch's pitch class (circular pitch-class distance), ties to the lowest
 * degree. The legacy pad and bass lanes read state.degree, so this keeps
 * them coherent with the melody under V2. Exported for melody.test.ts.
 */
export function nearestDegreeToPitchClass(targetPc: number, scale: ScaleName): number {
  const intervals = currentScale(scale);
  let best = 0;
  let bestDist = Infinity;
  for (let d = 0; d < intervals.length; d++) {
    const dist = Math.min(
      modPitchClass(intervals[d] - targetPc),
      modPitchClass(targetPc - intervals[d]),
    );
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

// Distance in beats from `beat` to the next phrase end (0 on the phrase-end
// beat itself — the cadence lane owns that beat, so the pull window only
// ever sees values >= 1).
function beatsToPhraseEnd(beat: number): number {
  const raw = (PHRASE_LENGTH - 1 - beat) % PHRASE_LENGTH;
  return (raw + PHRASE_LENGTH) % PHRASE_LENGTH;
}

/**
 * Drone events for one beat. `chordRootPc` is the caller's current chord root
 * pitch class (EngineState.chordRootPc).
 *
 * With Neo-Harmony on, each emitted drone hz is multiplied by the folded
 * chord-root ratio the tonal lanes sound —
 * chordRootHz(params.rootHz, chordRootPc) / params.rootHz, reusing the
 * existing fold — so a drone tracks every 8-bar chord change instead of
 * holding a fixed pitch that clashes with 6 of 12 chord roots. Flag off or
 * absent: the layer hz is emitted verbatim (explicit gate — never rely on
 * the ratio being 1). Zero RNG draws in both modes.
 */
function droneEvents(
  params: EngineParams,
  beat: number,
  beatSec: number,
  chordRootPc: number,
): MusicalEvent[] {
  const layers = params.drone?.layers ?? [];
  const chordRootRatio =
    params.enableNeoHarmony === true
      ? chordRootHz(params.rootHz, chordRootPc) / params.rootHz
      : 1;
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
        hz: layer.hz * chordRootRatio,
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

export function playableSampleEntries(
  sampleBank?: SampleBankEntry[],
): SampleBankEntry[] {
  const ids = new Set<string>();
  return (sampleBank ?? []).filter((entry) => {
    if (
      typeof entry?.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.url !== "string" ||
      entry.url.length === 0 ||
      (entry.gain !== undefined &&
        (!Number.isFinite(entry.gain) || entry.gain <= 0)) ||
      ids.has(entry.id)
    ) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
}

function maybeSampleEvent(
  state: EngineState,
  params: EngineParams,
  beat: number,
  rng: () => number,
): MusicalEvent[] {
  const samples = playableSampleEntries(params.sampleBank);
  if (samples.length === 0 || state.beat < state.nextSampleBeat) return [];
  const events: MusicalEvent[] = [];
  // ponytail: one sparse global sample lane with fixed probability/gap;
  // upgrading means per-sample probabilities, duration metadata, and overlap policy.
  if (rng() < SAMPLE_TRIGGER_PROBABILITY) {
    const sample = samples[Math.floor(rng() * samples.length)];
    events.push({
      type: "sample",
      sampleId: sample.id,
      amp: clamp(sample.gain ?? SAMPLE_DEFAULT_GAIN, 0, 1),
      durationSec: 0,
      pan:
        sample.pan !== undefined && Number.isFinite(sample.pan)
          ? clamp(sample.pan, -1, 1)
          : 0,
      beatIndex: beat,
      subBeatIndex: 0,
    });
  }
  state.nextSampleBeat =
    state.beat + SAMPLE_MIN_GAP_BEATS + Math.floor(rng() * SAMPLE_JITTER_BEATS);
  return events;
}

function euclideanRhythm(step: number, pulses: number, steps: number): boolean {
  return (step * pulses) % steps < pulses;
}

export const MARKOV_MOVES: readonly number[] = [-2, -1, 0, 1, 2];

const MARKOV_BASE_ROWS: readonly (readonly number[])[] = [
  [0.1, 0.25, 0.4, 0.2, 0.05],
  [0.05, 0.25, 0.45, 0.2, 0.05],
  [0.1, 0.2, 0.4, 0.2, 0.1],
  [0.05, 0.2, 0.45, 0.25, 0.05],
  [0.05, 0.2, 0.4, 0.25, 0.1],
];

// complexity blends the base row toward a uniform row: 0 keeps the Markov
// row, 1 makes every move equally likely. Under Melody V2 it keeps exactly
// this meaning through the same blend (higher complexity flattens the move
// distribution, so larger ladder moves become more likely); scene
// interpolation overwrites params.complexity when enableScenes is true
// (existing behaviour).
export const MARKOV_UNIFORM_BLEND = 0.2;

function blendedMarkovRow(lastInterval: number, complexity: number): number[] {
  const lastIdx = MARKOV_MOVES.indexOf(lastInterval);
  const row = MARKOV_BASE_ROWS[lastIdx >= 0 ? lastIdx : 2];
  return row.map((w) => w * (1 - complexity) + MARKOV_UNIFORM_BLEND * complexity);
}

function markovStep(
  lastInterval: number,
  complexity: number,
  rng: () => number,
): number {
  const weights = blendedMarkovRow(lastInterval, complexity);
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  let idx = 0;
  for (; idx < weights.length - 1 && (r -= weights[idx]) > 0; idx++);
  return MARKOV_MOVES[idx];
}

// Exported for musicalLogic.test.ts — the A2/B2 test confirms this stays in
// agreement with getEffectiveSceneParams() (bpm/mix/scale/complexity) for a
// non-bar-aligned sceneStartBeat, which used to silently diverge.
export function updateSceneEngine(
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
 * Phase 2 Neo-Harmony: advance the Z12 chord state across the 8-bar boundary.
 *
 * Flag off/absent: returns immediately — zero draws, zero state change, the
 * stream is bit-exact with pre-Phase-2 builds. Flag on: exactly ONE uniform
 * is drawn (whether or not it changes anything) and the chord walks P/L/R or
 * stays; targetRootHz follows the new chord root so the shells' existing
 * 600 ms slew carries every lane to it.
 *
 * Static-root pin (fix): with enableHarmonicLoop === false,
 * updateHarmonicLoop() re-pins targetRootHz/currentRootHz to params.rootHz
 * EVERY beat (including boundary beats) — it runs before this function, so a
 * chord advance here could never move the sounding root: the pad would voice
 * a moving chord over a pinned root and the pin would fight the slew every
 * beat. The chord therefore stays on its tonic triad (createInitialState)
 * for the whole run, and this lane draws NOTHING — the guard returns before
 * rng(), keeping the draw schedule a function of the beat index and fixed
 * constants (pinned by an rngState-equality check in harmony.test.ts).
 */
function updateHarmony(
  state: EngineState,
  params: EngineParams,
  rng: () => number,
): Partial<EngineState> {
  if (params.enableNeoHarmony !== true) return {};
  if (params.enableHarmonicLoop === false) return {};
  if (!isHarmonicCycleBoundary(state.beat)) return {};
  const next = applyHarmonyDraw(
    { rootPc: state.chordRootPc, quality: state.chordQuality },
    rng(),
  );
  return {
    chordRootPc: next.rootPc,
    chordQuality: next.quality,
    targetRootHz: chordRootHz(params.rootHz, next.rootPc),
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
  // with the flag on, the chord walk owns this
  // boundary — the ROOT_LOOP_HZ walk stays parked and updateHarmony() sets
  // targetRootHz. The static-root pin above still wins: with
  // enableHarmonicLoop === false there is no root motion and the chord stays
  // on its (tonic) triad.
  if (params.enableNeoHarmony === true) return {};
  // ✅ FIX (beat-0 harmonic advance): `state.beat > 0` prevents the first
  // beat from advancing the loop. The boundary check still fires every 8
  // bars (beat 32, 64, 96, ...), preserving the original cadence after
  // the initial cycle. (isHarmonicCycleBoundary is the shared, named form.)
  if (isHarmonicCycleBoundary(state.beat)) {
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

  // 2b. Neo-Harmony chord decision (Phase 2) — see RNG ORDER at the top of
  // this file: zero draws when the flag is off or absent; exactly one draw
  // at the 8-bar boundary when on, taken whether or not the drawn transform
  // changes the chord. The pre-boundary chord is captured for the melody V2
  // boundary snap, which maps the stored ladder position from the old chord's
  // ladder frame to the new one (two property reads, zero draws).
  const chordRootPcBefore = s.chordRootPc;
  const chordQualityBefore = s.chordQuality;
  const harmonyUpdates = updateHarmony(s, effectiveParams, rng);
  Object.assign(s, harmonyUpdates);

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

  // ✅ ADD (fourFloor): resolve the drum style once. Default keeps the
  // original 5/16 euclidean kick pattern. "fourFloor" fires a kick on
  // every quarter note (subBeatIndex 0 of each beat).
  const drumStyle = effectiveParams.drumStyle ?? "euclideanTrap";

  // ✅ ADD (beatless drone latch): In beatless mode, emit drone layers
  // exactly once (on the first beatless beat), then latch. The synthesis
  // shells reset s.droneLayersStarted on start()/startState-clone so a
  // stopped/restarted beatless playback re-fires the drone oscillators.
  // Beatless mode still increments s.beat so scene/harmonic-loop boundaries
  // continue to fire on the same beat grid as beat-enabled mode.
  if (effectiveParams.enableBeats === false) {
    events.push(...maybeSampleEvent(s, effectiveParams, beat, rng));
    if (!s.droneLayersStarted) {
      // Beatless mode has no pad/bass/melody (the early return below), so
      // there is no harmony for the drone to clash with; the latch emits each
      // layer once on the first beatless beat and is deliberately unchanged.
      events.push(...droneEvents(effectiveParams, beat, beatSec, s.chordRootPc));
      s.droneLayersStarted = true;
    }
    // A1: advance the drum-grid phase even when no drum events are emitted,
    // so a future toggle of enableBeats from false → true mid-stream resumes
    // the euclidean kick/snare/hat patterns from the correct phase instead
    // of a stale one. The normal path advances sixteenthCount by 4 below.
    s.sixteenthCount += 4;
    s.beat++;
    return { events, nextState: s };
  }

  // Emit configured drone layers in beat-enabled mode every beat so the
  // synthesis shells can re-trigger amp/pan/filter automation. Both
  // LiveEngine.playDrone() and renderAmbient.scheduleDrone() now re-anchor
  // the gain envelope and update frequency/detune/pan/filter on every event
  // for a layer; renderAmbient's scheduledLayers set only gates whether a
  // new oscillator gets created, not whether the event is processed.
  //
  // ✅ ADD (latch reset for beatless ↔ beat-enabled transitions): Reset the
  // beatless drone latch here so a future toggle of enableBeats from true →
  // false mid-stream re-fires the drone oscillators on the next beatless
  // beat. Without this reset, a beatless → beat-enabled → beatless cycle
  // would leave droneLayersStarted=true from the first beatless phase, and
  // the second beatless phase would emit zero drone events (the latch would
  // stay latched). The synthesis shells also reset this flag on start() /
  // startState-clone, but that only covers engine restarts — it does not
  // cover in-flight param toggles, which is what this reset handles.
  s.droneLayersStarted = false;
  events.push(...droneEvents(effectiveParams, beat, beatSec, s.chordRootPc));

  // 4. Drums — FIX C1: set subBeatIndex (0–3) on each drum event
  for (let i = 0; i < 4; i++) {
    const sixteenthStep = s.sixteenthCount + i;
    // ✅ ADD (fourFloor): "fourFloor" fires a kick on every quarter note
    // (i === 0). "euclideanTrap" preserves the original 5/16 euclidean
    // kick pattern. Both branch on `drumLevel > 0` identically below.
    const shouldKick =
      drumStyle === "fourFloor"
        ? i === 0
        : euclideanRhythm(sixteenthStep % 16, 5, 16);
    if (drumLevel > 0 && shouldKick) {
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

  // 6. Cadence / Markov — the melody lane's harmonic decision. Melody V2
  // (enableMelodyV2) keeps the draw schedule exactly: one draw on cadence
  // beats (the landing), one Markov draw otherwise (a weighted ladder move).
  // complexity keeps its meaning through the Markov blend — higher
  // complexity flattens the move distribution, so larger moves become more
  // likely; scene interpolation overwrites it when enableScenes is true
  // (existing behaviour).
  const isCadence = s.beat % CADENCE_INTERVAL === CADENCE_INTERVAL - 1;
  const melodyV2 = effectiveParams.enableMelodyV2 === true;
  // The V2 ladder for the CURRENT chord/scale, shared by this lane and the
  // melody lane below — a pure table build, zero draws.
  const v2Ladder = melodyV2
    ? buildMelodyLadder(
        effectiveParams.enableNeoHarmony === true
          ? { rootPc: s.chordRootPc, quality: s.chordQuality }
          : null,
        currentScaleName,
      )
    : null;
  if (melodyV2 && v2Ladder) {
    // Hard bounds: a mid-run scale swap (scenes, neo off) can shrink the
    // ladder under the stored position — clamp before use. Chord changes
    // re-anchor through the snap below.
    s.melodyLadderPos = clamp(s.melodyLadderPos, 0, v2Ladder.offsets.length - 1);
    if (
      effectiveParams.enableNeoHarmony === true &&
      isHarmonicCycleBoundary(s.beat)
    ) {
      // Boundary snap: the chord may have changed under the melody. Zero
      // draws; identity when the chord did not change.
      s.melodyLadderPos = snapMelodyLadder({
        oldLadder: buildMelodyLadder(
          { rootPc: chordRootPcBefore, quality: chordQualityBefore },
          currentScaleName,
        ),
        newLadder: v2Ladder,
        oldRootPc: chordRootPcBefore,
        newRootPc: s.chordRootPc,
        pos: s.melodyLadderPos,
      });
    }
    if (isCadence) {
      // The existing cadence draw becomes the landing: root or fifth by the
      // same split, snapped to the nearest ladder step with that pitch class
      // (ties to the lower step).
      const targetPc =
        rng() < CADENCE_ROOT_PROBABILITY
          ? MELODY_ROOT_PITCH_CLASS
          : poolFifthPitchClass(v2Ladder.offsets);
      const landing = nearestLadderStepWithPitchClass(
        v2Ladder.offsets,
        v2Ladder.offsets[s.melodyLadderPos],
        targetPc,
      );
      // The pool always contains the root and its nearest fifth; the guard is defensive.
      if (landing >= 0) s.melodyLadderPos = landing;
      s.lastInterval = 0;
    } else {
      const move = pickLadderMove({
        baseRow: blendedMarkovRow(s.lastInterval, effectiveParams.complexity),
        currentPos: s.melodyLadderPos,
        ladder: v2Ladder,
        refractoryFactor: MELODY_REPEAT_REFRACTORY_FACTOR,
        pullFactor: MELODY_PHRASE_PULL_FACTOR,
        pullWindowBeats: MELODY_PHRASE_PULL_WINDOW_BEATS,
        beatsToPhraseEnd: beatsToPhraseEnd(s.beat),
        fifthPitchClass: poolFifthPitchClass(v2Ladder.offsets),
        uniform: rng(),
      });
      s.melodyLadderPos = move.nextPos;
      s.lastInterval = move.move;
    }
    // Shadow degree (flag-gated side effect): the legacy pad and bass lanes
    // still read state.degree, so it is written back as the scale degree
    // nearest the melody's ladder pitch to keep them coherent — with neo
    // off, their walk inherits the V2 weighting.
    // ponytail: pad and bass share the melody's degree, so their walks
    // inherit the V2 weighting; upgrade path: give them their own state.
    s.degree = nearestDegreeToPitchClass(
      modPitchClass(v2Ladder.offsets[s.melodyLadderPos]),
      currentScaleName,
    );
  } else if (isCadence) {
    // ponytail: cadence keeps the old 0-or-2 degree landing; upgrading this
    // needs per-mode cadence targets rather than a raw degree number.
    s.degree = rng() < CADENCE_ROOT_PROBABILITY ? 0 : 2;
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
    let fMel: number;
    if (melodyV2 && v2Ladder) {
      // Phrase-end octave-lift draw: consumed exactly as in the legacy lane
      // so the draw schedule is mode-invariant; the result is ignored — the
      // ladder owns the register under V2.
      if (isPhraseEnd) rng();
      fMel =
        currentRootHz *
        Math.pow(2, v2Ladder.offsets[s.melodyLadderPos] / SEMITONES_PER_OCTAVE);
    } else {
      const octaveShift =
        isPhraseEnd && rng() < PHRASE_END_OCTAVE_PROBABILITY ? 2 : 1;
      fMel = noteHz(s.degree, octaveShift, currentRootHz, currentScaleName);
    }
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
  if (effectiveParams.enableNeoHarmony === true) {
    // Chord-voiced pad: root (left), third (right), fifth (center) — the
    // triad replaces the single re-attacked scale note. Voices sit in
    // [24, 31] semitones above the sounding root (the legacy pad register,
    // see PAD_VOICE_OCTAVES_ABOVE_ROOT); 3 × PAD_CHORD_AMP equals the legacy
    // 2 × 0.12 total, so the sustained pad energy is unchanged.
    // triadPitchClasses(0, quality) gives the chord-RELATIVE intervals
    // [0, third, fifth] used to voice above the sounding root.
    const [relRoot, relThird, relFifth] = triadPitchClasses(0, s.chordQuality);
    const padVoicing: ReadonlyArray<{ rel: number; pan: number }> = [
      { rel: relRoot, pan: -1 }, // signals "left pad" → padPanL / ADSR_PAD_L
      { rel: relThird, pan: 1 }, // signals "right pad" → padPanR / ADSR_PAD_R
      { rel: relFifth, pan: 0 }, // center voice → tonal bus
    ];
    for (const voice of padVoicing) {
      events.push({
        type: "pad",
        hz:
          currentRootHz *
          Math.pow(
            2,
            (PAD_VOICE_OCTAVES_ABOVE_ROOT * SEMITONES_PER_OCTAVE + voice.rel) /
              SEMITONES_PER_OCTAVE,
          ),
        amp: PAD_CHORD_AMP,
        durationSec: beatSec * 1.0,
        pan: voice.pan,
        timbre: currentTimbre,
        beatIndex: beat,
        subBeatIndex: 0,
      });
    }
  } else {
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
  }

  // 9. Bass
  const beatInBar = s.beat % BAR_LENGTH;
  if (euclideanRhythm(beatInBar, BASS_HITS, BAR_LENGTH)) {
    const fBass =
      effectiveParams.enableNeoHarmony === true
        ? currentRootHz *
          Math.pow(2, BASS_ROOT_SEMITONES / SEMITONES_PER_OCTAVE)
        : noteHz(
              wrapDegree(s.degree + sectionOffset, scaleLength),
              -1,
              currentRootHz,
              currentScaleName,
            ) / 2;
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

  // 11. Sample lane
  events.push(...maybeSampleEvent(s, effectiveParams, beat, rng));

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
    nextSampleBeat: 0,
    currentDensity: scenes[0].density,
    currentTimbre: scenes[0].timbre,
    // ✅ ADD (beatless drone latch): start with the latch cleared so the
    // first beatless beat emits drone events. LiveEngine.start() and the
    // renderAmbient startState clone both reset this to false as well.
    droneLayersStarted: false,
    // initial chord = tonic triad of the
    // selected scale, root pitch class 0 (relative to params.rootHz). Pure
    // table lookup — zero RNG draws, so flag-off streams are unchanged
    // (guarded by the backward-compat literals).
    chordRootPc: 0,
    chordQuality: SCALE_TONIC_QUALITY[params.scale],
    // the ladder position starts on the lowest step (the
    // root at the bottom of the register window), matching the legacy lane's
    // initial degree 0. Unconditional — zero RNG draws, flag-off streams
    // unchanged (guarded by the backward-compat literals).
    melodyLadderPos: 0,
  };
}

/**
 * FIX C2: Advance the RNG by exactly NOISE_BUFFER_SAMPLES calls to match
 * the original engine.ts createNoiseBuffer() which consumed from the same
 * this.rng() stream. This must be called after createInitialState() and
 * before initializeBell(), matching original constructor order:
 *   this.rng = mulberry32(seed)
 *   this.noiseBuffer = this.createNoiseBuffer()  ← ~22k calls
 *   this.nextBellBeat = Math.floor(this.rng() * 8) + 8  ← 1 call
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

/** Initialize nextSampleBeat — call after initializeBell */
export function initializeSampleLane(
  state: EngineState,
  params: EngineParams,
): EngineState {
  const s = { ...state };
  if (playableSampleEntries(params.sampleBank).length === 0) return s;
  s.nextSampleBeat = Math.floor(mulberry32Next(s) * 8) + 8;
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

// Determinism and behavior tests live in musicalLogic.test.ts (Vitest).
// They were previously self-executing IIFEs at the bottom of this file,
// which meant they shipped in every build and ran on every import. Moving
// them to a real test file also fixed a recurring problem: a hardcoded
// scale-interval oracle table here kept being treated as a duplicate of
// SCALE_INTERVALS, "fixed" by referencing SCALE_INTERVALS directly (which
// made the test tautological — it could never fail), then flagged again for
// that. Test files are excluded from duplication analysis, so the oracle
// table can safely live there permanently.
//
// The new beatless-drone-latch and fourFloor-kick self-checks also live in
// musicalLogic.test.ts — see the "beatless mode" and "drum styles"
// describe blocks there.
