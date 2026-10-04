/**
 * sinks.ts — the three block consumers for the streaming synth. Each one
 * processes a block and immediately discards it: no sink retains audio, so
 * verification adds O(block) memory on top of generation (the G1 numbers
 * therefore measure generation; hashing is streaming too).
 *
 * PCM16 conversion mirrors audioBufferToWav (renderAmbient.ts:1015) and
 * bench/lib/wav.mjs: clamp then `round(s<0 ? s*0x8000 : s*0x7fff)`.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";

export function floatToPcm16(s: number): number {
  const c = Math.max(-1, Math.min(1, s));
  return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
}

export function interleavePcm16(l: Float32Array, r: Float32Array, frames: number, buf: Buffer): void {
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(floatToPcm16(l[i]), i * 4);
    buf.writeInt16LE(floatToPcm16(r[i]), i * 4 + 2);
  }
}

/** Streaming WAV (PCM16) writer — 44-byte canonical header, identical layout
 * to bench/lib/wav.mjs (verified post-hoc by lib/wav.mjs verifyWavHeader). */
export class WavFileSink {
  private fd: number;
  private readonly buf: Buffer;
  private h = createHash("sha256");
  dataBytes = 0;
  nonFinite = 0;
  peak = 0;
  constructor(filePath: string, sampleRate: number, private readonly channels = 2) {
    this.fd = fs.openSync(filePath, "w");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); // data length patched on finish()
    header.writeUInt32LE(0, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * this.channels * 2, 28);
    header.writeUInt16LE(this.channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(0, 40);
    fs.writeSync(this.fd, header);
    this.buf = Buffer.alloc(65536 * 4);
  }
  writeBlock(left: Float32Array, right: Float32Array, frames: number): void {
    // Slice into fixed 16384-frame pieces so any block size is safe (the
    // single-block I1 config feeds ~1.3M-frame "blocks").
    for (let start = 0; start < frames; start += 16384) {
      const n = Math.min(16384, frames - start);
      for (let i = 0; i < n; i++) {
        const l = left[start + i];
        const r = right[start + i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) this.nonFinite++;
        const al = Math.abs(l);
        const ar = Math.abs(r);
        if (al > this.peak) this.peak = al;
        if (ar > this.peak) this.peak = ar;
        this.buf.writeInt16LE(floatToPcm16(l), i * 4);
        this.buf.writeInt16LE(floatToPcm16(r), i * 4 + 2);
      }
      this.flush(n * 4);
    }
  }
  private flush(bytes: number): void {
    if (bytes === 0) return;
    this.h.update(this.buf.subarray(0, bytes));
    fs.writeSync(this.fd, this.buf.subarray(0, bytes));
    this.dataBytes += bytes;
  }
  finish(): { dataBytes: number; sha256: string } {
    fs.fsyncSync(this.fd);
    const size = fs.fstatSync(this.fd).size;
    const view = Buffer.alloc(4);
    view.writeUInt32LE(36 + this.dataBytes, 0);
    fs.writeSync(this.fd, view, 0, 4, 4); // RIFF size
    view.writeUInt32LE(this.dataBytes, 0);
    fs.writeSync(this.fd, view, 0, 4, 40); // data size
    fs.closeSync(this.fd);
    return { dataBytes: this.dataBytes, sha256: this.h.digest("hex"), fileSize: size };
  }
}

/** Streaming hash sink — verification with O(block) memory. */
export class HashSink {
  private h = createHash("sha256");
  private hex: string | null = null;
  nonFinite = 0;
  peak = 0;
  sumSq = 0;
  samples = 0;
  private buf = Buffer.alloc(65536 * 4);
  writeBlock(left: Float32Array, right: Float32Array, frames: number): void {
    for (let start = 0; start < frames; start += 16384) {
      const n = Math.min(16384, frames - start);
      for (let i = 0; i < n; i++) {
        const l = left[start + i];
        const r = right[start + i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) this.nonFinite++;
        const al = Math.abs(l);
        const ar = Math.abs(r);
        if (al > this.peak) this.peak = al;
        if (ar > this.peak) this.peak = ar;
        this.sumSq += l * l + r * r;
        this.buf.writeInt16LE(floatToPcm16(l), i * 4);
        this.buf.writeInt16LE(floatToPcm16(r), i * 4 + 2);
      }
      this.h.update(this.buf.subarray(0, n * 4));
    }
    this.samples += frames;
  }
  sha256(): string {
    if (this.hex === null) this.hex = this.h.digest("hex");
    return this.hex;
  }
  rms(): number {
    return this.samples ? Math.sqrt(this.sumSq / (this.samples * 2)) : 0;
  }
}

