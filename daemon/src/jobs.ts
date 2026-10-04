/**
 * jobs.ts — job registry + runner. v1 runs ONE render at a time (a pending
 * queue drained when the current job finishes — raise MAX_CONCURRENT later,
 * the queue shape already supports it). Each job gets:
 *   - a full UUID (never a seed source — seeds live in the recipe)
 *   - a fresh worker_threads Worker, terminated on completion (state isolation)
 *   - a job-ID-scoped directory: data/jobs/<uuid>/ (tmp → verify → rename)
 *   - a provenance sidecar (recipe, versions, seed, exact ffmpeg commands)
 */
import { randomUUID, randomInt, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DATA_DIR, getAsset } from "./assets";
import { ffprobeJson, ffmpegDecodedAudioSec, atomicWriteJson, probeNvenc, sha256FileStreaming } from "./ffmpeg";
import type { WorkerDone, WorkerProgress } from "./render_worker";
import type { EngineParams } from "../../kernel/musicalLogic";

declare const __dirname: string; // available in the CJS bundle (build/ dir)

const JOBS_DIR = path.join(DATA_DIR, "jobs");
const JOBS_INDEX = path.join(DATA_DIR, "jobs.json");
const ROOT = path.resolve(__dirname, "..");
const WORKER_FILE = path.join(ROOT, "build", "render_worker.cjs");
const MAX_CONCURRENT = 1; // ponytail: queue is already here; raising this later needs the cross-job test re-run

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  job_id: string;
  recipe_id: string;
  recipe: StoredRecipe; // frozen copy — later recipe edits never affect a submitted job
  status: JobStatus;
  progress: number; // 0..1
  preview: boolean;
  error?: string;
  created: string;
  started?: string;
  finished?: string;
  outputs?: OutputFile[];
  provenance?: Provenance;
}

export interface OutputFile {
  path: string;
  format: string;
  bytes: number;
  sha256: string;
}

export interface Provenance {
  job_id: string;
  recipe_id: string;
  created: string;
  kernel: { file: string; sha256: string; note: string };
  blockSynth: { file: string; sha256: string; note: string };
  seed: number;
  duration: { requested_sec: number; snapped_sec: number; bars: number; beats: number };
  render: { sample_rate: number; block_frames: number; kernel_event_count: number; skipped_sample_events: number; peak_concurrent_voices: number; pcm16_sha256: string; peak_sample_abs: number; wall_sec: number; worker_isolation: string };
  ffmpeg_commands: string[];
  outputs: OutputFile[];
  nvenc: { available: boolean; note: string };
  node_version: string;
  ffmpeg_version: string;
}

export interface StoredRecipe {
  recipe_id: string;
  // Same recipe type the UI builds (EngineParams, defined once in the shared
  // kernel) + the daemon-mandated persisted seed.
  kernel_params: EngineParams & { seed: number };
  duration_sec: number;
  output: { format: "wav" | "m4a" | "mp3" | "mp4"; video_asset_id?: string };
  created: string;
  seed_generated?: boolean; // true when the daemon generated + persisted the seed
}

function loadJobs(): Record<string, Job> {
  try {
    return JSON.parse(fs.readFileSync(JOBS_INDEX, "utf8"));
  } catch {
    return {};
  }
}
function saveJobs(jobs: Record<string, Job>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteJson(JOBS_INDEX, jobs);
}

const jobs: Record<string, Job> = loadJobs();
const queue: string[] = [];
let running = false;

// ffmpeg version string, probed lazily once
let ffmpegVersion = "";
async function getFfmpegVersion(): Promise<string> {
  if (!ffmpegVersion) {
    const { run } = await import("./ffmpeg");
    ffmpegVersion = (await run("ffmpeg", ["-version"], 10_000)).stdout.split("\n")[0];
  }
  return ffmpegVersion;
}

