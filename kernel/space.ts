/**
 * space.ts — Phase 1 "Space" shared layer: reverb topology constants and the
 * medium noise bed source, defined once and imported by all three synthesis
 * shells (LiveEngine, renderAmbient, daemon blockSynth).
 *
 * Pure module: no Web Audio types, importable in Node. The browser shells
 * build the Web Audio graph from these constants; the daemon ports the same
 * topology per-sample (see blockSynth SpaceComb / SpaceAllpass).
 *
 * RNG CONTRACT: the noise bed is a SEPARATE mulberry32 stream derived from
 * the recipe seed via MEDIUM_NOISE_SEED_SALT. It consumes ZERO draws from
 * the main kernel stream (guarded by the rngState test in space.test.ts).
 *
 * Topology (per channel), corrected per re-derivation:
 *   send (tonal bus, post-sidechain) -> predelay -> 4 parallel combs
 *   (delay + feedback g) -> sum -> wet-tone LPF -> 2 series allpasses
 *   -> wet gain -> master out. Comb feedback g is DERIVED at module load
 *   from REVERB_RT60_TARGET_SEC via g = 10^(-3·L/RT60), so the table cannot
 *   drift from the target if either constant is retuned.
 *
 * Delay lengths are specified as SAMPLE COUNTS at SPACE_REFERENCE_SAMPLE_RATE
 * (44100 — the offline/daemon reference rate), following the NOISE_BUFFER_SAMPLES
 * precedent: the sample COUNT is the contract. Shells convert to SECONDS
 * (count / 44100) and DelayNode takes seconds, so the loop TIME is identical
 * at 48000 Hz — and RT60 = -3·L/log10(g) has no sample-rate term (the
 * feedback gains are dimensionless, the damper cutoff is in Hz), so the tail
 * LENGTH is unchanged too; only sub-sample interpolation rounding differs.
 * The bed is the one rate-sensitive piece: its fixed 352800-sample buffer
 * plays 8.0 s at 44100 but 7.35 s at 48000. The offline renderer and the
 * daemon run at 44100 and stay sample-exact.
 *
 * ponytail: daemon-vs-browser parity of the combs and allpasses was first
 * ASSUMED from the round2 master-delay verification (+128-sample feedback
 * re-entry). It is now impulse-verified directly against headless Chromium
 * (OfflineAudioContext vs SpaceComb/SpaceAllpass): allpass bit-exact over
 * 16384 samples, comb within 5.96e-8 (one f32 ULP at tail amplitude). The
 * check lives in daemon/test/space_browser_impulse.mjs (needs chromium; not
 * wired into run_all). Ceiling: single nodes verified — the full wet chain
 * (predelay + damper + wet-sum) end-to-end is not yet parity-checked.
 */

import { mulberry32Next } from "./musicalLogic";

// ── Reverb topology ──────────────────────────────────────────────────────────

export const SPACE_REFERENCE_SAMPLE_RATE = 44100;

// ponytail: 4-comb + 2-allpass Schroeder topology — the smallest structure
// with a usable long tail; upgrading to Freeverb-style 8 combs means +4
// delay/LPF/gain nodes per shell and +1 ring+Biquad per comb in the daemon.
// ~61/79/103/131 ms — mutually incommensurate, long-tail oriented (the
// classic Schroeder 29.7-43.7 ms set is tuned for rooms, not 6-9 s tails).
export const REVERB_COMB_DELAY_SAMPLES = [2690, 3484, 4542, 5777] as const;

export const REVERB_RT60_TARGET_SEC = 7.0;

// Derived, not stored: g_i = 10^(-3·L_i/RT60) so every comb decays at the
// same low-band RT60. Worked check: RT60 = -3·L/log10(g) ≡ target exactly.
export const REVERB_COMB_FEEDBACK: readonly number[] = REVERB_COMB_DELAY_SAMPLES.map(
  (samples) => Math.pow(10, (-3 * (samples / SPACE_REFERENCE_SAMPLE_RATE)) / REVERB_RT60_TARGET_SEC),
);

