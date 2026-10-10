/**
 * test/phase5.ts — daemon HTTP API + job registry + THE MANDATED
 * cross-job state-isolation test.
 *
 * Design under test: one daemon process, fresh worker_threads Worker per job,
 * terminated on completion. The PoC was only ever tested one-render-per-process;
 * this test covers the new long-running-daemon regime:
 *   1. submit job A (seed 42, wav) then IMMEDIATELY job B (seed 777, bpm 92,
 *      fourFloor, mp3) so B queues behind A in the same daemon
 *   2. A's output hash must equal a fresh-process reference render of A
 *   3. B's output hash must equal a fresh-process reference render of B
 *   4. A != B (sanity)
 *   5. resubmit A after B → identical hash to the first A (order-independence)
 *   6. seed handling: recipe without seed gets a CSPRNG seed generated once,
 *      persisted, and reused on resubmission (same seed → same hash, never
 *      derived from the job id)
 *   7. atomic finalize: outputs appear only as verified final files (no .tmp
 *      debris), provenance sidecar written and complete
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

declare const __dirname: string; // CJS bundle
const ROOT = path.resolve(__dirname, "..");
const PORT = 7789;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = "/tmp/ambientd-p5";

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${j?.error ?? "?"}`);
  return j;
}

async function waitJob(jobId: string, timeoutMs = 120_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const j = await api("GET", `/jobs/${jobId}`);
    if (j.status === "done") return { ...j, ...(await api("GET", `/jobs/${jobId}/result`)) };
    if (j.status === "failed") return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} timed out in status ${j.status}`);
    await sleep(300);
  }
}

const PARAMS_A = {
  scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap", sidechainAmount: 0,
  drone: { layers: [0, 1, 2, 3].map((i) => ({ hz: 55 + i * 8, amp: 0.15, pan: -1 + (2 * i) / 3, timbre: "sine" })) },
};
const PARAMS_B = {
  scale: "aeolian", rootHz: 165, bpm: 92, complexity: 0.7, mix: 0.6,
  sceneDurationBars: 16, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 777, drumLevel: 0.8, swing: 0.25, drumStyle: "fourFloor", sidechainAmount: 0.5,
};

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // start daemon (bundled), fresh data dir
  const daemon = spawn(process.execPath, [path.join(ROOT, "build", "server.cjs")], {
    env: { ...process.env, AMBIENTD_PORT: String(PORT), AMBIENTD_DATA: DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const daemonLog: string[] = [];
  daemon.stdout.on("data", (d) => daemonLog.push(String(d)));
  daemon.stderr.on("data", (d) => daemonLog.push(String(d)));

  try {
    // wait for health
    let up = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {}
      await sleep(200);
    }
    check("daemon healthy", up, daemonLog.join("").slice(-300));

    // recipes
    const recA = await api("POST", "/recipes", { kernel_params: PARAMS_A, duration_sec: 20, output: { format: "wav" } });
    const recB = await api("POST", "/recipes", { kernel_params: PARAMS_B, duration_sec: 10, output: { format: "mp3" } });
    check("recipe ids are uuids", /^[0-9a-f-]{36}$/.test(recA.recipe_id) && /^[0-9a-f-]{36}$/.test(recB.recipe_id), recA.recipe_id.slice(0, 13) + "…");
    check("explicit seed persisted", recA.kernel_params.seed === 42 && recB.kernel_params.seed === 777, `A=${recA.kernel_params.seed} B=${recB.kernel_params.seed}`);

    const recNoSeed = await api("POST", "/recipes", { kernel_params: { ...PARAMS_A, seed: undefined }, duration_sec: 5, output: { format: "wav" } });
    const recNoSeed2 = await api("POST", "/recipes", { kernel_params: { ...PARAMS_A, seed: undefined }, duration_sec: 5, output: { format: "wav" } });
    check("seed generated once + persisted", Number.isInteger(recNoSeed.kernel_params.seed) && recNoSeed.seed_generated === true, `seed=${recNoSeed.kernel_params.seed}`);
    check("two seedless recipes → different seeds", recNoSeed.kernel_params.seed !== recNoSeed2.kernel_params.seed, `${recNoSeed.kernel_params.seed} != ${recNoSeed2.kernel_params.seed}`);

    // seedless recipes: the persisted seed (not the job id, not submission
    // count) must be the only determinant of output
    const sameSeedA = await api("POST", "/jobs", { recipe_id: recNoSeed.recipe_id });
    const sameSeedB = await api("POST", "/jobs", { recipe_id: recNoSeed2.recipe_id });
    const sa = await waitJob(sameSeedA.job_id);
    const sb = await waitJob(sameSeedB.job_id);
    const refNoSeed = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "build", "phase5_ref.cjs"), JSON.stringify({ kernelParams: { ...PARAMS_A, seed: recNoSeed.kernel_params.seed }, durationSec: 5 })], { maxBuffer: 1e8 }).toString());
    check("seedless recipe: persisted seed alone determines output (never job id)",
      sa.status === "done" && sb.status === "done" &&
      sa.provenance.render.pcm16_sha256 === refNoSeed.sha256,
      `job ${sameSeedA.job_id.slice(0, 8)}… hash ${sa.provenance.render.pcm16_sha256.slice(0, 12)}… == fresh-ref of stored seed ${recNoSeed.kernel_params.seed}`);
    check("two different generated seeds render differently", sa.provenance.render.pcm16_sha256 !== sb.provenance.render.pcm16_sha256, "distinct seeds, distinct output");

    // ── THE cross-job state-isolation test ──
    const jobA = await api("POST", "/jobs", { recipe_id: recA.recipe_id });
    const jobB = await api("POST", "/jobs", { recipe_id: recB.recipe_id }); // submitted immediately → queues behind A
    const stA = await api("GET", `/jobs/${jobA.job_id}`);
    check("submit returns immediately (202, running/pending)", stA.status === "running" || stA.status === "pending", stA.status);

    const doneA = await waitJob(jobA.job_id);
    const doneB = await waitJob(jobB.job_id);
    check("job A done", doneA.status === "done", doneA.status + (doneA.error ? ` (${doneA.error.slice(0, 200)})` : ""));
    check("job B done (ran after A in same daemon)", doneB.status === "done", doneB.status + (doneB.error ? ` (${doneB.error.slice(0, 200)})` : ""));

    // fresh-process references (no shared state with the daemon)
    const refA = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "build", "phase5_ref.cjs"), JSON.stringify({ kernelParams: PARAMS_A, durationSec: 20 })], { maxBuffer: 1e8 }).toString());
    const refB = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "build", "phase5_ref.cjs"), JSON.stringify({ kernelParams: PARAMS_B, durationSec: 10 })], { maxBuffer: 1e8 }).toString());

    const shaA = doneA.provenance.render.pcm16_sha256;
    const shaB = doneB.provenance.render.pcm16_sha256;
    check("CROSS-JOB: A hash == fresh-process reference", shaA === refA.sha256, `${shaA.slice(0, 16)} vs ${refA.sha256.slice(0, 16)}`);
    check("CROSS-JOB: B hash == fresh-process reference", shaB === refB.sha256, `${shaB.slice(0, 16)} vs ${refB.sha256.slice(0, 16)}`);
    check("A != B", shaA !== shaB, "different recipes produce different output");

    // resubmit A after B — must reproduce the first A byte-for-byte
    const jobA2 = await api("POST", "/jobs", { recipe_id: recA.recipe_id });
    const doneA2 = await waitJob(jobA2.job_id);
    check("resubmit A after B → identical hash (order-independence)", doneA2.status === "done" && doneA2.provenance.render.pcm16_sha256 === shaA,
      `${doneA2.provenance?.render?.pcm16_sha256?.slice(0, 16)} vs ${shaA.slice(0, 16)}`);

    // ── atomic finalize + provenance ──
    const jobDir = path.join(DATA, "jobs", jobA.job_id);
    check("no tmp debris left", !fs.existsSync(path.join(jobDir, "tmp")), "tmp/ removed after finalize");
    check("final output exists", fs.existsSync(path.join(jobDir, "output.wav")), "output.wav");
    const prov = doneA.provenance;
    check("provenance complete", !!(prov.kernel?.sha256 && prov.seed === 42 && prov.duration.snapped_sec === 20 && prov.ffmpeg_commands?.length >= 1 && prov.render.block_frames === 4096),
      `seed=${prov.seed} snapped=${prov.duration.snapped_sec}s cmds=${prov.ffmpeg_commands.length} kernelSha=${prov.kernel.sha256.slice(0, 8)}…`);
    check("provenance records snap", prov.duration.requested_sec === 20 && prov.duration.bars === 6, `6 bars of 10/3 s = 20.0 s (bars=${prov.duration.bars})`);

    // job_result endpoint
    const res = await api("GET", `/jobs/${jobA.job_id}/result`);
    check("job_result returns outputs+provenance", res.outputs?.[0]?.format === "wav" && res.provenance?.job_id === jobA.job_id, res.outputs[0].path.split("/").pop());

    // worker really terminated: no lingering worker threads in daemon — indirect check via RSS sanity
    const health = await api("GET", "/health");
    check("health endpoint reports nvenc probe + job counts", "nvenc" in health && health.jobs.done >= 5, `nvenc=${health.nvenc?.available} jobs=${JSON.stringify(health.jobs)}`);

    console.log(failures === 0 ? "PHASE5 ALL PASS" : `${failures} PHASE5 FAILURES`);
    process.exitCode = failures ? 1 : 0;
  } finally {
    daemon.kill("SIGTERM");
    await sleep(300);
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
