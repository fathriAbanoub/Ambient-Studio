/**
 * render_worker.ts — one fresh worker_threads Worker per render job,
 * terminated when the job completes (per-job V8-isolate isolation: no shared
 * module state can bleed across jobs). Owns the whole pipeline:
 *
 *   kernel timeline → BlockSynth (PoC, unmodified DSP) → sink:
 *     wav  → WavFileSink (PoC)
 *     m4a  → FfmpegStdinSink (PoC) with aac args
 *     mp3  → FfmpegStdinSink (PoC) with libmp3lame args   [new: codec swap]
 *     mp4  → fade sink → two-input mux ffmpeg stdin pipe  [new]
 *
 * Duration is cadence-snapped to the recipe BPM's bar grid (integer frame
 * math) with a linear outro fade. Writes to <tmp>, the daemon verifies with
 * ffprobe and renames into place (atomic artifact rule). Posts progress at
 * ~500 ms cadence. Exits non-zero on any failure — loud, never silent.
 */
import { parentPort, workerData } from "node:worker_threads";
import { BlockSynth, buildTimeline, type SynthSink } from "./blockSynth";
import { WavFileSink, FfmpegStdinSink, drainWritable } from "./sinks";
import { snapToBar, makeFadeSink } from "./cadence";
import { spawnMux, ensureDefaultBg } from "./video";

export interface WorkerRequest {
  jobId: string;
  kernelParams: Record<string, unknown>; // EngineParams — seed REQUIRED (validated by daemon)
  durationSec: number;
  output: { format: "wav" | "m4a" | "mp3" | "mp4"; videoAssetFile?: string };
  outTmp: string;
}

export interface WorkerProgress {
  type: "progress";
  framesWritten: number;
  totalFrames: number;
}
export interface WorkerDone {
  type: "done";
  outTmp: string;
  totalFrames: number;
  snappedSec: number;
  requestedSec: number;
  bars: number;
  beats: number;
  kernelEventCount: number;
  skippedSampleEvents: number;
  peakConcurrentVoices: number;
  pcmSha256: string;
  peakSampleAbs: number;
  nonFinite: number;
  renderWallSec: number;
  ffmpeg?: { exitCode: number | null; sha256: string; stderr: string };
}

const SR = 44100;
const BLOCK_FRAMES = 4096;
const FADE_SEC = 3.0;

