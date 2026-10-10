/**
 * test/phase5_ref.ts — fresh-process reference renderer for the cross-job
 * isolation test. Prints the PCM16 sha256 of one render (fade included, same
 * as the worker path) so the daemon's worker output can be compared against a
 * render that shares NO state with the daemon process.
 * Usage: node build/phase5_ref.cjs '<json: {kernelParams, durationSec}>'
 */
import { BlockSynth, buildTimeline } from "../src/blockSynth";
import { HashSink } from "../src/sinks";
import { snapToBar, makeFadeSink } from "../src/cadence";

const SR = 44100;
const input = JSON.parse(process.argv[2] ?? "{}") as { kernelParams: any; durationSec: number };
const snap = snapToBar(input.durationSec, input.kernelParams.bpm ?? 72, SR);
const timeline = buildTimeline(input.kernelParams, snap.snappedSec);
const synth = new BlockSynth({ params: input.kernelParams, timeline, sampleRate: SR, blockFrames: 4096, durationSec: snap.snappedSec });
const sink = new HashSink();
// round2: render is async (sink backpressure); print after completion.
synth.render(makeFadeSink(sink, snap.totalFrames, 3, SR)).then(() => {
  process.stdout.write(JSON.stringify({ sha256: sink.sha256(), totalFrames: snap.totalFrames, snappedSec: snap.snappedSec }));
}).catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
