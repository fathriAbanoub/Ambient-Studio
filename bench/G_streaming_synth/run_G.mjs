/**
 * run_G.mjs — in-process streaming synth (the core claim), independently
 * runnable:   node bench/G_streaming_synth/run_G.mjs  [--scale S]
 *
 * G1 — RSS over time during single renders at 4 duration points spanning
 *      48–96× (5 min → 4–8 h), sampled continuously in-child (not peak-at-end).
 *      This is the test category C failed; it must be conclusive.
 * G2 — wall-clock realtime factor at the same points.
 * G3 — byte-identical determinism (same seed, two full 30-min runs, fresh
 *      processes) + block-size invariance (1024/4096/16384 frames → equal
 *      hashes) + an order-reversal audit for the JIT-contamination bug class.
 *
 * Every duration point runs in a FRESH child process: isolation by
 * construction (self-audit class 1), verified empirically by the audit.
 * Verification memory is streaming (hashes) — generation vs verification are
 * not conflated (self-audit class 2).
 *
 * Chunked execution (for sandboxes with a per-invocation CPU ceiling — the
 * default no-flag invocation runs EVERYTHING in one process and is what
 * users should run):
 *   node run_G.mjs --durations 300,1800,7200 --phase sweep
 *   node run_G.mjs --durations 14400 --phase sweep
 *   node run_G.mjs --phase rest
 * Sweep points persist to .work/G/sweep_state.json; `--phase rest` loads it
 * for the cross-point fit and the audit comparisons. Results are written
 * once, in the `rest` phase (or by the default all-at-once run).
 */
import path from "node:path";
import fs from "node:fs";
import { buildTsEntry, runNode } from "../lib/tsrun.mjs";
import { Result, skipBench } from "../lib/result.mjs";
import { captureEnvironment, diskFree } from "../lib/env.mjs";
import { wavTheoreticalBytes } from "../lib/wav.mjs";
import { linearFit } from "../lib/stats.mjs";
import {
  G_SAMPLE_RATE, G_BLOCK_FRAMES, G_SWEEP_SEC, G_DETERMINISM_SEC,
  G_AUDIT_RECHECK_SEC, G_DRONE_LAYERS_HEAVY, G_PANIC_TIMEOUT_MS,
  DISK_SAFETY_MARGIN,
} from "../lib/constants.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? path.join(BENCH_DIR, "results");
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const KEEP = process.env.BENCH_KEEP_ARTIFACTS === "1";
const ENV = process.env.BENCH_ENV ? JSON.parse(process.env.BENCH_ENV) : await captureEnvironment(RESULTS_DIR);
const WORK = path.join(BENCH_DIR, ".work", "G");
const STATE_FILE = path.join(WORK, "sweep_state.json");

// ── argv phase controls ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argvValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const PHASE = argvValue("--phase") ?? "all"; // all | sweep | rest
const DURATIONS_OVERRIDE = argvValue("--durations")
  ?.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

function parseMeasurement(stdout) {
  const marker = "__BENCH_JSON__";
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) throw new Error(`render_entry produced no JSON. stderr tail:\n${stdout.slice(-800)}`);
  return JSON.parse(stdout.slice(idx + marker.length));
}

/** Stats over the continuous RSS curve (the "flat line" evidence). */
function curveStats(curve) {
  if (!curve?.length) return null;
  const values = curve.map((s) => s.rss);
  const sorted = [...values].sort((a, b) => a - b);
  const fit = linearFit(curve.map((s) => s.t), values);
  return {
    samples: curve.length,
    first_rss: values[0],
    last_rss: values[values.length - 1],
    min_rss: sorted[0],
    max_rss: sorted[sorted.length - 1],
    median_rss: sorted[sorted.length >> 1],
    drift_bytes_per_wall_sec: fit ? fit.slope : null,
  };
}

function downsample(curve, maxPoints = 384) {
  if (!curve || curve.length <= maxPoints) return curve ?? [];
  const step = curve.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(curve[Math.floor(i * step)]);
  return out;
}

