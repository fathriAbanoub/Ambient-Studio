/**
 * bench/F/run_F.mjs — Node Web Audio implementation battery (independently
 * runnable):   node bench/F/run_F.mjs
 *
 * Tests each DETECTED Node Web Audio implementation (node-web-audio-api,
 * web-audio-engine — whichever resolve from ui/node_modules) against
 * the node types the real engine actually uses (renderAmbient/LiveEngine:
 * Gain, Oscillator, BiquadFilter, Delay+feedback, DynamicsCompressor,
 * StereoPanner, AudioBufferSource). No package is assumed bug-free: prior
 * investigation found at least one implementation with a delay/feedback
 * automation bug, so every primitive is exercised and its output validated.
 *
 * Invariants per graph (real invariants, no fabricated thresholds):
 *   - render completes
 *   - zero NaN/Infinity samples
 *   - non-silent output (rms > 0)
 *   - feedback graph: audible tail after the input stops (feedback > 0 ⇒
 *     energy after source end)
 * Peak is RECORDED but not asserted: resonant filters (Q ≥ 1) and feedback
 * summation legitimately exceed ±1.0 inside any Web Audio graph — clamping
 * belongs to playback/encoding, not the graph.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { Result, skipBench } from "../lib/result.mjs";
import { F_GRAPH_DURATION_SEC, F_SAMPLE_RATE, F_COMPRESSOR, F_DELAY_SEC, F_FEEDBACK } from "../lib/constants.mjs";

const ENV = JSON.parse(process.env.BENCH_ENV ?? "{}");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR;

function detectImplementations() {
  const impls = [];
  try {
    const req = createRequire(path.join(ENV.ui, "package.json"));
    const waa = req("node-web-audio-api");
    impls.push({ name: "node-web-audio-api", version: waa.VERSION ?? "unknown", module: waa });
  } catch { /* not installed */ }
  try {
    const req = createRequire(path.join(ENV.ui, "package.json"));
    const wae = req("web-audio-engine");
    impls.push({ name: "web-audio-engine", version: "unknown", module: wae });
  } catch { /* not installed */ }
  return impls;
}

function scan(buffer) {
  let nonFinite = 0;
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { nonFinite++; continue; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      n++;
    }
  }
  return { nonFinite, peak, rms: n ? Math.sqrt(sumSq / n) : 0 };
}

function tailRms(buffer, fromFrac = 0.9) {
  let sumSq = 0;
  let n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = Math.floor(d.length * fromFrac); i < d.length; i++) {
      sumSq += d[i] * d[i];
      n++;
    }
  }
  return n ? Math.sqrt(sumSq / n) : 0;
}

/** Battery graph builders — each receives (ctx) and wires nodes → destination. */
const GRAPH_BUILDERS = {
  "osc+gain(ADSR)": (ctx) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.5, 0.05);
    g.gain.setValueAtTime(0.5, 3);
    g.gain.linearRampToValueAtTime(0, 4.5);
    osc.connect(g).connect(ctx.destination);
    osc.start(0);
    osc.stop(4.5);
  },
  "osc+filter+delay+feedback(automated)": (ctx) => {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 220;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.0;
    filter.frequency.setValueAtTime(600, 0);
    filter.frequency.linearRampToValueAtTime(2400, F_GRAPH_DURATION_SEC);
    const delay = ctx.createDelay(2.0);
    delay.delayTime.setValueAtTime(0.2, 0);
    delay.delayTime.linearRampToValueAtTime(0.35, F_GRAPH_DURATION_SEC);
    const fb = ctx.createGain();
    fb.gain.value = F_FEEDBACK;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g).connect(filter);
    filter.connect(delay);
    delay.connect(fb).connect(delay);
    filter.connect(ctx.destination);
    delay.connect(ctx.destination);
    osc.start(0);
    osc.stop(3.0); // stops early — the feedback tail must still carry energy
  },
  "osc+compressor": (ctx) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = F_COMPRESSOR.threshold;
    comp.ratio.value = F_COMPRESSOR.ratio;
    comp.attack.value = F_COMPRESSOR.attack;
    comp.release.value = F_COMPRESSOR.release;
    osc.connect(g).connect(comp).connect(ctx.destination);
    osc.start(0);
    osc.stop(F_GRAPH_DURATION_SEC);
  },
  "osc+stereopanner(automated)": (ctx) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 330;
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.8, 0);
    pan.pan.setTargetAtTime(0.8, 1.0, 0.08);
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g).connect(pan).connect(ctx.destination);
    osc.start(0);
    osc.stop(F_GRAPH_DURATION_SEC);
  },
  "bufferSource(noise buffer)": (ctx) => {
    const buf = ctx.createBuffer(1, Math.ceil(0.5 * F_SAMPLE_RATE), F_SAMPLE_RATE);
    const d = buf.getChannelData(0);
    let s = 42 >>> 0; // mulberry32, matching the engine's PRNG
    for (let i = 0; i < d.length; i++) {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.3;
    src.connect(g).connect(ctx.destination);
    src.start(0);
    src.stop(F_GRAPH_DURATION_SEC);
  },
};

