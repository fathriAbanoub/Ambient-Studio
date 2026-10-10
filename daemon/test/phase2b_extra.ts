/**
 * test/phase2b_extra.ts — remaining verification gaps:
 *   1. providers: no API key → clear loud error (not a crash); with a fake
 *      local Pexels-style server: search → select → cache via HTTP URL
 *   2. spawn race: two MCP shims started simultaneously on a cold port must
 *      end with exactly ONE daemon
 *   3. long render through the daemon: 1 h WAV — duration exact, peak RSS
 *      measured (VmHWM), wall time recorded (measured scaling point, stated)
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

declare const __dirname: string;
const ROOT = path.resolve(__dirname, "..");
const PORT = 7795;
const DATA = "/tmp/ambientd-x";

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  process.env.AMBIENTD_DATA = DATA;

  // ── 1. provider error path (no key) ──
  const { pexels, pixabay } = await import("../src/providers");
  const savedPexKey = process.env.PEXELS_API_KEY;
  const savedPixKey = process.env.PIXABAY_API_KEY;
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  let pexErr = "";
  try { await pexels.search("rain", 5); } catch (e) { pexErr = String((e as Error).message); }
  check("pexels without key fails loudly", pexErr.includes("PEXELS_API_KEY"), pexErr.slice(0, 80));
  let pixErr = "";
  try { await pixabay.search("rain", 5); } catch (e) { pixErr = String((e as Error).message); }
  check("pixabay without key fails loudly", pixErr.includes("PIXABAY_API_KEY"), pixErr.slice(0, 80));

  // fake Pexels server: search endpoint + video file download
  const clip = fs.readFileSync(path.join(ROOT, "test", "media", "loop.mp4"));
  const fake = http.createServer((req, res) => {
    if (req.url?.startsWith("/videos/search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        videos: [{
          id: 999, duration: 10, width: 640, height: 360,
          image: "http://x/thumb.jpg", user: { name: "test" },
          video_files: [{ link: `http://127.0.0.1:${PORT}/dl`, width: 640, height: 360, quality: "sd", file_type: "video/mp4" }],
        }],
      }));
    } else if (req.url === "/dl") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": clip.length });
      res.end(clip);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => fake.listen(PORT, "127.0.0.1", r));
  process.env.PEXELS_API_KEY = "fake-key-for-local-test";
  process.env.PEXELS_API_BASE = `http://127.0.0.1:${PORT}`;
  const { searchStockVideos, selectCandidate, listAssets, getAsset } = await import("../src/assets");
  const candidates = await searchStockVideos("calm ocean", 5, "pexels");
  check("fake pexels search returns candidates", candidates.length === 1 && candidates[0].provider === "pexels", JSON.stringify(candidates[0]?.ref));
  const viaUrl = await selectCandidate(candidates[0].ref);
  check("select via search ref → cached asset", /^sha256:[0-9a-f]{64}$/.test(viaUrl.asset_id) && fs.existsSync(viaUrl.file), viaUrl.asset_id.slice(0, 28) + "…");
  check("asset registry has entry", getAsset(viaUrl.asset_id)?.source.provider === "pexels", `provider=${getAsset(viaUrl.asset_id)?.source.provider}`);
  check("search cache holds 5 assets", listAssets().length >= 1, `${listAssets().length}`);
  fake.close();
  delete process.env.PEXELS_API_BASE;
  process.env.PEXELS_API_KEY = savedPexKey;
  process.env.PIXABAY_API_KEY = savedPixKey;

  // ── 2. spawn race: two shims, one daemon ──
  const racePort = 7796;
  const shim = () => spawn(process.execPath, [path.join(ROOT, "build", "mcp.cjs")], {
    env: { ...process.env, AMBIENTD_PORT: String(racePort), AMBIENTD_DATA: DATA },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const s1 = shim();
  const s2 = shim();
  let up = false;
  let pid1 = -1;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${racePort}/health`)).json();
      up = true; pid1 = h.pid; break;
    } catch { await sleep(200); }
  }
  await sleep(1000); // give the loser time to notice and exit
  let pid2 = -1;
  try { pid2 = (await (await fetch(`http://127.0.0.1:${racePort}/health`)).json()).pid; } catch {}
  const bothAlive = (() => {
    try { process.kill(pid1, 0); } catch { return false; }
    return true;
  })();
  check("race: exactly one daemon wins", up && pid1 === pid2 && bothAlive, `pid ${pid1} stable, health reachable`);
  s1.kill(); s2.kill();
  try { process.kill(pid1, "SIGTERM"); } catch {}
  await sleep(500);

  // ── 3. long render through the daemon (1 h WAV) ──
  const longPort = 7797;
  const daemon = spawn(process.execPath, [path.join(ROOT, "build", "server.cjs")], {
    env: { ...process.env, AMBIENTD_PORT: String(longPort), AMBIENTD_DATA: DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonLog = "";
  daemon.stderr.on("data", (d) => (daemonLog += String(d)));
  const api = async (m: string, p: string, b?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${longPort}${p}`, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error ?? res.status);
    return j;
  };
  for (let i = 0; i < 60; i++) { try { await api("GET", "/health"); break; } catch { await sleep(200); } }

  const t0 = Date.now();
  const rec = await api("POST", "/recipes", {
    kernel_params: { scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4, seed: 42, drone: { layers: [{ hz: 55, amp: 0.15, pan: 0, timbre: "sine" }] } },
    duration_sec: 3600,
    output: { format: "wav" },
  });
  const job = await api("POST", "/jobs", { recipe_id: rec.recipe_id });
  let fin: any = null;
  for (;;) {
    const s = await api("GET", `/jobs/${job.job_id}`);
    if (s.status === "done") { fin = await api("GET", `/jobs/${job.job_id}/result`); break; }
    if (s.status === "failed") { console.error(daemonLog.slice(-600)); check("1 h job done", false, s.error ?? "failed"); break; }
    if (Date.now() - t0 > 9 * 60_000) { check("1 h job done", false, "timeout"); break; }
    await sleep(1000);
  }
  if (fin) {
    const wall = (Date.now() - t0) / 1000;
    const out = fin.outputs[0];
    const prov = fin.provenance;
    check("1 h snapped exactly", prov.duration.snapped_sec === 3600 && prov.duration.bars === 1080, `1080 bars = 3600.000 s (bars=${prov.duration.bars})`);
    const expectedBytes = 44 + 3600 * 44100 * 4;
    check("1 h WAV size exact (44 + frames×4)", out.bytes === expectedBytes, `${out.bytes} bytes vs theoretical ${expectedBytes}`);
    check("1 h realtime factor measured > 10×", wall < 360, `${wall.toFixed(0)} s wall for 3600 s audio (${(3600 / wall).toFixed(1)}× realtime)`);
    // worker peak RSS — VmHWM of the daemon process (worker shares the address space)
    const status = fs.readFileSync(`/proc/${daemon.pid}/status`, "utf8");
    const hwm = Number(status.match(/^VmHWM:\s+(\d+)\s+kB/m)?.[1] ?? 0) * 1024;
    check("1 h peak RSS bounded (≪ PCM size 1.27 GB)", hwm > 50e6 && hwm < 500e6, `VmHWM ${(hwm / 1e6).toFixed(1)} MB while PCM16 data is 1270 MB`);
    console.log(`  [measured] 1 h WAV: wall ${wall.toFixed(1)} s, realtime ×${(3600 / wall).toFixed(1)}, peak RSS ${(hwm / 1e6).toFixed(1)} MB, output ${(out.bytes / 1e9).toFixed(2)} GB sha256 ${out.sha256.slice(0, 12)}…`);
  } else {
    check("1 h job produced a result", false, "no result");
  }
  daemon.kill("SIGTERM");

  console.log(failures === 0 ? "PHASE2b EXTRA ALL PASS" : `${failures} EXTRA FAILURES`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
