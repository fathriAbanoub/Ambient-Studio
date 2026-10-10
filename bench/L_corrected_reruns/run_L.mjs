/**
 * run_L.mjs — corrected re-runs of A's original claims (L1 + L2 note),
 * independently runnable:   node bench/L_corrected_reruns/run_L.mjs
 *
 * L1 — category A's A2 config sweep re-run with the JIT-contamination fix:
 *      every config in its OWN process (isolation by construction), spawned
 *      in both ascending AND descending order to prove order-independence.
 *      The ORIGINAL contamination pattern (6 configs sequential in one
 *      process) is re-created and run in both orders as the "before"
 *      picture — if its numbers flip with order, the original A2 numbers
 *      carry execution-order contamination; the isolated numbers must not.
 *
 *      The OLD A2 result JSON lives in the user's bench/results/ (their
 *      hardware) and is NOT reproduced or re-claimed here — this sandbox
 *      holds no copies. What L1 delivers: clean numbers + a measured
 *      demonstration that the old pattern's ordering can move them.
 *
 * L2 — the written note about what C got wrong and how G/I fix it (also in
 *      bench/results/L2_supersession_note.md and the what-changed doc).
 */
import path from "node:path";
import fs from "node:fs";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";
import { captureEnvironment } from "../lib/env.mjs";
import { L_HORIZON_BEATS, L_CONFIGS } from "../lib/constants.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? path.join(BENCH_DIR, "results");
const ENV = process.env.BENCH_ENV ? JSON.parse(process.env.BENCH_ENV) : await captureEnvironment(RESULTS_DIR);

function parseMeasurement(stdout, tag) {
  const marker = "__BENCH_JSON__";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) throw new Error(`${tag} produced no JSON. stderr tail:\n${stdout.slice(-800)}`);
  return JSON.parse(stdout.slice(idx + marker.length));
}

