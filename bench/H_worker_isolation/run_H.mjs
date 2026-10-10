/**
 * run_H.mjs — worker isolation / responsiveness (H1), independently runnable:
 *   node bench/H_worker_isolation/run_H.mjs [--scale S]
 *
 * Measures main-thread event-loop lag with a 50 ms setInterval probe:
 *   1. baseline window (no render), then
 *   2. while a 15-min seeded render runs inside a worker_threads Worker.
 * The worker runs the exact G-category render path. Claim under test: an
 * 8-hour-scale render must not block request handling — quantified here as
 * lag distributions with vs without the render.
 *
 * Cross-topology determinism is also asserted: the worker's WAV hash must
 * equal a fresh child-process hash of the same seed/duration/params (the
 * render path is the same module; the topology must not matter).
 */
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";
import { captureEnvironment } from "../lib/env.mjs";
import { verifyWavHeader } from "../lib/wav.mjs";
import { H_RENDER_SEC, H_LAG_POLL_INTERVAL_MS, H_BASELINE_MS, G_SAMPLE_RATE, G_BLOCK_FRAMES } from "../lib/constants.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? path.join(BENCH_DIR, "results");
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const ENV = process.env.BENCH_ENV ? JSON.parse(process.env.BENCH_ENV) : await captureEnvironment(RESULTS_DIR);
const WORK = path.join(BENCH_DIR, ".work", "H");

/** Event-loop lag probe: setInterval drift = how late each tick fired. */
function lagProbe(intervalMs) {
  const samples = [];
  let timer = null;
  let next = performance.now() + intervalMs;
  const tick = () => {
    const now = performance.now();
    samples.push(Math.max(0, now - next));
    next = now + intervalMs;
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop() { clearTimeout(timer); },
    samples,
  };
}

function lagStats(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: sorted.length,
    mean: samples.reduce((a, b) => a + b, 0) / sorted.length,
    median: pct(0.5),
    p95: pct(0.95),
    max: sorted[sorted.length - 1],
  };
}

