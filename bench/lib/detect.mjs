/**
 * bench/lib/detect.mjs — tool and package detection (Hard Rules 6 & 9).
 * The harness never installs anything; it reports exactly what is missing
 * and the command to install it, then skips only the affected benchmarks.
 */
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FRONTEND = path.join(ROOT, "ui");

export { ROOT, FRONTEND };

/** Resolve a package from the ui workspace's node_modules. */
export function resolveFromFrontend(pkg) {
  try {
    const req = createRequire(path.join(FRONTEND, "package.json"));
    return { ok: true, path: req.resolve(pkg) };
  } catch {
    return { ok: false, error: `cannot resolve '${pkg}' from ui/` };
  }
}

function nodeModulesExists() {
  // npm workspaces hoist deps to the repo-root node_modules; frontend may
  // have none of its own. Accept either.
  return fs.existsSync(path.join(FRONTEND, "node_modules")) || fs.existsSync(path.join(ROOT, "node_modules"));
}

export const INSTALL_HINTS = {
  node_modules: "cd ui && npm install",
  esbuild: "cd ui && npm install (esbuild arrives transitively with vite/vitest)",
  playwright: "cd ui && npm install && npx playwright install chromium",
  node_web_audio_api: "cd ui && npm install --save-dev node-web-audio-api",
  web_audio_engine: "cd ui && npm install --save-dev web-audio-engine",
  ffmpeg: "install ffmpeg and ensure it is on PATH (https://ffmpeg.org/download.html)",
};

export async function detectTools() {
  const d = {
    root: ROOT,
    ui: FRONTEND,
    node_modules_installed: nodeModulesExists(),
    esbuild: resolveFromFrontend("esbuild"),
    typescript: resolveFromFrontend("typescript"),
    playwright: resolveFromFrontend("@playwright/test"),
    node_web_audio_api: resolveFromFrontend("node-web-audio-api"),
    web_audio_engine: resolveFromFrontend("web-audio-engine"),
  };
  d.ts_runner = d.esbuild.ok
    ? "esbuild"
    : d.typescript.ok
      ? "tsc"
      : null;
  d.ts_runner_hint = d.ts_runner ? null : INSTALL_HINTS.node_modules;
  return d;
}

export function missingList(d) {
  const missing = [];
  if (!d.node_modules_installed) missing.push(["node_modules", INSTALL_HINTS.node_modules]);
  else {
    if (!d.esbuild.ok && !d.typescript.ok) missing.push(["esbuild-or-typescript", INSTALL_HINTS.node_modules]);
    if (!d.playwright.ok) missing.push(["@playwright/test", INSTALL_HINTS.playwright]);
  }
  if (!d.node_web_audio_api.ok) missing.push(["node-web-audio-api", INSTALL_HINTS.node_web_audio_api]);
  if (!d.web_audio_engine.ok) missing.push(["web-audio-engine", INSTALL_HINTS.web_audio_engine]);
  return missing;
}
