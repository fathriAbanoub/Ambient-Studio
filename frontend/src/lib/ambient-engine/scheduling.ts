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
 *       beats (including the downbeat) are untouched. Both shells import
 *       getSubBeatEventTime() so live and offline renders stay sample-
 *       aligned for the same params.swing value.
 *   ✅ ADD (sidechain helper): getSidechainDuckShape() returns the duck
 *       gain multiplier, attack time, and release time for a kick at
 *       `kickTime`. Returns null when sidechainAmount is 0/undefined so
 *       the shells can early-out without scheduling any automation.
 *   ✅ ADD (self-checks): testSchedulingHelpers() IIFE asserts:
 *       - swing=0 leaves odd sub-beat timing unchanged
 *       - swing=0.5 offsets odd sub-beats by 0.5 * sixteenthSec
 *       - swing never offsets even sub-beats
 *       - sidechain amount=1 produces the full 5 dB duck
 *       - sidechain attack/release times are kickTime + 0.01 / +0.18
 *       - sidechain amount=0 returns null (no duck)
 *     Skipped in production to avoid the import-time cost.
 */

export const MAX_SWING = 0.6;
export const SIDECHAIN_MAX_DUCK_DB = 5;
export const SIDECHAIN_ATTACK_SEC = 0.01;
export const SIDECHAIN_RELEASE_SEC = 0.18;

export interface SidechainDuckShape {
  duckGainMultiplier: number;
  attackTime: number;
  releaseTime: number;
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

(function testSchedulingHelpers() {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production")
    return;

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
  assert(duck!.attackTime === 2.01, "sidechain attack timing check failed");
  assert(duck!.releaseTime === 2.18, "sidechain release timing check failed");
  assert(
    getSidechainDuckShape(2, 0) === null,
    "sidechain amount 0 should leave output unchanged",
  );
})();