export async function runH() {
  console.log("[H] worker isolation / responsiveness");
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const build = await buildTsEntry(path.join(BENCH_DIR, "G_streaming_synth", "worker_entry.ts"), path.join(BENCH_DIR, ".build"), "worker_entry");
  if (!build.ok) {
    await skipBench(RESULTS_DIR, "H1_mainthread_responsiveness", "H", ENV, `TypeScript runner unavailable → ${build.error}`);
    return;
  }

  const renderSec = Math.max(30, Math.round(H_RENDER_SEC * SCALE));
  const wavPath = path.join(WORK, `h_render.wav`);
  const params = {
    scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
    sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true,
    enableBeats: true, seed: 42, drumLevel: 0.5, swing: 0,
    drumStyle: "euclideanTrap", sidechainAmount: 0,
  };

  const result = new Result("H1_mainthread_responsiveness", "H", ENV,
    { render_sec: renderSec, lag_poll_interval_ms: H_LAG_POLL_INTERVAL_MS, baseline_ms: H_BASELINE_MS, topology: "worker_threads" },
    {
      measured: "main-thread event-loop lag (setInterval drift) during (a) a no-render baseline window and (b) the full worker render; plus the worker's own completion stats",
      granularity: "one lag sample per 50 ms probe tick, throughout both windows",
      trials: "1 baseline window + 1 render window (the render is the long operation under test)",
      warmup: "the baseline window precedes the render; probe runs continuously across both",
      outliers: "none removed — max/median/p95 reported",
      statistic: "lag mean/median/p95/max per window; render-vs-baseline ratios",
    });

  // 1. baseline lag (no render)
  const probe = lagProbe(H_LAG_POLL_INTERVAL_MS);
  await new Promise((r) => setTimeout(r, H_BASELINE_MS));
  probe.stop();
  const baseline = lagStats(probe.samples);
  console.log(`  baseline: median ${baseline.median.toFixed(2)} ms, max ${baseline.max.toFixed(2)} ms over ${baseline.n} probes`);

  // 2. render in worker with live probe
  const probe2 = lagProbe(H_LAG_POLL_INTERVAL_MS);
  const workerStart = performance.now();
  const worker = new Worker(pathToFileURL(build.outfile), {
    workerData: { params, durationSec: renderSec, blockFrames: G_BLOCK_FRAMES, out: wavPath },
  });
  const workerDone = new Promise((resolve, reject) => {
    worker.on("message", (m) => {
      m.main_thread_wall_sec = (performance.now() - workerStart) / 1000;
      resolve(m);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
  const summary = await workerDone;
  probe2.stop();
  const during = lagStats(probe2.samples);
  console.log(`  during render: median ${during.median.toFixed(2)} ms, max ${during.max.toFixed(2)} ms over ${during.n} probes`);
  console.log(`  worker: ${summary.frames_written} frames in ${summary.wall_sec.toFixed(1)}s (${(summary.frames_written / summary.wall_sec / G_SAMPLE_RATE).toFixed(1)}× realtime)`);

  result.addTrial("baseline", { phase: "no_render" }, probe.samples.length ? [probe.samples[probe.samples.length - 1]] : [0], { stats: baseline, raw_omitted: true, note: "raw samples in raw_samples.baseline_lag" });
  result.addTrial("during_render", { phase: "worker_render_active" }, [during.median], { stats: during, note: "raw samples in raw_samples.during_lag" });
  result.doc.raw_samples = {
    baseline_lag_ms: probe.samples.map((v) => Number(v.toFixed(3))),
    during_lag_ms: probe2.samples.map((v) => Number(v.toFixed(3))),
  };

  result.setStats("baseline", baseline);
  result.setStats("during_render", during);
  result.setStats("ratios", {
    median: during.median / Math.max(baseline.median, 1e-9),
    p95: during.p95 / Math.max(baseline.p95, 1e-9),
    max: during.max / Math.max(baseline.max, 1e-9),
  });
  result.setStats("worker", summary);

  result.addAssertion("frames_exact", summary.frames_written === Math.ceil(renderSec * G_SAMPLE_RATE),
    `expected ${Math.ceil(renderSec * G_SAMPLE_RATE)} frames, got ${summary.frames_written}`);
  const hdr = verifyWavHeader(wavPath);
  result.addAssertion("wav_header_ok", hdr.riffOk && hdr.sizeConsistent, `RIFF ok=${hdr.riffOk}, size consistent=${hdr.sizeConsistent}`);

  // Cross-topology determinism: same seed via a child process must produce
  // the identical bytes the worker produced.
  const entry = await buildTsEntry(path.join(BENCH_DIR, "G_streaming_synth", "render_entry.ts"), path.join(BENCH_DIR, ".build"), "render_entry");
  if (entry.ok) {
    const { runNode } = await import("../lib/tsrun.mjs");
    const { code, stdout, stderr } = await runNode(entry.outfile, [
      "--duration", String(renderSec), "--block", String(G_BLOCK_FRAMES),
      "--mode", "hash", "--seed", "42", "--out", path.join(WORK, "h_cross.wav"),
    ], { timeoutMs: 3600_000 });
    if (code === 0) {
      const marker = "__BENCH_JSON__";
      const child = JSON.parse(stdout.slice(stdout.lastIndexOf(marker) + marker.length));
      result.addAssertion("worker_vs_child_byte_identical", child.pcm16_sha256 === summary.sha256,
        child.pcm16_sha256 === summary.sha256
          ? `worker_threads and child-process renders agree (${String(summary.sha256).slice(0, 16)}…) — topology does not affect output`
          : `MISMATCH worker ${summary.sha256} vs child ${child.pcm16_sha256}`);
    } else {
      result.addObservation(`cross-topology check failed to run: ${stderr.slice(0, 200)}`);
    }
  }

  result.addObservation(
    `Event-loop lag with a ${renderSec}s render active in a worker: median ${during.median.toFixed(2)} ms vs baseline ${baseline.median.toFixed(2)} ms, ` +
    `p95 ${during.p95.toFixed(2)} vs ${baseline.p95.toFixed(2)} ms, max ${during.max.toFixed(2)} vs ${baseline.max.toFixed(2)} ms. ` +
    `Interpretation: the probe lives on the main thread that would serve HTTP/MCP requests; sustained lag growth here is the "long render blocks request handling" failure mode.`,
  );

  const file = await result.write(RESULTS_DIR);
  console.log(`  -> ${file}`);
  if (process.env.BENCH_KEEP_ARTIFACTS !== "1") {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runH();
}