export async function runL() {
  console.log("[L] corrected re-runs (A2 JIT-contamination fix + C supersession note)");
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const one = await buildTsEntry(path.join(BENCH_DIR, "L_corrected_reruns", "kernel_sweep_one.ts"), path.join(BENCH_DIR, ".build"), "kernel_sweep_one");
  const contamBuild = await buildTsEntry(path.join(BENCH_DIR, "L_corrected_reruns", "l1_contaminated.ts"), path.join(BENCH_DIR, ".build"), "l1_contaminated");
  if (!one.ok || !contamBuild.ok) {
    await skipBench(RESULTS_DIR, "L1_kernel_sweep_isolated", "L", ENV, `TypeScript runner unavailable → ${one.error ?? contamBuild.error}`);
    return;
  }

  const result = new Result("L1_kernel_sweep_isolated", "L", ENV,
    { configs: L_CONFIGS, horizon_beats: L_HORIZON_BEATS, isolation: "one fresh process per config", spawn_orders: ["asc", "desc"] },
    {
      measured: "per-call kernel time (median/p95 ms) for each A2 config, one fresh process per config, in both spawn orders; plus the original sequential-in-one-process pattern re-created in both orders",
      granularity: "per getMusicalEvents call, performance.now(); first 100 measured calls discarded per run (same as A2)",
      trials: `6 configs × 2 isolated spawn orders + 2 contaminated-pattern runs (asc/desc)`,
      warmup: "30 s simulated warm-up per config (isolated) / per config position (contaminated), first 100 measured calls discarded — identical to A2",
      outliers: "none removed",
      statistic: "median/p95 per config per order; asc/desc median ratios; contaminated vs isolated side-by-side",
    });

  // ── isolated: one fresh process per config, both orders ──
  const isolated = { asc: {}, desc: {} };
  for (const order of ["asc", "desc"]) {
    const configs = order === "asc" ? L_CONFIGS : [...L_CONFIGS].reverse();
    for (const cfg of configs) {
      const { code, stdout, stderr } = await runNode(one.outfile, [
        "--drones", String(cfg.drones), "--bank", String(cfg.bank), "--beats", String(L_HORIZON_BEATS),
      ], { timeoutMs: 600_000 });
      if (code !== 0) {
        result.addObservation(`RUN ERROR isolated ${order} drones=${cfg.drones} bank=${cfg.bank}: ${stderr.slice(-200)}`);
        continue;
      }
      const m = parseMeasurement(stdout, "kernel_sweep_one");
      isolated[order][`${cfg.drones}_${cfg.bank}`] = m;
      result.addTrial(`isolated_${order}_d${cfg.drones}_b${cfg.bank}`, { ...cfg, spawn_order: order }, [m.median_ms], { ...m });
    }
  }

  // ── contaminated: the original A2 pattern, both orders ──
  const contaminated = {};
  for (const order of ["asc", "desc"]) {
    const { code, stdout, stderr } = await runNode(contamBuild.outfile, [order, String(L_HORIZON_BEATS)], { timeoutMs: 600_000 });
    if (code !== 0) {
      result.addObservation(`RUN ERROR contaminated ${order}: ${stderr.slice(-200)}`);
      continue;
    }
    contaminated[order] = parseMeasurement(stdout, "l1_contaminated");
  }

  // ── side-by-side + order-sensitivity (judged on BATCHED means — per-call
  // timers cost ~100–200 ns vs 2–3 µs medians, which made even isolated runs
  // look order-sensitive at µs scale; see kernel_sweep_one.ts comment) ──
  const rows = [];
  for (const cfg of L_CONFIGS) {
    const key = `${cfg.drones}_${cfg.bank}`;
    const a = isolated.asc[key];
    const d = isolated.desc[key];
    const cAsc = contaminated.asc?.configs?.find((c) => c.drone_layers === cfg.drones && c.sample_bank_entries === cfg.bank);
    const cDesc = contaminated.desc?.configs?.find((c) => c.drone_layers === cfg.drones && c.sample_bank_entries === cfg.bank);
    rows.push({
      drones: cfg.drones, bank: cfg.bank,
      isolated_median_asc: a?.median_ms ?? null,
      isolated_median_desc: d?.median_ms ?? null,
      isolated_batched_us_asc: a?.batched_mean_us_per_call ?? null,
      isolated_batched_us_desc: d?.batched_mean_us_per_call ?? null,
      isolated_batched_asc_desc_ratio: a && d ? d.batched_mean_us_per_call / a.batched_mean_us_per_call : null,
      contaminated_median_asc: cAsc?.median_ms ?? null,
      contaminated_median_desc: cDesc?.median_ms ?? null,
      contaminated_batched_us_asc: cAsc?.batched_mean_us_per_call ?? null,
      contaminated_batched_us_desc: cDesc?.batched_mean_us_per_call ?? null,
      contaminated_batched_asc_desc_ratio: cAsc && cDesc ? cDesc.batched_mean_us_per_call / cAsc.batched_mean_us_per_call : null,
      events_per_beat: a?.events_per_beat_median ?? null,
    });
  }
  result.doc.stats = { rows, contaminated_pattern: contaminated };
  for (const r of rows) {
    result.addTrial(`d${r.drones}_b${r.bank}`, { drones: r.drones, bank: r.bank },
      [r.isolated_batched_us_asc ?? 0, r.isolated_batched_us_desc ?? 0], {
      isolated_batched_asc_desc_ratio: r.isolated_batched_asc_desc_ratio,
      contaminated_batched_asc_desc_ratio: r.contaminated_batched_asc_desc_ratio,
      isolated_median_asc: r.isolated_median_asc,
      isolated_median_desc: r.isolated_median_desc,
    });
  }

  const isoRatios = rows.map((r) => r.isolated_batched_asc_desc_ratio).filter((v) => v !== null && Number.isFinite(v));
  const conRatios = rows.map((r) => r.contaminated_batched_asc_desc_ratio).filter((v) => v !== null && Number.isFinite(v));
  const maxIsoDev = Math.max(...isoRatios.map((r) => Math.abs(r - 1)));
  const maxConDev = Math.max(...conRatios.map((r) => Math.abs(r - 1)));
  result.setStats("order_sensitivity", {
    statistic: "batched mean µs/call, desc/asc ratio per config",
    isolated_max_asc_desc_median_deviation: maxIsoDev,
    contaminated_max_asc_desc_median_deviation: maxConDev,
    note: "ratios are measurements, not assertions — no threshold is claimed; read them against run-to-run noise (see A1's distribution)",
  });
  result.addAssertion("isolated_configs_all_ran", isoRatios.length === rows.length, `${isoRatios.length}/${rows.length} isolated config pairs completed in both orders`);

  result.addObservation(
    `L1 correction: the original A2 swept 6 configs sequentially in ONE process. If JIT/warm-state carries across configs, the numbers depend on sweep ORDER (the category-A bug where an 8-drone config looked faster than a 0-drone config — backwards from reality). ` +
    `Re-created here, judged on batched means: contaminated pattern max|desc/asc−1| = ${(maxConDev * 100).toFixed(1)}% vs isolated per-process max deviation ${(maxIsoDev * 100).toFixed(1)}%. ` +
    `The isolated numbers are the corrected reference; per-config medians and batched means land in trials. The ORIGINAL A2 JSON (user's hardware) is neither re-claimed nor altered.`,
  );
  result.addObservation(
    "L2 (what C got wrong, and how G/I supersede it): category C's chunked PoC never claimed O(1) memory for the WHOLE pipeline — its single-pass reference buffer was fully materialized, so peak memory scaled with duration regardless of the streaming compare (the claim shipped half-true). Independently, C measured that chunked output diverges from continuous output (max|Δ| 2.8e-1, NOT seam-localized) because per-chunk re-rendering re-anchors exponential automation and misaligns biquad coefficient quanta. G replaces the whole approach: one in-process block synth carries every automation state per-sample (D4) and streams every buffer, so memory has no duration-proportional term (G1) and block boundaries are byte-invisible (G3/I1a). I1 proves the negative: re-introducing C's mechanisms (re-anchoring + block-relative quanta) makes divergence return measurably. C's numbers stand as the record of why the chunked path was abandoned; nothing in C is re-run or patched in place.",
  );

  const file = await result.write(RESULTS_DIR);

  // L2 as a standalone note in results/ for the record
  fs.writeFileSync(path.join(RESULTS_DIR, "L2_supersession_note.md"),
    `# L2 — what category C got wrong, and how G/I supersede it\n\n` +
    `Written for the record; nothing in C is re-run or patched in place.\n\n` +
    `1. **C's memory claim shipped half-true.** C stopped materializing the *chunked* output (streaming per-chunk compare + streaming hash), but the *single-pass reference buffer* used for comparison was fully materialized. Peak memory therefore still scaled with duration — ~450 MB at 6 min, ~2.9 GB at 1 h (measured on the user's hardware, bench/results/ on their machine). G replaces the comparison with streaming hashes and bounded windows; its G1 sweep shows RSS flat across a 96× duration span, and I1's only materializing step is the bounded Web Audio reference (disclosed per run).\n\n` +
    `2. **C's divergence finding is real and now explained.** Chunked output diverged from continuous output (max|Δ| 2.8e-1, not seam-localized). I1b re-creates both mechanisms inside the in-process design — exponential-automation re-anchoring and block-relative biquad coefficient quanta — and measures divergence return; I1a shows the healthy design has neither mechanism (hash-identical across partitions including single-block).\n\n` +
    `3. **C's priming overhead (70.6% at 60 s chunks) is the cost of approximating state hand-off the API cannot express.** The in-process design does not approximate: delay rings, filter states and automation state simply carry (G/I walls show no per-chunk overhead because there are no chunks).\n`);
  console.log(`  -> ${file}\n  -> ${path.join(RESULTS_DIR, "L2_supersession_note.md")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runL();
}
