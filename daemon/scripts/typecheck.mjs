// scripts/typecheck.mjs — strict tsc over src/ + test/.
// Exactly ONE exception is tolerated, and it is documented:
//   src/sinks.ts(116,71) — benchmark-PoC WavFileSink.finish() declares
//   {dataBytes, sha256} but also returns fileSize. The PoC is reused as-is
//   (byte-parity enforced by scripts/check_kernel_parity.mjs) and compiled
//   with strict:false by the bench itself. Runtime is unaffected.
import { execSync } from "node:child_process";

const ALLOWED = [/^src\/sinks\.ts\(116,\d+\): error TS2353/];

let out = "";
try {
  out = execSync("npx tsc -p .", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  out = String(e.stdout ?? "") + String(e.stderr ?? "");
}
const lines = out.split("\n").filter((l) => l.startsWith("src/") || l.startsWith("test/"));
const unexpected = lines.filter((l) => !ALLOWED.some((re) => re.test(l)));
if (unexpected.length) {
  console.error("TYPECHECK FAILED:");
  for (const l of unexpected) console.error("  " + l);
  process.exit(1);
}
console.log(`typecheck OK (${lines.length} documented PoC exception${lines.length === 1 ? "" : "s"})`);
