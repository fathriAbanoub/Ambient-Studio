/**
 * test/harmony_render.ts — Phase 2 Neo-Harmony checks for the daemon shell.
 *   1. enableNeoHarmony ABSENT == explicitly false (byte-identical digests on
 *      this machine), and the 20 s flag-off peak/RMS match the pre-change
 *      render within LEGACY_AUDIO_TOLERANCE (portable across machines — same
 *      literals as space_reverb.ts: Phase 2 must not move the flag-off audio
 *      either). The whole flag-off EVENT stream is additionally pinned
 *      exactly by the rounded-hash literals in kernel harmony/space tests,
 *      so these audio checks generalize to any duration.
 *   2. flag ON: output differs, zero non-finite samples, exact frame count,
 *      and is block-size invariant (4096 vs 1024).
 *   3. Per-chord-segment sounding pitch classes over a longer walk: every
 *      pad/bass event outside the 600 ms boundary slew window sits inside
 *      the segment chord's triad ∪ declared colour pool (asserted), reported
 *      with note names.
 *   4. Measurements (printed, not asserted): peak / RMS / clip count, off vs on.
 * Run: node build/harmony_render.cjs (bundled by test/run_all.mjs)
 */
import { BlockSynth, buildTimeline, type SynthSink } from "../src/blockSynth";
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  isHarmonicCycleBoundary,
  triadPitchClasses,
  SEMITONES_PER_OCTAVE,
  MINOR_COLOUR_INTERVALS,
  MAJOR_COLOUR_INTERVALS,
  type EngineParams,
} from "../../kernel/musicalLogic";
import { createHash } from "node:crypto";

const SR = 44100;
// Matches space_reverb.ts — the duration the legacy peak/RMS literals were
// captured at (aggregates over different durations are not comparable).
const LEGACY_CHECK_DURATION_SEC = 20;
// Long enough that ≥ 2 chord boundaries (every 32 beats ≈ 26.7 s at 72 bpm,
// incl. the 4-bar pre-roll) fall inside the rendered window.
const CHORD_WALK_DURATION_SEC = 60;

// Captured from the UNMODIFIED code (commit 19e4282): BASE_PARAMS below, seed
// 42, 20 s, block 4096, reverbLevel absent. RMS is over both channels.
// ponytail: tolerance check, not a byte check; the strict byte-for-byte proof
// is the same-machine A/B described in space_reverb.ts's header.
const LEGACY_PEAK = 0.5334128737449646;
const LEGACY_RMS = 0.09762361140805774;
const LEGACY_AUDIO_TOLERANCE = 1e-6;

const BLOCK_FRAMES_DEFAULT = 4096;
const BLOCK_FRAMES_SMALL = 1024;
const CLIP_THRESHOLD = 0.999;

const BASE_PARAMS: EngineParams = {
  scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap", sidechainAmount: 0,
  drone: { layers: [0, 1, 2, 3].map((i) => ({ hz: 55 + i * 8, amp: 0.15, pan: -1 + (2 * i) / 3, timbre: "sine" as const })) },
};

// Note names for pitch classes relative to rootHz = 220 (A3): pc 0 is A.
const NOTE_NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"];
const noteName = (pc: number): string =>
  NOTE_NAMES[((pc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE];

class MeterSink implements SynthSink {
  peak = 0;
  sumSq = 0;
  n = 0;
  clips = 0;
  nonFinite = 0;
  private bufL: Float32Array[] = [];
  private bufR: Float32Array[] = [];
  writeBlock(l: Float32Array, r: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i++) {
      for (const x of [l[i], r[i]]) {
        if (!Number.isFinite(x)) this.nonFinite++;
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        if (a >= CLIP_THRESHOLD) this.clips++;
        this.sumSq += x * x;
        this.n++;
      }
    }
    this.bufL.push(l.slice(0, frames));
    this.bufR.push(r.slice(0, frames));
  }
  digest(): string {
    // Hash the full L stream then the full R stream — NOT per-chunk
    // interleaved, so the digest is block-size invariant.
    const h2 = createHash("sha256");
    for (let i = 0; i < this.bufL.length; i++) h2.update(Buffer.from(this.bufL[i].buffer as ArrayBuffer));
    for (let i = 0; i < this.bufR.length; i++) h2.update(Buffer.from(this.bufR[i].buffer as ArrayBuffer));
    return h2.digest("hex");
  }
  rms(): number { return Math.sqrt(this.sumSq / this.n); }
}

async function render(enableNeoHarmony: boolean | undefined, blockFrames: number, durationSec: number) {
  const params: EngineParams = enableNeoHarmony === undefined
    ? { ...BASE_PARAMS }
    : { ...BASE_PARAMS, enableNeoHarmony };
  const timeline = buildTimeline(params, durationSec);
  const synth = new BlockSynth({ params, timeline, sampleRate: SR, blockFrames, durationSec });
  const sink = new MeterSink();
  const stats = await synth.render(sink);
  return { sink, stats, digest: sink.digest(), timeline };
}

/**
 * Chord per beat, from the same deterministic kernel loop buildTimeline runs
 * (same init order, same per-beat bpm stepping). Returns the chord root pc
 * and quality for every beat, plus whether the beat is a boundary beat —
 * there the shells' 600 ms slew makes the sounding root transitional.
 */
function chordPerBeat(params: EngineParams, beatCount: number): Array<{
  rootPc: number; quality: string; boundary: boolean;
}> {
  let state = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, params);

  const rows: Array<{ rootPc: number; quality: string; boundary: boolean }> = [];
  for (let i = 0; i < beatCount; i++) {
    const boundary = isHarmonicCycleBoundary(state.beat);
    const { nextState } = getMusicalEvents(state.beat, { ...state }, params);
    rows.push({ rootPc: nextState.chordRootPc, quality: nextState.chordQuality, boundary });
    state = nextState;
  }
  return rows;
}

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

