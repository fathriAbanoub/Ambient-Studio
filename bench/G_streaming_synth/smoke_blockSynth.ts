/**
 * smoke_blockSynth.ts — assert-based self-check of the block synth core.
 * Renders 20 s, verifies: exact frame count, zero non-finite samples,
 * non-silent output, block-size invariance (two block sizes → same hash),
 * and D5 loud failure on a malformed event. Exits non-zero on any failure.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { BlockSynth, buildTimeline, type SynthSink } from "./blockSynth";
import { TONAL_BUS_GAIN } from "../../kernel/scheduling";

const SR = 44100;
const DUR = 20;
const PARAMS = {
  scale: "majorPent" as const, rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true, enableBeats: true,
  seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap" as const, sidechainAmount: 0,
  // automation-heavy config: 4 drone layers exercise D4 paths
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

function render(blockFrames: number, broken = false): { sink: HashSink; stats: ReturnType<BlockSynth["render"]> } {
  const timeline = buildTimeline(PARAMS, DUR);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames, durationSec: DUR, brokenReanchor: broken });
  const sink = new HashSink();
  const stats = synth.render(sink);
  return { sink, stats };
}

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

const a = render(4096);
const b = render(1024);

check("frames_exact", a.stats.framesWritten === DUR * SR, `${a.stats.framesWritten} vs ${DUR * SR}`);
check("nonfinite_zero", a.sink.nonFinite === 0, `non-finite=${a.sink.nonFinite}`);
check("non_silent", a.sink.rms() > 1e-4 && a.sink.peak > 1e-3, `rms=${a.sink.rms().toFixed(5)} peak=${a.sink.peak.toFixed(4)}`);
check("block_invariance_1024_vs_4096", a.sink.digest() === b.sink.digest(),
  `sha256 ${a.sink.digest().slice(0, 16)} vs ${b.sink.digest().slice(0, 16)}`);
check("voices_bounded", a.stats.peakConcurrentVoices > 0 && a.stats.peakConcurrentVoices < 128, `peak=${a.stats.peakConcurrentVoices}`);
check("drones_started", a.stats.droneLayersStarted === 4, `layers=${a.stats.droneLayersStarted}`);

// D5: unknown type must throw
let threw = false;
try {
  const timeline = buildTimeline(PARAMS, 5);
  timeline.events.push({ t: 1, priority: 50, seq: 1e9, ev: { type: "laser" as never, amp: 1, durationSec: 1, pan: 0, beatIndex: 0, subBeatIndex: 0 } });
  // re-sort the way a hostile timeline would arrive
  timeline.events.sort((x, y) => x.t - y.t || x.priority - y.priority || x.seq - y.seq);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: 4096, durationSec: 5 });
  synth.render(new HashSink());
} catch (e) {
  threw = String((e as Error).message).includes("[D5]");
}
check("d5_unknown_type_throws", threw, "malformed event rejected loudly");

// D4 broken variant must NOT be block-invariant (the test can detect the anti-pattern)
const brokenBig = render(8192, true);
const brokenSmall = render(512, true);
check("broken_variant_detectable", brokenBig.sink.digest() !== brokenSmall.sink.digest(),
  `8192-frame vs 512-frame broken renders diverge (hashes differ: ${brokenBig.sink.digest() !== brokenSmall.sink.digest()})`);

// sanity: WAV header shape via a tiny file write
const w = render(4096);
const wav = Buffer.alloc(44);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + w.sink.bytes, 4); wav.write("WAVE", 8);
wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(w.sink.bytes, 40);
writeFileSync("/tmp/ambient/smoke.pcm", Buffer.alloc(0)); void wav; void TONAL_BUS_GAIN;

console.log(failures === 0 ? "\nALL SMOKE CHECKS PASS" : `\n${failures} SMOKE CHECKS FAILED`);
process.stdout.write("__BENCH_JSON__" + JSON.stringify({
  hash_4096: a.sink.digest(), hash_1024: b.sink.digest(),
  rms: a.sink.rms(), peak: a.sink.peak, stats: a.stats,
}));
process.exit(failures === 0 ? 0 : 1);
