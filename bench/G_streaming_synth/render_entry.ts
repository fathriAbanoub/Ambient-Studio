/**
 * render_entry.ts — the whole render path in ONE child process:
 * kernel timeline → in-process block synth → streaming sink.
 *
 * Each invocation is a fresh process, so duration points cannot contaminate
 * each other's JIT/warm state (self-audit class 1 from the brief: isolation
 * by construction, verified empirically by run_G's order-reversal check).
 *
 * While rendering, an in-process sampler records {t, rss} every
 * BENCH_G_RSS_INTERVAL_MS — the continuous RSS curve G1 needs (not just a
 * peak-at-end). Output: one __BENCH_JSON__ object on stdout.
 */
import { BlockSynth, buildTimeline, type SynthSink } from "./blockSynth";
import { WavFileSink, HashSink, NullSink, FfmpegStdinSink } from "./sinks";

const RSS_INTERVAL_MS = Number(process.env.BENCH_G_RSS_INTERVAL_MS ?? 500);
const SR = Number(process.env.BENCH_G_SAMPLE_RATE ?? 44100);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

interface RssSample { t: number; rss: number }

const DEFAULT_PARAMS = {
  scale: "majorPent", rootHz: 220, bpm: 72, complexity: 0.35, mix: 0.4,
  sceneDurationBars: 32, enableScenes: true, enableHarmonicLoop: true,
  enableBeats: true, seed: 42, drumLevel: 0.5, swing: 0,
  drumStyle: "euclideanTrap", sidechainAmount: 0,
};

async function main(): Promise<void> {
  const durationSec = Number(arg("--duration"));
  const blockFrames = Number(arg("--block") ?? 4096);
  const mode = arg("--mode") ?? "hash"; // hash | wav | ffmpeg
  const out = arg("--out") ?? "/tmp/ambient/render.wav";
  const drones = Number(arg("--drones") ?? 0);
  const seed = Number(arg("--seed") ?? 42);
  const broken = hasFlag("--broken");

  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`--duration invalid: ${durationSec}`);

  const params: typeof DEFAULT_PARAMS & Record<string, unknown> = { ...DEFAULT_PARAMS, seed };
  if (drones > 0) {
    params.drone = {
      layers: Array.from({ length: drones }, (_, i) => ({
        hz: 55 + i * 8, amp: 0.15, pan: -1 + (2 * i) / Math.max(1, drones - 1), timbre: "sine",
      })),
    };
  }

  // RSS curve — sampled INSIDE the render: synth.render() is synchronous and
  // would starve a setInterval timer (measured: 1 sample per whole render).
  // Every sink callback (once per block) checks the wall clock instead.
  const rss: RssSample[] = [];
  const t0 = Date.now();
  const sampleRss = () => {
    const last = rss.length ? t0 + rss[rss.length - 1].t * 1000 : -Infinity;
    if (Date.now() - last >= RSS_INTERVAL_MS) {
      rss.push({ t: (Date.now() - t0) / 1000, rss: process.memoryUsage().rss });
    }
  };

  const wallStart = performance.now();
  const timeline = buildTimeline(params, durationSec);
  const timelineMs = performance.now() - wallStart;
  const synthStart = performance.now();
  const synth = new BlockSynth({ params, timeline, sampleRate: SR, blockFrames, durationSec, brokenReanchor: broken });

  let sink: WavFileSink | HashSink | NullSink | FfmpegStdinSink;
  let ffmpeg: { exitCode: number | null; sha256: string; peakRssBytes: number; stderr: string } | null = null;
  let wavInfo: { dataBytes: number; sha256: string; fileSize: number } | null = null;
  if (mode === "wav") {
    sink = new WavFileSink(out, SR);
  } else if (mode === "ffmpeg") {
    sink = new FfmpegStdinSink(out, SR, {
      args: ["-c:a", "aac", "-b:a", String(process.env.BENCH_J_BITRATE_K ?? 160) + "k"],
    });
  } else {
    sink = new HashSink();
  }
  // Wrap whichever sink was chosen: sample RSS at block cadence, then stream.
  const innerWrite = sink.writeBlock.bind(sink);
  const samplingSink: SynthSink = {
    writeBlock: (l, r, frames) => { sampleRss(); innerWrite(l, r, frames); },
  };

  const stats = synth.render(samplingSink);
  const renderMs = performance.now() - synthStart;

  if (sink instanceof WavFileSink) {
    wavInfo = sink.finish();
  } else if (sink instanceof FfmpegStdinSink) {
    ffmpeg = await sink.finish();
  }
  rss.push({ t: (Date.now() - t0) / 1000, rss: process.memoryUsage().rss });

  const ru = (process as NodeJS.Process & { resourceUsage?: () => { maxRSS: number } }).resourceUsage?.();
  const result = {
    mode, durationSec, blockFrames, broken, seed, drones,
    frames_written: stats.framesWritten,
    peak_concurrent_voices: stats.peakConcurrentVoices,
    skipped_sample_events: stats.skippedSampleEvents,
    drone_layers_started: stats.droneLayersStarted,
    blocks: stats.blocks,
    beats: timeline.beats,
    kernel_event_count: timeline.kernelEventCount,
    kernel_events_by_type: timeline.kernelEventsByType,
    pre_roll_sec: timeline.preRollSec,
    timeline_ms: timelineMs,
    render_ms: renderMs,
    wall_sec: (performance.now() - wallStart) / 1000,
    realtime_factor: stats.framesWritten / ((performance.now() - wallStart) / 1000) / SR,
    wav: wavInfo,
    ffmpeg,
    pcm16_sha256: (sink instanceof HashSink) ? sink.sha256()
      : (sink instanceof WavFileSink) ? wavInfo!.sha256
      : ffmpeg!.sha256,
    non_finite: (sink instanceof HashSink || sink instanceof WavFileSink || sink instanceof FfmpegStdinSink)
      ? (sink as HashSink | WavFileSink | FfmpegStdinSink).nonFinite : -1,
    peak_sample_abs: (sink instanceof HashSink || sink instanceof WavFileSink) ? (sink as HashSink | WavFileSink).peak : null,
    rss_curve: rss,
    peak_rss_bytes: ru ? ru.maxRSS * 1024 : process.memoryUsage().rss,
    rss_note: "resourceUsage().maxRSS of this child process; rss_curve is the in-process sample",
  };
  process.stdout.write("__BENCH_JSON__" + JSON.stringify(result));
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
