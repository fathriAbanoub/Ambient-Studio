/**
 * scheduling.ts — Pure synthesis-shell scheduling helpers.
 *
 * No Web Audio dependencies; imported by live/offline shells for actual
 * audio-clock timing decisions that do not belong in musicalLogic.ts.
 *
 * Layered additions (new file):
 *   ✅ ADD (swing helper): getSwingOffsetSec() and getSubBeatEventTime()
 *       give both shells a single source of truth for the subBeatIndex →
 *       eventTime conversion. Swing offsets only odd sub-beats; even sub-
 *       beats (including the downbeat) are untouched.
 *   ✅ ADD (sidechain helper): getSidechainDuckShape() returns the duck
 *       gain multiplier, attack time, and release time for a kick at
 *       `kickTime`. Returns null when sidechainAmount is 0/undefined so
 *       the shells can early-out without scheduling any automation.
 *   ✅ ADD (cancelAndHold helper): Shared cancel-and-hold automation
 *       primitive. Both shells use it to re-anchor gain/filter ramps to
 *       their true current value instead of jumping to a stale target when
 *       automation is superseded mid-flight. Accepts an explicit
 *       fallbackValue for the offline pre-render path where param.value
 *       returns the intrinsic init value rather than the automated value.
 *   ✅ ADD (curve evaluators): evaluateExponentialApproach() and
 *       evaluateDroneEnvelope() let the offline scheduler reconstruct the
 *       true automated value of a param at any query time, so the
 *       cancelAndHold fallback anchors to the real curve instead of a stale
 *       stored target. evaluateDroneEnvelope()'s null-sustainTime branch
 *       models the spec's ramp-replaces-setTarget behaviour (a LinearRamp
 *       scheduled after a not-yet-started SetTarget replaces it), so the
 *       fallback matches the curve actually rendered.
 *   ✅ ADD (shared pan-drift time constant): PAN_DRIFT_TIME_CONSTANT_SEC is
 *       the single source of truth for the pan-drift smoothing used by
 *       LiveEngine.tick() and renderAmbient's beat loop.
 *   ✅ ADD (self-checks): testSchedulingHelpers() IIFE asserts swing,
 *       sidechain, exponential-approach, and piecewise drone-envelope
 *       behaviour. Skipped in production to avoid the import-time cost.
 */

import type { MusicalEvent } from "./musicalLogic";

export const MAX_SWING = 0.6;
export const SIDECHAIN_MAX_DUCK_DB = 5;
export const SIDECHAIN_ATTACK_SEC = 0.01;
export const SIDECHAIN_RELEASE_SEC = 0.18;

// ✅ ADD (shared tonal-bus gain): Single source of truth for the tonal-bus
// steady-state gain. Both LiveEngine and renderAmbient import this so live
// and offline renders stay perceptually matched and the sidechain duck/return
// always anchors to the same level the tonal bus was initialized to.
export const TONAL_BUS_GAIN = 0.3;

// ✅ ADD (shared pan-drift time constant): Single source of truth for the
// pan-drift smoothing time constant. Both LiveEngine.tick() and
// renderAmbient's beat loop smooth their per-beat pan targets with
// setTargetAtTime using this value — keeping the two shells on one constant
// is what keeps live playback and offline exports panning identically.
export const PAN_DRIFT_TIME_CONSTANT_SEC = 0.1;
export const ADSR_MELODY = { a: 0.02, d: 0.2, s: 0.55, r: 0.25 };
export const ADSR_PAD_L = { a: 0.5, d: 0.8, s: 0.7, r: 0.8 };
export const ADSR_PAD_R = { a: 0.6, d: 0.8, s: 0.7, r: 0.9 };
export const ADSR_BASS = { a: 0.005, d: 0.15, s: 0.25, r: 0.2 };
export const ADSR_BELL = { a: 0.01, d: 0.1, s: 0.2, r: 0.15 };

export interface SidechainDuckShape {
  duckGainMultiplier: number;
  attackTime: number;
  releaseTime: number;
}

export interface ToneEnvelope {
  env: { a: number; d: number; s: number; r: number };
  vibratoAmount?: number;
}

