/**
 * run_J.mjs — direct-to-ffmpeg streaming (J1), independently runnable:
 *   node bench/J_ffmpeg_streaming/run_J.mjs [--scale S]
 *
 * Compares the two handoff designs for the same seeded render:
 *   wav_then_ffmpeg — stream the render to a WAV file, then encode:
 *                     ffmpeg -i render.wav -c:a aac -b:a 160k out.m4a
 *   stdin_pipe      — stream raw s16le PCM straight into ffmpeg's stdin,
 *                     which encodes as the render runs (no intermediate WAV)
 *
 * Per point: synth wall, encode wall, total wall, ffmpeg peak RSS (Linux
 * VmHWM via RssPoller), peak work-dir bytes (DirSizeSampler — the WAV mode's
 * 2.5 GB intermediate at 2 h IS the disk claim being measured), and ffprobe
 * truth on both outputs. The two modes' PCM16 hashes must be byte-identical
 * (same seed — G3's invariant, asserted here across handoff topologies).
 */
import path from "node:path";
import fs from "node:fs";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";
import { captureEnvironment, diskFree } from "../lib/env.mjs";
import { ffmpegRun, runProcess } from "../lib/ffmpeg.mjs";
import { DirSizeSampler } from "../lib/procmon.mjs";
import { wavTheoreticalBytes, verifyWavHeader } from "../lib/wav.mjs";
import { J_SWEEP_SEC, J_AUDIO_BITRATE_K, G_SAMPLE_RATE, G_BLOCK_FRAMES, DISK_SAFETY_MARGIN } from "../lib/constants.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? path.join(BENCH_DIR, "results");
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const KEEP = process.env.BENCH_KEEP_ARTIFACTS === "1";
const ENV = process.env.BENCH_ENV ? JSON.parse(process.env.BENCH_ENV) : await captureEnvironment(RESULTS_DIR);
const WORK = path.join(BENCH_DIR, ".work", "J");

// chunked-execution controls (sandboxes with a per-invocation CPU ceiling):
//   node run_J.mjs --durations 300,1800   (default: all sweep points, both modes)
const J_ARGS = process.argv.slice(2);
const J_DURATIONS = (() => {
  const i = J_ARGS.indexOf("--durations");
  if (i === -1) return null;
  return J_ARGS[i + 1].split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
})();
const J_MODES = (() => {
  const i = J_ARGS.indexOf("--modes");
  if (i === -1) return null;
  return J_ARGS[i + 1].split(","); // e.g. wav_then_ffmpeg,stdin_pipe
})();

function parseMeasurement(stdout) {
  const marker = "__BENCH_JSON__";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) throw new Error(`render_entry produced no JSON. stderr tail:\n${stdout.slice(-800)}`);
  return JSON.parse(stdout.slice(idx + marker.length));
}

