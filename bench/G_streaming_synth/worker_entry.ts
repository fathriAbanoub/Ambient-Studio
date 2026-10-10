/**
 * worker_entry.ts — runs inside a worker_threads Worker: renders a seeded
 * program to a WAV file (same path as the G children) and posts progress +
 * a summary back to the main thread. No audio crosses the boundary.
 */
import { parentPort, workerData } from "node:worker_threads";
import { BlockSynth, buildTimeline } from "./blockSynth";
import { WavFileSink } from "./sinks";

const SR = Number(process.env.BENCH_G_SAMPLE_RATE ?? 44100);

const { params, durationSec, blockFrames, out } = workerData as {
  params: Record<string, unknown>;
  durationSec: number;
  blockFrames: number;
  out: string;
};

const wallStart = performance.now();
const timeline = buildTimeline(params as never, durationSec);
const synth = new BlockSynth({ params: params as never, timeline, sampleRate: SR, blockFrames, durationSec });
const sink = new WavFileSink(out, SR);
const stats = synth.render(sink);
const wav = sink.finish();

parentPort?.postMessage({
  frames_written: stats.framesWritten,
  peak_concurrent_voices: stats.peakConcurrentVoices,
  beats: timeline.beats,
  kernel_event_count: timeline.kernelEventCount,
  sha256: wav.sha256,
  data_bytes: wav.dataBytes,
  file_size: wav.fileSize,
  wall_sec: (performance.now() - wallStart) / 1000,
  peak_rss_bytes: process.memoryUsage().rss, // threads share the address space
});