export function resolveToneEnvelope(
  type: MusicalEvent["type"],
  pan: number,
): ToneEnvelope {
  switch (type) {
    case "melody":
      return { env: ADSR_MELODY, vibratoAmount: 1.5 };
    case "pad":
      return { env: pan < 0 ? ADSR_PAD_L : ADSR_PAD_R };
    case "bass":
      return { env: ADSR_BASS };
    case "bell":
      return { env: ADSR_BELL };
    default:
      return { env: ADSR_PAD_L };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSwingOffsetSec(
  subBeatIndex: number,
  sixteenthSec: number,
  swing?: number,
): number {
  if (subBeatIndex % 2 === 0) return 0;
  const amount = Number.isFinite(swing) ? clamp(swing ?? 0, 0, MAX_SWING) : 0;
  return amount * sixteenthSec;
}

export function getSubBeatEventTime(
  beatTime: number,
  subBeatIndex: number,
  sixteenthSec: number,
  swing?: number,
): number {
  // ponytail: one global swing amount offsets every odd sixteenth equally;
  // upgrading means per-voice/per-lane swing curves in EngineParams.
  return (
    beatTime +
    subBeatIndex * sixteenthSec +
    getSwingOffsetSec(subBeatIndex, sixteenthSec, swing)
  );
}

export function getSidechainDuckShape(
  kickTime: number,
  sidechainAmount?: number,
): SidechainDuckShape | null {
  const amount = Number.isFinite(sidechainAmount)
    ? clamp(sidechainAmount ?? 0, 0, 1)
    : 0;
  if (amount <= 0) return null;

  // ponytail: fixed global 5 dB tonal-bus duck and fixed attack/release;
  // upgrading means a dedicated music duck bus or per-voice/per-drum curves.
  return {
    duckGainMultiplier: Math.pow(10, (-SIDECHAIN_MAX_DUCK_DB * amount) / 20),
    attackTime: kickTime + SIDECHAIN_ATTACK_SEC,
    releaseTime: kickTime + SIDECHAIN_RELEASE_SEC,
  };
}

/**
 * Cancels future automation on `param` and holds its value at `t`.
 *
 * `cancelAndHoldAtTime` is the spec-correct primitive. Engines without it
 * fall back to cancelScheduledValues + setValueAtTime. In a live context
 * `param.value` is the current interpolated value, so the fallback is
 * reasonably accurate. In an offline pre-render context every event is
 * queued before startRendering(), so `param.value` returns the intrinsic
 * init value and would cause catastrophic jumps — callers in the offline
 * path must pass an explicit `fallbackValue` derived from the tracked
 * automation curve (see evaluateDroneEnvelope / evaluateSidechain).
 */
export function cancelAndHold(
  param: AudioParam,
  t: number,
  fallbackValue?: number,
): void {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(t);
  } else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(
      fallbackValue !== undefined ? fallbackValue : param.value,
      t,
    );
  }
}

/**
 * Evaluates a Web Audio setTargetAtTime exponential-approach curve at `now`.
 *
 * value(t) = toValue + (fromValue - toValue) * exp(-(t - startTime) / tc)
 *
 * `timeConstant <= 0` guards against a degenerate caller by snapping straight
 * to the target rather than dividing by zero.
 */
export function evaluateExponentialApproach(
  fromValue: number,
  toValue: number,
  startTime: number,
  timeConstant: number,
  now: number,
): number {
  if (timeConstant <= 0) return toValue;
  const t = Math.max(0, now - startTime);
  return toValue + (fromValue - toValue) * Math.exp(-t / timeConstant);
}

/**
 * Evaluates the full piecewise drone gain envelope at `now`, mirroring the
 * exact automation scheduleDrone() writes for one event.
 *
 * Sustain scheduled (sustainTime non-null):
 *   1. now before sustainTime: exponential approach toward toValue.
 *   2. now within [sustainTime, releaseEndTime): linear interpolation from
 *      sustainValue toward releaseTarget.
 *   3. now at/after releaseEndTime: releaseTarget.
 *
 * Sustain omitted (sustainTime null — the short-drone guard): the scheduled
 * events are anchor @ startTime, SetTarget toward toValue, then
 * LinearRamp(releaseTarget) @ releaseEndTime. Per spec, a LinearRamp
 * following a not-yet-started SetTarget REPLACES it (T0 = the SetTarget's
 * start time, V0 = the value just before it starts — the anchor), so the
 * rendered curve is a single straight line from fromValue at startTime to
 * releaseTarget at releaseEndTime. The exponential approach never plays in
 * this branch, so we model the straight line — not the approach — to keep
 * the cancelAndHold fallback anchored to what is actually on the AudioParam.
 */
export function evaluateDroneEnvelope(
  fromValue: number,
  toValue: number,
  startTime: number,
  timeConstant: number,
  sustainTime: number | null,
  sustainValue: number,
  releaseEndTime: number,
  releaseTarget: number,
  now: number,
): number {
  if (sustainTime === null) {
    // See the doc comment: with no sustain anchor, the LinearRamp replaces
    // the SetTarget, so the true curve is linear from (startTime, fromValue)
    // to (releaseEndTime, releaseTarget).
    if (now >= releaseEndTime) return releaseTarget;
    const span = releaseEndTime - startTime;
    if (span <= 0) return releaseTarget;
    const progress = Math.max(0, (now - startTime) / span);
    return fromValue + (releaseTarget - fromValue) * progress;
  }
  if (now < sustainTime) {
    return evaluateExponentialApproach(
      fromValue,
      toValue,
      startTime,
      timeConstant,
      now,
    );
  }
  if (now >= releaseEndTime) {
    return releaseTarget;
  }
  const releaseSpan = releaseEndTime - sustainTime;
  if (releaseSpan <= 0) return releaseTarget;
  const progress = (now - sustainTime) / releaseSpan;
  return sustainValue + (releaseTarget - sustainValue) * progress;
}