// kernel/synth file hashes for provenance (computed once)
function fileSha(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function createRecipe(input: { kernel_params: Record<string, unknown>; duration_sec: number; output: StoredRecipe["output"] }): StoredRecipe {
  // Trust-boundary validation — loud failure, never a guess (rule 5).
  const kp = input.kernel_params ?? {};
  if (typeof kp !== "object") throw new Error("kernel_params must be an object");
  if (!Number.isFinite(input.duration_sec) || input.duration_sec <= 0) {
    throw new Error(`duration_sec must be a positive number, got ${input.duration_sec}`);
  }
  if (input.duration_sec > 8 * 3600) throw new Error("duration_sec exceeds the 8-hour maximum");
  const fmt = input.output?.format;
  if (!["wav", "m4a", "mp3", "mp4"].includes(fmt)) throw new Error(`output.format must be wav|m4a|mp3|mp4, got ${fmt}`);
  if (fmt === "mp4" && input.output.video_asset_id) {
    const asset = getAsset(input.output.video_asset_id);
    if (!asset) throw new Error(`video_asset_id '${input.output.video_asset_id}' not in registry — select/upload it first`);
  }
  // Seed: NEVER derived from job id, NEVER picked at render time (the kernel's
  // createInitialState falls back to Math.random() — unacceptable). Generate
  // once here from a CSPRNG and persist into the stored recipe.
  const seedIn = (kp as { seed?: unknown }).seed;
  let seedGenerated = false;
  if (seedIn === undefined || seedIn === null) {
    kp.seed = randomInt(0, 0xffffffff); // CSPRNG, generated once, persisted immediately
    seedGenerated = true;
  } else {
    kp.seed = seedIn;
  }
  const seedVal = kp.seed as number;
  if (!Number.isInteger(seedVal) || seedVal < 0 || seedVal > 0xffffffff) {
    throw new Error(`kernel_params.seed must be an integer in [0, 2^32), got ${seedVal}`);
  }
  const recipe: StoredRecipe = {
    recipe_id: randomUUID(),
    kernel_params: kp as unknown as StoredRecipe["kernel_params"],
    duration_sec: input.duration_sec,
    output: input.output,
    created: new Date().toISOString(),
    seed_generated: seedGenerated,
  };
  const recipes = loadRecipes();
  recipes[recipe.recipe_id] = recipe;
  saveRecipes(recipes);
  return recipe;
}

const RECIPES_INDEX = path.join(DATA_DIR, "recipes.json");
function loadRecipes(): Record<string, StoredRecipe> {
  try {
    return JSON.parse(fs.readFileSync(RECIPES_INDEX, "utf8"));
  } catch {
    return {};
  }
}
function saveRecipes(r: Record<string, StoredRecipe>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteJson(RECIPES_INDEX, r);
}
export function getRecipe(id: string): StoredRecipe | undefined {
  return loadRecipes()[id];
}

export function submitJob(recipeId: string, opts: { preview?: boolean; durationSecOverride?: number; formatOverride?: "wav" | "m4a" | "mp3" | "mp4" } = {}): Job {
  const recipe = getRecipe(recipeId);
  if (!recipe) throw new Error(`recipe '${recipeId}' not found`);
  const job: Job = {
    job_id: randomUUID(), // full UUID — never a seed source
    recipe_id: recipeId,
    recipe: structuredClone(recipe),
    status: "pending",
    progress: 0,
    preview: opts.preview ?? false,
    created: new Date().toISOString(),
  };
  if (opts.durationSecOverride !== undefined) {
    if (!Number.isFinite(opts.durationSecOverride) || opts.durationSecOverride <= 0) throw new Error("duration_sec override must be > 0");
    job.recipe.duration_sec = opts.durationSecOverride;
  }
  if (opts.formatOverride !== undefined) {
    // previews default to mp3 — cheap audition; the stored recipe is untouched
    job.recipe.output = { ...job.recipe.output, format: opts.formatOverride, video_asset_id: opts.formatOverride === "mp4" ? job.recipe.output.video_asset_id : undefined };
  }
  jobs[job.job_id] = job;
  saveJobs(jobs);
  queue.push(job.job_id);
  drain();
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs[jobId];
}

export function jobStatusCounts(): Record<JobStatus, number> {
  const counts: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const j of Object.values(jobs)) counts[j.status]++;
  return counts;
}

