/**
 * test/round2_extra.ts — regression checks for the round-2 fixes:
 *
 *   1. Biquad Q convention: ambientd's Biquad must reproduce the browser's
 *      actual BiquadFilterNode.getFrequencyResponse magnitudes (fixtures
 *      captured in headless Chromium, test/round2/*.json) — dB-Q for
 *      lpf/hpf, linear-Q for bpf, max|err| ≤ 1e-6.
 *   2. verifyRenderedOutput: a real render passes; a deliberately truncated
 *      file must FAIL loudly (the "correct metadata, short content" gap).
 *   3. Backpressure stress: an ffmpeg consumer throttled with -readrate
 *      must exercise the drain path (drainWaits > 0) and still produce a
 *      byte-identical PCM stream (hash equal to the unthrottled reference)
 *      with correct duration.
 *
 * Run: node build/round2_extra.cjs   (AMBIENTD_DATA set by run_all.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { Biquad, BlockSynth, buildTimeline } from "../src/blockSynth";
import { FfmpegStdinSink, HashSink } from "../src/sinks";
import { WavFileSink } from "../src/sinks";
import { verifyRenderedOutput } from "../src/jobs";
import { ffprobeJson } from "../src/ffmpeg";
import { makeFadeSink } from "../src/cadence";

// CJS bundle: __dirname is available (import.meta is not)
declare const __dirname: string;
const root = path.resolve(__dirname, "..");
const SR = 44100;
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

function biquadMagAt(bq: Biquad, f: number, sr: number): number {
  const w = (-2 * Math.PI * f) / sr;
  const zr = Math.cos(w), zi = Math.sin(w);
  const z2r = zr * zr - zi * zi, z2i = 2 * zr * zi;
  const numR = bq.b0 + bq.b1 * zr + bq.b2 * z2r;
  const numI = bq.b1 * zi + bq.b2 * z2i;
  const denR = 1 + bq.a1 * zr + bq.a2 * z2r;
  const denI = bq.a1 * zi + bq.a2 * z2i;
  return Math.hypot(numR, numI) / Math.hypot(denR, denI);
}

const PARAMS = {
  scale: "majorPent" as const, rootHz: 110, bpm: 128, complexity: 1.0, mix: 0.6,
  enableScenes: false, enableHarmonicLoop: true, enableBeats: true,
  drumLevel: 1.0, swing: 0, drumStyle: "fourFloor" as const, sidechainAmount: 0.8,
  seed: 7,
  drone: { layers: [
    { hz: 110, timbre: "sine" as const, amp: 0.5, pan: 0 },
    { hz: 330, timbre: "fm" as const, amp: 0.4, pan: 0.3 },
  ] },
};

async function renderWav(out: string, dur: number): Promise<void> {
  const timeline = buildTimeline(PARAMS, dur);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: 4096, durationSec: dur });
  const sink = new WavFileSink(out, SR);
  await synth.render(sink);
  sink.finish();
}

async function renderMp3(out: string, dur: number, inputArgs?: string[]): Promise<{ enc: FfmpegStdinSink; ref: HashSink; exitCode: number | null; sha256: string }> {
  const frames = Math.round(dur * SR);
  const ref = new HashSink();
  const t1 = buildTimeline(PARAMS, dur);
  await new BlockSynth({ params: PARAMS, timeline: t1, sampleRate: SR, blockFrames: 4096, durationSec: dur }).render(makeFadeSink(ref, frames, 3, SR));
  const enc = new FfmpegStdinSink(out, SR, { args: ["-c:a", "libmp3lame", "-b:a", "192k"], inputArgs });
  const t2 = buildTimeline(PARAMS, dur);
  await new BlockSynth({ params: PARAMS, timeline: t2, sampleRate: SR, blockFrames: 4096, durationSec: dur }).render(makeFadeSink(enc, frames, 3, SR));
  const fin = await enc.finish();
  return { enc, ref, exitCode: fin.exitCode, sha256: fin.sha256 };
}

async function main(): Promise<void> {
  // ── 1. Biquad Q convention vs captured browser response ──
  {
    const r = JSON.parse(fs.readFileSync(path.join(root, "test/round2/biquad_response.json"), "utf8"));
    const FREQS = [500, 1000, 2000, 3000, 3300, 3400, 3500, 3550, 3600, 3650, 3700, 3800, 4000, 4500, 5000, 6000, 6600, 8000, 10000];
    const cases: Array<{ key: string; kind: "lpf" | "hpf" | "bpf"; f0: number; q: number }> = [
      { key: "drone_lpf_3600_q0p7", kind: "lpf", f0: 3600, q: 0.7 },
      { key: "master_lpf_6600_q1", kind: "lpf", f0: 6600, q: 1.0 },
    ];
    for (const c of cases) {
      const bq = new Biquad(SR);
      (c.kind === "lpf" ? bq.setLpf : bq.setHpf).call(bq, c.f0, c.q);
      const maxErr = Math.max(...FREQS.map((f, i) => Math.abs(biquadMagAt(bq, f, SR) - r[c.key].mag[i])));
      check(`biquad ${c.key} matches browser getFrequencyResponse`, maxErr < 1e-6, `max|err|=${maxErr.toExponential(2)}`);
    }
    const rp = JSON.parse(fs.readFileSync(path.join(root, "test/round2/bp_hp_response.json"), "utf8"));
    const bp = new Biquad(SR); bp.setBpf(2000, 1.5);
    const hp = new Biquad(SR); hp.setHpf(7000, 1.0);
    const eBp = Math.max(...rp.freqs.map((f: number, i: number) => Math.abs(biquadMagAt(bp, f, SR) - rp.bp[i])));
    const eHp = Math.max(...rp.freqs.map((f: number, i: number) => Math.abs(biquadMagAt(hp, f, SR) - rp.hp[i])));
    check("biquad bandpass 2000/Q1.5 matches browser", eBp < 1e-6, `max|err|=${eBp.toExponential(2)}`);
    check("biquad highpass 7000/Q1.0 matches browser", eHp < 1e-6, `max|err|=${eHp.toExponential(2)}`);
  }

  const tmp = fs.mkdtempSync("/tmp/ambientd-round2-");

  // ── 2. verifyRenderedOutput: positive + truncated negatives ──
  {
    const mp3 = path.join(tmp, "good.mp3");
    const { exitCode } = await renderMp3(mp3, 12);
    check("round2 mp3 render exit 0", exitCode === 0, `exit=${exitCode}`);
    let threw: string | null = null;
    try { await verifyRenderedOutput(mp3, "mp3", 12, false); } catch (e) { threw = String((e as Error).message); }
    check("verifyRenderedOutput accepts a good mp3", threw === null, threw ?? "passed");

    const truncMp3 = path.join(tmp, "truncated.mp3");
    fs.copyFileSync(mp3, truncMp3);
    fs.truncateSync(truncMp3, Math.floor(fs.statSync(truncMp3).size * 0.4));
    threw = null;
    try { await verifyRenderedOutput(truncMp3, "mp3", 12, false); } catch (e) { threw = String((e as Error).message); }
    check("verifyRenderedOutput FAILS a truncated mp3", threw !== null, threw?.slice(0, 90) ?? "NOT CAUGHT");

    const wav = path.join(tmp, "good.wav");
    await renderWav(wav, 12);
    threw = null;
    try { await verifyRenderedOutput(wav, "wav", 12, false); } catch (e) { threw = String((e as Error).message); }
    check("verifyRenderedOutput accepts a good wav", threw === null, threw ?? "passed");
    const truncWav = path.join(tmp, "truncated.wav");
    fs.copyFileSync(wav, truncWav);
    fs.truncateSync(truncWav, Math.floor(fs.statSync(truncWav).size * 0.7));
    threw = null;
    try { await verifyRenderedOutput(truncWav, "wav", 12, false); } catch (e) { threw = String((e as Error).message); }
    check("verifyRenderedOutput FAILS a truncated wav", threw !== null, threw?.slice(0, 90) ?? "NOT CAUGHT");
  }

  // ── 3. Backpressure stress: ffmpeg throttled to 2× native read rate ──
  {
    const DUR = 12;
    const out = path.join(tmp, "stressed.mp3");
    const { enc, ref, exitCode, sha256 } = await renderMp3(out, DUR, ["-readrate", "2"]);
    check("backpressure was exercised (drainWaits > 0)", enc.drainWaits > 0, `drainWaits=${enc.drainWaits}`);
    check("throttled render exit 0", exitCode === 0, `exit=${exitCode}`);
    check("throttled PCM byte-identical to unthrottled reference", sha256 === ref.sha256(), `${sha256.slice(0, 16)} vs ${ref.sha256().slice(0, 16)}`);
    const probe = await ffprobeJson(out);
    const dur = Number(probe.format.duration ?? -1);
    check("throttled output duration ~12 s", Math.abs(dur - DUR) < 0.25, `ffprobe=${dur.toFixed(2)}s`);
    let threw: string | null = null;
    try { await verifyRenderedOutput(out, "mp3", DUR, false); } catch (e) { threw = String((e as Error).message); }
    check("throttled output passes verification", threw === null, threw ?? "passed");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL ROUND2 CHECKS PASS" : `${failures} ROUND2 CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
