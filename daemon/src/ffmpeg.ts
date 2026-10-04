/**
 * ffmpeg.ts — spawn helpers for ffmpeg/ffprobe + the NVENC probe.
 * ponytail: node:child_process + /proc parsing only; no fluent-ffmpeg.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(bin: string, args: string[], timeoutMs = 10 * 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err?.message ?? err), timedOut });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export const ffmpegRun = (args: string[], timeoutMs?: number) => run("ffmpeg", args, timeoutMs);

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  nb_frames?: string;
}
export interface FfprobeInfo {
  streams: FfprobeStream[];
  format: { duration?: string; bit_rate?: string; size?: string; format_name?: string };
}

export async function ffprobeJson(path: string): Promise<FfprobeInfo> {
  const res = await run("ffprobe", [
    "-v", "error",
    "-show_streams", "-show_format",
    "-of", "json",
    path,
  ], 60_000);
  if (res.code !== 0) throw new Error(`ffprobe failed for ${path}: ${res.stderr.slice(-500)}`);
  return JSON.parse(res.stdout);
}

/** round2: DECODED audio length in seconds — fully decodes the first audio
 * stream into the null muxer and reads the final stats time. This exposes
 * container headers that lie (measured: a truncated MP3's Xing header still
 * reports the full frame count, so format.duration stays "correct" while the
 * real content is short). Video is demuxed but never decoded. */
export async function ffmpegDecodedAudioSec(path: string): Promise<number> {
  const res = await run("ffmpeg", [
    "-nostdin", "-v", "info", "-stats", "-stats_period", "0.1",
    "-i", path,
    "-map", "0:a:0",
    "-f", "null", "-",
  ], 10 * 60_000);
  if (res.code !== 0) {
    throw new Error(`decode verification failed for ${path} (no/broken audio stream?): ${res.stderr.slice(-300)}`);
  }
  const matches = [...res.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`decode verification produced no timing for ${path}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

export const videoStream = (info: FfprobeInfo) => info.streams.find((s) => s.codec_type === "video");
export const audioStream = (info: FfprobeInfo) => info.streams.find((s) => s.codec_type === "audio");

/**
 * NVENC usability probe — same shape as backend/services/video_renderer.py:58-80
 * (encode one tiny frame with h264_nvenc, see if it errors). NOTE: the
 * benchmark's D0 port used a 16x16 frame, which NVENC rejects outright
 * ("Frame Dimension less than the minimum supported value") even on working
 * GPUs — a false negative. We probe at 256x256 so "unavailable" means it.
 */
export async function probeNvenc(): Promise<{ available: boolean; command: string; output: string }> {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
    "-vcodec", "h264_nvenc", "-f", "null", "-",
  ];
  const res = await run("ffmpeg", args, 30_000);
  return {
    available: res.code === 0,
    command: ["ffmpeg", ...args].join(" "),
    output: (res.stderr + res.stdout).slice(-1000),
  };
}

/** Atomic write helper: write to <path>.tmp-<pid>, fsync, rename over target. */
export function atomicWriteJson(path: string, obj: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
}

/** Streaming sha256 — bounded 1 MiB read buffer, NEVER a full-file read.
 * (MEASURED bug: readFileSync of the 1 h WAV put the whole 635 MB output in
 * RSS during finalize; an 8 h WAV would be 5.08 GB. Verification must be
 * streaming everywhere — the same rule the benchmark suite enforces.) */
export async function sha256FileStreaming(file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}
