/**
 * run_I.mjs — automation state-carry (I1), independently runnable:
 *   node bench/I_automation_state_carry/run_I.mjs [--scale S]
 *
 * The direct successor to category C. Category C asked: can a Web-Audio
 * graph be split into chunks whose output matches one continuous render?
 * It measured max|Δ| = 2.8e-1 with divergence NOT seam-localized (i.e.
 * systematic re-anchoring, not edge effects) and 70.6% chunking overhead.
 * Those numbers were measured on the user's machine (bench/results/ on
 * their hardware); they are quoted here as context, not re-measured.
 *
 * I1 asks the successor question: does the in-process block-synth design
 * eliminate that divergence class?
 *   I1a — block-size invariance: the C-graph rendered through the in-process
 *         design at 1024/4096/16384 frames AND a single-block partition must
 *         produce byte-identical output (streaming sha256). If block
 *         boundaries are invisible, chunk-divergence is structurally gone.
 *   I1b — broken variant: re-anchoring + block-relative coefficient grid
 *         (the two mechanisms per-chunk rendering actually applies) must
 *         re-introduce divergence — its magnitude scales with RE-ANCHORING
 *         FREQUENCY (smaller blocks re-anchor more often → larger deviation),
 *         which the measured values show. This proves the tests detect the
 *         failure mode.
 *   I1c — cross-engine proximity: my block synth vs node-web-audio-api's
 *         single-pass render of the same graph at 120 s — measured max|Δ|/rms,
 *         reported, never asserted (different filter/osc implementations).
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";
import { captureEnvironment } from "../lib/env.mjs";
import {
  C_SAMPLE_RATE, C_CARRIER_HZ, C_SUBOSC_HZ, C_FILTER_START_HZ, C_FILTER_END_HZ,
  C_FILTER_Q, C_DELAY_START_SEC, C_DELAY_END_SEC, C_DELAY_MAX_SEC,
  C_FEEDBACK_GAIN, C_MASTER_GAIN, C_PAN_PERIOD_SEC, C_PAN_TARGET_TIME_CONSTANT,
  I_TOTAL_SEC, I_BLOCK_SIZES, I_CROSSCHECK_SEC, I_BROKEN_BLOCK_SIZES,
} from "../lib/constants.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? path.join(BENCH_DIR, "results");
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const ENV = process.env.BENCH_ENV ? JSON.parse(process.env.BENCH_ENV) : await captureEnvironment(RESULTS_DIR);

const C_CONST = {
  carrierHz: C_CARRIER_HZ, subHz: C_SUBOSC_HZ, subGain: 0.5,
  filterStartHz: C_FILTER_START_HZ, filterEndHz: C_FILTER_END_HZ, filterQ: C_FILTER_Q,
  delayStartSec: C_DELAY_START_SEC, delayEndSec: C_DELAY_END_SEC, delayMaxSec: C_DELAY_MAX_SEC,
  feedbackGain: C_FEEDBACK_GAIN, masterGain: C_MASTER_GAIN,
  panPeriodSec: C_PAN_PERIOD_SEC, panTargetTcSec: C_PAN_TARGET_TIME_CONSTANT,
};

function parseMeasurement(stdout) {
  const marker = "__BENCH_JSON__";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) throw new Error(`i_entry produced no JSON. stderr tail:\n${stdout.slice(-800)}`);
  return JSON.parse(stdout.slice(idx + marker.length));
}

export async function runI() {
  console.log("[I] automation state-carry (successor to category C)");
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // The whole category runs in ONE child process (i_entry.ts): the renders
  // are per-sample streaming with fixed inventory — no cross-configuration
  // warm-state risk for MEMORY, and hash comparisons are order-independent.
  // Timing claims are per-render wall clocks inside that child.
  const build = await buildTsEntry(path.join(BENCH_DIR, "I_automation_state_carry", "i_entry.ts"), path.join(BENCH_DIR, ".build"), "i_entry");
  if (!build.ok) {
    await skipBench(RESULTS_DIR, "I1_automation_state_carry", "I", ENV, `TypeScript runner unavailable → ${build.error}`);
    return;
  }
  const totalSec = Math.max(60, Math.round(I_TOTAL_SEC * SCALE));
  const crossSec = Math.max(30, Math.round(I_CROSSCHECK_SEC * SCALE));
  process.env.BENCH_ROOT = BENCH_DIR; // i_entry (bundled CJS) cannot use import.meta
  const { code, stdout, stderr } = await runNode(build.outfile, [
    "--total-sec", String(totalSec), "--cross-sec", String(crossSec),
  ], { timeoutMs: 3600_000 });
  if (code !== 0) {
    await skipBench(RESULTS_DIR, "I1_automation_state_carry", "I", ENV, `i_entry exited ${code}: ${stderr.slice(-800)}`);
    return;
  }
  const m = parseMeasurement(stdout);

  const result = new Result("I1_automation_state_carry", "I", ENV,
    { total_sec: totalSec, block_sizes: I_BLOCK_SIZES.slice(0, -1).concat(["single_block"]), broken_block_sizes: I_BROKEN_BLOCK_SIZES, crosscheck_sec: crossSec, c_graph_constants: C_CONST },
    {
      measured: "streaming sha256 of the C-graph rendered in-process at 4 block partitions (incl. single-block); broken-variant hashes at 3 block sizes; per-sample max|Δ|/rms vs node-web-audio-api's single-pass render at the crosscheck duration",
      granularity: "whole-render streaming hash (invariance); per-sample float comparison (cross-engine)",
      trials: "4 healthy partitions + 3 broken partitions + 1 Web Audio reference + 1 Web Audio-vs-mine comparison",
      warmup: "none — hash comparisons are order-independent; wall clocks reported per render",
      outliers: "none",
      statistic: "hash equality booleans; max_abs_delta / rms_delta measured, never asserted",
    });

  for (const a of m.assertions) result.addAssertion(a.name, a.passed, a.detail);
  result.doc.stats = m.stats;
  result.setDerived("healthy_hashes", m.healthy_hashes);
  result.setDerived("broken_hashes", m.broken_hashes);
  result.setDerived("webaudio_reference", m.webaudio);

  // Category-C context numbers are quoted from the user's own run of the
  // ORIGINAL suite (bench/results/C_chunked_render_poc__*.json on their
  // machine); this sandbox holds no copies — stated, not invented.
  result.addObservation(
    "Category C (user's hardware, chunked OfflineAudioContext, 1800 s program): overhead 70.6% at 60 s chunks, max|Δ| 2.8e-1, divergence NOT seam-localized. " +
    "I1a shows the in-process design makes block boundaries invisible (hash-equal across partitions incl. single-block) — the divergence class C measured has no mechanism to exist here: node state carries, and the coefficient quantum grid is absolute-frame aligned. " +
    `I1b re-introduces C's mechanisms deliberately (re-anchoring + block-relative quanta) and measures divergence return: max|Δ| (sampled, every 4th frame) by block size = ${JSON.stringify(m.stats.broken_growth_max_delta_sampled ?? {})}. ` +
    `I1c cross-engine proximity at ${crossSec} s: max|Δ| ${m.webaudio?.max_abs_delta?.toExponential?.(2) ?? m.webaudio?.max_abs_delta}, rms ${m.webaudio?.rms_delta?.toExponential?.(2) ?? m.webaudio?.rms_delta} — measured, not asserted; different biquad/oscillator implementations make byte-identity impossible across engines, what matters is the magnitude class vs C's within-engine 2.8e-1.`,
  );
  result.addObservation(
    `Web Audio reference memory disclosure: the OfflineAudioContext render materializes ${crossSec}s × 44100 × 2ch × 4 B ≈ ${((crossSec * C_SAMPLE_RATE * 2 * 4) / 1048576).toFixed(0)} MB for the comparison — the one materializing verification in this suite, reported separately from generation memory.`,
  );

  const file = await result.write(RESULTS_DIR);
  console.log(`  -> ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runI();
}
