/**
 * bench/lib/tsrun.mjs — TypeScript execution strategy for benchmarks that
 * import the real, unmodified engine sources.
 *
 * Priority (working discipline: installed dependency > new install):
 *   1. esbuild JS API (transitive dep of vite/vitest in frontend/) — bundle
 *      the entry to a self-contained CJS file, then run it with node.
 *   2. tsc API (direct devDependency) — emit CommonJS, then run.
 * If neither exists, returns null and the caller SKIPPEDs with the hint
 * printed by detect.mjs (Hard Rule 9: never install silently).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveFromFrontend, ROOT } from "./detect.mjs";

async function bundleWithEsbuild(entry, outfile) {
  const resolved = resolveFromFrontend("esbuild");
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const esbuild = await import(pathToFileURL(resolved.path).href);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    sourcemap: false,
    logLevel: "silent",
    target: ["node18"],
  });
  return { ok: true, outfile };
}

async function compileWithTsc(entry, outDir) {
  const resolved = resolveFromFrontend("typescript");
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const ts = await import(pathToFileURL(resolved.path).href);
  // Explicit rootDir pins the emitted tree to ROOT-relative paths, so the
  // entry's emitted location is deterministic (bench/A/x.ts →
  // outDir/bench/A/x.js) and relative imports resolve inside the outDir.
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    rootDir: ROOT,
    outDir,
  });
  const emit = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  // The engine compiles clean under the repo's own tsconfig; here we surface
  // real errors but tolerate cosmetic ones unrelated to emit.
  const emitted = fs.existsSync(outDir) && fs.readdirSync(outDir, { recursive: true }).some((f) => String(f).endsWith(".js"));
  if (!emitted) {
    const msg = errors.slice(0, 5).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
    return { ok: false, error: msg || "tsc emitted nothing" };
  }
  const outfile = path.join(outDir, path.relative(ROOT, entry).replace(/\.ts$/, ".js"));
  if (!fs.existsSync(outfile)) {
    return { ok: false, error: `tsc emitted but entry artifact missing at ${outfile}` };
  }
  return { ok: true, outfile };
}

/**
 * Bundle a TS entry to CJS and return the runnable artifact path.
 * @returns {Promise<{ok:true, outfile:string, runner:'esbuild'|'tsc'}|{ok:false, error:string, runner:string|null}>}
 */
export async function buildTsEntry(entry, buildDir, tag) {
  fs.mkdirSync(buildDir, { recursive: true });
  const outfile = path.join(buildDir, `${tag}.cjs`);
  const esbuildRes = await bundleWithEsbuild(entry, outfile);
  if (esbuildRes.ok) return { ok: true, outfile, runner: "esbuild" };

  const outDir = path.join(buildDir, `${tag}_tsc`);
  const tscRes = await compileWithTsc(entry, outDir);
  if (tscRes.ok) return { ok: true, outfile: tscRes.outfile, runner: "tsc" };

  return {
    ok: false,
    runner: null,
    error: `esbuild: ${esbuildRes.error}; tsc: ${tscRes.error}`,
  };
}

/** Spawn node on a built artifact with args; resolves {code, stdout, stderr}. */
export function runNode(outfile, args, { timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err?.message || err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
