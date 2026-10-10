#!/usr/bin/env node
/**
 * bench/run.mjs — the single entry point.
 *
 *   npm run bench                     # short/representative sweep (no 8h runs)
 *   npm run bench -- --categories A,D # subset
 *   npm run bench -- --scale 0.2      # smoke test the harness itself
 *   npm run bench -- --long-2h        # opt into one 2-hour case per category
 *   npm run bench -- --long-8h        # opt into the 8-hour cases (hours!)
 *   npm run bench -- --full           # widen D's fps sweep (5/10/15/24)
 *   npm run bench -- --keep-artifacts # keep WAV/MP4 outputs instead of deleting
 *
 * Hard rules implemented here: preflight prints exactly what will run/skip
 * and what is missing (+ install commands) before any benchmark starts;
 * nothing is ever installed silently.
 */
import fs from "node:fs";
import path from "node:path";
import { captureEnvironment } from "./lib/env.mjs";
import { detectTools, missingList, INSTALL_HINTS } from "./lib/detect.mjs";
import { runSelftest } from "./selftest.mjs";
import { ffmpegInfo } from "./lib/env.mjs";

const BENCH_DIR = path.resolve(import.meta.dirname);
const RESULTS_DIR = path.join(BENCH_DIR, "results");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const categoriesArg = args.find((a) => a.startsWith("--categories"));
const CATEGORIES = categoriesArg
  ? (categoriesArg.includes("=")
      ? categoriesArg.split("=")[1]
      : args[args.indexOf(categoriesArg) + 1])?.split(",") ?? ["A"]
  : ["A", "B", "C", "D", "E", "F"]; // default unchanged — G..L via --categories G,H,I,J,K,L

function usage() {
  console.log(`usage: node bench/run.mjs [--categories A,B,C,D,E,F] [--scale S] [--trials N]
  [--long-2h] [--long-8h] [--full] [--keep-artifacts] [--no-aggregate] [--list]`);
}

if (flag("--help") || flag("-h")) {
  usage();
  process.exit(0);
}

if (flag("--list")) {
  console.log("categories: A kernel · B offline render · C chunked PoC (superseded by I, kept for the record) · D ffmpeg ladder · E disk/IO · F node webaudio battery · G in-process streaming synth · H worker isolation · I automation state-carry · J direct-to-ffmpeg · K determinism stress · L corrected re-runs");
  process.exit(0);
}

// ── preflight ────────────────────────────────────────────────────────────
console.log("═".repeat(72));
console.log(" Ambient Studio benchmark harness — preflight");
console.log("═".repeat(72));

const selftestOk = await runSelftest().catch((err) => {
  console.error("selftest FAILED — lib logic is broken, refusing to run:", err.message);
  process.exit(1);
});

const tools = await detectTools();
const ffmpeg = await ffmpegInfo();
if (!ffmpeg.available) {
  console.error("\nMISSING: ffmpeg is not on PATH — required by categories D and E.");
  console.error(`install: ${INSTALL_HINTS.ffmpeg}`);
}
const missing = missingList(tools).filter(([name]) => name !== "web-audio-engine" || true);

console.log("\nenvironment:");
console.log(`  node      ${process.version} on ${process.platform}/${process.arch}`);
console.log(`  cpu       ${tools.node_modules_installed ? "" : ""}${(await import("node:os")).cpus()[0]?.model ?? "?"} ×${(await import("node:os")).cpus().length}`);
console.log(`  ffmpeg    ${ffmpeg.available ? ffmpeg.version_line : "NOT FOUND"}`);
console.log(`  ts runner ${tools.ts_runner ?? "none (A/B will skip)"}`);
console.log(`  playwright ${tools.playwright.ok ? "yes" : "no (B browser ground truth will skip)"}`);
console.log(`  node-web-audio-api ${tools.node_web_audio_api.ok ? "yes" : "no (B-node/C/F will skip)"}`);

if (missing.length) {
  console.log("\nMISSING (affected benchmarks will be SKIPPED, not failed):");
  for (const [name, hint] of missing) console.log(`  - ${name}: ${hint}`);
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const ENV = {
  ...(await captureEnvironment(RESULTS_DIR)),
  tools: {
    ts_runner: tools.ts_runner,
    playwright: tools.playwright.ok,
    node_web_audio_api: tools.node_web_audio_api.ok,
    web_audio_engine: tools.web_audio_engine.ok,
  },
  ui: tools.ui,
  root: tools.root,
};

const runEnv = {
  BENCH_ENV: JSON.stringify(ENV),
  BENCH_RESULTS_DIR: RESULTS_DIR,
  BENCH_SCALE: args.find((a) => a.startsWith("--scale"))?.split("=")[1] ?? (args.includes("--scale") ? args[args.indexOf("--scale") + 1] : "1"),
  BENCH_TRIALS: args.includes("--trials") ? args[args.indexOf("--trials") + 1] : "1",
  BENCH_LONG_2H: flag("--long-2h") ? "1" : "0",
  BENCH_LONG_8H: flag("--long-8h") ? "1" : "0",
  BENCH_FULL: flag("--full") ? "1" : "0",
  BENCH_KEEP_ARTIFACTS: flag("--keep-artifacts") ? "1" : "0",
  BENCH_LONG: flag("--long") ? "1" : "0",
};
Object.assign(process.env, runEnv); // category runners read these

console.log(`\nscale=${runEnv.BENCH_SCALE}  trials=${runEnv.BENCH_TRIALS}  long2h=${runEnv.BENCH_LONG_2H}  long8h=${runEnv.BENCH_LONG_8H}`);
console.log(`results → ${RESULTS_DIR}\n`);

const RUNNERS = {
  A: () => import("./A/run_A.mjs").then((m) => m.runA()),
  B: () => import("./B/run_B.mjs").then((m) => m.runB()),
  C: () => import("./C/run_C.mjs"),
  D: () => import("./D/run_D.mjs").then((m) => m.runD()),
  E: () => import("./E/run_E.mjs").then((m) => m.runE()),
  F: () => import("./F/run_F.mjs").then((m) => m.runF()),
  G: () => import("./G_streaming_synth/run_G.mjs").then((m) => m.runG()),
  H: () => import("./H_worker_isolation/run_H.mjs").then((m) => m.runH()),
  I: () => import("./I_automation_state_carry/run_I.mjs").then((m) => m.runI()),
  J: () => import("./J_ffmpeg_streaming/run_J.mjs").then((m) => m.runJ()),
  K: () => import("./K_determinism_stress/run_K.mjs").then((m) => m.runK()),
  L: () => import("./L_corrected_reruns/run_L.mjs").then((m) => m.runL()),
};

for (const cat of CATEGORIES) {
  if (!RUNNERS[cat]) {
    console.error(`unknown category '${cat}' — valid: A,B,C,D,E,F,G,H,I,J,K,L`);
    continue;
  }
  console.log("─".repeat(72));
  try {
    await RUNNERS[cat]();
  } catch (err) {
    console.error(`category ${cat} crashed:`, err);
    console.error("(other categories continue)");
  }
}

if (!flag("--no-aggregate")) {
  console.log("─".repeat(72));
  await import("./aggregate.mjs");
}
