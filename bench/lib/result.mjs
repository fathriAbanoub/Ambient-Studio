/**
 * bench/lib/result.mjs — the one result schema, reused by every benchmark
 * (Hard Rule 2). One JSON file per run:
 *   { schema_version, benchmark_id, category, timestamp, params, environment,
 *     methodology, skipped, skip_reason, assertions, trials, stats,
 *     raw_samples, derived, observations }
 *
 * `observations` is the ONLY place commentary may live (Hard Rule: measured
 * numbers and interpretation never mix).
 */
import fs from "node:fs";
import path from "node:path";
import { summarize } from "./stats.mjs";
import { RESULT_SCHEMA_VERSION } from "./constants.mjs";

export class Result {
  /**
   * @param {string} benchmarkId e.g. "D2_zoom_ladder"
   * @param {string} category "A".."F"
   * @param {object} environment full env capture, embedded verbatim
   * @param {object} params exact params/commands used for this run
   * @param {object} methodology {measured, granularity, trials, warmup, outliers, statistic}
   */
  constructor(benchmarkId, category, environment, params, methodology) {
    this.doc = {
      schema_version: RESULT_SCHEMA_VERSION,
      benchmark_id: benchmarkId,
      category,
      timestamp: new Date().toISOString(),
      params,
      environment,
      methodology,
      skipped: false,
      skip_reason: null,
      assertions: [],
      trials: [],
      stats: {},
      raw_samples: {},
      derived: {},
      observations: [],
    };
  }

  /** trials: [{label, params, samples:[...], extras}] — stats computed per trial. */
  addTrial(label, params, samples, extras = {}) {
    const s = summarize(samples);
    this.doc.trials.push({ label, params, samples_count: s?.n ?? 0, stats: s, extras });
    this.doc.raw_samples[label] = samples;
    return s;
  }

  /** Named trial stats must be exposed at top level for the aggregator. */
  setStats(key, value) {
    this.doc.stats[key] = value;
  }

  addAssertion(name, passed, detail) {
    this.doc.assertions.push({ name, passed, detail });
    return passed;
  }

  addObservation(text) {
    this.doc.observations.push(text);
  }

  setDerived(key, value) {
    this.doc.derived[key] = value;
  }

  async write(resultsDir) {
    await fs.promises.mkdir(resultsDir, { recursive: true });
    const file = path.join(
      resultsDir,
      `${this.doc.benchmark_id}__${this.doc.timestamp.replace(/[:.]/g, "-")}.json`,
    );
    await fs.promises.writeFile(file, JSON.stringify(this.doc, null, 2));
    return file;
  }
}

export async function writeSkipped(resultsDir, benchmarkId, category, environment, reason, params = {}) {
  const r = new Result(benchmarkId, category, environment, params, {
    measured: "not run",
    granularity: null,
    trials: 0,
    warmup: null,
    outliers: null,
    statistic: null,
  });
  r.doc.skipped = true;
  r.doc.skip_reason = reason;
  return r.write(resultsDir);
}

export async function writeError(resultsDir, benchmarkId, category, environment, error, params = {}) {
  const r = new Result(benchmarkId, category, environment, params, {
    measured: "run attempted but failed",
    granularity: null,
    trials: 0,
    warmup: null,
    outliers: null,
    statistic: null,
  });
  r.doc.skip_reason = null;
  r.doc.error = String(error?.stack || error);
  return r.write(resultsDir);
}

/** Emit a skipped benchmark record (non-throwing). Returns the file path. */
export async function skipBench(resultsDir, benchmarkId, category, environment, reason, params = {}) {
  const file = await writeSkipped(resultsDir, benchmarkId, category, environment, reason, params);
  console.log(`  SKIPPED: ${reason}`);
  console.log(`  -> ${file}`);
  return file;
}