const mod12 = (pc: number): number =>
  ((pc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;

async function main() {
  // ── Audio checks at the legacy duration ──────────────────────────────────
  const off = await render(undefined, BLOCK_FRAMES_DEFAULT, LEGACY_CHECK_DURATION_SEC);
  const explicitOff = await render(false, BLOCK_FRAMES_DEFAULT, LEGACY_CHECK_DURATION_SEC);
  const on = await render(true, BLOCK_FRAMES_DEFAULT, LEGACY_CHECK_DURATION_SEC);
  const onSmall = await render(true, BLOCK_FRAMES_SMALL, LEGACY_CHECK_DURATION_SEC);

  const peakDiff = Math.abs(off.sink.peak - LEGACY_PEAK);
  const rmsDiff = Math.abs(off.sink.rms() - LEGACY_RMS);
  check("flag_off_matches_prechange_peak_rms", peakDiff < LEGACY_AUDIO_TOLERANCE && rmsDiff < LEGACY_AUDIO_TOLERANCE,
    `peak diff ${peakDiff.toExponential(2)}, rms diff ${rmsDiff.toExponential(2)} (tolerance ${LEGACY_AUDIO_TOLERANCE})`);
  check("flag_absent_equals_flag_false", off.digest === explicitOff.digest,
    `${off.digest.slice(0, 16)}… vs ${explicitOff.digest.slice(0, 16)}…`);
  check("flag_on_differs", on.digest !== off.digest, "chord walk changed the output");
  check("nonfinite_zero_both", off.sink.nonFinite === 0 && on.sink.nonFinite === 0,
    `off=${off.sink.nonFinite} on=${on.sink.nonFinite}`);
  check("frames_exact_both",
    off.stats.framesWritten === LEGACY_CHECK_DURATION_SEC * SR && on.stats.framesWritten === LEGACY_CHECK_DURATION_SEC * SR,
    `${off.stats.framesWritten}/${on.stats.framesWritten} vs ${LEGACY_CHECK_DURATION_SEC * SR}`);
  check("block_invariance_flag_on", on.digest === onSmall.digest,
    `${BLOCK_FRAMES_DEFAULT} ${on.digest.slice(0, 12)}… vs ${BLOCK_FRAMES_SMALL} ${onSmall.digest.slice(0, 12)}…`);

  // ── Per-segment pitch-class audit over the longer walk ───────────────────
  const walkOn = await render(true, BLOCK_FRAMES_DEFAULT, CHORD_WALK_DURATION_SEC);
  const walkOff = await render(undefined, BLOCK_FRAMES_DEFAULT, CHORD_WALK_DURATION_SEC);
  const beats = chordPerBeat({ ...BASE_PARAMS, enableNeoHarmony: true }, walkOn.timeline.beats);
  const segmentPcs = new Map<string, Set<number>>(); // "rootPc:quality" → sounding pcs
  let outsidePool = 0;
  let auditedEvents = 0;
  let skippedBoundaryEvents = 0;
  for (const te of walkOn.timeline.events) {
    const ev = te.ev;
    if (!ev || (ev.type !== "pad" && ev.type !== "bass") || ev.hz === undefined) continue;
    const row = beats[ev.beatIndex];
    if (!row) continue;
    if (row.boundary) { skippedBoundaryEvents++; continue; }
    const pc = mod12(Math.round(SEMITONES_PER_OCTAVE * Math.log2(ev.hz / BASE_PARAMS.rootHz)));
    const key = `${row.rootPc}:${row.quality}`;
    let set = segmentPcs.get(key);
    if (!set) { set = new Set(); segmentPcs.set(key, set); }
    set.add(pc);
    const pool = new Set<number>([
      ...triadPitchClasses(row.rootPc, row.quality as "major" | "minor"),
      ...(row.quality === "major" ? MAJOR_COLOUR_INTERVALS : MINOR_COLOUR_INTERVALS),
    ]);
    auditedEvents++;
    if (!pool.has(pc)) outsidePool++;
  }
  check("segment_pcs_within_chord_and_colour", outsidePool === 0 && segmentPcs.size >= 3,
    `${auditedEvents} pad/bass events audited across ${segmentPcs.size} segments, ${outsidePool} outside the pool (${skippedBoundaryEvents} slew-window events skipped)`);

  console.log(`\nchord walk (seed 42, ${CHORD_WALK_DURATION_SEC} s, flag on) — chord [sounding pcs]:`);
  for (const [key, pcs] of segmentPcs) {
    const [rootPcStr, quality] = key.split(":");
    const rootPc = Number(rootPcStr);
    const names = [...pcs].sort((a, b) => a - b).map(noteName).join(" ");
    console.log(`  ${noteName(rootPc)} ${quality} [${key}] → sounding: ${names}`);
  }

  console.log(`\nmeasurements (flag off vs on, ${CHORD_WALK_DURATION_SEC} s):`);
  console.log(`  peak: ${walkOff.sink.peak.toFixed(6)} -> ${walkOn.sink.peak.toFixed(6)}`);
  console.log(`  rms:  ${walkOff.sink.rms().toFixed(6)} -> ${walkOn.sink.rms().toFixed(6)}`);
  console.log(`  clips (|x|>=${CLIP_THRESHOLD}): ${walkOff.sink.clips} -> ${walkOn.sink.clips}`);

  console.log(failures === 0 ? "\nALL HARMONY CHECKS PASS" : `\n${failures} HARMONY CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