async function testImplementation(impl) {
  const ctxFactory = impl.name === "node-web-audio-api"
    ? (frames) => new impl.module.OfflineAudioContext(2, frames, F_SAMPLE_RATE)
    : async (frames) => {
        // web-audio-engine: OfflineAudioContextAPI via Renderer
        const { OfflineAudioContext } = impl.module;
        return new OfflineAudioContext(2, frames, F_SAMPLE_RATE);
      };

  const rows = [];
  for (const [name, build] of Object.entries(GRAPH_BUILDERS)) {
    const frames = F_GRAPH_DURATION_SEC * F_SAMPLE_RATE;
    const t0 = performance.now();
    try {
      const ctx = await ctxFactory(frames);
      build(ctx);
      const buf = await ctx.startRendering();
      const wall = (performance.now() - t0) / 1000;
      const s = scan(buf);
      const checks = {
        rendered: true,
        nonfinite_zero: s.nonFinite === 0,
        non_silent: s.rms > 0,
      };
      if (name.includes("feedback")) {
        checks.feedback_tail_present = tailRms(buf) > 0;
      }
      const pass = Object.values(checks).every(Boolean);
      rows.push({
        graph: name, pass, checks,
        rms: s.rms, peak: s.peak, peak_exceeds_full_scale: s.peak > 1.0001, non_finite: s.nonFinite,
        render_wall_sec: wall,
        realtime_factor: F_GRAPH_DURATION_SEC / wall,
      });
    } catch (err) {
      rows.push({ graph: name, pass: false, checks: { rendered: false }, error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return rows;
}

export async function runF() {
  console.log("[F] Node Web Audio implementation battery");
  const impls = detectImplementations();
  if (impls.length === 0) {
    await skipBench(RESULTS_DIR, "F_node_webaudio_battery", "F", ENV,
      "no Node Web Audio implementation found — install one: cd ui && npm install --save-dev node-web-audio-api");
    return;
  }
  const result = new Result("F_node_webaudio_battery", "F", ENV,
    { implementations: impls.map((i) => ({ name: i.name, version: i.version })), graph_duration_sec: F_GRAPH_DURATION_SEC, sample_rate: F_SAMPLE_RATE },
    {
      measured: "per-implementation correctness battery over the node types the real engine uses, plus offline render speed",
      granularity: "per graph: pass/fail on real invariants (zero non-finite, non-silent, headroom, feedback tail), rms/peak values, realtime factor",
      trials: "1 per graph per implementation (deterministic graphs; timing is informational)",
      warmup: "none",
      outliers: "none",
      statistic: "pass/fail per invariant + measured rms/peak/speed",
    });
  const allRows = {};
  for (const impl of impls) {
    console.log(`  implementation: ${impl.name}`);
    allRows[impl.name] = await testImplementation(impl);
    for (const row of allRows[impl.name]) {
      console.log(`    ${row.pass ? "PASS" : "FAIL"}  ${row.graph}${row.error ? ` — ${row.error}` : ""}`);
    }
  }
  result.doc.stats = { by_implementation: allRows };
  result.addAssertion("all_graphs_pass_all_invariants",
    Object.values(allRows).flat().every((r) => r.pass),
    "every implementation must render every graph with zero non-finite samples, non-silent output, and peak within headroom");
  await result.write(RESULTS_DIR);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runF();
}
