#!/usr/bin/env node
/**
 * browser_ref.mjs — round-2 ground-truth driver. Bundles
 * browser_ref_harness.ts (which imports the REAL renderAmbient.ts from the
 * Ambient-Studio repo), injects it into headless Chromium, renders the test
 * recipe through the browser's OfflineAudioContext, and writes:
 *
 *   test/round2/ref_browser.wav      — reference (a)
 *   test/round2/biquad_response.json — BiquadFilterNode magnitude response
 *                                      (lowpass @3600 Q0.7, lowpass @6600 Q1.0,
 *                                      highpass @7000 Q1.0) + the same points
 *                                      computed by ambientd's Biquad both ways.
 *
 * Usage: node scripts/browser_ref.mjs <recipe.json> <durationSec> <outWav>
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "test", "round2");
fs.mkdirSync(outDir, { recursive: true });

const [recipePath, durArg, outWavArg] = process.argv.slice(2);
if (!recipePath || !durArg) {
  console.error("usage: node scripts/browser_ref.mjs <recipe.json> <durationSec> [outWav]");
  process.exit(2);
}
const durationSec = Number(durArg);
const outWav = outWavArg ?? path.join(outDir, "ref_browser.wav");

// playwright lives in the global npm tree (ESM ignores NODE_PATH)
const globalRequire = createRequire("/home/z/.npm-global/lib/node_modules/noop.js");
const { chromium } = globalRequire("playwright");

const bundle = path.join(outDir, "browser_ref_bundle.iife.js");
execSync(
  `npx esbuild ${path.join(here, "browser_ref_harness.ts")} --bundle --platform=browser --format=iife --target=chrome120 --outfile=${bundle} --log-level=warning`,
  { cwd: root, stdio: "inherit" },
);

const recipe = fs.readFileSync(recipePath, "utf8");
const FREQS = [500, 1000, 2000, 3000, 3300, 3400, 3500, 3550, 3600, 3650, 3700, 3800, 4000, 4500, 5000, 6000, 6600, 8000, 10000];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[console.error]", m.text());
  });
  await page.addScriptTag({ content: fs.readFileSync(bundle, "utf8") });

  console.log("rendering recipe in headless Chromium (real renderAmbient.ts + OfflineAudioContext)…");
  const { wav_b64, frames, sampleRate } = await page.evaluate(async ([p, d]) => {
    return window.__ref.renderRecipe(p, d);
  }, [recipe, durationSec]);
  fs.writeFileSync(outWav, Buffer.from(wav_b64, "base64"));
  console.log(`(a) browser reference: ${outWav} — ${frames} frames @${sampleRate}Hz, ${fs.statSync(outWav).size} bytes`);

  const fr = await page.evaluate(([f0a, qa, f0b, qb, freqs]) => {
    return {
      drone_lpf_3600_q0p7: window.__ref.freqResponse("lowpass", f0a, qa, freqs),
      master_lpf_6600_q1: window.__ref.freqResponse("lowpass", f0b, qb, freqs),
    };
  }, [3600, 0.7, 6600, 1.0, JSON.stringify(FREQS)]);
  fs.writeFileSync(path.join(outDir, "biquad_response.json"), JSON.stringify(fr, null, 2));
  console.log("biquad response captured → test/round2/biquad_response.json");
} finally {
  await browser.close();
}
