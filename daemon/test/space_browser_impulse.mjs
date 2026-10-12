#!/usr/bin/env node
/**
 * space_browser_impulse.mjs — Space browser-parity check (Phase 1 review).
 * NOT wired into run_all: it needs a playwright-driven chromium and would
 * fail on browserless machines. Run explicitly:
 *
 *   cd daemon && node test/space_browser_impulse.mjs
 *
 * Renders a 1-sample impulse through one comb and one allpass in headless
 * Chromium's OfflineAudioContext (topology and constants exactly as the
 * shells build them — see space_browser_impulse_harness.ts), runs the same
 * impulse through the daemon's SpaceComb / SpaceAllpass ports, and asserts:
 *   - allpass output bit-exact vs the port,
 *   - comb output within one f32 ULP at tail amplitude (< 1e-6),
 *   - the comb's first echo at exactly REVERB_COMB_DELAY_SAMPLES[0].
 * Exit 0 on pass, 1 on any failure.
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(here, "..");
const buildDir = path.join(daemonRoot, "build");
fs.mkdirSync(buildDir, { recursive: true });

const pageBundle = path.join(buildDir, "space_browser_impulse_page.iife.js");
const portBundle = path.join(buildDir, "space_browser_impulse_port.cjs");
execSync(
  `npx esbuild test/space_browser_impulse_harness.ts --bundle --platform=browser --format=iife --target=chrome120 --outfile=${pageBundle} --log-level=warning`,
  { cwd: daemonRoot, stdio: "inherit" },
);
execSync(
  `npx esbuild test/space_port_entry.ts --bundle --platform=node --format=cjs --target=node20 --outfile=${portBundle} --log-level=warning`,
  { cwd: daemonRoot, stdio: "inherit" },
);

// playwright lives in the global npm tree (same driver as scripts/browser_ref.mjs)
const globalRequire = createRequire("/home/z/.npm-global/lib/node_modules/noop.js");
const { chromium } = globalRequire("playwright");
const nodeRequire = createRequire(import.meta.url);

const browser = await chromium.launch();
let pageData;
try {
  const page = await browser.newPage();
  await page.addScriptTag({ path: pageBundle });
  pageData = await page.evaluate(() => window.__spaceImpulse());
} finally {
  await browser.close();
}

const { SpaceComb, SpaceAllpass } = nodeRequire(portBundle);
const { comb, allpass, constants } = pageData;

function portSeries(Ctor, args, frames) {
  const node = new Ctor(...args);
  const y = new Array(frames).fill(0);
  for (let i = 0; i < frames; i++) {
    node.process(i === 0 ? 1 : 0, i === 0 ? 1 : 0);
    y[i] = node.yL;
  }
  return y;
}

function compare(name, browserCh, portY) {
  let maxDiff = 0;
  let firstNonzero = -1;
  for (let i = 0; i < portY.length; i++) {
    const d = Math.abs(browserCh[i] - portY[i]);
    if (d > maxDiff) maxDiff = d;
    if (firstNonzero === -1 && Math.abs(browserCh[i]) > 1e-6) firstNonzero = i;
  }
  console.log(`${name}: firstNonzero@${firstNonzero} browser=${browserCh[firstNonzero].toPrecision(8)} port=${portY[firstNonzero].toPrecision(8)} maxSampleDiff=${maxDiff.toExponential(3)}`);
  return { maxDiff, firstNonzero };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

console.log(`constants: comb D=${constants.combD} g=${constants.combG.toPrecision(8)} | allpass D=${constants.apD} g=${constants.apG} | SR=${constants.sr}`);
const combPort = portSeries(SpaceComb, [constants.combD, constants.combG], comb.l.length);
const apPort = portSeries(SpaceAllpass, [constants.apD], allpass.l.length);

const cl = compare("comb L", comb.l, combPort);
const cr = compare("comb R", comb.r, combPort);
const al = compare("allpass L", allpass.l, apPort);
const ar = compare("allpass R", allpass.r, apPort);

check("comb_first_echo_exact", cl.firstNonzero === constants.combD,
  `first echo @${cl.firstNonzero} vs D=${constants.combD}`);
check("comb_within_one_f32_ulp", cl.maxDiff < 1e-6 && cr.maxDiff < 1e-6,
  `L ${cl.maxDiff.toExponential(3)}, R ${cr.maxDiff.toExponential(3)} (1 ULP @ ~0.9 amp = 5.96e-8)`);
check("allpass_bit_exact", al.maxDiff === 0 && ar.maxDiff === 0,
  `L ${al.maxDiff}, R ${ar.maxDiff} over ${allpass.l.length} samples`);

console.log(failures === 0 ? "ALL SPACE BROWSER IMPULSE CHECKS PASS" : `${failures} SPACE BROWSER IMPULSE CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
