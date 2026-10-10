/**
 * test/smoke.mjs — the benchmark PoC's own self-check (smoke_blockSynth.ts),
 * re-pointed at the vendored kernel. Same assertions, same params (seed 42,
 * 4 drone layers): exact frame count, zero non-finite, non-silent,
 * block-size invariance, D5 loud failure, broken-variant detectability.
 * Run: node build/smoke.cjs (bundled by build.mjs when SMOKE=1)
 */
import { BlockSynth, buildTimeline } from "../src/blockSynth";
import type { SynthSink } from "../src/blockSynth";
import { createHash } from "node:crypto";

const SR = 44100;
const DUR = 20;
const PARAMS = {
  scale: "majorPent" as const, rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap" as const, sidechainAmount: 0,
  drone: { layers: [0, 1, 2, 3].map((i) => ({ hz: 55 + i * 8, amp: 0.15, pan: -1 + (2 * i) / 3, timbre: "sine" as const })) },
};

class HashSink implements SynthSink {
  private h = createHash("sha256");
  bytes = 0;
  peak = 0; sumSq = 0; nonFinite = 0;
  writeBlock(l: Float32Array, r: Float32Array, frames: number): void {
    const buf = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      for (const [ch, x] of [[0, l[i]], [1, r[i]]] as const) {
        if (!Number.isFinite(x)) this.nonFinite++;
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        this.sumSq += x * x;
        const s = Math.max(-1, Math.min(1, x));
        buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 4 + ch * 2);
      }
    }
    this.h.update(buf);
    this.bytes += frames * 4;
  }
  private hex: string | null = null;
  digest(): string {
    if (this.hex === null) this.hex = this.h.digest("hex");
    return this.hex;
  }
  rms(): number { return Math.sqrt(this.sumSq / (this.bytes / 4)); }
}

async function render(blockFrames: number, broken = false) {
  const timeline = buildTimeline(PARAMS, DUR);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames, durationSec: DUR, brokenReanchor: broken });
  const sink = new HashSink();
  const stats = await synth.render(sink);
  return { sink, stats };
}

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

async function main() {
const a = await render(4096);
const b = await render(1024);

check("frames_exact", a.stats.framesWritten === DUR * SR, `${a.stats.framesWritten} vs ${DUR * SR}`);
check("nonfinite_zero", a.sink.nonFinite === 0, `non-finite=${a.sink.nonFinite}`);
check("non_silent", a.sink.rms() > 1e-4 && a.sink.peak > 1e-3, `rms=${a.sink.rms().toFixed(5)} peak=${a.sink.peak.toFixed(4)}`);
check("block_invariance_1024_vs_4096", a.sink.digest() === b.sink.digest(),
  `sha256 ${a.sink.digest().slice(0, 16)} vs ${b.sink.digest().slice(0, 16)}`);
check("voices_bounded", a.stats.peakConcurrentVoices > 0 && a.stats.peakConcurrentVoices < 128, `peak=${a.stats.peakConcurrentVoices}`);
check("drones_started", a.stats.droneLayersStarted === 4, `layers=${a.stats.droneLayersStarted}`);

let threw = false;
try {
  const timeline = buildTimeline(PARAMS, 5);
  timeline.events.push({ t: 1, priority: 50, seq: 1e9, ev: { type: "laser" as never, amp: 1, durationSec: 1, pan: 0, beatIndex: 0, subBeatIndex: 0 } });
  timeline.events.sort((x, y) => x.t - y.t || x.priority - y.priority || x.seq - y.seq);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: 4096, durationSec: 5 });
  await synth.render(new HashSink());
} catch (e) {
  threw = String((e as Error).message).includes("[D5]");
}
check("d5_unknown_type_throws", threw, "malformed event rejected loudly");

const brokenBig = await render(8192, true);
const brokenSmall = await render(512, true);
check("broken_variant_detectable", brokenBig.sink.digest() !== brokenSmall.sink.digest(),
  `8192-frame vs 512-frame broken renders diverge`);

console.log(failures === 0 ? "ALL SMOKE CHECKS PASS" : `${failures} SMOKE CHECKS FAILED`);
process.stdout.write("__BENCH_JSON__" + JSON.stringify({ hash_4096: a.sink.digest(), rms: a.sink.rms(), peak: a.sink.peak }));
process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
