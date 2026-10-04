// scripts/build.mjs — bundle the three entry points to CJS with esbuild
// (same proven strategy as the benchmark harness's tsrun.mjs).
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: ["node20"],
  logLevel: "silent",
  sourcemap: false,
};

for (const entry of ["src/server.ts", "src/mcp.ts", "src/render_worker.ts"]) {
  const outfile = `build/${entry.split("/")[1].replace(".ts", ".cjs")}`;
  await build({ ...common, entryPoints: [entry], outfile });
  console.log("built", outfile);
}