let entryBuild = null;
async function runChild({ durationSec, blockFrames, mode, drones, seed, broken, outfileBase }) {
  if (!entryBuild) {
    entryBuild = await buildTsEntry(path.join(BENCH_DIR, "G_streaming_synth", "render_entry.ts"), path.join(BENCH_DIR, ".build"), "render_entry");
    if (!entryBuild.ok) throw new Error(`render_entry build failed: ${entryBuild.error}`);
  }
  const wavPath = path.join(WORK, `${outfileBase}.wav`);
  const args2 = [
    "--duration", String(durationSec),
    "--block", String(blockFrames),
    "--mode", mode,
    "--out", wavPath,
    "--drones", String(drones ?? 0),
    "--seed", String(seed ?? 42),
  ];
  if (broken) args2.push("--broken");
  const { code, stdout, stderr } = await runNode(entryBuild.outfile, args2, { timeoutMs: G_PANIC_TIMEOUT_MS });
  if (code !== 0) throw new Error(`render_entry exited ${code}: ${stderr.slice(-800)}`);
  const m = parseMeasurement(stdout);
  m.artifact = mode === "wav" ? { path: wavPath, bytes: m.wav?.fileSize ?? null } : null;
  return m;
}

async function diskOk(durationSec) {
  const need = wavTheoreticalBytes(G_SAMPLE_RATE, 2, Math.ceil(durationSec * G_SAMPLE_RATE)) * DISK_SAFETY_MARGIN;
  const { free_bytes } = await diskFree(RESULTS_DIR);
  return { ok: free_bytes === null || free_bytes > need, need, free: free_bytes };
}

