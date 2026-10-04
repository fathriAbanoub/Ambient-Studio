// test/run_all.mjs — build + run every check in order. Exits non-zero on any failure.
import { execSync, spawnSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, env = {}) => {
  console.log(`\n=== ${cmd} ===`);
  const r = spawnSync(cmd, { shell: "/bin/sh", stdio: "inherit", cwd: root, env: { ...process.env, ...env } });
  return r.status === 0;
};

const bundles = ["test/smoke.ts:build/smoke.cjs", "test/phase2.ts:build/phase2.cjs", "test/phase3.ts:build/phase3.cjs", "test/phase4.ts:build/phase4.cjs", "test/phase5.ts:build/phase5.cjs", "test/phase5_ref.ts:build/phase5_ref.cjs", "test/phase6_e2e.ts:build/phase6_e2e.cjs", "test/phase2b_extra.ts:build/phase2b_extra.cjs", "test/round2_extra.ts:build/round2_extra.cjs"];
for (const b of bundles) {
  const [entry, out] = b.split(":");
  execSync(`npx esbuild ${entry} --bundle --platform=node --format=cjs --target=node20 --outfile=${out} --log-level=silent`, { cwd: root, stdio: "inherit" });
}

let ok = true;
ok &&= run("node scripts/check_shared_kernel.mjs");
ok &&= run("node scripts/typecheck.mjs");
ok &&= run("node scripts/build.mjs");
ok &&= run("node build/smoke.cjs");
ok &&= run("node build/phase2.cjs", { AMBIENTD_DATA: "/tmp/ambientd-test2" });
ok &&= run("node build/phase3.cjs");
ok &&= run("node build/phase4.cjs", { AMBIENTD_DATA: "/tmp/ambientd-p4" });
ok &&= run("node build/phase5.cjs");
ok &&= run("node build/phase6_e2e.cjs");
ok &&= run("node build/phase2b_extra.cjs");
ok &&= run("node build/round2_extra.cjs", { AMBIENTD_DATA: "/tmp/ambientd-round2" });
console.log(ok ? "\nALL SUITES PASS" : "\nSUITE FAILURES PRESENT");
process.exit(ok ? 0 : 1);
