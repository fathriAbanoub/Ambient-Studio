/**
 * bench/E/run_E.mjs — disk and I/O accounting (independently runnable):
 *   node bench/E/run_E.mjs [--scale S] [--long-2h] [--long-8h]
 *
 * E1: on-disk WAV size vs the theoretical calculation
 *     (44-byte header + frames × channels × 2 — mirrors audioBufferToWav,
 *     renderAmbient.ts:989-990), for every sweep duration.
 * E2: sustained sequential write throughput (Node fs — the app's own write
 *     path) + instantaneous throughput sampled during a real encode.
 * E3: peak disk usage of one full pipeline run (WAV + mpegts segments +
 *     final MP4 present simultaneously) — the "how much free disk does a
 *     long render actually need" number, measured at the longest duration
 *     you opt into.
 */
import path from "node:path";
import fs from "node:fs";
import { Result, skipBench } from "../lib/result.mjs";
import { WavPcm16Writer, sineFrameGen, wavTheoreticalBytes, verifyWavHeader } from "../lib/wav.mjs";
import { ffmpegRun, lavfiAudioArgs } from "../lib/ffmpeg.mjs";
import { DirSizeSampler } from "../lib/procmon.mjs";
import { diskFree } from "../lib/env.mjs";
import {
  E1_SWEEP_MIN, E2_BASELINE_WRITE_MB, E2_WRITE_CHUNK_MB, E2_SAMPLE_INTERVAL_SEC,
  E3_DEFAULT_MIN, E3_LONG_MIN_2H, E3_LONG_MIN_8H, E3_SEGMENT_COUNT,
  D_VIDEO_WIDTH, D_VIDEO_HEIGHT, D_CRF, D_X264_PRESET, D_AUDIO_CODEC,
  D_AUDIO_SAMPLE_RATE, DISK_SAFETY_MARGIN,
} from "../lib/constants.mjs";

const ENV = JSON.parse(process.env.BENCH_ENV ?? "{}");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR;
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const LONG_2H = process.env.BENCH_LONG_2H === "1";
const LONG_8H = process.env.BENCH_LONG_8H === "1";
const KEEP = process.env.BENCH_KEEP_ARTIFACTS === "1";
const WORK_ROOT = path.join(RESULTS_DIR, "..", "work");

async function seqWriteThroughput(dir) {
  const file = path.join(dir, "seq_write_test.bin");
  const chunk = Buffer.alloc(E2_WRITE_CHUNK_MB * 1024 * 1024, 0x42);
  const chunks = Math.ceil(E2_BASELINE_WRITE_MB / E2_WRITE_CHUNK_MB);
  const t0 = performance.now();
  const handle = await fs.promises.open(file, "w");
  for (let i = 0; i < chunks; i++) await handle.write(chunk);
  await handle.sync();
  await handle.close();
  const wall = (performance.now() - t0) / 1000;
  fs.rmSync(file, { force: true });
  return { written_mb: chunks * E2_WRITE_CHUNK_MB, wall_sec: wall, mb_per_sec: (chunks * E2_WRITE_CHUNK_MB) / wall };
}

