#!/usr/bin/env node
/** Driver for impulse_probe_harness.ts. */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const globalRequire = createRequire("/home/z/.npm-global/lib/node_modules/noop.js");
const { chromium } = globalRequire("playwright");

const bundle = path.join(root, "test", "round2", "impulse_probe_bundle.iife.js");
execSync(
  `npx esbuild ${path.join(here, "impulse_probe_harness.ts")} --bundle --platform=browser --format=iife --target=chrome120 --outfile=${bundle} --log-level=warning`,
  { cwd: root, stdio: "inherit" },
);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.addScriptTag({ content: fs.readFileSync(bundle, "utf8") });
const res = await page.evaluate(() => window.__impulse());
await browser.close();
console.log("(a) delay only, no cycle:");
for (const l of res.a) console.log("   ", l);
console.log("(b) delay + fb(0.4) cycle — expect echoes at 0.46s steps, gains 1,0.4,0.16,…:");
for (const l of res.b) console.log("   ", l);
console.log("(c) full drone chain with delay network:");
for (const l of res.c) console.log("   ", l);
fs.writeFileSync(path.join(root, "test", "round2", "impulse_probe_result.json"), JSON.stringify(res, null, 2));