// In-loop damping is deliberately NOT used: a peak-free in-loop LP needs
// RBJ qLinear ≈ 0.707 (Butterworth), which in the Web Audio dB-domain Q is a
// NEGATIVE Q value — a cross-browser interpretation hazard — and any peaking
// in-loop damper (|H| up to ≈1.16 at Q_dB ≥ 0) drives the g ≈ 0.94 loops
// above unity (measured: impulse grew to 12.3 before the move). The damper
// therefore sits after the comb sum, where it darkens the wet tone without
// touching loop stability; the comb RT60 below is then exact at all
// frequencies. Upgrade: probe negative-Q parity in the target browsers,
// relax the shared Biquad's q > 0 floor, and move the LP in-loop for true
// HF-tail shortening.
export const REVERB_DAMP_HZ = 4500;
export const REVERB_DAMP_Q_DB = 1.0;

// 2 series allpasses for diffusion. The canonical allpass needs feedback, so
// each stage re-enters one render quantum late in Web Audio — the daemon port
// mirrors that (+COEFF_QUANTUM_FRAMES), keeping shells sample-aligned.
export const REVERB_ALLPASS_DELAY_SAMPLES = [234, 781] as const; // ≈5.3 / 17.7 ms
export const REVERB_ALLPASS_GAIN = 0.5;

export const REVERB_PREDELAY_SAMPLES = 2205; // 50 ms — inside the sourced 40-80 ms band

// Wet full-scale gain at reverbLevel = 1. The send is post-tonal-bus
// (already ×0.3), and 4 combs each contribute ≈1 early tap, so 0.25 puts the
// early wet energy near parity with the dry bus.
export const REVERB_WET_GAIN = 0.25;

export const REVERB_LEVEL_MAX = 1;

/** Clamp a recipe-supplied level into [0, 1]; non-finite/absent -> fallback 0. */
export function resolveReverbLevel(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(REVERB_LEVEL_MAX, Math.max(0, value));
}

// ── Medium noise bed ─────────────────────────────────────────────────────────

// 8.0 s at 44100 (1.35 MiB mono f32). At the bed level (-50 dBFS-ish) a
// filtered-noise loop of this length has no perceptible periodicity — noise
// has no distinct events to betray the loop, unlike the 0.5 s kernel table
// whose threshold rule produces audible repeating click patterns.
export const MEDIUM_NOISE_BUFFER_SAMPLES = 352800;

// Integer golden-ratio constant (2^32/φ): the standard hash-mixing salt, so
// bedStream(seed) != mainStream(seed) for every seed including 0.
export const MEDIUM_NOISE_SEED_SALT = 0x9e3779b9;

export function mediumNoiseSeed(seed: number): number {
  return (seed ^ MEDIUM_NOISE_SEED_SALT) >>> 0;
}

/**
 * The medium noise source: white uniform (-1, 1) samples from a dedicated
 * mulberry32 stream. Browser shells fill an AudioBuffer with this table and
 * loop it; the daemon indexes the same table with wrap, so offline and
 * daemon renders are sample-identical. ZERO draws from the main kernel
 * stream — the state object below is local to this generator.
 */
export function generateMediumNoiseTable(seed: number): Float32Array {
  const data = new Float32Array(MEDIUM_NOISE_BUFFER_SAMPLES);
  const rngState = { rngState: mediumNoiseSeed(seed) };
  for (let i = 0; i < MEDIUM_NOISE_BUFFER_SAMPLES; i++) {
    data[i] = mulberry32Next(rngState) * 2 - 1;
  }
  return data;
}

// Bed tone: lowpassed white ("air"). Same lowpass shape as the future wear
// hiss (5000 Hz); the two stacks are tuned independently for now.
// ponytail: single LP, no HP shelf — upgrade to a spectral tilt if the bed
// reads too dark/bright by ear.
export const BED_NOISE_LP_HZ = 5000;
export const BED_NOISE_LP_Q = 0.7;
// Full-scale bed gain at reverbLevel = 1: white RMS 0.577 × 0.005 ≈ -51 dBFS —
// felt more than heard, like room air on a recording.
export const BED_NOISE_GAIN = 0.005;
