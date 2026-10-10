/**
 * ref_render.ts — ambientd-side reference render for the round-2 diff: the
 * RAW BlockSynth → WavFileSink path (no cadence snap, no fade, no daemon),
 * identical recipe/duration to scripts/browser_ref.mjs's browser render.
 * This is reference (b) [before the fix] and (c) [after].
 *
 * Usage (bundled): node build/ref_render.cjs <recipe.json> <durationSec> <outWav>
 */
import { readFileSync, statSync } from "node:fs";
import { buildTimeline, BlockSynth } from "../src/blockSynth";
import { WavFileSink } from "../src/sinks";

const [recipePath, durArg, outWav] = process.argv.slice(2);
if (!recipePath || !durArg || !outWav) {
  console.error("usage: ref_render <recipe.json> <durationSec> <outWav>");
  process.exit(2);
}
// round2: main() wrapper — render() is async (sink backpressure) and this
// file bundles to CJS, which has no top-level await.
async function main(): Promise<void> {
  const SR = 44100;
  const params = JSON.parse(readFileSync(recipePath, "utf8"));
  const durationSec = Number(durArg);

  const timeline = buildTimeline(params, durationSec);
  const synth = new BlockSynth({ params, timeline, sampleRate: SR, blockFrames: 4096, durationSec });
  const sink = new WavFileSink(outWav, SR);
  const stats = await synth.render(sink);
  const fin = sink.finish();
  console.log(JSON.stringify({
    outWav,
    bytes: statSync(outWav).size,
    sha256: fin.sha256,
    frames: stats.framesWritten,
    peakAbs: sink.peak,
    nonFinite: sink.nonFinite,
    droneLayersStarted: stats.droneLayersStarted,
    kernelEvents: timeline.kernelEventCount,
    kernelEventsByType: timeline.kernelEventsByType,
  }));
  if (sink.nonFinite > 0) process.exit(1);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