(function testSchedulingHelpers() {
  if (process.env.NODE_ENV === "production") return;

  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`[ambient-engine] ${message}`);
  };
  const approx = (a: number, b: number) => Math.abs(a - b) < 1e-12;

  assert(
    getSubBeatEventTime(10, 1, 0.125, 0) === 10.125,
    "swing=0 changed odd sub-beat timing",
  );
  assert(
    getSubBeatEventTime(10, 1, 0.125, 0.5) === 10.1875,
    "swing failed to offset odd sub-beat timing",
  );
  assert(
    getSubBeatEventTime(10, 2, 0.125, 0.5) === 10.25,
    "swing offset an even sub-beat",
  );

  const duck = getSidechainDuckShape(2, 1);
  assert(duck !== null, "sidechain amount 1 produced no duck shape");
  assert(
    approx(duck!.duckGainMultiplier, Math.pow(10, -SIDECHAIN_MAX_DUCK_DB / 20)),
    "sidechain duck depth check failed",
  );
  assert(
    approx(duck!.attackTime, 2.01),
    "sidechain attack timing check failed",
  );
  assert(
    approx(duck!.releaseTime, 2.18),
    "sidechain release timing check failed",
  );
  assert(
    getSidechainDuckShape(2, 0) === null,
    "sidechain amount 0 should leave output unchanged",
  );

  // evaluateExponentialApproach checks
  assert(
    evaluateExponentialApproach(0, 1, 0, 1, 0) === 0,
    "exp approach at start",
  );
  const mid = evaluateExponentialApproach(0, 1, 0, 1, 1);
  assert(mid > 0 && mid < 1, "exp approach mid");
  assert(
    Math.abs(evaluateExponentialApproach(0, 1, 0, 1, 100) - 1) < 1e-6,
    "exp approach asymptote",
  );
  assert(
    evaluateExponentialApproach(0, 1, 0, 0, 5) === 1,
    "exp approach zero tc guard",
  );

  // evaluateDroneEnvelope checks
  // Before sustain point → exponential-approach value.
  const beforeSustain = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    2.0,
    0.5,
    3.0,
    0.0001,
    1.0,
  );
  const expectedExp = 0.5 + (0.1 - 0.5) * Math.exp(-1.0 / (1 / 3));
  assert(
    Math.abs(beforeSustain - expectedExp) < 1e-9,
    "drone envelope before sustain should match exponential approach",
  );
  // At sustain point → sustain value.
  const atSustain = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    2.0,
    0.5,
    3.0,
    0.0001,
    2.0,
  );
  assert(
    Math.abs(atSustain - 0.5) < 1e-9,
    "drone envelope at sustain should equal sustain value",
  );
  // Partway through release → strictly between sustain and release target.
  const midRelease = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    2.0,
    0.5,
    3.0,
    0.0001,
    2.5,
  );
  assert(
    midRelease > 0.0001 && midRelease < 0.5,
    "drone envelope mid-release should be between sustain and release target",
  );
  assert(
    Math.abs(midRelease - 0.25005) < 1e-9,
    "drone envelope mid-release should be the linear midpoint",
  );
  // At/after stopTime → release target.
  const atStop = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    2.0,
    0.5,
    3.0,
    0.0001,
    3.0,
  );
  assert(
    Math.abs(atStop - 0.0001) < 1e-12,
    "drone envelope at stop should equal release target",
  );
  const afterStop = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    2.0,
    0.5,
    3.0,
    0.0001,
    4.0,
  );
  assert(
    Math.abs(afterStop - 0.0001) < 1e-12,
    "drone envelope after stop should equal release target",
  );
  // Null sustainTime → the LinearRamp replaces the SetTarget per spec, so
  // the curve is a straight line from (startTime, fromValue) to
  // (releaseEndTime, releaseTarget), NOT the exponential approach.
  const nullSustain = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    null,
    0.5,
    3.0,
    0.0001,
    2.5,
  );
  const expectedLinear = 0.1 + (0.0001 - 0.1) * (2.5 / 3.0);
  assert(
    Math.abs(nullSustain - expectedLinear) < 1e-9,
    "drone envelope with null sustain should follow the replacing linear ramp",
  );
  const nullSustainAtEnd = evaluateDroneEnvelope(
    0.1,
    0.5,
    0,
    1 / 3,
    null,
    0.5,
    3.0,
    0.0001,
    3.0,
  );
  assert(
    Math.abs(nullSustainAtEnd - 0.0001) < 1e-12,
    "drone envelope with null sustain should reach release target at stopTime",
  );
})();
