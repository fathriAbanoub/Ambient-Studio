/**
 * server.ts — the ambientd daemon: HTTP API + startup (lockfile, port bind,
 * NVENC probe, stale-job reap). State lives HERE; the MCP shim is a thin client.
 *
 * Port: AMBIENTD_PORT (default 7781). Data: AMBIENTD_DATA (default ./data).
 * Lockfile: data/daemon.lock (O_EXCL) with pid-liveness stale detection —
 * plus the port bind as the final arbiter, so two racing spawns cannot both win.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, listAssets, getAsset, evictAsset, ingestVideo, searchStockVideos, selectCandidate } from "./assets";
import { createRecipe, getRecipe, submitJob, getJob, jobResult, reapStaleJobs, jobStatusCounts } from "./jobs";
import { probeNvenc } from "./ffmpeg";

export const PORT = Number(process.env.AMBIENTD_PORT ?? 7781);
const LOCK_FILE = path.join(DATA_DIR, "daemon.lock");

function acquireLock(): boolean {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // stale lockfile: if the pid recorded in it is gone, take over
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    const pid = Number(raw.trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // liveness probe — throws if dead
        return false; // another daemon is genuinely alive
      } catch {
        fs.rmSync(LOCK_FILE, { force: true }); // stale
      }
    }
  } catch { /* no lockfile */ }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
  } catch {
    return false; // lost the race
  }
  return true;
}

function releaseLock(): void {
  try {
    if (fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* gone */ }
}

let nvencInfo: { available: boolean; command: string; output: string } | null = null;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024 * 1024) throw new Error("body too large (64 MB limit)");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/health") {
      return json(res, 200, {
        ok: true,
        daemon: "ambientd v1",
        pid: process.pid,
        uptime_sec: process.uptime(),
        nvenc: nvencInfo,
        jobs: jobStatusCounts(),
      });
    }

    // ── recipes ──
    if (req.method === "POST" && p === "/recipes") {
      const body = await readBody(req);
      const recipe = createRecipe(body);
      return json(res, 201, recipe);
    }
    const mRecipe = p.match(/^\/recipes\/([\w-]+)$/);
    if (req.method === "GET" && mRecipe) {
      const r = getRecipe(mRecipe[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: "recipe not found" });
    }

    // ── jobs ──
    if (req.method === "POST" && p === "/jobs") {
      const body = await readBody(req);
      if (!body.recipe_id) throw new Error("recipe_id required");
      const job = submitJob(body.recipe_id, {
        durationSecOverride: body.duration_sec,
        formatOverride: body.preview_format,
        preview: body.preview,
      });
      return json(res, 202, { job_id: job.job_id, status: job.status, preview: job.preview });
    }
    const mJob = p.match(/^\/jobs\/([\w-]+)(\/result)?$/);
    if (req.method === "GET" && mJob) {
      const job = getJob(mJob[1]);
      if (!job) return json(res, 404, { error: "job not found" });
      if (mJob[2]) {
        const result = jobResult(mJob[1]);
        return json(res, 200, { job_id: job.job_id, status: job.status, ...result });
      }
      return json(res, 200, {
        job_id: job.job_id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        preview: job.preview,
        created: job.created,
        finished: job.finished,
      });
    }

    // ── assets ──
    if (req.method === "POST" && p === "/assets/search") {
      const body = await readBody(req);
      if (!body.query) throw new Error("query required");
      const candidates = await searchStockVideos(body.query, Math.min(Number(body.count ?? 10), 40), body.provider);
      return json(res, 200, { candidates });
    }
    if (req.method === "POST" && p === "/assets/select") {
      const body = await readBody(req);
      if (!body.candidate_ref) throw new Error("candidate_ref required");
      const entry = await selectCandidate(body.candidate_ref);
      return json(res, 201, entry);
    }
    if (req.method === "POST" && p === "/assets/upload") {
      const body = await readBody(req);
      if (body.url) {
        const entry = await ingestVideo({ url: body.url, label: body.label ?? "upload", provider: body.provider });
        return json(res, 201, entry);
      }
      if (body.file && fs.existsSync(body.file)) {
        const entry = await ingestVideo({ file: body.file, label: body.label ?? path.basename(body.file) });
        return json(res, 201, entry);
      }
      throw new Error("pass a reachable url or an existing local file path");
    }
    if (req.method === "GET" && p === "/assets") {
      return json(res, 200, { assets: listAssets() });
    }
    const mAsset = p.match(/^\/assets\/(sha256:[0-9a-f]{64})$/);
    if (req.method === "GET" && mAsset) {
      const a = getAsset(mAsset[1]);
      return a ? json(res, 200, a) : json(res, 404, { error: "asset not found" });
    }
    if (req.method === "DELETE" && mAsset) {
      return evictAsset(mAsset[1]) ? json(res, 200, { evicted: mAsset[1] }) : json(res, 404, { error: "asset not found" });
    }

    return json(res, 404, { error: `no route: ${req.method} ${p}` });
  } catch (e) {
    return json(res, 400, { error: String((e as Error)?.message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  if (!acquireLock()) {
    console.error(`[ambientd] another daemon holds ${LOCK_FILE} (or the port) — exiting`);
    process.exit(0);
  }
  const reaped = reapStaleJobs();
  console.log(`[ambientd] listening on 127.0.0.1:${PORT} (pid ${process.pid}, data ${DATA_DIR}, reaped ${reaped} stale jobs)`);
  probeNvenc().then((r) => (nvencInfo = r)).catch(() => (nvencInfo = { available: false, command: "", output: "probe error" }));
});

process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
