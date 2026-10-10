/**
 * bench/selftest.mjs — assert-based checks of the suite's own non-trivial
 * lib logic (working discipline: non-trivial logic leaves a small runnable
 * assert-based check, no framework). Run by the preflight and standalone:
 *   node bench/selftest.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarize, percentile, linearFit } from "./lib/stats.mjs";
import { WavPcm16Writer, wavTheoreticalBytes, verifyWavHeader, WAV_HEADER_BYTES, sineFrameGen } from "./lib/wav.mjs";

function testStats() {
  const s = summarize([3, 1, 4, 1, 5, 9, 2, 6]);
  assert.equal(s.n, 8);
  assert.equal(s.min, 1);
  assert.equal(s.max, 9);
  assert.equal(s.median, 3.5); // sorted [1,1,2,3,4,5,6,9] → (3+4)/2
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 0.5) - 2.5) < 1e-12);
  const fit = linearFit([0, 1, 2], [1, 3, 5]); // y = 2x + 1
  assert.ok(Math.abs(fit.slope - 2) < 1e-12 && Math.abs(fit.intercept - 1) < 1e-12);
}

async function testWavWriter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-selftest-"));
  const file = path.join(dir, "t.wav");
  const rate = 8000;
  const channels = 2;
  const frames = 1000;
  const expected = wavTheoreticalBytes(rate, channels, frames);
  assert.equal(expected, WAV_HEADER_BYTES + frames * channels * 2);
  const writer = new WavPcm16Writer(file, rate, channels, frames, sineFrameGen(220, rate), 300);
  const bytes = await writer.write();
  assert.equal(bytes, expected);
  const st = fs.statSync(file);
  assert.equal(st.size, expected, "on-disk WAV size must equal the theoretical calculation");
  const hdr = verifyWavHeader(file);
  assert.ok(hdr.riffOk, "RIFF/WAVE markers");
  assert.ok(hdr.sizeConsistent, "declared data chunk must equal file size − 44");
  assert.equal(hdr.channels, channels);
  assert.equal(hdr.sampleRate, rate);
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function runSelftest() {
  testStats();
  await testWavWriter();
  return true;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === import.meta.filename) {
  runSelftest()
    .then(() => {
      console.log("selftest: all assertions passed");
      process.exit(0);
    })
    .catch((err) => {
      console.error("selftest FAILED:", err);
      process.exit(1);
    });
}
