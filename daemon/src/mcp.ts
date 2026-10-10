/**
 * mcp.ts — thin MCP stdio shim over the daemon's HTTP API.
 * The MCP process holds NO state. On startup it health-checks the daemon and,
 * if unreachable, spawns it detached (lockfile inside the daemon prevents
 * double-spawn races) and waits for it to come up.
 *
 * Tools: create_recipe, submit_job, job_status, job_result, render_preview,
 *        search_stock_videos, select_stock_video, upload_custom_video,
 *        list_assets, evict_asset
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

declare const __dirname: string; // CJS bundle location (build/)

const PORT = Number(process.env.AMBIENTD_PORT ?? 7781);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..");
const DAEMON_FILE = path.join(ROOT, "build", "server.cjs");

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`daemon returned non-JSON HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}: ${parsed?.error ?? text.slice(0, 300)}`);
  return parsed;
}

async function isDaemonUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonUp()) return;
  // Spawn detached — the daemon's own lockfile + port bind resolve spawn races.
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  const logFd = fs.openSync(path.join(ROOT, "data", "daemon.log"), "a");
  const child = spawn(process.execPath, [DAEMON_FILE], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    cwd: ROOT,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await isDaemonUp()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon did not come up on port ${PORT} within 10 s — check data/daemon.log`);
}

const kernelParamsShape = z.object({
  // Literal enums (not bare strings) so a bad scale/timbre/drumStyle fails
  // loudly at the tool boundary — same literal set as the kernel's types.
  scale: z.enum(["majorPent", "minorPent", "ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian", "locrian"]).optional().describe("Scale name (kernel ScaleName)"),
  rootHz: z.number().optional().describe("Root frequency in Hz (default 220)"),
  bpm: z.number().optional().describe("Base tempo (default 72)"),
  complexity: z.number().min(0).max(1).optional().describe("Melodic randomness 0..1"),
  mix: z.number().min(0).max(1).optional().describe("Delay/space 0..1"),
  sceneDurationBars: z.number().optional().describe("Bars per scene (default 32)"),
  enableScenes: z.boolean().optional(),
  enableHarmonicLoop: z.boolean().optional(),
  enableBeats: z.boolean().optional(),
  drumLevel: z.number().min(0).max(1).optional(),
  swing: z.number().min(0).max(0.6).optional(),
  drumStyle: z.enum(["euclideanTrap", "fourFloor"]).optional(),
  sidechainAmount: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional().describe("RNG seed; omitted = generated once and persisted in the recipe"),
  drone: z.object({ layers: z.array(z.object({
    hz: z.number(), detuneCents: z.number().optional(), amp: z.number(),
    pan: z.number(), timbre: z.enum(["sine", "triangle", "softsq", "fm"]),
    sweepSec: z.number().optional(),
  })).max(8) }).optional().describe("Drone layers (max 8)"),
  sampleBank: z.array(z.object({
    id: z.string(), url: z.string(),
    gain: z.number().min(0).optional(),
    pan: z.number().min(-1).max(1).optional(),
  })).max(16).optional().describe("Sample bank entries (max 16) — stored and provenance-tracked; the render core currently counts and skips sample events (no remote decode)"),
}).passthrough();

// Drift guard: the MCP recipe shape and the kernel's EngineParams are checked
// against each other at typecheck time — if one changes without the other,
// `npm test` fails to compile instead of silently drifting (the same class of
// bug the old vendored-copy parity check guarded against).
import type { EngineParams } from "../../kernel/musicalLogic";
type SchemaKernelParams = z.infer<typeof kernelParamsShape>;
const _schemaMatchesEngineParams = (p: SchemaKernelParams): Partial<EngineParams> => p;
void _schemaMatchesEngineParams;

const outputShape = z.object({
  format: z.enum(["wav", "m4a", "mp3", "mp4"]),
  video_asset_id: z.string().optional().describe("Asset from select_stock_video/upload (required for mp4 with video; omit for the static-image fallback)"),
});

async function main(): Promise<void> {
  await ensureDaemon();

  const server = new McpServer({ name: "ambientd", version: "1.0.0" });

  server.tool(
    "create_recipe",
    "Create a stored music recipe (kernel params + duration + output format). Generates and persists a seed if none given. Returns recipe_id.",
    { kernel_params: kernelParamsShape.describe("Generative engine parameters"), duration_sec: z.number().positive().max(8 * 3600).describe("Requested duration in seconds (1 min - 8 h; gets cadence-snapped to whole bars at render)"), output: outputShape },
    async ({ kernel_params, duration_sec, output }) => {
      const r = await call("POST", "/recipes", { kernel_params, duration_sec, output });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "submit_job",
    "Submit a render job for a recipe. Returns immediately with job_id; rendering happens in the background.",
    { recipe_id: z.string().uuid().or(z.string().min(1)) },
    async ({ recipe_id }) => {
      const j = await call("POST", "/jobs", { recipe_id });
      return { content: [{ type: "text", text: JSON.stringify(j, null, 2) }] };
    },
  );

  server.tool(
    "job_status",
    "Get job status (pending|running|done|failed) and progress (0..1).",
    { job_id: z.string().min(1) },
    async ({ job_id }) => {
      const j = await call("GET", `/jobs/${job_id}`);
      return { content: [{ type: "text", text: JSON.stringify(j, null, 2) }] };
    },
  );

  server.tool(
    "job_result",
    "Get a completed job's output file paths and provenance sidecar (seed, versions, ffmpeg commands).",
    { job_id: z.string().min(1) },
    async ({ job_id }) => {
      const r = await call("GET", `/jobs/${job_id}/result`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "render_preview",
    "Fast audition render of a recipe (default 60 s) — check it sounds right before committing to a long render. Returns a job_id; poll with job_status.",
    { recipe_id: z.string().min(1), duration_sec: z.number().positive().max(600).optional().default(60), format: z.enum(["wav", "m4a", "mp3"]).optional().default("mp3") },
    async ({ recipe_id, duration_sec, format }) => {
      const j = await call("POST", "/jobs", { recipe_id, duration_sec, preview_format: format, preview: true });
      return { content: [{ type: "text", text: JSON.stringify({ ...j, note: "preview job — poll job_status then job_result" }, null, 2) }] };
    },
  );

  server.tool(
    "search_stock_videos",
    "Search stock video providers (Pexels/Pixabay) for background footage. Returns candidate refs with thumbnail/duration/resolution/license — NOT yet cached; present the shortlist to the human, then select_stock_video.",
    { query: z.string().min(1), provider: z.enum(["pexels", "pixabay", "all"]).optional().default("all"), count: z.number().int().min(1).max(40).optional().default(10) },
    async ({ query, provider, count }) => {
      const r = await call("POST", "/assets/search", { query, provider, count });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "select_stock_video",
    "Download + normalize (h264/mp4, ~2.5 Mbps, target resolution) and cache a candidate from search_stock_videos. Returns an asset_id for use in recipes. Ask the human to pick the candidate first.",
    { candidate_ref: z.string().min(1).describe("ref from search results, or a direct video URL") },
    async ({ candidate_ref }) => {
      const a = await call("POST", "/assets/select", { candidate_ref });
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    },
  );

  server.tool(
    "upload_custom_video",
    "Ingest your own video (local path or URL) through the same normalize+cache flow. Returns an asset_id.",
    { file: z.string().optional().describe("local file path"), url: z.string().url().optional().describe("or a direct video URL"), label: z.string().optional() },
    async ({ file, url, label }) => {
      const a = await call("POST", "/assets/upload", { file, url, label });
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    },
  );

  server.tool(
    "list_assets",
    "List cached (normalized) video assets.",
    {},
    async () => {
      const r = await call("GET", "/assets");
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "evict_asset",
    "Delete a cached video asset (manual cleanup; renders keep their already-written outputs).",
    { asset_id: z.string().min(1).describe("sha256:... asset id") },
    async ({ asset_id }) => {
      const r = await call("DELETE", `/assets/${asset_id}`);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[ambientd-mcp] connected (daemon at ${BASE})`);
}

main().catch((e) => {
  console.error(`[ambientd-mcp] fatal: ${String(e?.stack ?? e)}`);
  process.exit(1);
});