export async function runE() {
  console.log("[E] disk and I/O accounting");
  fs.mkdirSync(WORK_ROOT, { recursive: true });

  // ── E1 ──────────────────────────────────────────────────────────────────
  {
    const workDir = fs.mkdtempSync(path.join(WORK_ROOT, "E1_wav_sizes__"));
    const result = new Result("E1_wav_size_accounting", "E", ENV,
      { sample_rate: D_AUDIO_SAMPLE_RATE, channels: 2, bit_depth: 16, durations_min: E1_SWEEP_MIN.map((m) => m * SCALE) },
      {
        measured: "on-disk WAV size (bench WAV writer, PCM16 stereo, header shape mirrored from audioBufferToWav) vs theoretical 44 + frames×channels×2",
        granularity: "per file",
        trials: "1 per duration",
        warmup: "n/a",
        outliers: "n/a",
        statistic: "size_bytes vs theoretical_bytes (equality is a real invariant, asserted)",
      });
    let allMatch = true;
    for (const min of E1_SWEEP_MIN) {
      const durSec = Math.round(min * 60 * SCALE);
      const frames = durSec * D_AUDIO_SAMPLE_RATE;
      const file = path.join(workDir, `e1_${min}min.wav`);
      const writer = new WavPcm16Writer(file, D_AUDIO_SAMPLE_RATE, 2, frames, sineFrameGen(220, D_AUDIO_SAMPLE_RATE));
      const written = await writer.write();
      const actual = fs.statSync(file).size;
      const hdr = verifyWavHeader(file);
      const match = actual === wavTheoreticalBytes(D_AUDIO_SAMPLE_RATE, 2, frames) && hdr.sizeConsistent;
      if (!match) allMatch = false;
      result.addTrial(`${min}min${SCALE !== 1 ? "×scale" : ""}`, { duration_sec: durSec, frames }, [actual], {
        theoretical_bytes: wavTheoreticalBytes(D_AUDIO_SAMPLE_RATE, 2, frames),
        writer_returned_bytes: written, header_ok: hdr.riffOk, size_consistent: hdr.sizeConsistent,
      });
      console.log(`  E1 ${min}min×${SCALE}: ${actual} bytes (theoretical ${wavTheoreticalBytes(D_AUDIO_SAMPLE_RATE, 2, frames)})`);
      fs.rmSync(file, { force: true });
    }
    result.addAssertion("wav_size_matches_theory", allMatch, "every file must equal header + frames×channels×bytesPerSample exactly");
    // Cross-read: B results' recorded wav_bytes, when a B run exists.
    const bFiles = fs.existsSync(RESULTS_DIR)
      ? fs.readdirSync(RESULTS_DIR).filter((f) => f.startsWith("B1_offline_render_sweep") && f.endsWith(".json"))
      : [];
    const crossRead = [];
    for (const f of bFiles) {
      const j = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"));
      for (const p of j.raw_samples?.points ?? []) {
        if (p.wav_bytes) {
          const theoretical = wavTheoreticalBytes(D_AUDIO_SAMPLE_RATE, 2, p.output_frames || 0);
          crossRead.push({ source_file: f, duration_minutes: p.duration_minutes, wav_bytes: p.wav_bytes, output_frames: p.output_frames, theoretical_from_frames: theoretical, matches: p.output_frames ? p.wav_bytes === theoretical : null });
        }
      }
    }
    if (crossRead.length) result.setDerived("cross_read_from_B_results", crossRead);
    await result.write(RESULTS_DIR);
    if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
  }

  // ── E2 ──────────────────────────────────────────────────────────────────
  {
    const workDir = fs.mkdtempSync(path.join(WORK_ROOT, "E2_throughput__"));
    const targetSec = Math.max(60, Math.round(600 * Number(process.env.BENCH_SCALE ?? 1)));
    const result = new Result("E2_disk_throughput", "E", ENV,
      { baseline_write_mb: E2_BASELINE_WRITE_MB, chunk_mb: E2_WRITE_CHUNK_MB, encode: `static 1080p @1fps, ${Math.round(targetSec / 60)} min payload`, sample_interval_sec: E2_SAMPLE_INTERVAL_SEC },
      {
        measured: "(a) sustained sequential write MB/s via Node fs (the app's own write path); (b) instantaneous disk consumption MB/s sampled during a real ffmpeg encode",
        granularity: "per-second dir-size deltas during the encode",
        trials: "1 + 1",
        warmup: "none — first-run numbers are the honest ones on a cold cache",
        outliers: "none; full delta series retained",
        statistic: "mb_per_sec (baseline); instantaneous series + sustained average (encode)",
      });
    const baseline = await seqWriteThroughput(workDir);
    result.addTrial("baseline_sequential_write", {}, [baseline.mb_per_sec], baseline);

    console.error(`  E2: baseline write done (${E2_BASELINE_WRITE_MB} MB), now ${targetSec}s static encode with per-second disk sampling…`);
    const sampler = new DirSizeSampler(workDir);
    const run = await ffmpegRun([
      "-loop", "1", "-framerate", "1", "-i", path.join(ENV.root, "bench", "assets", "bg.png"),
      ...lavfiAudioArgs(targetSec),
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", D_X264_PRESET, "-crf", String(D_CRF), "-pix_fmt", "yuv420p", "-r", "1",
      "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(targetSec),
      path.join(workDir, "e2_static10min.mp4"),
    ]);
    // one final sample so the tail is captured
    await new Promise((r) => setTimeout(r, 100));
    sampler.stop();
    const samples = sampler.samples;
    const deltas = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].t - samples[i - 1].t) / 1000;
      if (dt > 0) deltas.push(((samples[i].bytes - samples[i - 1].bytes) / 1048576) / dt);
    }
    result.addTrial("during_static_encode", {}, deltas, {
      ffmpeg_exit_code: run.code,
      note: "values are MB/s of disk consumption (deltas include intermediate files)",
      peak_workdir_bytes: sampler.peakBytes,
      final_size_bytes: fs.existsSync(path.join(workDir, "e2_static10min.mp4")) ? fs.statSync(path.join(workDir, "e2_static10min.mp4")).size : 0,
    });
    result.setStats("sustained_encode_mb_per_sec", deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null);
    console.error(`  E2: encode done (exit ${run.code}), sustained ${(deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0).toFixed(1)} MB/s`);
    await result.write(RESULTS_DIR);
    if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
  }

  // ── E3 ──────────────────────────────────────────────────────────────────
  {
    const durMin = LONG_8H ? E3_LONG_MIN_8H : LONG_2H ? E3_LONG_MIN_2H : E3_DEFAULT_MIN * SCALE;
    const durSec = Math.round(durMin * 60);
    const need = Math.ceil(durSec * (D_AUDIO_SAMPLE_RATE * 2 * 2) * DISK_SAFETY_MARGIN) + 2 * 1024 ** 3;
    const free = await diskFree(WORK_ROOT);
    if (free.free_bytes !== null && free.free_bytes < need) {
      await skipBench(RESULTS_DIR, "E3_pipeline_disk_peak", "E", ENV,
        `insufficient disk for a ${durMin}-min full-pipeline run: need ≈ ${(need / 1073741824).toFixed(1)} GB free, have ${free.free_bytes === null ? "unknown" : (free.free_bytes / 1073741824).toFixed(1)} GB`);
      return;
    }
    const workDir = fs.mkdtempSync(path.join(WORK_ROOT, "E3_pipeline_peak__"));
    const sampler = new DirSizeSampler(workDir);
    const result = new Result("E3_pipeline_disk_peak", "E", ENV,
      { duration_min: durMin, segments: E3_SEGMENT_COUNT, pipeline: "WAV artifact → mpegts segment encodes → concat MP4" },
      {
        measured: "peak simultaneous disk usage of a full pipeline run (WAV artifact + all intermediate segments + final MP4), plus final artifact sizes",
        granularity: `dir-size samples every 2 s + final file sizes`,
        trials: "1",
        warmup: "none",
        outliers: "n/a",
        statistic: "peak_workdir_bytes, wav_bytes, segments_total_bytes, mp4_bytes, disk_free_before/after",
      });
    const diskBefore = await diskFree(WORK_ROOT);
    // Stage 1: the WAV artifact (real streaming writer, sine payload).
    const wavPath = path.join(workDir, "artifact.wav");
    const frames = durSec * D_AUDIO_SAMPLE_RATE;
    const wavWriter = new WavPcm16Writer(wavPath, D_AUDIO_SAMPLE_RATE, 2, frames, sineFrameGen(220, D_AUDIO_SAMPLE_RATE));
    const t0 = performance.now();
    console.error(`  E3: writing ${durMin}-min WAV artifact…`);
    await wavWriter.write();
    const wavWriteSec = (performance.now() - t0) / 1000;
    console.error(`  E3: WAV written in ${wavWriteSec.toFixed(1)}s, encoding ${E3_SEGMENT_COUNT} segments…`);
    // Stage 2: segmented encode consuming the real WAV.
    const segSec = durSec / E3_SEGMENT_COUNT;
    const segs = [];
    for (let k = 0; k < E3_SEGMENT_COUNT; k++) {
      const r = await ffmpegRun([
        "-i", wavPath,
        "-loop", "1", "-framerate", "1", "-i", path.join(ENV.root, "bench", "assets", "bg.png"),
        "-map", "1:v", "-map", "0:a",
        "-c:v", "libx264", "-preset", D_X264_PRESET, "-crf", String(D_CRF), "-pix_fmt", "yuv420p", "-r", "1",
        "-c:a", D_AUDIO_CODEC, "-f", "mpegts", "-t", String(segSec),
        path.join(workDir, `seg_${k}.ts`),
      ]);
      if (r.code !== 0) {
        sampler.stop();
        result.doc.error = `segment ${k} failed (exit ${r.code}): ${r.stderr_tail}`;
        console.error(`  E3 FAILED: ${result.doc.error}`);
        await result.write(RESULTS_DIR);
        return;
      }
      segs.push(path.join(workDir, `seg_${k}.ts`));
    }
    // Stage 3: stream-copy assembly.
    const listFile = path.join(workDir, "concat.txt");
    fs.writeFileSync(listFile, segs.map((l) => `file '${l.replace(/\\/g, "/")}'`).join("\n"));
    const asm = await ffmpegRun(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", path.join(workDir, "final.mp4")]);
    await new Promise((r) => setTimeout(r, 200));
    sampler.stop();
    const diskAfter = await diskFree(WORK_ROOT);
    const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    result.doc.stats = {
      duration_min: durMin,
      wav_bytes: sizeOf(wavPath),
      segments_total_bytes: segs.reduce((a, p) => a + sizeOf(p), 0),
      mp4_bytes: sizeOf(path.join(workDir, "final.mp4")),
      peak_workdir_bytes: sampler.peakBytes,
      disk_free_before: diskBefore.free_bytes,
      disk_free_after: diskAfter.free_bytes,
      wav_write_sec: wavWriteSec,
      assemble_exit_code: asm.code,
      ffprobe: asm.code === 0 ? "see D harness for ffprobe details" : null,
    };
    result.addTrial(`pipeline_${durMin}min`, { duration_min: durMin }, [sampler.peakBytes], { wav_write_sec: wavWriteSec });
    console.log(`  E3 ${durMin}min: peak ${(sampler.peakBytes / 1048576).toFixed(0)} MB (wav ${sizeOf(wavPath)}, mp4 ${sizeOf(path.join(workDir, "final.mp4"))})`);
    await result.write(RESULTS_DIR);
    if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runE();
}
