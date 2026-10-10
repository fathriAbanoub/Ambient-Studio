/**
 * bench/lib/ffmpeg.mjs — ffmpeg/ffprobe spawn helpers with RSS + disk
 * monitoring (D5), and the NVENC probe ported verbatim from
 * backend/services/video_renderer.py:58-80.
 */
import { spawn } from "node:child_process";
import { RssPoller, DirSizeSampler } from "./procmon.mjs";
import { D_NVENC_PROBE_ARGS, D_NVENC_PROBE_TIMEOUT_MS, D_SYNTH_AUDIO_AMPLITUDE, D_SYNTH_AUDIO_SEED, D_AUDIO_SAMPLE_RATE } from "./constants.mjs";

export function runProcess(bin, args, { timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err?.message || err), timedOut, spawned: false });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawned: true });
    });
  });
}

/**
 * Run one ffmpeg invocation with D5 monitoring attached.
 * Returns { code, wall_sec, peak_rss_bytes, stderr_tail, command }.
 * Caller is responsible for directory-size sampling around multi-file runs.
 */
export async function ffmpegRun(args, { timeoutMs = null } = {}) {
  const poller = new RssPoller(-1); // replaced on spawn below
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  poller.pid = child.pid;
  poller.start();
  let stderr = "";
  let timedOut = false;
  const t0 = performance.now();
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs)
    : null;
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });
  const wallSec = (performance.now() - t0) / 1000;
  if (timer) clearTimeout(timer);
  const peakRss = poller.finish();
  return {
    code,
    timedOut,
    wall_sec: wallSec,
    peak_rss_bytes: peakRss,
    stderr_tail: stderr.slice(-2000),
    command: ["ffmpeg", ...args].join(" "),
  };
}

/**
 * Port of video_renderer.py:58-80 _check_nvenc — exact command preserved.
 * Returns { available, command, output, pass }.
 */
export async function probeNvenc() {
  const res = await runProcess("ffmpeg", D_NVENC_PROBE_ARGS, {
    timeoutMs: D_NVENC_PROBE_TIMEOUT_MS,
  });
  return {
    available: res.code === 0,
    command: ["ffmpeg", ...D_NVENC_PROBE_ARGS].join(" "),
    output: ((res.stderr || "") + (res.stdout || "")).slice(-1000),
    pass: res.code === 0,
  };
}

/**
 * Streamed synthetic audio args (same payload for every compared run):
 * deterministic pink noise via anoisesrc(seed=…), resampled to stereo.
 * ponytail: streaming lavfi audio avoids multi-GB WAV temps inside D, which
 * measures VIDEO cost; the real-pipeline disk cost including a WAV artifact
 * is measured separately by E3. Upgrade path: swap input for a file.
 */
export function lavfiAudioArgs(durationSec) {
  return [
    "-f", "lavfi",
    "-i", `anoisesrc=colour=pink:amplitude=${D_SYNTH_AUDIO_AMPLITUDE}:seed=${D_SYNTH_AUDIO_SEED}:sample_rate=${D_AUDIO_SAMPLE_RATE}:duration=${durationSec}`,
    "-ac", "2",
  ];
}
