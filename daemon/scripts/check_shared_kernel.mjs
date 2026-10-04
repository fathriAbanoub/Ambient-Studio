// scripts/check_shared_kernel.mjs — the unified-repo replacement for the old
// vendoring parity check. Since ui, daemon and bench all import ONE copy of
// the kernel at <repo>/kernel/, the whole class of "did the vendored copy
// drift" bugs is gone — this guard fails loudly if that invariant is broken:
//   1. exactly ONE copy of musicalLogic.ts / scheduling.ts exists in the repo
//   2. the ui alias (@ambient-engine/*) resolves into that directory
//   3. the daemon and bench block synths import from that directory
//   4. prints the sha256 of the kernel files (informational fingerprint)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // daemon/scripts/ → repo root
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "build", "data", "test-results", "playwright-report"]);
function findCopies(dir, name, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findCopies(path.join(dir, entry.name), name, out);
    } else if (entry.name === name) out.push(path.join(dir, entry.name));
  }
  return out;
}

const KERNEL = path.join(repo, "kernel");
for (const file of ["musicalLogic.ts", "scheduling.ts"]) {
  const copies = findCopies(repo, file);
  check(`exactly one ${file} in the repo`, copies.length === 1 && copies[0] === path.join(KERNEL, file),
    copies.map((c) => path.relative(repo, c)).join(", ") || "none found");
}

const tsconfig = fs.readFileSync(path.join(repo, "ui", "tsconfig.json"), "utf8");
check("ui tsconfig maps @ambient-engine/* to ../kernel/*", /"@ambient-engine\/\*"\s*:\s*\["\.\.\/kernel\/\*"\]/.test(tsconfig));

for (const importer of [
  path.join(repo, "daemon", "src", "blockSynth.ts"),
  path.join(repo, "bench", "G_streaming_synth", "blockSynth.ts"),
]) {
  const src = fs.readFileSync(importer, "utf8");
  check(`${path.relative(repo, importer)} imports the shared kernel`,
    /from "\.\.\/\.\.\/kernel\/musicalLogic"/.test(src));
}

for (const file of fs.readdirSync(KERNEL).filter((f) => f.endsWith(".ts"))) {
  const buf = fs.readFileSync(path.join(KERNEL, file));
  console.log(`  sha256 ${file} = ${createHash("sha256").update(buf).digest("hex").slice(0, 16)}…`);
}

if (failed) {
  console.error(`SHARED-KERNEL GUARD: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("SHARED KERNEL OK — one copy, all importers point at it");
