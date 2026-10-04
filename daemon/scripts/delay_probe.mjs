#!/usr/bin/env node
/** Driver for delay_probe_harness.ts — measures Web Audio's actual
 * DelayNode feedback-cycle transfer at 110 Hz and compares it with the
 * code-faithful model (1/(1-fb*e^{-j*2*pi*110*delay})) and the
 * +128-sample-cycle variant. */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const globalRequire = createRequire("/home/z/.npm-global/lib/node_modules/noop.js");
const { chromium } = globalRequire("playwright");

const bundle = path.join(root, "test", "round2", "delay_probe_bundle.iife.js");
execSync(
  `npx esbuild ${path.join(here, "delay_probe_harness.ts")} --bundle --platform=browser --format=iife --target=chrome120 --outfile=${bundle} --log-level=warning`,
  { cwd: root, stdio: "inherit" },
);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.addScriptTag({ content: fs.readFileSync(bundle, "utf8") });
const res = await page.evaluate(async () => ({
  loop: await window.__delayProbe.loop(),
  full: await window.__delayProbe.full(),
  dry: await window.__delayProbe.dry(),
  gainOnly: await window.__delayProbe.gainOnly(),
}));
await browser.close();

// left channel is enough (pan 0 makes L == R)
const amp = (o) => o.L.amp;
const ph = (o) => o.L.phase;
console.log("browser measured (110 Hz, left channel):");
console.log(`  gainOnly       amp=${amp(res.gainOnly).toFixed(6)} phase=${ph(res.gainOnly).toFixed(4)} peak=${res.gainOnly.peak.toFixed(6)}`);
console.log(`  loop_only      amp=${amp(res.loop).toFixed(6)} phase=${ph(res.loop).toFixed(4)} peak=${res.loop.peak.toFixed(6)}`);
console.log(`  full_chain     amp=${amp(res.full).toFixed(6)} phase=${ph(res.full).toFixed(4)} peak=${res.full.peak.toFixed(6)}`);
console.log(`  dry (no delay) amp=${amp(res.dry).toFixed(6)} phase=${ph(res.dry).toFixed(4)} peak=${res.dry.peak.toFixed(6)}`);

// model comparison at 110 Hz, delay 0.46 s, fb 0.4
const SR = 44100, f = 110, DEL = 0.46, FB = 0.4;
const th = (extra) => 2 * Math.PI * f * (DEL + extra / SR);
const model = (extraSamples) => {
  const t = th(extraSamples);
  const den = { re: 1 - FB * Math.cos(t), im: FB * Math.sin(t) };
  const m = Math.hypot(den.re, den.im);
  return { amp: 1 / m, phase: -Math.atan2(den.im, den.re) };
};
console.log("model 1/(1-fb*e^{-jθ}) normalized to dry:");
const dry = { amp: amp(res.dry), phase: ph(res.dry) };
for (const extra of [0, 128]) {
  const m = model(extra);
  console.log(`  extra=${extra} samples: amp/dry=${m.amp.toFixed(4)} phase=${m.phase.toFixed(4)} → predicted full amp=${(m.amp * dry.amp).toFixed(6)}`);
}
console.log(`  measured full/dry = ${(amp(res.full) / dry.amp).toFixed(4)} phase=${(ph(res.full) - dry.phase).toFixed(4)}`);
fs.writeFileSync(path.join(root, "test", "round2", "delay_probe_result.json"), JSON.stringify(res, null, 2));
