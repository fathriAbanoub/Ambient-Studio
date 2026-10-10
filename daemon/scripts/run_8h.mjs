// scripts/run_8h.mjs — detached 8-hour WAV render through the real daemon,
// with an RSS/progress curve sampler. Writes results to /tmp/ambientd-8h/curve.json.
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = 7801;
const DATA = "/tmp/ambientd-8h";
const api = async (m, p, b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? r.status);
  return j;
};
const hwm = (pid) => {
  try {
    return Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)[1]) / 1024;
  } catch { return -1; }
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const daemon = spawn(process.execPath, ["build/server.cjs"], {
  env: { ...process.env, AMBIENTD_PORT: String(PORT), AMBIENTD_DATA: DATA },
  stdio: ["ignore", "pipe", "pipe"],
  cwd: process.cwd(),
});
let log = "";
daemon.stderr.on("data", (d) => (log += String(d)));
daemon.stdout.on("data", (d) => (log += String(d)));

for (let i = 0; i < 60; i++) { try { await api("GET", "/health"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const rec = await api("POST", "/recipes", {
  kernel_params: { scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4, seed: 42, enableScenes: true, enableHarmonicLoop: true, enableBeats: true, drumLevel: 0.5, drumStyle: "euclideanTrap", sidechainAmount: 0, drone: { layers: [{ hz: 55, amp: 0.15, pan: 0, timbre: "sine" }, { hz: 110, amp: 0.12, pan: 0.4, timbre: "sine" }] } },
  duration_sec: 28800,
  output: { format: "wav" },
});
const t0 = Date.now();
const job = await api("POST", "/jobs", { recipe_id: rec.recipe_id });

const curve = [];
const status = (s, note) => {
  curve.push({ t: (Date.now() - t0) / 1000, rss_mb: hwm(daemon.pid), progress: s.progress ?? 0, status: s.status, note });
};
try {
  for (;;) {
    const s = await api("GET", `/jobs/${job.job_id}`);
    status(s);
    fs.writeFileSync(`${DATA}/curve.json`, JSON.stringify(curve, null, 1));
    if (s.status === "done" || s.status === "failed") break;
    await new Promise((r) => setTimeout(r, 20000));
  }
  const res = await api("GET", `/jobs/${job.job_id}/result`);
  fs.writeFileSync(`${DATA}/final.json`, JSON.stringify({ wall_sec: (Date.now() - t0) / 1000, job: res, daemon_log_tail: log.slice(-2000) }, null, 2));
  console.log("8h render done:", JSON.stringify({ wall_sec: (Date.now() - t0) / 1000, bytes: res.outputs[0].bytes, sha: res.outputs[0].sha256.slice(0, 16) }));
  daemon.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  console.error("8h render FAILED:", String(e), log.slice(-1500));
  fs.writeFileSync(`${DATA}/final.json`, JSON.stringify({ error: String(e), log: log.slice(-3000) }));
  daemon.kill("SIGTERM");
  process.exit(1);
}