/** On daemon startup: anything the previous process left "running"/"pending" is dead. */
export function reapStaleJobs(): number {
  let n = 0;
  for (const j of Object.values(jobs)) {
    if (j.status === "running" || j.status === "pending") {
      j.status = "failed";
      j.error = "daemon restarted before job completed";
      j.finished = new Date().toISOString();
      n++;
    }
  }
  if (n) saveJobs(jobs);
  queue.length = 0;
  return n;
}

async function drain(): Promise<void> {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
    await runJob(next);
  } finally {
    running = false;
    if (queue.length) void drain();
  }
}

function runJob(jobId: string): Promise<void> {
  const job = jobs[jobId];
  if (!job) return Promise.resolve();
  const jobDir = path.join(JOBS_DIR, job.job_id);
  fs.mkdirSync(jobDir, { recursive: true });
  const tmpDir = path.join(jobDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const ext = job.recipe.output.format === "m4a" ? "m4a" : job.recipe.output.format;
  // temp name keeps the real extension LAST — ffmpeg infers the muxer from the
  // output extension, so "output.mp3.tmp" would abort with "Unable to find a
  // suitable output format" and EPIPE the pipe (caught by test/phase5).
  const outTmp = path.join(tmpDir, `output.tmp.${ext}`);
  const outFinal = path.join(jobDir, `output.${ext}`);

  const fmt = job.recipe.output.format;
  let assetFile: string | undefined;
  if (fmt === "mp4" && job.recipe.output.video_asset_id) {
    const asset = getAsset(job.recipe.output.video_asset_id);
    if (!asset) {
      job.status = "failed";
      job.error = `video asset '${job.recipe.output.video_asset_id}' evicted before render`;
      job.finished = new Date().toISOString();
      saveJobs(jobs);
      return Promise.resolve();
    }
    assetFile = asset.file;
  }

  job.status = "running";
  job.started = new Date().toISOString();
  saveJobs(jobs);

  return new Promise<void>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: {
          jobId: job.job_id,
          kernelParams: job.recipe.kernel_params,
          durationSec: job.recipe.duration_sec,
          output: { format: fmt, videoAssetFile: assetFile },
          outTmp,
        },
      });
    } catch (e) {
      fail(job, `worker spawn failed: ${String(e)}`, tmpDir);
      return resolve();
    }
    let lastDone: WorkerDone | null = null;
    worker.on("message", (m: WorkerProgress | WorkerDone) => {
      if (m.type === "progress") {
        job.progress = m.totalFrames > 0 ? m.framesWritten / m.totalFrames : 0;
        saveJobs(jobs);
      } else if (m.type === "done") {
        lastDone = m;
      }
    });
    worker.on("error", (e: Error) => {
      fail(job, String(e?.message ?? e), tmpDir);
      resolve();
    });
    worker.on("exit", (code: number) => {
      if (job.status !== "running") return resolve(); // already failed via error handler
      if (code !== 0 || !lastDone) {
        fail(job, `worker exited with code ${code} before completion`, tmpDir);
        return resolve();
      }
      finalize(job, lastDone, outTmp, outFinal, tmpDir, jobDir, assetFile).then(resolve).catch((e) => {
        fail(job, `finalize failed: ${String(e?.message ?? e)}`, tmpDir);
        resolve();
      });
    });
  });
}

function fail(job: Job, error: string, tmpDir: string): void {
  job.status = "failed";
  job.error = error.slice(-2000);
  job.finished = new Date().toISOString();
  saveJobs(jobs);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(`[job ${job.job_id}] FAILED: ${job.error}`);
}

