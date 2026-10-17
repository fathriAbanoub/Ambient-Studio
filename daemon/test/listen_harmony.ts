/**
 * test/listen_harmony.ts — DEV TOOL for ear/analyser checks (NOT part of
 * test/run_all.mjs). Renders ONE stem (full | padbass | melody | drone) from
 * the shared buildTimeline() output, so a chord/harmony analyser — or the
 * deterministic in-tool audit below — can inspect the harmony lanes without
 * the other lanes masking them. All stems are filtered copies of the same
 * timeline, so they sum to the full mix event-for-event; per-beat automation
 * records are kept in every stem.
 *
 * With Neo-Harmony on, the tool additionally audits the rendered stem's own
 * PCM per chord segment (no external analyser, deterministic Goertzel bins —
 * one bin per pitch class per octave, pitch-class-major so bin k's pitch
 * class is floor(k / CHROMA_OCTAVE_COUNT)):
 *   padbass — the segment's chord-tone pitch classes must hold at least
 *             CHORD_TONE_ENERGY_MIN of the summed chroma energy;
 *   drone   — the strongest pitch class must be the segment's chord root.
 * Segment boundaries come from the kernel chord-per-beat rows and the
 * timeline beat times; the first SLEW_DURATION_SEC of every segment after the
 * first is skipped (the shells' 600 ms root slew sounds the old→new
 * transition there). Chord-label counts from third-party analysers are never
 * an acceptance criterion — the assertions above are the whole contract.
 *
 * Usage: npx esbuild test/listen_harmony.ts --bundle --platform=node
 *        --format=cjs --target=node20 --outfile=build/listen_harmony.cjs
 *        && node build/listen_harmony.cjs <full|padbass|melody|drone> <on|off> [v2on|v2off] [ston|stoff]
 * The second argument is the enableNeoHarmony value (default on). The third
 * argument is the enableMelodyV2 value; unknown values are ignored safely
 * (legacy melody lane, no name suffix). The fourth argument is the
 * enableStochasticEvents value; unknown values fall back to the legacy gap
 * logic. Writes
 * /tmp/harmony_<flag>[_v2on|_v2off][_ston|_stoff]_<stem>.wav and prints the
 * path plus peak, RMS and clip count for the render.
 */
import {
  BlockSynth,
  buildTimeline,
  SLEW_DURATION_SEC,
  type SynthSink,
  type Timeline,
} from "../src/blockSynth";
import { goertzelBands } from "./goertzel";
import { chordPerBeat } from "./chordWalk";
import { writeFileSync } from "node:fs";
import {
  triadPitchClasses,
  SEMITONES_PER_OCTAVE,
  type EngineParams,
  type MusicalEvent,
} from "../../kernel/musicalLogic";
const SR = 44100;
const DURATION = 60; // 60 seconds is enough to hear 2 chord changes
const BLOCK_FRAMES = 4096;
const OUTPUT_DIR = "/tmp";
const CLIP_THRESHOLD = 0.999;
const ROOT_HZ = 220; // pitch class 0 = A

// Chroma bin grid: one Goertzel bin per pitch class per octave over
// CHROMA_OCTAVE_COUNT octaves starting at CHROMA_OCTAVE_OFFSET_START. The
// span covers the lowest folded drone fundamental (55 Hz drone, root fold
// down to −6 semitones → ~38.9 Hz ≈ pc 6, offset −3) up to the pad's upper
// chord tones (folded root +6 semitones, fifth +31 → ~1.9 kHz ≈ pc 1,
// offset +3).
const CHROMA_OCTAVE_OFFSET_START = -3;
const CHROMA_OCTAVE_COUNT = 7;

