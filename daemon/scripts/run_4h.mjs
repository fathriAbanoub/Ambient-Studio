// scripts/run_4h.mjs — foreground 4-hour WAV render through the real daemon
// (sandbox kills detached processes across tool calls; 4 h ≈ 490 s wall fits
// the 10-min foreground cap). Samples an RSS/progress curve in-process.
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = 7802;
const DATA = "/tmp/ambientd-4h";
const api = async (m, p, b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? r.status);
  return j;
};
const rss = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      rss: Number(s.match(/^VmRSS:\s+(\d+)/m)[1]) / 1024,
      hwm: Number(s.match(/^VmHWM:\s+(\d+)/m)[1]) / 1024,
    };
  } catch { return { rss: -1, hwm: -1 }; }
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const daemon = spawn(process.execPath, ["build/server.cjs"], {
  env: { ...process.env, AMBIENTD_PORT: String(PORT), AMBIENTD_DATA: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
daemon.stderr.on("data", (d) => (log += String(d)));
daemon.stdout.on("data", (d) => (log += String(d)));

for (let i = 0; i < 60; i++) { try { await api("GET", "/health"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const rec = await api("POST", "/recipes", {
  kernel_params: { scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4, seed: 42, enableScenes: true, enableHarmonicLoop: true, enableBeats: true, drumLevel: 0.5, drumStyle: "euclideanTrap", sidechainAmount: 0, drone: { layers: [{ hz: 55, amp: 0.15, pan: 0, timbre: "sine" }, { hz: 110, amp: 0.12, pan: 0.4, timbre: "sine" }] } },
  duration_sec: 14400,
  output: { format: "wav" },
});
const t0 = Date.now();
const job = await api("POST", "/jobs", { recipe_id: rec.recipe_id });

const curve = [];
let done = false;
let failed = false;
while (!done && !failed) {
  await new Promise((r) => setTimeout(r, 10000));
  const s = await api("GET", `/jobs/${job.job_id}`);
  const m = rss(daemon.pid);
  curve.push({ t: (Date.now() - t0) / 1000, rss_mb: m.rss, hwm_mb: m.hwm, progress: s.progress ?? 0 });
  if (s.status === "done") done = true;
  if (s.status === "failed") failed = true;
}

if (failed) {
  console.error("4h render FAILED");
  console.error(log.slice(-1500));
  daemon.kill("SIGTERM");
  process.exit(1);
}

const res = await api("GET", `/jobs/${job.job_id}/result`);
const m = rss(daemon.pid);
const wall = (Date.now() - t0) / 1000;
console.log("=== 4-HOUR RENDER THROUGH THE DAEMON (measured) ===");
console.log(`wall:            ${wall.toFixed(1)} s  (${(14400 / wall).toFixed(1)}× realtime)`);
console.log(`output:          ${res.outputs[0].bytes} bytes (theoretical ${44 + 14400 * 44100 * 4})`);
console.log(`sha256:          ${res.outputs[0].sha256.slice(0, 20)}…`);
console.log(`snapped:         ${res.provenance.duration.snapped_sec} s = ${res.provenance.duration.bars} bars, ${res.provenance.duration.beats} beats`);
console.log(`kernel events:   ${res.provenance.render.kernel_event_count}, peak voices ${res.provenance.render.peak_concurrent_voices}`);
console.log(`final RSS:       ${m.rss.toFixed(1)} MB, peak HWM ${m.hwm.toFixed(1)} MB (PCM16 data = ${(14400 * 44100 * 4 / 1e9).toFixed(2)} GB)`);
console.log("RSS curve (t_s, rss_MB, progress):");
for (const p of curve) console.log(`  ${p.t.toFixed(0)}  ${p.rss_mb.toFixed(1)}  ${(p.progress * 100).toFixed(0)}%`);
daemon.kill("SIGTERM");
