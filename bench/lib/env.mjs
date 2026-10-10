/**
 * bench/lib/env.mjs — environment capture (Hard Rule 4).
 * A number without its environment attached is not a result.
 */
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const pExecFile = promisify(execFile);

async function safe(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await pExecFile(cmd, args, {
      timeout: 10_000, ...opts,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), stdout: err?.stdout ?? "", stderr: err?.stderr ?? "" };
  }
}

async function gpuInfo() {
  // Best-effort GPU model detection. Ceiling: probes nvidia-smi on all
  // platforms and Win32_VideoController on Windows; macOS/linux PCI probing
  // is not attempted. Upgrade path: add `system_profiler SPDisplaysDataType`
  // (darwin) and `lspci` (linux) probes if needed.
  const smi = await safe("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]);
  if (smi.ok && smi.stdout.trim()) {
    return { source: "nvidia-smi", gpus: smi.stdout.trim().split("\n").map((l) => l.trim()) };
  }
  if (process.platform === "win32") {
    const ps = await safe("powershell", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
    ]);
    if (ps.ok && ps.stdout.trim()) {
      return { source: "win32_videocontroller", gpus: ps.stdout.trim().split("\n").map((l) => l.trim()) };
    }
  }
  return { source: "none", gpus: [] };
}

export async function ffmpegInfo(ffmpegBin = "ffmpeg") {
  const ver = await safe(ffmpegBin, ["-version"]);
  if (!ver.ok) return { available: false };
  const lines = ver.stdout.split("\n");
  const enc = await safe(ffmpegBin, ["-hide_banner", "-encoders"]);
  const nvencEncoders = enc.ok
    ? enc.stdout.split("\n").filter((l) => l.toLowerCase().includes("nvenc")).map((l) => l.trim())
    : [];
  return {
    available: true,
    version_line: lines[0]?.trim() ?? null,
    config_line: lines.find((l) => l.trim().startsWith("configuration:"))?.trim() ?? null,
    nvenc_encoders: nvencEncoders,
  };
}

export async function diskFree(path) {
  try {
    const st = await fs.promises.statfs(path);
    return { free_bytes: Number(st.bsize) * Number(st.bavail), total_bytes: Number(st.bsize) * Number(st.blocks) };
  } catch {
    // ponytail: fs.statfs needs Node >= 18.15; on failure record null and let
    // disk guards degrade to "unknown" instead of skipping. Upgrade path: none needed.
    return { free_bytes: null, total_bytes: null };
  }
}

export async function captureEnvironment(resultsDir) {
  const cpus = os.cpus();
  const [ff, gpu, disk] = await Promise.all([
    ffmpegInfo(),
    gpuInfo(),
    diskFree(resultsDir),
  ]);
  return {
    captured_at: new Date().toISOString(),
    os: { platform: process.platform, type: os.type(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0]?.model ?? null, cores: cpus.length, speed_mhz: cpus[0]?.speed ?? null },
    total_ram_bytes: os.totalmem(),
    node_version: process.version,
    ffmpeg: ff,
    ffprobe: (await safe("ffprobe", ["-version"])).ok,
    gpu,
    results_dir_disk: disk,
  };
}
