import { BlockSynth, buildTimeline, type SynthSink } from "../src/blockSynth";
import { writeFileSync } from "node:fs";
import type { EngineParams } from "../../kernel/musicalLogic";

const SR = 44100;
const DURATION = 60; // 60 seconds is enough to hear 2 chord changes

const PARAMS: EngineParams = {
  scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true,
  enableBeats: true, seed: 42, drumLevel: 0.5, swing: 0, drumStyle: "euclideanTrap",
  sidechainAmount: 0,
  enableNeoHarmony: false, // <--- THIS IS THE MAGIC FLAG
  drone: { layers: [{ hz: 55, amp: 0.15, pan: 0, timbre: "sine" as const }] },
};

class WavSink implements SynthSink {
  private l: Float32Array[] = [];
  private r: Float32Array[] = [];
  writeBlock(l: Float32Array, r: Float32Array, frames: number) {
    this.l.push(l.slice(0, frames));
    this.r.push(r.slice(0, frames));
  }
  write(path: string) {
    const totalFrames = this.l.reduce((a, b) => a + b.length, 0);
    const buf = Buffer.alloc(44 + totalFrames * 4);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + totalFrames * 4, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(totalFrames * 4, 40);

    let offset = 44;
    for (let i = 0; i < this.l.length; i++) {
      const left = this.l[i];
      const right = this.r[i];
      for (let j = 0; j < left.length; j++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, left[j] * 32767)), offset);
        offset += 2;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, right[j] * 32767)), offset);
        offset += 2;
      }
    }
    writeFileSync(path, buf);
  }
}

async function main() {
  const timeline = buildTimeline(PARAMS, DURATION);
  const synth = new BlockSynth({ params: PARAMS, timeline, sampleRate: SR, blockFrames: 4096, durationSec: DURATION });
  const sink = new WavSink();
  await synth.render(sink);
  sink.write("/tmp/harmony_on.wav");
  console.log("✅ Wrote /tmp/harmony_on.wav");
}
main().catch(console.error);