// Chord-tone energy floor for the padbass audit: measured chord-tone fraction
// was 0.98–1.00 per segment on the seed-42 walk (the padbass stem voices
// chord tones only; residual energy is envelope/decay spread), so the floor
// is a pollution guard well under the measurement, not a tightness claim.
const CHORD_TONE_ENERGY_MIN = 0.8;
// A segment whose total chroma energy is below this is silence — neither a
// strongest pitch class nor a chord-tone fraction is meaningful there.
const CHROMA_ENERGY_FLOOR = 1e-12;
// 5% of total chroma energy is clearly audible above envelope/decay spread.
const AUDIBLE_PC_ENERGY_FRACTION = 0.05;
// Print the three strongest pitch classes for the drone audit.
const TOP_CHROMA_DISPLAY_COUNT = 3;

const PARAMS: EngineParams = {
  scale: "majorPent", rootHz: ROOT_HZ, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true,
  enableBeats: true, seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap",
  sidechainAmount: 0,
  enableNeoHarmony: process.argv[3] !== "off",
  // Third CLI argument: enableMelodyV2. Unknown values fall back to the
  // legacy melody lane (undefined) and get no name suffix.
  enableMelodyV2:
    process.argv[4] === "v2on" ? true : process.argv[4] === "v2off" ? false : undefined,
  enableStochasticEvents:
    process.argv[5] === "ston" ? true : process.argv[5] === "stoff" ? false : undefined,
  drone: { layers: [{ hz: 55, amp: 0.15, pan: 0, timbre: "sine" as const }] },
};

// Stem filters by event type; `undefined` events are the per-beat automation
// anchors (sceneMix / panDriftPhase) and are kept in every stem.
const STEMS: Record<string, (ev: MusicalEvent) => boolean> = {
  full: () => true,
  padbass: (ev) => ev.type === "pad" || ev.type === "bass",
  melody: (ev) => ev.type === "melody",
  drone: (ev) => ev.type === "drone",
};

// Note names for pitch classes relative to rootHz = ROOT_HZ (A3): pc 0 is A.
const NOTE_NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"];
const noteName = (pc: number): string =>
  NOTE_NAMES[((pc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE];

const mod12 = (pc: number): number =>
  ((pc % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE;

// Pitch-class-major bin grid: bin k belongs to pitch class
// floor(k / CHROMA_OCTAVE_COUNT).
const CHROMA_BINS_HZ: number[] = [];
for (let pc = 0; pc < SEMITONES_PER_OCTAVE; pc++) {
  for (let o = 0; o < CHROMA_OCTAVE_COUNT; o++) {
    CHROMA_BINS_HZ.push(
      ROOT_HZ *
        Math.pow(
          2,
          (pc + (CHROMA_OCTAVE_OFFSET_START + o) * SEMITONES_PER_OCTAVE) /
            SEMITONES_PER_OCTAVE,
        ),
    );
  }
}

/** Summed chroma energy of one PCM window: one Goertzel bin per pitch class
 * per octave, octaves summed per pitch class. */
function chromaOfWindow(l: Float32Array, r: Float32Array, startFrame: number, frames: number): number[] {
  const powers = goertzelBands(
    l.subarray(startFrame),
    r.subarray(startFrame),
    frames,
    CHROMA_BINS_HZ,
    SR,
  );
  const chroma = new Array<number>(SEMITONES_PER_OCTAVE).fill(0);
  for (let k = 0; k < powers.length; k++) {
    chroma[Math.floor(k / CHROMA_OCTAVE_COUNT)] += powers[k];
  }
  return chroma;
}

interface Segment { startBeat: number; endBeat: number; rootPc: number; quality: string; }

/** Group consecutive beats with the same (rootPc, quality) into segments. */
function groupSegments(rows: Array<{ rootPc: number; quality: string }>): Segment[] {
  const segs: Segment[] = [];
  for (let b = 0; b < rows.length; b++) {
    const last = segs[segs.length - 1];
    if (last && last.rootPc === rows[b].rootPc && last.quality === rows[b].quality) {
      last.endBeat = b + 1;
    } else {
      segs.push({ startBeat: b, endBeat: b + 1, rootPc: rows[b].rootPc, quality: rows[b].quality });
    }
  }
  return segs;
}

class WavSink implements SynthSink {
  peak = 0;
  sumSq = 0;
  n = 0;
  clips = 0;
  private l: Float32Array[] = [];
  private r: Float32Array[] = [];
  writeBlock(l: Float32Array, r: Float32Array, frames: number) {
    for (let i = 0; i < frames; i++) {
      for (const x of [l[i], r[i]]) {
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        if (a >= CLIP_THRESHOLD) this.clips++;
        this.sumSq += x * x;
        this.n++;
      }
    }
    this.l.push(l.slice(0, frames));
    this.r.push(r.slice(0, frames));
  }
  rms(): number { return this.n > 0 ? Math.sqrt(this.sumSq / this.n) : 0; }
  /** De-interleaved full-length mono streams for the chroma audit. */
  merged(): { l: Float32Array; r: Float32Array; frames: number } {
    const frames = this.l.reduce((a, b) => a + b.length, 0);
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    let off = 0;
    for (let i = 0; i < this.l.length; i++) {
      l.set(this.l[i], off);
      r.set(this.r[i], off);
      off += this.l[i].length;
    }
    return { l, r, frames };
  }
  write(path: string) {
    const totalFrames = this.l.reduce((a, b) => a + b.length, 0);
    const buf = Buffer.alloc(44 + totalFrames * 4);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + totalFrames * 4, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(totalFrames * 4, 40);

    let offset = 44;
    for (let i = 0; i < this.l.length; i++) {
      const left = this.l[i];
      const right = this.r[i];
      for (let j = 0; j < left.length; j++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, left[j] * 32767)), offset);
        offset += 2;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, right[j] * 32767)), offset);
        offset += 2;
      }
    }
    writeFileSync(path, buf);
  }
}

