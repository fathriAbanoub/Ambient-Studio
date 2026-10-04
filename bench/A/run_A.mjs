/**
 * bench/A/run_A.mjs — category A orchestrator (independently runnable):
 *   node bench/A/run_A.mjs [--scale S]
 * --scale divides the A1/A3 horizon (default 8h) for smoke tests.
 */
import path from "node:path";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";

const ENV = JSON.parse(process.env.BENCH_ENV ?? "{}");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR;
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const BENCH_DIR = path.resolve(import.meta.dirname, "..");

function parseMeasurement(stdout) {
  const marker = "__BENCH_JSON__";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) throw new Error(`kernel_bench produced no measurement JSON. stderr tail:\n${stdout.slice(-500)}`);
  return JSON.parse(stdout.slice(idx + marker.length));
}

async function runMode(benchmarkId, mode, methodology, extraParams = {}) {
  const build = await buildTsEntry(
    path.join(BENCH_DIR, "A", "kernel_bench.ts"),
    path.join(BENCH_DIR, ".build"),
    "kernel_bench",
  );
  if (!build.ok) {
    await skipBench(RESULTS_DIR, benchmarkId, "A", ENV, `TypeScript runner unavailable → ${build.error}`);
    return null;
  }
  process.env.BENCH_A_HOURS = String(8 * SCALE);
  const res = runNode(build.outfile, [mode]);
  const { code, stdout, stderr } = await res;
  if (code !== 0) {
    await skipBench(RESULTS_DIR, benchmarkId, "A", ENV, `kernel_bench exited ${code}: ${stderr.slice(-500)}`);
    return null;
  }
  const m = parseMeasurement(stdout);
  const result = new Result(benchmarkId, "A", ENV, { ts_runner: build.runner, horizon_hours: 8 * SCALE, ...extraParams }, methodology);
  result.doc.stats = m;
  result.doc.raw_samples = { bucket_medians_ms: m.bucket_medians_ms ?? null };
  const file = await result.write(RESULTS_DIR);
  console.log(`  -> ${file}`);
  return m;
}

export async function runA() {
  console.log("[A] kernel throughput");
  await runMode(
    "A1_kernel_throughput_8h",
    "A1",
    {
      measured: "wall-clock time per getMusicalEvents() call (ms) across a full simulated 8-hour beat sequence",
      granularity: "per call, performance.now() around the kernel call only (shell-side spread excluded)",
      trials: "1 run ≈ 30k calls; distribution reported over all calls",
      warmup: "30 s simulated warm-up run before measurement; first 100 measured calls discarded",
      outliers: "none removed — median/p95/min/max reported; bucket medians expose growth and boundary spikes",
      statistic: "median, p95, min, max + per-bucket medians + transition vs non-transition",
    },
  );
  await runMode(
    "A2_kernel_feature_costs",
    "A2",
    {
      measured: "per-call cost by configuration: drone layers 0/4/8 × sample bank 0/16 entries",
      granularity: "per call, ms",
      trials: "1 run × 2000 nominal beats per configuration (6 configurations)",
      warmup: "30 s simulated warm-up per configuration; first 100 measured calls discarded",
      outliers: "none removed — median/p95 reported",
      statistic: "median, p95, min, max",
    },
  );
  await runMode(
    "A3_kernel_8h_totals",
    "A3",
    {
      measured: "total wall-clock and peak RSS to generate (kernel only, no audio graph) a full 8-hour beat sequence",
      granularity: "whole-run wall clock; resourceUsage().maxRSS (KB per Node docs) or memoryUsage().rss",
      trials: "1 run",
      warmup: "none (the run itself is the measurement)",
      outliers: "n/a — single-run totals",
      statistic: "wall_sec, wall_per_call_us, peak_rss_bytes",
    },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runA();
}