async function main(): Promise<void> {
  const req = workerData as WorkerRequest;
  const post = (m: WorkerProgress | WorkerDone) => parentPort?.postMessage(m);

  const params = req.kernelParams as never; // shape validated by daemon; seed enforced there
  const snap = snapToBar(req.durationSec, Number((req.kernelParams as { bpm: number }).bpm || 72), SR);

  const wallStart = performance.now();
  const timeline = buildTimeline(params, snap.snappedSec);
  const synth = new BlockSynth({ params, timeline, sampleRate: SR, blockFrames: BLOCK_FRAMES, durationSec: snap.snappedSec });

  const format = req.output.format;
  let lastPost = 0;
  let inner: SynthSink;
  let ffmpegInfo: WorkerDone["ffmpeg"] | undefined;
  let pipeStdin: import("node:stream").Writable | null = null;
  let muxDone: Promise<{ code: number | null; stderr: string }> | null = null;
  let encStderrTail = "";

  if (format === "wav") {
    inner = new WavFileSink(req.outTmp, SR);
  } else if (format === "m4a" || format === "mp3") {
    // same PoC sink as AAC, codec args swapped for MP3
    encStderrTail = "";
    inner = new FfmpegStdinSink(req.outTmp, SR, {
      args: format === "m4a"
        ? ["-c:a", "aac", "-b:a", "160k"]
        : ["-c:a", "libmp3lame", "-b:a", "192k"],
      onStderr: (s) => { encStderrTail = (encStderrTail + s).slice(-2000); },
    });
  } else {
    // mp4 — two-input mux (cached asset stream-copy or 1fps static-image fallback)
    if (req.output.videoAssetFile) {
      const m = spawnMux({ kind: "asset", assetFile: req.output.videoAssetFile, sampleRate: SR, outputTmp: req.outTmp, durationSec: snap.snappedSec });
      pipeStdin = m.stdin;
      muxDone = m.done;
    } else {
      await ensureDefaultBg();
      const m = spawnMux({ kind: "static", sampleRate: SR, outputTmp: req.outTmp, durationSec: snap.snappedSec });
      pipeStdin = m.stdin;
      muxDone = m.done;
    }
    // round2: same backpressure contract as FfmpegStdinSink — track false
    // write() returns, expose drain() for BlockSynth to await between blocks.
    let muxBackpressured = false;
    inner = {
      writeBlock(l, r, frames) {
        if (!pipeStdin || pipeStdin.destroyed) throw new Error("mux ffmpeg stdin closed early — encoder failed");
        for (let start = 0; start < frames; start += 16384) {
          const n = Math.min(16384, frames - start);
          const buf = Buffer.allocUnsafe(n * 4);
          for (let i = 0; i < n; i++) {
            const lv = l[start + i];
            const rv = r[start + i];
            if (!Number.isFinite(lv) || !Number.isFinite(rv)) throw new Error(`non-finite sample at frame ${start + i}`);
            buf.writeInt16LE(Math.max(-1, Math.min(1, lv)) < 0 ? Math.round(Math.max(-1, Math.min(1, lv)) * 0x8000) : Math.round(Math.max(-1, Math.min(1, lv)) * 0x7fff), i * 4);
            buf.writeInt16LE(Math.max(-1, Math.min(1, rv)) < 0 ? Math.round(Math.max(-1, Math.min(1, rv)) * 0x8000) : Math.round(Math.max(-1, Math.min(1, rv)) * 0x7fff), i * 4 + 2);
          }
          if (!pipeStdin.write(buf)) muxBackpressured = true;
        }
      },
      drain() {
        const p = drainWritable(pipeStdin, muxBackpressured);
        muxBackpressured = false;
        return p;
      },
    };
  }

  // progress wrapper at ~500 ms cadence
  const progressSink: SynthSink = {
    writeBlock(l, r, frames) {
      const now = Date.now();
      if (now - lastPost > 500) {
        lastPost = now;
        post({ type: "progress", framesWritten: (synth as unknown as { frameWritten: number }).frameWritten, totalFrames: snap.totalFrames });
      }
      inner.writeBlock(l, r, frames);
    },
    // round2: forward the encoder's backpressure hook to BlockSynth
    drain: inner.drain?.bind(inner),
  };

  // cadence fade wraps the real sink (frame-index pure — determinism safe)
  const fadeSink = makeFadeSink(progressSink, snap.totalFrames, FADE_SEC, SR);
  const wavSink = format === "wav" ? (inner as WavFileSink) : null;
  const encSink = format === "m4a" || format === "mp3" ? (inner as FfmpegStdinSink) : null;

  let stats;
  try {
    stats = await synth.render(fadeSink);
  } catch (e) {
    // surface the encoder's own stderr — a pipe failure without encoder logs
    // is undebuggable
    const msg = String((e as Error)?.message ?? e);
    if (muxDone) {
      try { pipeStdin?.destroy(); } catch { /* already gone */ }
      const m = await Promise.race([muxDone, new Promise<{ code: null; stderr: string }>((r) => setTimeout(() => r({ code: null, stderr: "" }), 2000))]);
      throw new Error(`${msg} | mux ffmpeg exit=${m.code} stderr: ${m.stderr.slice(-800)}`);
    }
    if (encStderrTail) throw new Error(`${msg} | encoder stderr: ${encStderrTail.slice(-800)}`);
    throw e;
  }

  let pcmSha256 = "";
  let peakSampleAbs = 0;
  let nonFinite = -1;
  if (wavSink) {
    const fin = wavSink.finish();
    pcmSha256 = fin.sha256;
    peakSampleAbs = wavSink.peak;
    nonFinite = wavSink.nonFinite;
    if (nonFinite > 0) throw new Error(`${nonFinite} non-finite samples in output`);
  } else if (encSink) {
    const fin = await encSink.finish();
    ffmpegInfo = { exitCode: fin.exitCode, sha256: fin.sha256, stderr: fin.stderr };
    if (fin.exitCode !== 0) throw new Error(`ffmpeg ${format} encode failed (exit ${fin.exitCode}): ${fin.stderr.slice(-500)}`);
    if (encSink.nonFinite > 0) throw new Error(`${encSink.nonFinite} non-finite samples in output`);
    pcmSha256 = fin.sha256;
    peakSampleAbs = encSink.peak;
    nonFinite = encSink.nonFinite;
  } else {
    pipeStdin!.end();
    const m = await muxDone!;
    if (m.code !== 0) throw new Error(`mux ffmpeg failed (exit ${m.code}): ${m.stderr.slice(-800)}`);
    ffmpegInfo = { exitCode: m.code, sha256: "", stderr: m.stderr };
  }

  const done: WorkerDone = {
    type: "done",
    outTmp: req.outTmp,
    totalFrames: snap.totalFrames,
    snappedSec: snap.snappedSec,
    requestedSec: snap.requestedSec,
    bars: snap.bars,
    beats: timeline.beats,
    kernelEventCount: timeline.kernelEventCount,
    skippedSampleEvents: stats.skippedSampleEvents,
    peakConcurrentVoices: stats.peakConcurrentVoices,
    pcmSha256,
    peakSampleAbs,
    nonFinite,
    renderWallSec: (performance.now() - wallStart) / 1000,
    ffmpeg: ffmpegInfo,
  };
  post(done);
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