async function main() {
  const stemArg = process.argv[2] ?? "full";
  const keep = STEMS[stemArg];
  if (!keep) {
    console.error(`unknown stem "${stemArg}" — expected one of: ${Object.keys(STEMS).join(", ")}`);
    process.exit(1);
  }
  const flag = process.argv[3] === "off" ? "off" : "on";
  const v2Suffix =
    process.argv[4] === "v2on" || process.argv[4] === "v2off" ? `_${process.argv[4]}` : "";
  const stSuffix =
    process.argv[5] === "ston" || process.argv[5] === "stoff" ? `_${process.argv[5]}` : "";

  const timeline: Timeline = buildTimeline(PARAMS, DURATION);
  const stemTimeline = {
    ...timeline,
    events: timeline.events.filter((te) => te.ev === undefined || keep(te.ev)),
  };
  const synth = new BlockSynth({ params: PARAMS, timeline: stemTimeline, sampleRate: SR, blockFrames: BLOCK_FRAMES, durationSec: DURATION });
  const sink = new WavSink();
  await synth.render(sink);
  const path = `${OUTPUT_DIR}/harmony_${flag}${v2Suffix}${stSuffix}_${stemArg}.wav`;
  sink.write(path);
  console.log(`wrote ${path}`);
  console.log(`  peak ${sink.peak.toFixed(6)}, rms ${sink.rms().toFixed(6)}, clips (|x|>=${CLIP_THRESHOLD}) ${sink.clips}`);

  if (flag !== "on") return; // the chroma audit needs chord semantics

  const rows = chordPerBeat(PARAMS, timeline.beats);
  const segs = groupSegments(rows);
  // Ascending beat times from the timeline's per-beat records (scene bpm
  // interpolation makes beat times uneven — never assume beatSec is fixed).
  const beatTimes: number[] = [];
  for (const te of timeline.events) if (te.beat) beatTimes.push(te.t);
  const preRollSec = timeline.preRollSec;
  // PCM frame 0 corresponds to timeline time preRollSec (the shells trim the
  // pre-roll); the render ends at preRollSec + DURATION.
  const { l, r, frames: totalFrames } = sink.merged();
  let failures = 0;

  console.log(`\nchroma audit (${stemArg} stem, ${segs.length} chord segments, slew window ${SLEW_DURATION_SEC}s skipped after each segment start):`);
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    // The shells' 600 ms root slew sounds the old→new transition at each
    // segment start after the first — skip that window.
    const slewSkip = si > 0 ? SLEW_DURATION_SEC : 0;
    const startT = beatTimes[seg.startBeat] - preRollSec + slewSkip;
    const endT = (seg.endBeat < beatTimes.length ? beatTimes[seg.endBeat] : preRollSec + DURATION) - preRollSec;
    const startFrame = Math.max(0, Math.round(startT * SR));
    const endFrame = Math.min(totalFrames, Math.round(endT * SR));
    const frames = endFrame - startFrame;
    const label = `${noteName(seg.rootPc)} ${seg.quality}`;
    if (frames <= 0) {
      console.log(`  ${label}: window is empty after the slew skip — skipped`);
      continue;
    }
    const chroma = chromaOfWindow(l, r, startFrame, frames);
    const total = chroma.reduce((a, b) => a + b, 0);
    if (total < CHROMA_ENERGY_FLOOR) {
      console.log(`  ${label}: total chroma energy ${total.toExponential(2)} below floor — skipped`);
      continue;
    }

    if (stemArg === "padbass") {
      const chordPcs = triadPitchClasses(seg.rootPc, seg.quality as "major" | "minor");
      const chordEnergy = chordPcs.reduce((a, pc) => a + chroma[pc], 0);
      const fraction = chordEnergy / total;
      const ok = fraction >= CHORD_TONE_ENERGY_MIN;
      if (!ok) failures++;
      console.log(`  ${label}: chord-tone fraction ${fraction.toFixed(3)} (min ${CHORD_TONE_ENERGY_MIN}) ${ok ? "PASS" : "FAIL"}`);
    } else if (stemArg === "drone") {
      let strongest = 0;
      for (let pc = 1; pc < SEMITONES_PER_OCTAVE; pc++) {
        if (chroma[pc] > chroma[strongest]) strongest = pc;
      }
      const ok = strongest === seg.rootPc;
      if (!ok) failures++;
      const top = chroma
        .map((e, pc) => ({ e, pc }))
        .sort((a, b) => b.e - a.e)
        .slice(0, TOP_CHROMA_DISPLAY_COUNT)
        .map((x) => `${noteName(x.pc)} ${(x.e / total).toFixed(3)}`)
        .join(", ");
      console.log(`  ${label}: strongest pc ${strongest} (${noteName(strongest)}) ${ok ? "PASS" : "FAIL"} — top: ${top}`);
    } else {
      const names = chroma
        .map((e, pc) => ({ e, pc }))
        .filter((x) => x.e > total * AUDIBLE_PC_ENERGY_FRACTION)
        .map((x) => noteName(x.pc))
        .join(" ");
      console.log(`  ${label}: audible pcs (>5% of energy): ${names}`);
    }
  }

  if (stemArg === "melody") {
    console.log("\nmelody pitch classes per chord segment (from the events):");
    for (const seg of segs) {
      const counts = new Map<number, number>();
      for (const te of timeline.events) {
        const ev = te.ev;
        if (!ev || ev.type !== "melody" || ev.hz === undefined) continue;
        if (ev.beatIndex < seg.startBeat || ev.beatIndex >= seg.endBeat) continue;
        const pc = mod12(Math.round(SEMITONES_PER_OCTAVE * Math.log2(ev.hz / ROOT_HZ)));
        counts.set(pc, (counts.get(pc) ?? 0) + 1);
      }
      const pcs = [...counts.entries()].sort((a, b) => a[0] - b[0])
        .map(([pc, n]) => `${noteName(pc)}×${n}`).join(" ");
      console.log(`  ${noteName(seg.rootPc)} ${seg.quality}: ${pcs || "(no melody events)"}`);
    }
  }

  if (stemArg === "padbass" || stemArg === "drone") {
    console.log(failures === 0 ? "\nCHROMA AUDIT PASS" : `\n${failures} CHROMA AUDIT FAILURES`);
    if (failures > 0) process.exit(1);
  }
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