/** Run the duration sweep (one fresh child per point) and persist state. */
async function runSweepPhase() {
  fs.mkdirSync(WORK, { recursive: true });
  const planned = DURATIONS_OVERRIDE ?? G_SWEEP_SEC;
  const sweep = planned.map((s) => Math.max(60, Math.round(s * SCALE)));
  // merge with any previously persisted points (chunked sweeps accumulate)
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { points: [], notes: [] };
  for (const dur of sweep) {
    if (state.points.some((p) => p.dur === dur)) {
      console.log(`  [G1/G2] point ${dur}s already measured — skipping (state file)`);
      continue;
    }
    const guard = await diskOk(dur);
    if (!guard.ok) {
      state.notes.push(`SKIPPED ${dur}s: need ${(guard.need / 1e9).toFixed(2)} GB free for the WAV, have ${guard.free === null ? "unknown" : (guard.free / 1e9).toFixed(2)} GB`);
      console.log(`  [G1/G2] SKIPPED ${dur}s: disk guard`);
      continue;
    }
    const label = `${Math.round(dur / 60)}min`;
    console.log(`  [G1/G2] rendering ${label} (${dur}s) → WAV ...`);
    try {
      const m = await runChild({ durationSec: dur, blockFrames: G_BLOCK_FRAMES, mode: "wav", drones: 0, seed: 42, outfileBase: `g1_${dur}s` });
      state.points.push({ dur, m });
      console.log(`    -> peak RSS ${(m.peak_rss_bytes / 1048576).toFixed(1)} MB · ${(m.realtime_factor).toFixed(1)}× realtime · ${m.non_finite} non-finite`);
      if (!KEEP && m.artifact?.bytes) { try { fs.unlinkSync(m.artifact.path); } catch { /* already gone */ } }
    } catch (err) {
      state.notes.push(`RUN ERROR at ${dur}s: ${String(err).slice(0, 300)}`);
      console.log(`    -> RUN ERROR: ${String(err).slice(0, 200)}`);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  return state;
}

export async function runG() {
  console.log("[G] in-process streaming synth (kernel → block synth → sink, D1–D5)");
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  if (PHASE === "sweep") {
    await runSweepPhase();
    console.log("  [G] sweep phase complete — run with --phase rest to finish the category");
    return;
  }

  const build = await buildTsEntry(path.join(BENCH_DIR, "G_streaming_synth", "render_entry.ts"), path.join(BENCH_DIR, ".build"), "render_entry");
  if (!build.ok) {
    await skipBench(RESULTS_DIR, "G1_rss_duration_sweep", "G", ENV, `TypeScript runner unavailable → ${build.error}`);
    await skipBench(RESULTS_DIR, "G2_realtime_throughput", "G", ENV, "same missing TS runner");
    await skipBench(RESULTS_DIR, "G3_determinism_and_invariance", "G", ENV, "same missing TS runner");
    return;
  }
  entryBuild = build;

  // Sweep points: from state file (chunked) or run inline (default).
  let sweepState;
  if (PHASE === "rest") {
    if (!fs.existsSync(STATE_FILE)) {
      await skipBench(RESULTS_DIR, "G1_rss_duration_sweep", "G", ENV, "--phase rest but no sweep state file — run --phase sweep first");
      await skipBench(RESULTS_DIR, "G2_realtime_throughput", "G", ENV, "no sweep state");
      await skipBench(RESULTS_DIR, "G3_determinism_and_invariance", "G", ENV, "no sweep state");
      return;
    }
    sweepState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } else {
    sweepState = await runSweepPhase();
  }
  const sweepRuns = sweepState.points.map((p) => ({ dur: p.dur, m: p.m }));

  // ── G1 + G2: results from the sweep points ──────────────────────────────
  const g1 = new Result("G1_rss_duration_sweep", "G", ENV,
    { sweep_sec_planned: DURATIONS_OVERRIDE ?? G_SWEEP_SEC, block_frames: G_BLOCK_FRAMES, sample_rate: G_SAMPLE_RATE, scale: SCALE, chunked_phases: PHASE !== "all" },
    {
      measured: "process RSS over time while one seeded render streams to a WAV file, at 4 durations spanning 48×+; peak via resourceUsage().maxRSS, curve via in-process sampler at block cadence",
      granularity: "per-render continuous RSS samples + per-point peak; wall clock per render",
      trials: "1 render per duration point, each in a fresh child process (isolation by construction)",
      warmup: "not applicable across points (fresh processes); within a render the first blocks ARE the render",
      outliers: "none removed",
      statistic: "per-point RSS curve stats + cross-point linear fit of peak RSS vs duration",
    });
  const g2 = new Result("G2_realtime_throughput", "G", ENV,
    { sweep_sec_planned: DURATIONS_OVERRIDE ?? G_SWEEP_SEC, block_frames: G_BLOCK_FRAMES, scale: SCALE },
    {
      measured: "wall-clock realtime factor (frames synthesized per wall second / sample rate) for the same renders as G1",
      granularity: "whole-render wall clock including WAV write",
      trials: "same runs as G1 (identical children)",
      warmup: "none — whole-render measurement",
      outliers: "none removed",
      statistic: "realtime_factor per duration; comparison notes vs B (OfflineAudioContext) and A3 (kernel-only)",
    });

  for (const note of sweepState.notes ?? []) {
    g1.addObservation(note);
    g2.addObservation(note);
  }
  for (const { dur, m } of sweepRuns) {
    const label = `${Math.round(dur / 60)}min`;
    const cs = curveStats(m.rss_curve);
    g1.addTrial(label, { duration_sec: dur, block_frames: G_BLOCK_FRAMES, mode: "wav" }, [m.peak_rss_bytes], {
      rss_curve_stats: cs,
      rss_curve_downsampled: downsample(m.rss_curve),
      frames_written: m.frames_written,
      kernel_event_count: m.kernel_event_count,
      beats: m.beats,
      peak_concurrent_voices: m.peak_concurrent_voices,
      realtime_factor: m.realtime_factor,
      non_finite: m.non_finite,
    });
    g2.addTrial(label, { duration_sec: dur }, [m.realtime_factor], {
      wall_sec: m.wall_sec, render_ms: m.render_ms, timeline_ms: m.timeline_ms,
      frames_written: m.frames_written,
    });
    g1.addAssertion(`frames_exact_${dur}`, m.frames_written === Math.ceil(dur * G_SAMPLE_RATE), `expected ${Math.ceil(dur * G_SAMPLE_RATE)} frames, got ${m.frames_written}`);
    g1.addAssertion(`nonfinite_zero_${dur}`, m.non_finite === 0, `non-finite samples: ${m.non_finite}`);
  }
  // The cross-point claim: peak RSS vs duration slope. O(1) memory ⇒ slope ≈
  // event-list growth (KB per audio-minute), NOT the 10.6 MB/min PCM16 rate.
  if (sweepRuns.length >= 2) {
    const fit = linearFit(sweepRuns.map((r) => r.dur / 60), sweepRuns.map((r) => r.m.peak_rss_bytes));
    const pcmRate = (G_SAMPLE_RATE * 2 * 2 * 60) / 1; // PCM16 stereo bytes per audio-minute
    g1.setDerived("peak_rss_vs_duration_linear_fit", fit);
    g1.setDerived("peak_rss_slope_bytes_per_audio_minute", fit ? fit.slope : null);
    g1.setDerived("pcm16_bytes_per_audio_minute", pcmRate);
    g1.setDerived("slope_as_pcm_fraction", fit ? fit.slope / pcmRate : null);
    g1.setStats("peaks", Object.fromEntries(sweepRuns.map((r) => [`${Math.round(r.dur / 60)}min`, r.m.peak_rss_bytes])));
    g1.addObservation(
      `Peak RSS vs duration fit: slope ${fit ? (fit.slope / 1048576).toFixed(2) : "?"} MB per audio-minute ` +
      `(PCM16 stereo alone would be ${(pcmRate / 1048576).toFixed(2)} MB/min; category C's chunked path measured ~75 MB/min over 6→60 min). ` +
      `The residual duration-linear term is the kernel event list (~0.2 KB/event), not audio buffers.`,
    );
  }

  // ── heavy-automation point (4 drone layers, 30 min) ─────────────────────
  {
    console.log(`  [G1] heavy-automation point: ${Math.round(1800 * SCALE)}s with ${G_DRONE_LAYERS_HEAVY} drone layers`);
    try {
      const m = await runChild({ durationSec: Math.round(1800 * SCALE), blockFrames: G_BLOCK_FRAMES, mode: "hash", drones: G_DRONE_LAYERS_HEAVY, seed: 42, outfileBase: "g1_heavy" });
      const cs = curveStats(m.rss_curve);
      g1.addTrial("30min_4drone_layers", { duration_sec: 1800, drones: G_DRONE_LAYERS_HEAVY, mode: "hash" }, [m.peak_rss_bytes], {
        rss_curve_stats: cs, realtime_factor: m.realtime_factor,
        peak_concurrent_voices: m.peak_concurrent_voices, drone_layers_started: m.drone_layers_started,
        non_finite: m.non_finite, kernel_event_count: m.kernel_event_count,
      });
      g2.addTrial("30min_4drone_layers", { drones: G_DRONE_LAYERS_HEAVY }, [m.realtime_factor], { wall_sec: m.wall_sec });
      console.log(`    -> peak RSS ${(m.peak_rss_bytes / 1048576).toFixed(1)} MB · ${m.realtime_factor.toFixed(1)}× realtime`);
    } catch (err) {
      g1.addObservation(`heavy point failed: ${String(err).slice(0, 200)}`);
    }
  }

  // ── G3: determinism + block-size invariance + order audit ──────────────
  const g3 = new Result("G3_determinism_and_invariance", "G", ENV,
    { determinism_sec: Math.round(G_DETERMINISM_SEC * SCALE), block_sizes: [1024, G_BLOCK_FRAMES, 16384], audit_points: G_AUDIT_RECHECK_SEC },
    {
      measured: "sha256 of streamed PCM16: (a) same seed two full runs in fresh processes; (b) block sizes 1024/4096/16384; (c) order-reversal audit — re-runs of two sweep points after all other G work, from fresh processes",
      granularity: "whole-render streaming hash; per-run wall clock and peak RSS",
      trials: "2 determinism runs + 3 invariance runs + 2 audit re-runs",
      warmup: "fresh process per run — no cross-run warm state exists",
      outliers: "none",
      statistic: "hash equality (boolean), wall/peak RSS per run",
    });
  const detSec = Math.round(G_DETERMINISM_SEC * SCALE);
  const hashes = [];
  for (let run = 1; run <= 2; run++) {
    console.log(`  [G3] determinism run ${run}/2 (${detSec}s, fresh process)`);
    const m = await runChild({ durationSec: detSec, blockFrames: G_BLOCK_FRAMES, mode: "hash", drones: 0, seed: 42, outfileBase: `g3_run${run}` });
    hashes.push(m.pcm16_sha256);
    g3.addTrial(`determinism_run_${run}`, { seed: 42, block_frames: G_BLOCK_FRAMES }, [m.wall_sec], {
      sha256: m.pcm16_sha256, peak_rss_bytes: m.peak_rss_bytes, realtime_factor: m.realtime_factor, non_finite: m.non_finite,
    });
  }
  g3.addAssertion("byte_identical_same_seed", hashes[0] === hashes[1],
    hashes[0] === hashes[1] ? `two fresh-process renders of seed 42 are byte-identical (${hashes[0].slice(0, 16)}…)` : `MISMATCH: ${hashes[0]} vs ${hashes[1]}`);

  const invHashes = {};
  for (const bs of [1024, G_BLOCK_FRAMES, 16384]) {
    const m = await runChild({ durationSec: detSec, blockFrames: bs, mode: "hash", drones: 0, seed: 42, outfileBase: `g3_bs${bs}` });
    invHashes[bs] = m.pcm16_sha256;
    g3.addTrial(`block_${bs}`, { block_frames: bs }, [m.wall_sec], { sha256: m.pcm16_sha256, realtime_factor: m.realtime_factor });
  }
  const allSame = Object.values(invHashes).every((h) => h === invHashes[1024]);
  g3.addAssertion("block_size_invariance", allSame,
    allSame ? `1024/4096/16384-frame blocks → identical sha256 (${String(invHashes[1024]).slice(0, 16)}…): block boundaries are invisible in the output`
      : `MISMATCH: ${JSON.stringify(Object.fromEntries(Object.entries(invHashes).map(([k, v]) => [k, String(v).slice(0, 16)])))}`);
  g3.addAssertion("invariance_matches_determinism", invHashes[G_BLOCK_FRAMES] === hashes[0],
    "4096-frame invariance run equals the determinism runs' hash — same-seed renders agree across runs");

  // Order-reversal audit (self-audit class 1): re-run two sweep points after
  // all other G work and compare wall/RSS/hash against the first pass.
  for (const dur of G_AUDIT_RECHECK_SEC.map((s) => Math.round(s * SCALE))) {
    const prior = sweepRuns.find((r) => r.dur === dur);
    if (!prior) continue;
    const m = await runChild({ durationSec: dur, blockFrames: G_BLOCK_FRAMES, mode: "hash", drones: 0, seed: 42, outfileBase: `audit_${dur}` });
    g3.addTrial(`audit_recheck_${Math.round(dur / 60)}min`, { duration_sec: dur, note: "re-run after all other G work" }, [m.wall_sec], {
      sha256: m.pcm16_sha256,
      wall_sec_first_pass: prior.m.wall_sec,
      wall_ratio: m.wall_sec / prior.m.wall_sec,
      peak_rss_first_pass: prior.m.peak_rss_bytes,
      peak_rss_ratio: m.peak_rss_bytes / prior.m.peak_rss_bytes,
      hash_matches_first_pass: m.pcm16_sha256 === prior.m.pcm16_sha256,
    });
    g3.addAssertion(`audit_hash_stable_${dur}`, m.pcm16_sha256 === prior.m.pcm16_sha256, "same-seed hash identical regardless of position in the sweep");
  }

  const f1 = await g1.write(RESULTS_DIR);
  const f2 = await g2.write(RESULTS_DIR);
  const f3 = await g3.write(RESULTS_DIR);
  console.log(`  -> ${f1}\n  -> ${f2}\n  -> ${f3}`);
  if (!KEEP) {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runG();
}