async function ffprobeJson(file) {
  const res = await runProcess("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 30_000 });
  if (res.code !== 0) return { error: res.stderr.slice(-200) };
  try { return JSON.parse(res.stdout); } catch (e) { return { error: String(e) }; }
}

export async function runJ() {
  console.log("[J] direct-to-ffmpeg streaming (WAV file vs stdin pipe)");
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const entry = await buildTsEntry(path.join(BENCH_DIR, "G_streaming_synth", "render_entry.ts"), path.join(BENCH_DIR, ".build"), "render_entry");
  if (!entry.ok) {
    await skipBench(RESULTS_DIR, "J1_wav_vs_ffmpeg_stdin", "J", ENV, `TypeScript runner unavailable → ${entry.error}`);
    return;
  }

  const result = new Result("J1_wav_vs_ffmpeg_stdin", "J", ENV,
    { sweep_sec: J_SWEEP_SEC, bitrate_k: J_AUDIO_BITRATE_K, sample_rate: G_SAMPLE_RATE, block_frames: G_BLOCK_FRAMES },
    {
      measured: "wall clock (synth, encode, total), ffmpeg peak RSS, peak work-dir bytes, and ffprobe of the encoded output, for WAV-file handoff vs direct stdin-pipe handoff of the identical seeded render",
      granularity: "per-point wall clocks (child-reported synth wall; runner-measured encode wall); ffmpeg VmHWM; 2 s work-dir sampling",
      trials: "1 per duration × 2 modes, fresh child per render",
      warmup: "none — whole-pipeline measurement",
      outliers: "none",
      statistic: "wall totals + peak RSS + peak disk per mode; hash equality across modes asserted",
    });

  const durations = (J_DURATIONS ?? J_SWEEP_SEC).map((s) => Math.max(60, Math.round(s * SCALE)));
  for (const dur of durations) {
    const label = `${Math.round(dur / 60)}min`;
    const need = wavTheoreticalBytes(G_SAMPLE_RATE, 2, Math.ceil(dur * G_SAMPLE_RATE)) * DISK_SAFETY_MARGIN;
    const { free_bytes } = await diskFree(RESULTS_DIR);
    if (free_bytes !== null && free_bytes <= need) {
      result.addObservation(`SKIPPED ${label}: ${(need / 1e9).toFixed(2)} GB needed, ${free_bytes === null ? "unknown" : (free_bytes / 1e9).toFixed(2)} GB free`);
      continue;
    }

    const wavPath = path.join(WORK, `j_${dur}.wav`);
    const m4aFromWav = path.join(WORK, `j_${dur}_from_wav.m4a`);
    const m4aFromPipe = path.join(WORK, `j_${dur}_from_pipe.m4a`);

    // ── mode A: WAV file, then ffmpeg reads it ──
    const wantA = J_MODES === null || J_MODES.includes("wav_then_ffmpeg");
    const wantB = J_MODES === null || J_MODES.includes("stdin_pipe");
    let mA = null, mB = null, peakDiskA = 0, peakDiskB = 0, totalWallA = 0, totalWallB = 0, synthWallA = 0, encA = null, hdr = null, probeA = null, probeB = null;
    if (wantA) {
      console.log(`  [J1] ${label} mode A: render → WAV → ffmpeg encode`);
      const samplerA = new DirSizeSampler(WORK);
      const synthT0 = performance.now();
      const childA = await runNode(entry.outfile, [
        "--duration", String(dur), "--block", String(G_BLOCK_FRAMES),
        "--mode", "wav", "--seed", "42", "--out", wavPath,
      ], { timeoutMs: 3600_000 });
      synthWallA = (performance.now() - synthT0) / 1000;
      if (childA.code !== 0) {
        samplerA.stop();
        result.addObservation(`RUN ERROR ${label} mode A: ${childA.stderr.slice(-200)}`);
      } else {
        mA = parseMeasurement(childA.stdout);
        encA = await ffmpegRun(["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-c:a", "aac", "-b:a", `${J_AUDIO_BITRATE_K}k`, m4aFromWav], { timeoutMs: 3600_000 });
        totalWallA = (performance.now() - synthT0) / 1000;
        samplerA.stop();
        hdr = verifyWavHeader(wavPath);
        probeA = await ffprobeJson(m4aFromWav);
        peakDiskA = Math.max(...samplerA.samples.map((s) => s.bytes), 0);
        result.addTrial(`${label}_wav_then_ffmpeg`, { duration_sec: dur, mode: "wav_then_ffmpeg" }, [totalWallA], {
          synth_wall_sec: synthWallA,
          encode_wall_sec: encA.wall_sec,
          total_wall_sec: totalWallA,
          ffmpeg_peak_rss_bytes: encA.peak_rss_bytes,
          wav_header_ok: hdr.riffOk && hdr.sizeConsistent,
          pcm16_sha256: mA.wav?.sha256 ?? null,
          peak_workdir_bytes: peakDiskA,
          output_bytes: fs.existsSync(m4aFromWav) ? fs.statSync(m4aFromWav).size : null,
          ffprobe_duration_sec: probeA?.format?.duration ? Number(probeA.format.duration) : null,
          ffmpeg_exit: encA.code,
        });
        result.addAssertion(`ffmpeg_exit_zero_wav_${dur}`, encA.code === 0, `mode A exit ${encA.code}`);
      }
    }

    // ── mode B: raw PCM piped into ffmpeg stdin ──
    if (wantB) {
      console.log(`  [J1] ${label} mode B: render → ffmpeg stdin (no WAV)`);
      const samplerB = new DirSizeSampler(WORK);
      const pipeT0 = performance.now();
      const childB = await runNode(entry.outfile, [
        "--duration", String(dur), "--block", String(G_BLOCK_FRAMES),
        "--mode", "ffmpeg", "--seed", "42", "--out", m4aFromPipe,
      ], { timeoutMs: 3600_000 });
      totalWallB = (performance.now() - pipeT0) / 1000;
      samplerB.stop();
      if (childB.code !== 0) {
        result.addObservation(`RUN ERROR ${label} mode B: ${childB.stderr.slice(-200)}`);
      } else {
        mB = parseMeasurement(childB.stdout);
        probeB = await ffprobeJson(m4aFromPipe);
        peakDiskB = Math.max(...samplerB.samples.map((s) => s.bytes), 0);
        result.addTrial(`${label}_stdin_pipe`, { duration_sec: dur, mode: "stdin_pipe" }, [totalWallB], {
          synth_wall_sec: mB.render_ms / 1000 + mB.timeline_ms / 1000,
          encode_wall_sec: null, // overlapped with synthesis — that is the design
          total_wall_sec: totalWallB,
          ffmpeg_peak_rss_bytes: mB.ffmpeg?.peakRssBytes ?? null,
          child_peak_rss_bytes: mB.peak_rss_bytes ?? null, // the synth process — backpressure check
          pcm16_sha256: mB.pcm16_sha256,
          peak_workdir_bytes: peakDiskB,
          output_bytes: fs.existsSync(m4aFromPipe) ? fs.statSync(m4aFromPipe).size : null,
          ffprobe_duration_sec: probeB?.format?.duration ? Number(probeB.format.duration) : null,
          ffmpeg_exit: mB.ffmpeg?.exitCode,
        });
        result.addAssertion(`ffmpeg_exit_zero_pipe_${dur}`, mB.ffmpeg?.exitCode === 0, `mode B exit ${mB.ffmpeg?.exitCode}`);
      }
    }

    if (mA && mB) {
      result.addAssertion(`pcm_hash_equal_across_modes_${dur}`, mA.wav?.sha256 === mB.pcm16_sha256,
        mA.wav?.sha256 === mB.pcm16_sha256
          ? `identical PCM bytes through both handoffs (${String(mA.wav?.sha256).slice(0, 16)}…)`
          : `MISMATCH: wav ${mA.wav?.sha256} vs pipe ${mB.pcm16_sha256}`);
    }
    if (mA) console.log(`    -> A(wav): synth ${synthWallA.toFixed(1)}s + encode ${encA.wall_sec.toFixed(1)}s = ${totalWallA.toFixed(1)}s, ffmpeg RSS ${((encA.peak_rss_bytes || 0) / 1048576).toFixed(0)} MB, peak disk ${(peakDiskA / 1e9).toFixed(2)} GB`);
    if (mB) console.log(`    -> B(pipe): total ${totalWallB.toFixed(1)}s, ffmpeg RSS ${((mB.ffmpeg?.peakRssBytes || 0) / 1048576).toFixed(0)} MB, peak disk ${(peakDiskB / 1e9).toFixed(2)} GB`);

    if (!KEEP) {
      for (const f of [wavPath, m4aFromWav, m4aFromPipe]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    }
  }

  result.addObservation(
    "Reading the two modes: stdin-pipe overlaps encoding with synthesis (no encode-wall term, no WAV intermediate — peak disk stays at work-dir baseline); wav-then-ffmpeg pays the WAV write+read and holds duration-proportional disk (at 2 h: the same ~2.5 GB that E1/E3 measured for the current pipeline). Both feed ffmpeg identical bytes (asserted per point).",
  );

  const file = await result.write(RESULTS_DIR);
  console.log(`  -> ${file}`);
  if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runJ();
}
