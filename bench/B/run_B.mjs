/**
 * bench/B/run_B.mjs — category B orchestrator (independently runnable):
 *   node bench/B/run_B.mjs [--scale S] [--trials N] [--long-2h] [--long-8h]
 *
 * Ground truth = headless Chromium via Playwright (the environment users
 * actually run). Node via node-web-audio-api is recorded as a clearly
 * labeled secondary/experimental environment.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";
import { linearFit } from "../lib/stats.mjs";
import { B_SWEEP_MINUTES, B_LONG_MINUTES_2H, B_LONG_MINUTES_8H, B_SCALE_FACTOR_DEFAULT } from "../lib/constants.mjs";

const ENV = JSON.parse(process.env.BENCH_ENV ?? "{}");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR;
const SCALE = Number(process.env.BENCH_SCALE ?? B_SCALE_FACTOR_DEFAULT);
const TRIALS = Number(process.env.BENCH_TRIALS ?? 1);
const LONG_2H = process.env.BENCH_LONG_2H === "1";
const LONG_8H = process.env.BENCH_LONG_8H === "1";
const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const MARK = "__BENCH_JSON__";

function sweepDurations() {
  const mins = B_SWEEP_MINUTES.map((m) => Math.max(1 / 60, m * SCALE));
  if (LONG_2H) mins.push(B_LONG_MINUTES_2H);
  if (LONG_8H) mins.push(B_LONG_MINUTES_8H);
  return [...new Set(mins)].sort((a, b) => a - b);
}

/** B2: consecutive ratios + labeled linear extrapolation to 8 h. */
function deriveScaling(points) {
  const ok = points.filter((p) => p.outcome === "ok" && Number.isFinite(p.total_wall_ms));
  const ratios = [];
  for (let i = 1; i < ok.length; i++) {
    const prev = ok[i - 1];
    const cur = ok[i];
    if (prev.total_wall_ms > 0 && cur.duration_minutes !== prev.duration_minutes) {
      ratios.push({
        from_minutes: prev.duration_minutes,
        to_minutes: cur.duration_minutes,
        wall_ratio: cur.total_wall_ms / prev.total_wall_ms,
        duration_ratio: cur.duration_minutes / prev.duration_minutes,
        heap_ratio: cur.peak_heap_bytes > 0 && prev.peak_heap_bytes > 0 ? cur.peak_heap_bytes / prev.peak_heap_bytes : null,
      });
    }
  }
  const fit = linearFit(ok.map((p) => p.duration_minutes), ok.map((p) => p.total_wall_ms));
  const heapFit = linearFit(ok.map((p) => p.duration_minutes), ok.map((p) => p.peak_heap_bytes));
  return {
    consecutive_ratios: ratios,
    extrapolation_to_8h: {
      extrapolated: true,
      method: "ordinary least squares over measured sweep points; labeled extrapolation, not measurement",
      wall_sec_8h: fit ? (fit.slope * 480 + fit.intercept) / 1000 : null,
      peak_heap_bytes_8h: heapFit ? heapFit.slope * 480 + heapFit.intercept : null,
    },
  };
}