/** Accepts a no-op sink for throughput-only runs (still visits every sample). */
export class NullSink {
  nonFinite = 0;
  writeBlock(_l: Float32Array, _r: Float32Array, _frames: number): void {}
}

/** Stream PCM16 into a spawned ffmpeg reading s16le from stdin. Reports the
 * encoder's peak RSS (Linux VmHWM) sampled every 100 ms. */
export class FfmpegStdinSink {
  private child;
  private stdin: import("node:stream").Writable | null;
  private buf = Buffer.alloc(65536 * 4);
  private h = createHash("sha256");
  private peakRss = 0;
  private poller: NodeJS.Timeout | null = null;
  private readonly stderrTail: string[] = [];
  nonFinite = 0;
  peak = 0;
  exitCode: number | null = null;
  constructor(
    filePath: string,
    sampleRate: number,
    opts: { args?: string[]; onStderr?: (s: string) => void } = {},
  ) {
    // Raw PCM in; container/codec chosen by caller (repo uses AAC 160k).
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", String(sampleRate), "-ac", "2", "-i", "pipe:0",
      ...(opts.args ?? ["-c:a", "aac", "-b:a", "160k"]),
      filePath,
    ];
    this.child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    this.stdin = this.child.stdin;
    this.child.stderr.on("data", (d) => {
      const s = String(d);
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      opts.onStderr?.(s);
    });
    // Peak-RSS polling — VmHWM vanishes with the process, so sample live.
    const pid = this.child.pid;
    if (pid && process.platform === "linux") {
      this.poller = setInterval(() => {
        try {
          const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
          const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
          if (m) {
            const v = Number(m[1]) * 1024;
            if (v > this.peakRss) this.peakRss = v;
          }
        } catch { /* exited */ }
      }, 100);
    }
  }
  writeBlock(left: Float32Array, right: Float32Array, frames: number): void {
    if (!this.stdin || this.stdin.destroyed) throw new Error("ffmpeg stdin closed early — encoder failed");
    for (let start = 0; start < frames; start += 16384) {
      const n = Math.min(16384, frames - start);
      for (let i = 0; i < n; i++) {
        const l = left[start + i];
        const r = right[start + i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) this.nonFinite++;
        const al = Math.abs(l);
        const ar = Math.abs(r);
        if (al > this.peak) this.peak = al;
        if (ar > this.peak) this.peak = ar;
        this.buf.writeInt16LE(floatToPcm16(l), i * 4);
        this.buf.writeInt16LE(floatToPcm16(r), i * 4 + 2);
      }
      this.h.update(this.buf.subarray(0, n * 4));
      this.stdin.write(this.buf.subarray(0, n * 4));
    }
  }
  /** Closes stdin and waits for ffmpeg to finish. */
  finish(): Promise<{ exitCode: number | null; sha256: string; peakRssBytes: number; stderr: string }> {
    return new Promise((resolve) => {
      const done = (code: number | null) => {
        if (this.poller) clearInterval(this.poller);
        resolve({
          exitCode: code,
          sha256: this.h.digest("hex"),
          peakRssBytes: this.peakRss,
          stderr: this.stderrTail.join(""),
        });
      };
      const stdin = this.stdin!;
      stdin.end();
      this.stdin = null;
      if (this.child.exitCode !== null) done(this.child.exitCode);
      else this.child.on("close", done);
    });
  }
}
