/**
 * bench/B/node_harness.mjs — SECONDARY/experimental Node environment for B.
 * Requires node-web-audio-api (resolved from ui/node_modules); injects
 * its Web Audio constructors as globals, then drives the REAL renderAmbient
 * (bundled unmodified by esbuild/tsc) and applies B4's non-finite check.
 *
 * Prints ONE JSON measurement object to stdout (marker-prefixed).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FRONTEND = path.join(ROOT, "ui");
const MARK = "__BENCH_JSON__";
const BUNDLE = process.argv[2];
const DURATIONS = (process.argv[3] ?? "1").split(",").map(Number);

function fail(msg) {
  process.stdout.write(MARK + JSON.stringify({ outcome: "fatal", error: msg }));
  process.exit(1);
}

if (!BUNDLE) fail("usage: node node_harness.mjs <engine-bundle.cjs> <minutes,comma-list>");

let waa;
try {
  const req = createRequire(path.join(FRONTEND, "package.json"));
  waa = req("node-web-audio-api");
} catch (err) {
  fail(`node-web-audio-api unavailable: ${err}`);
}

// Inject globals before any engine call. renderAmbient touches
// OfflineAudioContext / AudioBuffer at call time, not import time.
for (const key of ["OfflineAudioContext", "AudioBuffer", "AudioContext"]) {
  if (waa[key]) globalThis[key] = waa[key];
}

const { renderAmbient, audioBufferToWav, REPO_DEFAULT_PARAMS } = await import(
  pathToFileURL(BUNDLE).href
);

function countNonFinite(buffer) {
  let bad = 0;
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) bad++;
      else if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  return { nonFinite: bad, peak };
}

function peakRssBytes() {
  try {
    const ru = process.resourceUsage?.();
    if (ru?.maxRSS) return ru.maxRSS * 1024;
  } catch { /* fall through */ }
  return process.memoryUsage().rss;
}

const points = [];
const nonFiniteViolations = [];
for (const minutes of DURATIONS) {
  const durationSeconds = minutes * 60;
  const phases = [];
  let buf;
  let peakBefore = peakRssBytes();
  const t0 = performance.now();
  try {
    buf = await renderAmbient({ ...REPO_DEFAULT_PARAMS }, durationSeconds, undefined, (p) => phases.push({ ...p, t_ms: performance.now() - t0 }));
  } catch (err) {
    points.push({
      duration_minutes: minutes, outcome: "error",
      error: String(err?.message ?? err), peak_rss_bytes: peakRssBytes(),
    });
    break; // longer points are pointless after a failure
  }
  const totalWall = performance.now() - t0;
  // B4: verify numerical integrity BEFORE trusting the timing (loud failure).
  const scan = countNonFinite(buf);
  if (scan.nonFinite > 0) nonFiniteViolations.push({ duration_minutes: minutes, non_finite: scan.nonFinite });
  let wavEncodeMs = null;
  let wavBytes = null;
  try {
    const t1 = performance.now();
    const blob = audioBufferToWav(buf);
    wavEncodeMs = performance.now() - t1;
    wavBytes = blob.size;
  } catch (err) {
    void err;
  }
  const renderingStart = phases.find((p) => p.phase === "rendering");
  const encodingStart = phases.find((p) => p.percent === 85);
  points.push({
    duration_minutes: minutes,
    outcome: "ok",
    scheduling_wall_ms: renderingStart?.t_ms ?? null,
    startRendering_wall_ms: renderingStart && encodingStart ? encodingStart.t_ms - renderingStart.t_ms : null,
    total_wall_ms: totalWall,
    peak_rss_bytes: Math.max(peakBefore, peakRssBytes()),
    rss_note: "resourceUsage().maxRSS (KB per Node docs) or memoryUsage().rss; process-level, not per-render",
    output_frames: buf.length,
    non_finite_samples: scan.nonFinite,
    peak_abs_sample: scan.peak,
    wav_encode_ms: wavEncodeMs,
    wav_bytes: wavBytes,
  });
}

process.stdout.write(
  MARK + JSON.stringify({
    outcome: nonFiniteViolations.length > 0 ? "nonfinite_violation" : "ok",
    environment_label: "node (node-web-audio-api) — SECONDARY/EXPERIMENTAL, not ground truth",
    implementation: {
      package: "node-web-audio-api",
      version: waa.VERSION ?? null,
    },
    non_finite_violations: nonFiniteViolations,
    points,
    peak_rss_bytes_process_end: peakRssBytes(),
  }),
);
