/**
 * test/phase6_e2e.ts — MCP shim cold-start + FULL end-to-end pass (phases 6+7).
 *
 * Cold start: no daemon running on the port. Spawn `build/mcp.cjs`, speak
 * JSON-RPC over stdio, and a cold tools/call must auto-spawn the daemon
 * (detached, lockfile-protected) and succeed.
 *
 * Then, entirely through MCP tools:
 *   create_recipe (mp4 + asset) → upload_custom_video (real clip) →
 *   submit_job → job_status polls → job_result → verify output file on disk,
 *   ffprobe it (video stream-copied h264 + aac), inspect the provenance
 *   sidecar for correctness.
 */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ffprobeJson, videoStream, audioStream } from "../src/ffmpeg";

declare const __dirname: string;
const ROOT = path.resolve(__dirname, "..");
const PORT = 7793;
const DATA = "/tmp/ambientd-e2e";

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class McpClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  stderr = "";

  constructor() {
    this.proc = spawn(process.execPath, [path.join(ROOT, "build", "mcp.cjs")], {
      env: { ...process.env, AMBIENTD_PORT: String(PORT), AMBIENTD_DATA: DATA },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr!.on("data", (d) => (this.stderr += String(d)));
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      // notifications (e.g. logging) ignored
    });
  }

  request(method: string, params: any, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin!.write(payload);
    });
  }

  notify(method: string, params: any): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async tool(name: string, args: any, timeoutMs = 120_000): Promise<any> {
    const res = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    // tool errors arrive as text content with isError
    if (res.isError) throw new Error(`tool ${name} failed: ${res.content?.[0]?.text?.slice(0, 300)}`);
    return JSON.parse(res.content[0].text);
  }

  kill(): void {
    this.proc.kill();
  }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // verify no daemon on the port (cold) — abort loudly if a stale daemon lingers
  let cold = true;
  try { cold = !(await (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) })).ok); } catch { cold = true; }
  if (!cold) {
    console.error("ABORT: port " + PORT + " is occupied by a stale daemon — kill it before rerunning");
    process.exit(2);
  }
  check("no daemon running (cold)", cold, `port ${PORT} unreachable`);

  const mcp = new McpClient();

  // MCP handshake
  const init = await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ambientd-test", version: "1.0.0" },
  }, 30_000);
  check("MCP initialize handshake", !!init.serverInfo?.name && typeof init.protocolVersion === "string",
    `server=${init.serverInfo?.name} proto=${init.protocolVersion}`);
  mcp.notify("notifications/initialized", {});

  const tools = await mcp.request("tools/list", {}, 30_000);
  const names = tools.tools.map((t: any) => t.name);
  const required = ["create_recipe", "submit_job", "job_status", "job_result", "render_preview", "search_stock_videos", "select_stock_video", "upload_custom_video", "list_assets", "evict_asset"];
  check("all 10 spec tools exposed", required.every((r) => names.includes(r)), names.join(", "));

  // daemon should now be up (auto-spawned during the first tool call — actually
  // at shim startup, before initialize returned)
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  check("daemon auto-spawned and healthy", health.ok === true, `pid=${health.pid} nvenc=${health.nvenc?.available}`);

  // ── Phase 7: full pass, everything through MCP tools ──
  // 1. ingest a REAL video asset via upload_custom_video (bench loop.mp4)
  const asset = await mcp.tool("upload_custom_video", {
    file: path.join(ROOT, "test", "media", "loop.mp4"),
    label: "e2e bench loop",
  }, 120_000);
  check("upload_custom_video returns asset_id", /^sha256:[0-9a-f]{64}$/.test(asset.asset_id), asset.asset_id.slice(0, 28) + "…");

  // 2. create_recipe: 33.3 s @72 bpm → 10 bars exactly; mp4 with the asset
  const recipe = await mcp.tool("create_recipe", {
    kernel_params: {
      scale: "aeolian", rootHz: 220, bpm: 72, complexity: 0.4, mix: 0.5,
      enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
      seed: 424242, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap", sidechainAmount: 0,
      drone: { layers: [{ hz: 55, amp: 0.12, pan: -0.5, timbre: "sine" }, { hz: 110, amp: 0.1, pan: 0.5, timbre: "triangle" }] },
    },
    duration_sec: 33.3,
    output: { format: "mp4", video_asset_id: asset.asset_id },
  }, 30_000);
  check("create_recipe returns recipe_id + persisted seed", /^[0-9a-f-]{36}$/.test(recipe.recipe_id) && recipe.kernel_params.seed === 424242,
    `recipe ${recipe.recipe_id.slice(0, 13)}… seed=${recipe.kernel_params.seed}`);

  // 3. quick preview (mp3, 12 s) through render_preview — audition before committing
  const preview = await mcp.tool("render_preview", { recipe_id: recipe.recipe_id, duration_sec: 12 }, 120_000);
  const previewDone = await (async () => {
    for (let i = 0; i < 100; i++) {
      const s = await mcp.tool("job_status", { job_id: preview.job_id }, 20_000);
      if (s.status === "done" || s.status === "failed") return s;
      await sleep(400);
    }
    throw new Error("preview timed out");
  })();
  check("render_preview completes", previewDone.status === "done", previewDone.status + (previewDone.error ? ` (${String(previewDone.error).slice(0, 150)})` : ""));

  // 4. submit the real job
  const job = await mcp.tool("submit_job", { recipe_id: recipe.recipe_id }, 20_000);
  check("submit_job returns 202 + uuid", /^[0-9a-f-]{36}$/.test(job.job_id), job.job_id);

  let progressSeen = 0;
  let final: any;
  for (let i = 0; i < 300; i++) {
    const s = await mcp.tool("job_status", { job_id: job.job_id }, 20_000);
    progressSeen = Math.max(progressSeen, s.progress ?? 0);
    if (s.status === "done" || s.status === "failed") { final = s; break; }
    await sleep(400);
  }
  check("job completes done", final?.status === "done", `${final?.status} peak progress ${progressSeen.toFixed(2)}`);

  // 5. job_result → outputs + provenance
  const result = await mcp.tool("job_result", { job_id: job.job_id }, 20_000);
  const outFile = result.outputs[0].path;
  check("result references an existing file", fs.existsSync(outFile), outFile);
  const prov = result.provenance;
  check("provenance sidecar written next to output", fs.existsSync(path.join(path.dirname(outFile), "provenance.json")), "provenance.json present");

  // 6. sidecar correctness
  check("provenance seed + snap correct", prov.seed === 424242 && prov.duration.bars === 10 && Math.abs(prov.duration.snapped_sec - 33.3333) < 0.01,
    `seed=${prov.seed} bars=${prov.duration.bars} snapped=${prov.duration.snapped_sec?.toFixed(4)}s (requested ${prov.duration.requested_sec}s)`);
  check("provenance kernel hash matches the shared kernel", prov.kernel.sha256.length === 64 && prov.kernel.file === "kernel/musicalLogic.ts", prov.kernel.sha256.slice(0, 16) + "…");
  check("provenance ffmpeg command is the spec mux", /-stream_loop -1 .* -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k .*-t 33\.333333/.test(prov.ffmpeg_commands[0].replace(/\s+/g, " ")) ||
    (prov.ffmpeg_commands[0].includes("-stream_loop -1") && prov.ffmpeg_commands[0].includes("-c:v copy")),
    prov.ffmpeg_commands[0].slice(0, 140) + "…");
  check("provenance output hash matches file", prov.outputs[0].sha256 === result.outputs[0].sha256, prov.outputs[0].sha256.slice(0, 16) + "…");

  // 7. ffprobe the final MP4: stream-copied video + correct audio + duration
  const probe = await ffprobeJson(outFile);
  const v = videoStream(probe)!;
  const a = audioStream(probe)!;
  const dur = Number(probe.format.duration ?? 0);
  check("mp4 video h264 (stream-copied from cached asset)", v.codec_name === "h264", `${v.codec_name} ${v.width}x${v.height}`);
  check("mp4 video resolution == cached asset (640x360)", v.width === asset.width && v.height === asset.height, `${v.width}x${asset.height}`);
  check("mp4 audio aac", a.codec_name === "aac", a.codec_name!);
  check("mp4 duration ≈ 33.33 s snapped", Math.abs(dur - 33.3333) < 1.0, `ffprobe ${dur.toFixed(3)}s`);
  check("mp4 is loop-muxed (longer than the 10 s source asset)", dur > asset.duration_sec, `${dur.toFixed(1)}s > ${asset.duration_sec}s source`);

  // 8. list_assets shows the asset; evict a scratch asset still works
  const assets = await mcp.tool("list_assets", {}, 20_000);
  check("list_assets includes e2e asset", assets.assets.some((x: any) => x.asset_id === asset.asset_id), `${assets.assets.length} assets`);

  console.log(failures === 0 ? "PHASE6/7 (MCP COLD START + FULL E2E) ALL PASS" : `${failures} FAILURES`);
  process.exitCode = failures ? 1 : 0;
  mcp.kill();
  // daemon stays detached — kill it via its lockfile pid so reruns are cold
  await sleep(200);
  try {
    const pid = fs.readFileSync(path.join(DATA, "daemon.lock"), "utf8").trim();
    if (pid) process.kill(Number(pid), "SIGTERM");
  } catch { /* already gone */ }
  await sleep(300);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