/** round2: output verification, exported from finalize() so tests can prove
 * the negative path — a truncated/corrupt file must throw here and never
 * reach "done". Checks, in order: file exists → container parseable
 * (ffprobe) → reported duration within tolerance of the expected (snapped)
 * duration → audio stream present → (mp4) video stream present and, when an
 * asset was muxed, still h264 stream-copied. */
export async function verifyRenderedOutput(
  outTmp: string,
  fmt: "wav" | "m4a" | "mp3" | "mp4",
  expectedSec: number,
  expectH264Video: boolean,
): Promise<void> {
  if (fmt === "wav") {
    // header/size consistency check (lib/wav.mjs shape) — cheap, no ffmpeg needed
    const fd = fs.openSync(outTmp, "r");
    const buf = Buffer.alloc(44);
    fs.readSync(fd, buf, 0, 44, 0);
    fs.closeSync(fd);
    const declared = buf.readUInt32LE(40);
    const actual = fs.statSync(outTmp).size - 44;
    if (buf.toString("ascii", 0, 4) !== "RIFF" || declared !== actual) {
      throw new Error(`WAV header inconsistent: declared ${declared} data bytes, file has ${actual}`);
    }
    if (Math.round(expectedSec * 44100) * 4 !== actual) {
      throw new Error(`WAV frame count mismatch: expected ${Math.round(expectedSec * 44100) * 4} data bytes, got ${actual}`);
    }
  } else {
    // ffprobe: container opens, expected duration, stream sanity
    const info = await ffprobeJson(outTmp);
    const dur = Number(info.format.duration ?? 0);
    const tol = Math.max(0.5, expectedSec * 0.02);
    if (Math.abs(dur - expectedSec) > tol) {
      throw new Error(`ffprobe duration ${dur.toFixed(2)}s differs from expected ${expectedSec.toFixed(2)}s beyond tolerance ${tol.toFixed(2)}s`);
    }
    // round2: container headers can LIE (a truncated MP3's Xing header still
    // claims the full frame count — measured). Assert against the ACTUAL
    // decoded audio length (ffprobe -count_samples), the check that would
    // have caught the "correct metadata, ~1 s of content" defect.
    const decodedSec = await ffmpegDecodedAudioSec(outTmp);
    if (Math.abs(decodedSec - expectedSec) > tol) {
      throw new Error(
        `decoded audio content is ${decodedSec.toFixed(2)}s but expected ${expectedSec.toFixed(2)}s ` +
        `(container claims ${dur.toFixed(2)}s, tolerance ${tol.toFixed(2)}s) — output is truncated or corrupt`,
      );
    }
    const hasAudio = info.streams.some((s) => s.codec_type === "audio");
    if (!hasAudio) throw new Error("output has no audio stream");
    if (fmt === "mp4") {
      const vs = info.streams.find((s) => s.codec_type === "video");
      if (!vs) throw new Error("mp4 output has no video stream");
      if (expectH264Video && vs.codec_name !== "h264") {
        throw new Error(`mp4 video codec ${vs.codec_name} — expected stream-copied h264`);
      }
    }
  }
}

