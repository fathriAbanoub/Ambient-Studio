/**
 * bench/lib/procmon.mjs — process RSS polling, directory-size sampling and
 * disk-free accounting. Cross-platform with documented granularity ceilings.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROC_RSS_POLL_INTERVAL_MS, PROC_RSS_POLL_INTERVAL_MS_WIN, DIR_SIZE_SAMPLE_INTERVAL_MS } from "./constants.mjs";

function rssBytesLinux(pid) {
  // /proc/<pid>/status VmHWM is the kernel-tracked peak; no polling error.
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
    if (m) return Number(m[1]) * 1024;
    const rss = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return rss ? Number(rss[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function rssBytesDarwin(pid) {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim();
    return out ? Number(out) * 1024 : null;
  } catch {
    return null;
  }
}

function rssBytesWindows(pid) {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).toString();
    const m = out.match(/"(\d+)\s*K"/); // tasklist reports K by default
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Poll a child process's RSS until it exits. Prefers the kernel's own peak
 * counter (Linux VmHWM); elsewhere samples at PROC_RSS_POLL_INTERVAL_MS_WIN.
 * ponytail: Windows sampling is 1s-granularity via tasklist and can miss
 * sub-second RSS spikes; upgrade path is a helper binary or ETW tracing.
 */
export class RssPoller {
  constructor(pid) {
    this.pid = pid;
    this.peak = 0;
    this.platform = process.platform;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.platform === "linux") {
      // VmHWM is read once after exit — no polling needed; still poll VmRSS
      // so mid-run values exist for the raw samples.
      this.timer = setInterval(() => {
        const v = rssBytesLinux(this.pid);
        if (v && v > this.peak) this.peak = v;
      }, PROC_RSS_POLL_INTERVAL_MS);
    } else {
      const interval = this.platform === "win32"
        ? PROC_RSS_POLL_INTERVAL_MS_WIN
        : PROC_RSS_POLL_INTERVAL_MS;
      this.timer = setInterval(() => {
        const v = this.platform === "win32" ? rssBytesWindows(this.pid) : rssBytesDarwin(this.pid);
        if (v && v > this.peak) this.peak = v;
      }, interval);
    }
  }

  /** Final read; on Linux re-reads VmHWM before the process entry vanishes. */
  finish() {
    if (this.platform === "linux") {
      const v = rssBytesLinux(this.pid);
      if (v && v > this.peak) this.peak = v;
    }
    this.stop();
    return this.peak;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.stopped = true;
  }
}

/** Recursively sum file sizes in a directory (follows no symlinks). */
export async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try {
        total += (await fs.promises.stat(p)).size;
      } catch {
        /* file vanished mid-walk */
      }
    }
  }
  return total;
}

/**
 * Sample a directory's total size every DIR_SIZE_SAMPLE_INTERVAL_MS.
 * Returns { stop(), peakBytes, samples: [{t, bytes}] }.
 */
export class DirSizeSampler {
  constructor(dir) {
    this.dir = dir;
    this.peakBytes = 0;
    this.samples = [];
    this.timer = setInterval(() => {
      void dirSize(dir).then((bytes) => {
        if (bytes > this.peakBytes) this.peakBytes = bytes;
        this.samples.push({ t: Date.now(), bytes });
      });
    }, DIR_SIZE_SAMPLE_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }
}
