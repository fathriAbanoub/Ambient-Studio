/**
 * bench/lib/wav.mjs — streaming WAV (PCM16) writer.
 * Header layout mirrors the repo's audioBufferToWav (renderAmbient.ts:984-1019):
 * 44-byte canonical header, interleaved PCM16 little-endian.
 */
import fs from "node:fs";

export const WAV_HEADER_BYTES = 44;
export const PCM16_BYTES_PER_SAMPLE = 2;

/** Exact on-disk size of a PCM16 WAV of this shape — the E1 theoretical value. */
export function wavTheoreticalBytes(sampleRate, channels, frames) {
  return WAV_HEADER_BYTES + frames * channels * PCM16_BYTES_PER_SAMPLE;
}

function ascii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Verify a WAV file's header matches its actual size (assert-based check). */
export function verifyWavHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(WAV_HEADER_BYTES);
    fs.readSync(fd, buf, 0, WAV_HEADER_BYTES, 0);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const riff = String.fromCharCode(...buf.subarray(0, 4));
    const wave = String.fromCharCode(...buf.subarray(8, 12));
    const declaredData = view.getUint32(40, true);
    const fileSize = fs.statSync(filePath).size;
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    return {
      riffOk: riff === "RIFF" && wave === "WAVE",
      declaredData,
      actualData: fileSize - WAV_HEADER_BYTES,
      sizeConsistent: declaredData === fileSize - WAV_HEADER_BYTES,
      channels,
      sampleRate,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream a PCM16 WAV file. `frameGen(iterIndex, channelIndex) -> [-1, 1]`
 * is called per sample; generation happens in fixed-size buffer chunks so
 * multi-GB files never materialize in memory.
 */
export class WavPcm16Writer {
  /**
   * @param {string} filePath
   * @param {number} sampleRate
   * @param {number} channels
   * @param {number} frames total frames to write
   * @param {(i: number, ch: number, t: number) => number} frameGen
   * @param {number} [chunkFrames] frames per flush
   */
  constructor(filePath, sampleRate, channels, frames, frameGen, chunkFrames = 1 << 16) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.frames = frames;
    this.frameGen = frameGen;
    this.chunkFrames = chunkFrames;
  }

  async write() {
    const fd = await fs.promises.open(this.filePath, "w");
    try {
      const header = Buffer.alloc(WAV_HEADER_BYTES);
      const view = new DataView(header.buffer);
      const dataLength = this.frames * this.channels * PCM16_BYTES_PER_SAMPLE;
      ascii(view, 0, "RIFF");
      view.setUint32(4, 36 + dataLength, true);
      ascii(view, 8, "WAVE");
      ascii(view, 12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, this.channels, true);
      view.setUint32(24, this.sampleRate, true);
      view.setUint32(28, this.sampleRate * this.channels * PCM16_BYTES_PER_SAMPLE, true);
      view.setUint16(32, this.channels * PCM16_BYTES_PER_SAMPLE, true);
      view.setUint16(34, 16, true);
      ascii(view, 36, "data");
      view.setUint32(40, dataLength, true);
      await fd.write(header);

      const buf = Buffer.alloc(this.chunkFrames * this.channels * PCM16_BYTES_PER_SAMPLE);
      for (let start = 0; start < this.frames; start += this.chunkFrames) {
        const n = Math.min(this.chunkFrames, this.frames - start);
        let off = 0;
        for (let i = 0; i < n; i++) {
          const frameIdx = start + i;
          const t = frameIdx / this.sampleRate;
          for (let ch = 0; ch < this.channels; ch++) {
            const s = Math.max(-1, Math.min(1, this.frameGen(frameIdx, ch, t)));
            // Same rounding shape as audioBufferToWav (renderAmbient.ts:1015):
            buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), off);
            off += 2;
          }
        }
        await fd.write(buf.subarray(0, off));
      }
    } finally {
      await fd.close();
    }
    return wavTheoreticalBytes(this.sampleRate, this.channels, this.frames);
  }
}

/** Deterministic test signal: 220 Hz sine, right channel phase-shifted. */
export function sineFrameGen(hz = 220, sampleRate = 44100) {
  return (i, ch, t) => (ch === 0 ? Math.sin(2 * Math.PI * hz * t) : Math.sin(2 * Math.PI * hz * t + Math.PI / 4));
}
