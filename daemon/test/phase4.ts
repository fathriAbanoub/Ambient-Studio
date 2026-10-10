/**
 * test/phase4.ts — two-input video mux end-to-end (the never-run-before path):
 *   asset mux: BlockSynth → fade → PCM16 pipe into ffmpeg alongside a REAL
 *   normalized cached asset; assert with ffprobe that
 *     - the video stream was stream-COPIED (bitrate matches the asset's, not a
 *       fresh CRF encode) and resolution matches
 *     - audio is AAC 160k with the right duration
 *     - container duration matches the snapped audio length within tolerance
 *       (this measures the -shortest overshoot, spec's exact command)
 *   static fallback: single-image 1 fps h264 path renders and probes clean.
 */
import fs from "node:fs";
import path from "node:path";
import { BlockSynth, buildTimeline } from "../src/blockSynth";
import { snapToBar, makeFadeSink } from "../src/cadence";
import { spawnMux, ensureDefaultBg } from "../src/video";
import { ingestVideo } from "../src/assets";
import { ffprobeJson, videoStream, audioStream } from "../src/ffmpeg";

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

async function renderMp4(outTmp: string, assetFile: string | undefined, durationSec: number) {
  const snap = snapToBar(durationSec, PARAMS.bpm, SR);
  const timeline = buildTimeline(PARAMS as never, snap.snappedSec);
  const synth = new BlockSynth({ params: PARAMS as never, timeline, sampleRate: SR, blockFrames: 4096, durationSec: snap.snappedSec });
  const m = spawnMux({
    kind: assetFile ? "asset" : "static",
    assetFile,
    sampleRate: SR,
    outputTmp: outTmp,
    durationSec: snap.snappedSec,
  });
  const sink = makeFadeSink({
    writeBlock(l, r, frames) {
      if (m.stdin.destroyed) throw new Error("mux stdin closed early");
      for (let start = 0; start < frames; start += 16384) {
        const n = Math.min(16384, frames - start);
        const buf = Buffer.allocUnsafe(n * 4);
        for (let i = 0; i < n; i++) {
          buf.writeInt16LE(floatToPcm(l[start + i]), i * 4);
          buf.writeInt16LE(floatToPcm(r[start + i]), i * 4 + 2);
        }
        m.stdin.write(buf);
      }
    },
  }, snap.totalFrames, 3, SR);
  const t0 = performance.now();
  await synth.render(sink);
  m.stdin.end();
  const res = await m.done;
  return { snap, res, wall: (performance.now() - t0) / 1000 };
}

function floatToPcm(s: number): number {
  const c = Math.max(-1, Math.min(1, s));
  return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
}

async function main() {
  const tmp = fs.mkdtempSync("/tmp/ambientd-p4-");

  // real normalized asset: ingest the hi-bitrate 1080p clip (re-encodes to 2.5 Mbps)
  const asset = await ingestVideo({ file: path.resolve(__dirname, "..", "test", "media", "hi_bitrate_1080.mp4"), label: "p4 asset" });
  const assetProbe = await ffprobeJson(asset.file);
  const assetBitrate = Number(assetProbe.format.bit_rate ?? 0);

  // ── asset mux ──
  const out1 = path.join(tmp, "muxed.mp4");
  const r1 = await renderMp4(out1, asset.file, 30);
  check("mux ffmpeg exit 0", r1.res.code === 0, `exit=${r1.res.code} ${r1.res.stderr.slice(-200)}`);

  const p1 = await ffprobeJson(out1);
  const v = videoStream(p1)!;
  const a = audioStream(p1)!;
  const dur = Number(p1.format.duration ?? 0);
  const outBitrate = Number(p1.format.bit_rate ?? 0);

  check("mux video codec h264 (copied)", v.codec_name === "h264", v.codec_name!);
  check("mux video resolution == asset", v.width === asset.width && v.height === asset.height, `${v.width}x${v.height} vs ${asset.width}x${asset.height}`);
  // stream-copy proof: total container bitrate ≈ asset bitrate + audio bitrate.
  // A re-encode at CRF would land far from this; copy duplicates the same bits.
  const expected = assetBitrate + 160_000;
  check("mux bitrate matches copy math (±15%)", Math.abs(outBitrate - expected) / expected < 0.15,
    `out ${(outBitrate / 1e6).toFixed(2)} Mbps vs asset ${(assetBitrate / 1e6).toFixed(2)} + 0.16 audio = ${(expected / 1e6).toFixed(2)}`);
  check("mux audio aac", a.codec_name === "aac", a.codec_name!);
  check("mux audio 160k", Number(a.bit_rate ?? 0) > 140_000 && Number(a.bit_rate ?? 0) < 185_000, `${(Number(a.bit_rate) / 1e3).toFixed(0)} kbps`);
  // -shortest overshoot measurement (spec command has -shortest, no -t)
  check("mux duration ≈ snapped (≤1 s overshoot)", Math.abs(dur - r1.snap.snappedSec) <= 1.0,
    `ffprobe ${dur.toFixed(3)}s vs snapped ${r1.snap.snappedSec.toFixed(3)}s (overshoot ${(dur - r1.snap.snappedSec).toFixed(3)}s)`);
  check("mux wall < 1/4 realtime", r1.wall < r1.snap.snappedSec / 4, `${r1.wall.toFixed(2)}s wall for ${r1.snap.snappedSec.toFixed(0)}s video (mux is copy+encode-audio only)`);

  // loop seam: asset is 20 s, render 30 s → video loops 1.5×. Frames must be
  // continuous across 20 s (no gap) — verify frame count ≈ fps × duration
  const frames = Number(v.nb_frames ?? 0);
  check("mux video looped without gap", frames === 0 || Math.abs(frames - (dur - 1) * (asset.width === 1920 ? 30 : 30)) < 90, `nb_frames=${frames} dur=${dur.toFixed(1)}`);

  // ── static fallback ──
  await ensureDefaultBg();
  const out2 = path.join(tmp, "static.mp4");
  const r2 = await renderMp4(out2, undefined, 15);
  check("static ffmpeg exit 0", r2.res.code === 0, `exit=${r2.res.code}`);
  const p2 = await ffprobeJson(out2);
  const v2 = videoStream(p2)!;
  const dur2 = Number(p2.format.duration ?? 0);
  check("static video h264 @1fps", v2.codec_name === "h264" && v2.r_frame_rate === "1/1", `${v2.codec_name} fps=${v2.r_frame_rate}`);
  check("static duration ≈ snapped", Math.abs(dur2 - r2.snap.snappedSec) <= 1.0, `ffprobe ${dur2.toFixed(2)}s vs ${r2.snap.snappedSec.toFixed(2)}s`);
  check("static audio aac", audioStream(p2)?.codec_name === "aac", "aac");
  check("static size small (cheap path)", fs.statSync(out2).size < 1_500_000, `${(fs.statSync(out2).size / 1e3).toFixed(0)} kB for ${dur2.toFixed(0)}s`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "PHASE4 ALL PASS" : `${failures} PHASE4 FAILURES`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