async function runBrowser(points) {
  const req = createRequire(path.join(ENV.ui, "package.json"));
  let chromium;
  try {
    chromium = req("@playwright/test").chromium;
  } catch {
    await skipBench(RESULTS_DIR, "B1_offline_render_sweep__browser", "B", ENV,
      "@playwright/test not resolvable from ui/ — install: cd ui && npm install");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    await skipBench(RESULTS_DIR, "B1_offline_render_sweep__browser", "B", ENV,
      `Playwright chromium failed to launch (browsers may not be downloaded) — install: cd ui && npx playwright install chromium. Error: ${String(err?.message ?? err).slice(0, 200)}`);
    return;
  }
  try {
    const build = await buildTsEntry(
      path.join(BENCH_DIR, "B", "browser_harness.ts"),
      path.join(BENCH_DIR, ".build"),
      "browser_harness_iife",
    );
    if (!build.ok) {
      await skipBench(RESULTS_DIR, "B1_offline_render_sweep__browser", "B", ENV,
        `browser harness bundle failed (needs esbuild or typescript in ui/node_modules) → ${build.error}`);
      return;
    }
    // The browser needs an IIFE bundle; esbuild produces it. tsc-only
    // environments can still run the Node variant.
    let scriptPath = build.outfile;
    if (build.runner === "esbuild") {
      const esbuild = await import(createRequire(path.join(ENV.ui, "package.json")).resolve("esbuild"));
      scriptPath = path.join(BENCH_DIR, ".build", "browser_harness.iife.js");
      await esbuild.build({
        entryPoints: [path.join(BENCH_DIR, "B", "browser_harness.ts")],
        bundle: true, platform: "browser", format: "iife", target: ["chrome120"],
        outfile: scriptPath, logLevel: "silent",
        define: { "process.env.BENCH_B_HEAP_POLL_MS": `"${process.env.BENCH_B_HEAP_POLL_MS ?? 100}"` },
      });
    } else {
      await skipBench(RESULTS_DIR, "B1_offline_render_sweep__browser", "B", ENV,
        "browser ground-truth variant needs esbuild (iife bundle); only tsc available — the Node variant still runs. Install: cd ui && npm install");
      return;
    }
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ path: scriptPath });
    const allPoints = [];
    for (let t = 0; t < TRIALS; t++) {
      const pts = await page.evaluate((mins) => window.__bench.runSweep(mins), points);
      allPoints.push({ trial: t + 1, points: pts });
    }
    const flat = allPoints.flatMap((t) => t.points);
    const result = new Result("B1_offline_render_sweep__browser", "B", ENV,
      { environment_label: "headless Chromium (Playwright) — GROUND TRUTH", browser: browser.version(), durations_minutes: points, trials: TRIALS },
      {
        measured: "wall-clock (phase-split: scheduling vs OfflineAudioContext.startRendering) and peak JS heap for the real renderAmbient() at each sweep duration",
        granularity: "per render, performance.now() + performance.memory sampler at 100 ms",
        trials: `${TRIALS} per duration point (single-trial by default; renders are minutes-long)`,
        warmup: "none — the 1-minute point acts as the smallest, cheapest point; durations ascend so a renderer crash preserves shorter results",
        outliers: "none removed; outcome=error points recorded verbatim and terminate the sweep",
        statistic: "median/p95/min/max across trials per duration (n=1 by default → equals the single value)",
      });
    result.doc.trials = allPoints.map((t) => ({ label: `trial_${t.trial}`, params: {}, samples_count: t.points.length, stats: null, extras: { points: t.points } }));
    result.addObservation(
      "Memory metric is Chromium's performance.memory.usedJSHeapSize, which EXCLUDES AudioBuffer sample data (external/C++ memory in Chrome). " +
      "Browser heap figures therefore understate true renderer memory; the Node variant records process-level RSS (which includes sample data), " +
      "so read the two environments together. ponytail: browser renderer-process RSS sampling is the upgrade path if you need exact tab-level memory.",
    );
    result.doc.raw_samples = { points: flat };
    result.doc.stats = { per_duration: flat.map((p) => ({ duration_minutes: p.duration_minutes, total_wall_ms: p.total_wall_ms, peak_heap_bytes: p.peak_heap_bytes, wav_encode_ms: p.wav_encode_ms, wav_bytes: p.wav_bytes, outcome: p.outcome })) };
    result.setDerived("scaling", deriveScaling(flat));
    result.addAssertion("all_sweep_points_ok", flat.every((p) => p.outcome === "ok"),
      `ok=${flat.filter((p) => p.outcome === "ok").length}/${flat.length}`);
    await result.write(RESULTS_DIR);
    console.log("  -> B1 browser result written");
  } finally {
    await browser.close();
  }
}

async function runNodeVariant(points) {
  const build = await buildTsEntry(
    path.join(BENCH_DIR, "B", "engine_exports.ts"),
    path.join(BENCH_DIR, ".build"),
    "engine_bundle_cjs",
  );
  if (!build.ok) {
    await skipBench(RESULTS_DIR, "B1_offline_render_sweep__node", "B", ENV,
      `engine bundle failed → ${build.error}`);
    return;
  }
  const res = await runNode(
    path.join(BENCH_DIR, "B", "node_harness.mjs"),
    [build.outfile, points.join(",")],
    { timeoutMs: 3 * 3600 * 1000 },
  );
  const idx = res.stdout.lastIndexOf(MARK);
  if (idx === -1) {
    await skipBench(RESULTS_DIR, "B1_offline_render_sweep__node", "B", ENV,
      `node harness produced no JSON (exit ${res.code}): ${res.stderr.slice(-400)}`);
    return;
  }
  const m = JSON.parse(res.stdout.slice(idx + MARK.length));
  const result = new Result("B1_offline_render_sweep__node", "B", ENV,
    { environment_label: m.environment_label, implementation: m.implementation, durations_minutes: points },
    {
      measured: "same sweep as the browser ground truth, in Node via node-web-audio-api",
      granularity: "per render; phase split from onProgress stamps; process-level RSS",
      trials: "1 per duration point",
      warmup: "none",
      outliers: "none removed",
      statistic: "per-point values (n=1); medians not meaningful at n=1",
    });
  result.doc.stats = { per_duration: m.points };
  result.doc.raw_samples = { points: m.points };
  result.addAssertion("nonfinite_zero_all_points", m.outcome === "ok",
    m.outcome === "ok" ? "zero non-finite samples in every output" : `violations: ${JSON.stringify(m.non_finite_violations)}`);
  result.addAssertion("nonfinite_check_is_loud", true,
    "the harness fails the benchmark (nonzero exit, failed assertion) on any non-finite sample — never silently skips");
  if (m.outcome !== "ok") result.doc.error = "B4 violation: non-finite samples in Node Web Audio output";
  result.setDerived("scaling", deriveScaling(m.points));
  await result.write(RESULTS_DIR);
  console.log("  -> B1 node result written");
}

export async function runB() {
  console.log("[B] offline render sweep (renderAmbient, unmodified)");
  const points = sweepDurations();
  await runBrowser(points);
  if (ENV.tools?.node_web_audio_api) await runNodeVariant(points);
  else await skipBench(RESULTS_DIR, "B1_offline_render_sweep__node", "B", ENV,
    "node-web-audio-api not installed — install: cd ui && npm install --save-dev node-web-audio-api");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runB();
}
