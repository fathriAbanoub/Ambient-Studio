/**
 * test/phase3.ts — cadence snap + outro fade + MP3 sink checks:
 *   1. snapToBar math: several BPMs/durations land on whole bars; < 1 bar
 *      clamps up to one bar; deterministic integer frame counts
 *   2. fade is block-size invariant (D4-safe) and actually fades the tail
 *   3. MP3 via FfmpegStdinSink (libmp3lame): decodes, right duration, and the
 *      piped PCM is byte-identical to a HashSink reference of the same render
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { BlockSynth, buildTimeline } from "../src/blockSynth";
import { HashSink, FfmpegStdinSink, floatToPcm16 } from "../src/sinks";
import { snapToBar, makeFadeSink } from "../src/cadence";
import { ffprobeJson } from "../src/ffmpeg";
import type { SynthSink } from "../src/blockSynth";

const SR = 44100;
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

const PARAMS = {
  scale: "majorPent" as const, rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap" as const, sidechainAmount: 0,
};

// ── 1. snapToBar ──
{
  const cases: Array<[number, number, number]> = [
    [72, 200, 200],          // barSec = 10/3 → exactly 60 bars
    [72, 28800, 28800],      // 8 h at 72 → 8640 bars exactly
    [120, 240, 240],         // barSec = 2 → 120 bars exactly
    [120, 1.5, 2],           // < 1 bar → clamp UP to one bar
    [120, 0.3, 2],           // way < 1 bar → one bar
    [71, 100, 101.41],       // non-integer barSec — nearest bar (checked as band)
    [144, 3600, 3600],       // barSec = 5/3 → 2160 bars exactly
  ];
  for (const [bpm, dur, expect] of cases) {
    const s = snapToBar(dur, bpm, SR);
    const barSec = (4 * 60) / bpm;
    if (typeof expect === "number" && barSec * Math.round(dur / barSec) !== dur) {
      // approximate case: expect is a seconds value
      check(`snap ${dur}s@${bpm}`, Math.abs(s.snappedSec - expect) < barSec / 2 && s.totalFrames % s.framesPerBar === 0,
        `${s.bars} bars → ${s.snappedSec.toFixed(3)}s (${s.totalFrames} frames, fpb ${s.framesPerBar})`);
    } else {
      check(`snap ${dur}s@${bpm}`, Math.abs(s.snappedSec - expect) < 0.001 && s.totalFrames % s.framesPerBar === 0,
        `${s.bars} bars → ${s.snappedSec.toFixed(4)}s (${s.totalFrames} frames)`);
    }
  }
  // determinism: same inputs → same frame count, always integer
  const s1 = snapToBar(1000.37, 73.5, SR);
  const s2 = snapToBar(1000.37, 73.5, SR);
  check("snap deterministic", s1.totalFrames === s2.totalFrames && Number.isInteger(s1.totalFrames), `${s1.totalFrames} frames`);
}

// ── 2. fade ──
function renderFaded(block: number, fade: boolean, dur: number) {
  const timeline = buildTimeline(PARAMS, dur);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: block, durationSec: dur });
  const sink = new HashSink();
  const totalFrames = Math.round(dur * SR);
  const inner: SynthSink = fade
    ? makeFadeSink(sink, totalFrames, 3, SR)
    : sink;
  void synth.render(inner);
  return { sink, totalFrames };
}
{
  const a = renderFaded(4096, true, 20);
  const b = renderFaded(1024, true, 20);
  check("fade block-invariant", a.sink.sha256() === b.sink.sha256(), `${a.sink.sha256().slice(0, 16)} vs ${b.sink.sha256().slice(0, 16)}`);
  const u = renderFaded(4096, false, 20);
  check("fade changes tail (not whole file)", u.sink.sha256() !== a.sink.sha256(), "faded != unfaded");
  // tail is actually silent at the very end: re-render last 100ms directly
  const timeline = buildTimeline(PARAMS, 20);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: 4096, durationSec: 20 });
  let lastSample = 1;
  const tail = makeFadeSink({ writeBlock(l, r, frames) { lastSample = Math.max(Math.abs(l[frames - 1]), Math.abs(r[frames - 1])); } }, Math.round(20 * SR), 3, SR);
  // render fully but only keep observing — cheap enough at 20 s
  void synth.render(tail);
  check("fade ends near silence", lastSample < 0.01, `last sample abs=${lastSample.toFixed(5)}`);
}

// ── 3. MP3 sink ──
async function main() {
  const DUR = 12;
  const tmp = fs.mkdtempSync("/tmp/ambientd-p3-");
  const out = path.join(tmp, "out.mp3");

  // reference PCM hash (HashSink, same render)
  const timeline = buildTimeline(PARAMS, DUR);
  const ref = new HashSink();
  await new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: 4096, durationSec: DUR }).render(makeFadeSink(ref, Math.round(DUR * SR), 3, SR));

  // MP3 render
  const timeline2 = buildTimeline(PARAMS, DUR);
  const synth2 = new BlockSynth({ params: PARAMS, timeline: timeline2, sampleRate: SR, blockFrames: 4096, durationSec: DUR });
  const enc = new FfmpegStdinSink(out, SR, { args: ["-c:a", "libmp3lame", "-b:a", "192k"] });
  const fade = makeFadeSink(enc, Math.round(DUR * SR), 3, SR);
  await synth2.render(fade);
  const fin = await enc.finish();

  check("mp3 ffmpeg exit 0", fin.exitCode === 0, `exit=${fin.exitCode} ${fin.stderr.slice(-120)}`);
  check("mp3 piped PCM == reference", fin.sha256 === ref.sha256(), `${fin.sha256.slice(0, 16)} vs ${ref.sha256().slice(0, 16)}`);
  const probe = await ffprobeJson(out);
  const dur = Number(probe.format.duration ?? -1);
  check("mp3 decodes, duration ≈ 12 s", probe.streams[0]?.codec_name === "mp3" && Math.abs(dur - DUR) < 0.2, `codec=${probe.streams[0]?.codec_name} dur=${dur.toFixed(2)}s size=${fs.statSync(out).size}`);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? "PHASE3 ALL PASS" : `${failures} PHASE3 FAILURES`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