/** ffprobe verification, then atomic rename into place + provenance sidecar. */
async function finalize(job: Job, done: WorkerDone, outTmp: string, outFinal: string, tmpDir: string, jobDir: string, assetFile?: string): Promise<void> {
  if (!fs.existsSync(outTmp)) throw new Error("render produced no temp output");
  const fmt = job.recipe.output.format;

  await verifyRenderedOutput(outTmp, fmt, done.snappedSec, Boolean(job.recipe.output.video_asset_id));

  // verified → atomic rename into place (a crashed/cancelled render never
  // leaves a half-written file where a client could find it)
  fs.renameSync(outTmp, outFinal);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const sha = await sha256FileStreaming(outFinal); // streaming — output can be GBs
  const output: OutputFile = {
    path: outFinal,
    format: fmt,
    bytes: fs.statSync(outFinal).size,
    sha256: sha,
  };
  job.outputs = [output];
  job.progress = 1;

  // provenance sidecar — what makes a render debuggable later
  const kernelSha = fileSha(path.join(ROOT, "..", "kernel", "musicalLogic.ts"));
  const synthSha = fileSha(path.join(ROOT, "src", "blockSynth.ts"));
  const nvenc = await probeNvenc();
  const commands: string[] = [];
  if (fmt === "m4a") commands.push(`ffmpeg -f s16le -ar 44100 -ac 2 -i pipe:0 -c:a aac -b:a 160k ${outFinal}`);
  if (fmt === "mp3") commands.push(`ffmpeg -f s16le -ar 44100 -ac 2 -i pipe:0 -c:a libmp3lame -b:a 192k ${outFinal}`);
  if (fmt === "mp4") {
    if (assetFile) commands.push(`ffmpeg -y -stream_loop -1 -i ${assetFile} -f s16le -ar 44100 -ac 2 -i pipe:0 -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart ${outFinal}`);
    else commands.push(`ffmpeg -y -loop 1 -r 1 -i <default_bg.png> -f s16le -ar 44100 -ac 2 -i pipe:0 -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 23 -r 1 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest -movflags +faststart ${outFinal}`);
  }
  if (fmt === "wav") commands.push("WavFileSink (PoC): streaming PCM16 WAV, 44-byte canonical header");

  job.provenance = {
    job_id: job.job_id,
    recipe_id: job.recipe_id,
    created: job.created,
    kernel: {
      file: "kernel/musicalLogic.ts",
      sha256: kernelSha,
      note: "the shared kernel — one copy at <repo>/kernel/musicalLogic.ts imported by ui, daemon and bench alike (single-copy drift guard: scripts/check_shared_kernel.mjs)",
    },
    blockSynth: {
      file: "src/blockSynth.ts",
      sha256: synthSha,
      note: "benchmark PoC block synth, unmodified DSP — import paths only",
    },
    seed: Number(job.recipe.kernel_params.seed),
    duration: {
      requested_sec: done.requestedSec,
      snapped_sec: done.snappedSec,
      bars: done.bars,
      beats: done.beats,
    },
    render: {
      sample_rate: 44100,
      block_frames: 4096,
      kernel_event_count: done.kernelEventCount,
      skipped_sample_events: done.skippedSampleEvents,
      peak_concurrent_voices: done.peakConcurrentVoices,
      pcm16_sha256: done.pcmSha256,
      peak_sample_abs: done.peakSampleAbs,
      wall_sec: done.renderWallSec,
      worker_isolation: "fresh worker_threads Worker per job, terminated on completion",
    },
    ffmpeg_commands: commands,
    outputs: [output],
    nvenc: { available: nvenc.available, note: "informational — v1 render path is CPU-only" },
    node_version: process.version,
    ffmpeg_version: await getFfmpegVersion(),
  };

  job.status = "done";
  job.finished = new Date().toISOString();
  saveJobs(jobs);
  atomicWriteJson(path.join(jobDir, "provenance.json"), job.provenance);
  console.log(`[job ${job.job_id}] done: ${outFinal} (${output.bytes} bytes)`);
}

export function jobResult(jobId: string): { outputs: OutputFile[]; provenance: Provenance } {
  const job = jobs[jobId];
  if (!job) throw new Error(`job '${jobId}' not found`);
  if (job.status !== "done") throw new Error(`job '${jobId}' is ${job.status}, not done`);
  if (!job.outputs || !job.provenance) {
    // sidecar on disk even if index was rebuilt
    const p = path.join(JOBS_DIR, jobId, "provenance.json");
    if (fs.existsSync(p)) {
      const prov = JSON.parse(fs.readFileSync(p, "utf8")) as Provenance;
      return { outputs: prov.outputs, provenance: prov };
    }
    throw new Error(`job '${jobId}' has no result on disk`);
  }
  return { outputs: job.outputs, provenance: job.provenance };
}
