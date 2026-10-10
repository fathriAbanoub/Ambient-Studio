/**
 * bench/aggregate.mjs — reads every results/*.json and renders
 * bench/results/summary.md: one Markdown table per category, numbers only,
 * each table stamped with the environment it was captured on.
 * No narrative, no recommendations (Hard Rule 3 + output format 4).
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS_DIR = path.resolve(import.meta.dirname, "results");
const OUT = path.join(RESULTS_DIR, "summary.md");

const fmt = (v, digits = 2) =>
  v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))
    ? "—"
    : typeof v === "number"
      ? Number(v).toFixed(digits)
      : String(v);

const mb = (bytes) => (bytes === null || bytes === undefined ? "—" : (bytes / 1048576).toFixed(1));

// Root-cause fix for the blank summary cells (G1/G2/G3/L1/D1/D2/D3): addTrial
// persists each trial's primary statistic in `stats.median`; the raw samples
// array is never written to the result JSON. Renderers must read the stored
// statistic back — reading `trial.samples?.[0]` always rendered "—".
const med = (t, digits = 2) => fmt(t?.stats?.median, digits);

function envStamp(doc) {
  const e = doc.environment ?? {};
  return [
    `**Captured:** ${doc.timestamp}`,
    `${e.os?.platform ?? "?"}/${e.os?.arch ?? "?"} · ${e.cpu?.model ?? "?"} ×${e.cpu?.cores ?? "?"} · ${(e.total_ram_bytes / 1073741824).toFixed(1)} GB RAM · node ${e.node_version ?? "?"}`,
    `ffmpeg: ${e.ffmpeg?.version_line ?? "n/a"} · NVENC encoders: ${e.ffmpeg?.nvenc_encoders?.length ?? 0}`,
  ].join("  \n");
}

function trialRow(trial, cols) {
  return "| " + cols.map((c) => c(trial)).join(" | ") + " |";
}

function table(title, headers, rows) {
  if (!rows.length) return `### ${title}\n\n_(no runs)_\n`;
  return [
    `### ${title}`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows,
    "",
  ].join("\n");
}

function collect() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"));
      } catch (err) {
        return { benchmark_id: f, category: "?", error_parsing: String(err), timestamp: "?" };
      }
    });
}

function groupBy(docs, keyFn) {
  const map = new Map();
  for (const d of docs) {
    const k = keyFn(d);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return map;
}

function render() {
  const docs = collect();
  const lines = [
    "# Benchmark results — numbers only",
    "",
    `_Generated ${new Date().toISOString()} from ${docs.length} result files in bench/results/._`,
    "",
  ];
  const byCategory = groupBy(docs, (d) => d.category ?? "?");

  for (const [cat, sectionTitle] of [
    ["A", "A — Kernel throughput"],
    ["B", "B — Offline render (renderAmbient)"],
    ["C", "C — Chunked-render PoC (superseded by I — kept for the record)"],
    ["D", "D — ffmpeg video ladder"],
    ["E", "E — Disk and I/O"],
    ["F", "F — Node Web Audio battery"],
    ["G", "G — In-process streaming synth (kernel → block synth → sink)"],
    ["H", "H — Worker isolation / responsiveness"],
    ["I", "I — Automation state-carry (successor to C)"],
    ["J", "J — Direct-to-ffmpeg streaming"],
    ["K", "K — Concurrency/determinism stress (D2)"],
    ["L", "L — Corrected re-runs of A's claims"],
  ]) {
    const catDocs = byCategory.get(cat) ?? [];
    lines.push(`\n## ${sectionTitle}\n`);
    for (const doc of catDocs) {
      lines.push(`<details><summary><code>${doc.benchmark_id}</code> — ${doc.timestamp}</summary>\n`);
      lines.push(envStamp(doc));
      if (doc.params) lines.push(`\n**Params:** \`${JSON.stringify(doc.params).slice(0, 400)}\`\n`);
      lines.push("");
      if (doc.skipped) {
        lines.push(`> SKIPPED: ${doc.skip_reason}\n`);
        lines.push("</details>\n");
        continue;
      }
      if (doc.error_parsing) {
        lines.push(`> result file could not be parsed: ${doc.error_parsing}\n`);
        lines.push("</details>\n");
        continue;
      }
      if (doc.error) lines.push(`> RUN ERROR: ${String(doc.error).slice(0, 300)}\n`);
      for (const a of doc.assertions ?? []) {
        lines.push(`- assertion \`${a.name}\`: ${a.passed ? "PASS" : "FAIL"} — ${a.detail}`);
      }
      lines.push("");

      switch (doc.benchmark_id) {
        case "A1_kernel_throughput_8h": {
          const s = doc.stats ?? {};
          lines.push(table("per-call distribution (ms)", ["metric", "value"], [
            trialRow({ a: "median", b: fmt(s.per_call_ms?.median, 4) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "p95", b: fmt(s.per_call_ms?.p95, 4) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "min", b: fmt(s.per_call_ms?.min, 4) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "max", b: fmt(s.per_call_ms?.max, 4) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "calls", b: fmt(s.calls, 0) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "last/first quarter median ratio", b: fmt(s.last_vs_first_quarter_median_ratio, 3) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "scene-transition median ms", b: fmt(s.scene_transition_call_ms?.median, 4) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "scene-transition calls", b: fmt(s.scene_transition_calls, 0) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "wall sec (whole 8h simulation)", b: fmt(s.wall_sec, 3) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "peak RSS MB", b: mb(s.peak_rss_bytes) }, [(r) => r.a, (r) => r.b]),
          ]));
          break;
        }
        case "A2_kernel_feature_costs": {
          const rows = ((doc.stats ?? {}).configs ?? []).map((c) =>
            `| ${c.drone_layers} | ${c.sample_bank_entries} | ${fmt(c.actual_beats, 0)} | ${fmt(c.stats?.median, 4)} | ${fmt(c.stats?.p95, 4)} | ${fmt(c.events_per_beat_median, 1)} |`);
          lines.push(table("config sweep", ["drone layers", "sample bank", "beats", "median ms", "p95 ms", "events/beat"], rows));
          break;
        }
        case "A3_kernel_8h_totals": {
          const s = doc.stats ?? {};
          lines.push(table("totals", ["metric", "value"], [
            trialRow({ a: "beats", b: fmt(s.beats, 0) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "events total", b: fmt(s.events_total, 0) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "wall sec", b: fmt(s.wall_sec, 3) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "wall µs/call", b: fmt(s.wall_per_call_us, 2) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "init chain ms", b: fmt(s.init_chain_ms, 3) }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "peak RSS MB", b: mb(s.peak_rss_bytes) }, [(r) => r.a, (r) => r.b]),
          ]));
          break;
        }
        case "B1_offline_render_sweep__browser":
        case "B1_offline_render_sweep__node": {
          const rows = (doc.stats?.per_duration ?? []).map((p) =>
            `| ${fmt(p.duration_minutes)} | ${fmt(p.total_wall_ms / 1000, 1)} | ${fmt((p.scheduling_wall_ms ?? NaN) / 1000, 1)} | ${fmt((p.startRendering_wall_ms ?? NaN) / 1000, 1)} | ${mb(p.peak_heap_bytes ?? p.peak_rss_bytes)} | ${fmt(p.non_finite_samples ?? 0, 0)} | ${mb(p.wav_bytes)} | ${p.outcome ?? "?"} |`);
          lines.push(table(`sweep (${doc.params?.environment_label ?? "?"})`, ["duration min", "wall s", "scheduling s", "startRendering s", "peak heap/RSS MB", "non-finite", "wav MB", "outcome"], rows));
          const sc = doc.derived?.scaling;
          if (sc?.extrapolation_to_8h) {
            lines.push(`\n_Extrapolation to 8 h (labeled extrapolation, linear fit): wall ${fmt(sc.extrapolation_to_8h.wall_sec_8h / 60, 1)} min, peak heap/RSS ${mb(sc.extrapolation_to_8h.peak_heap_bytes_8h)}_\n`);
          }
          break;
        }
        case "C_chunked_render_poc": {
          const rows = (doc.stats?.chunked ?? []).map((r) =>
            `| ${fmt(r.chunk_sec, 0)} | ${fmt(r.chunk_count, 0)} | ${fmt(r.chunked_total_wall_sec, 2)} | ${fmt(r.single_pass_wall_sec, 2)} | ${fmt(r.overhead_pct, 1)}% | ${fmt(r.priming_wall_share_pct, 1)}% | ${r.comparison_left?.byte_identical ? "yes" : "no"} | ${r.comparison_left?.max_abs_delta?.toExponential(2)} | ${r.comparison_left?.rms_delta?.toExponential(2)} | ${mb(r.peak_rss_bytes_chunked)} |`);
          lines.push(table("chunked vs single-pass", ["chunk s", "chunks", "chunked wall s", "single wall s", "overhead %", "priming share %", "byte-identical", "max delta", "rms delta", "peak RSS MB"], rows));
          break;
        }
        case "D0_nvenc_probe": {
          lines.push(`\nNVENC available: **${doc.params?.probe?.available}**`);
          lines.push(`\n\`\`\`\n${doc.params?.probe?.command}\n${(doc.params?.probe?.output ?? "").trim()}\n\`\`\`\n`);
          break;
        }
        case "D1_static_ladder":
        case "D2_zoom_ladder":
        case "D3_loop_ladder": {
          const rows = (doc.trials ?? []).map((t) =>
            `| ${t.label} | ${med(t, 2)} | ${mb(t.extras?.output_bytes)} | ${mb(t.extras?.peak_rss_bytes)} | ${fmt(t.extras?.ffprobe?.duration_sec, 1)} | ${t.extras?.ffprobe?.avg_frame_rate ?? "—"} | ${t.extras?.skipped_within_run ? "SKIPPED: " + t.extras.skipped_within_run.slice(0, 80) : "ok"} |`);
          lines.push(table("runs", ["mode", "wall s", "out MB", "peak RSS MB", "ffprobe dur s", "fps", "status"], rows));
          lines.push(`\n_peak workdir (incl. temps): ${mb(doc.stats?.peak_workdir_bytes)} MB_\n`);
          break;
        }
        case "D4_assembly_vs_naive": {
          const rows = (doc.trials ?? []).map((t) =>
            `| ${t.label} | ${fmt(t.extras?.build_sec, 2)} | ${fmt(t.extras?.assemble_sec, 2)} | ${fmt(t.extras?.naive_sec, 2)} | ${fmt(t.extras?.speedup_ratio, 2)}× | ${t.extras?.segment_failures ?? 0} | ${fmt(t.extras?.assembled_ffprobe?.duration_sec, 1)} |`);
          lines.push(table("assembly vs naive", ["mode", "build s", "assemble s", "naive s", "speedup", "seg failures", "assembled dur s"], rows));
          break;
        }
        case "E1_wav_size_accounting": {
          const rows = (doc.trials ?? []).map((t) =>
            `| ${t.label} | ${med(t, 0)} | ${fmt(t.extras?.theoretical_bytes, 0)} | ${t.extras?.header_ok ? "ok" : "BAD"} | ${t.extras?.size_consistent ? "ok" : "BAD"} |`);
          lines.push(table("WAV size vs theory", ["duration", "on-disk bytes", "theoretical bytes", "header", "size-consistent"], rows));
          break;
        }
        case "E2_disk_throughput": {
          const b = (doc.trials ?? []).find((t) => t.label === "baseline_sequential_write");
          const e = (doc.trials ?? []).find((t) => t.label === "during_static_encode");
          lines.push(table("throughput", ["metric", "value"], [
            trialRow({ a: "baseline sequential write (Node fs)", b: `${med(b, 1)} MB/s` }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "sustained during encode (mean of deltas)", b: `${fmt(doc.stats?.sustained_encode_mb_per_sec, 1)} MB/s` }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "peak workdir during encode", b: `${mb(e?.extras?.peak_workdir_bytes)} MB` }, [(r) => r.a, (r) => r.b]),
          ]));
          break;
        }
        case "E3_pipeline_disk_peak": {
          const s = doc.stats ?? {};
          lines.push(table("pipeline disk peak", ["metric", "value"], [
            trialRow({ a: "duration", b: `${fmt(s.duration_min, 0)} min` }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "WAV artifact", b: `${fmt((s.wav_bytes ?? 0) / 1073741824, 2)} GB` }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "segments total", b: `${fmt((s.segments_total_bytes ?? 0) / 1073741824, 2)} GB` }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "final MP4", b: `${fmt((s.mp4_bytes ?? 0) / 1073741824, 2)} GB` }, [(r) => r.a, (r) => r.b]),
            trialRow({ a: "PEAK simultaneous", b: `${fmt((s.peak_workdir_bytes ?? 0) / 1073741824, 2)} GB` }, [(r) => r.a, (r) => r.b]),
          ]));
          break;
        }
        case "F_node_webaudio_battery": {
          for (const [impl, rows] of Object.entries(doc.stats?.by_implementation ?? {})) {
            const trs = rows.map((r) =>
              `| ${r.graph} | ${r.pass ? "PASS" : "FAIL"} | ${r.checks?.nonfinite_zero === false ? r.non_finite : 0} | ${fmt(r.rms, 4)} | ${fmt(r.peak, 3)} | ${r.checks?.feedback_tail_present === undefined ? "—" : r.checks.feedback_tail_present ? "yes" : "NO"} | ${fmt(r.realtime_factor, 1)}× |`);
            lines.push(table(impl, ["graph", "pass", "non-finite", "rms", "peak", "feedback tail", "realtime×"], trs));
          }
          break;
        }
        case "G1_rss_duration_sweep": {
          const rows = (doc.trials ?? []).map((t) => {
            const cs = t.extras?.rss_curve_stats;
            return `| ${t.label} | ${fmt(t.extras?.frames_written, 0)} | ${fmt(t.extras?.kernel_event_count, 0)} | ${mb(t.stats?.median)} | ${mb(cs?.min_rss)} | ${mb(cs?.max_rss)} | ${cs?.drift_bytes_per_wall_sec !== null && cs?.drift_bytes_per_wall_sec !== undefined ? (cs.drift_bytes_per_wall_sec / 1024).toFixed(1) : "—"} | ${fmt(t.extras?.realtime_factor, 1)}× | ${t.extras?.non_finite} |`;
          });
          lines.push(table("RSS over render time (generation; verification is streaming)", ["point", "frames", "kernel events", "peak RSS MB", "curve min MB", "curve max MB", "drift KB/wall-s", "realtime×", "non-finite"], rows));
          const d = doc.derived ?? {};
          if (d.peak_rss_slope_bytes_per_audio_minute !== undefined) {
            lines.push(`\n_peak RSS vs duration slope: ${mb(d.peak_rss_slope_bytes_per_audio_minute)} MB per audio-minute · PCM16 stereo alone would be ${mb(d.pcm16_bytes_per_audio_minute)} MB/min (slope = ${(Number(d.slope_as_pcm_fraction) * 100).toFixed(2)}% of the PCM rate)_\n`);
          }
          break;
        }
        case "G2_realtime_throughput": {
          const rows = (doc.trials ?? []).map((t) =>
            `| ${t.label} | ${fmt(t.extras?.wall_sec, 1)} | ${fmt(t.extras?.timeline_ms, 0)} | ${fmt(t.extras?.render_ms, 0)} | ${med(t, 1)}× |`);
          lines.push(table("throughput", ["point", "wall s", "timeline ms", "render ms", "realtime×"], rows));
          break;
        }
        case "G3_determinism_and_invariance": {
          const rows = (doc.trials ?? []).map((t) =>
            `| ${t.label} | ${String(t.extras?.sha256 ?? "").slice(0, 16)} | ${med(t, 1)} | ${mb(t.extras?.peak_rss_bytes)} | ${fmt(t.extras?.realtime_factor, 1)}× |`);
          lines.push(table("runs (determinism / block sizes / audit re-runs)", ["run", "pcm16 sha256", "wall s", "peak RSS MB", "realtime×"], rows));
          break;
        }
        case "H1_mainthread_responsiveness": {
          const b = doc.stats?.baseline ?? {};
          const d = doc.stats?.during_render ?? {};
          const r = doc.stats?.ratios ?? {};
          const w = doc.stats?.worker ?? {};
          lines.push(table("event-loop lag (ms)", ["window", "n", "mean", "median", "p95", "max"], [
            trialRow({ a: "baseline (no render)", b: `${fmt(b.n, 0)} / ${fmt(b.mean, 2)} / ${fmt(b.median, 2)} / ${fmt(b.p95, 2)} / ${fmt(b.max, 2)}` }, [(x) => x.a, (x) => x.b]),
            trialRow({ a: "during worker render", b: `${fmt(d.n, 0)} / ${fmt(d.mean, 2)} / ${fmt(d.median, 2)} / ${fmt(d.p95, 2)} / ${fmt(d.max, 2)}` }, [(x) => x.a, (x) => x.b]),
            trialRow({ a: "ratio during/baseline (median/p95/max)", b: `${fmt(r.median, 2)} / ${fmt(r.p95, 2)} / ${fmt(r.max, 2)}` }, [(x) => x.a, (x) => x.b]),
          ]));
          lines.push(`\n_worker: ${fmt(w.frames_written, 0)} frames, wall ${fmt(w.wall_sec, 1)} s, ${(fmt(w.frames_written, 0) === "—" ? "—" : (w.frames_written / w.wall_sec / 44100).toFixed(1))}× realtime_\n`);
          break;
        }
        case "I1_automation_state_carry": {
          const hh = doc.derived?.healthy_hashes ?? {};
          const bh = doc.derived?.broken_hashes ?? {};
          lines.push(table("I1a healthy partitions (streaming sha256)", ["partition", "hash"],
            Object.entries(hh).map(([k, v]) => trialRow({ a: k, b: String(v).slice(0, 16) + "…" }, [(x) => x.a, (x) => x.b]))));
          lines.push(table("I1b broken variant (re-anchored)", ["block frames", "hash"],
            Object.entries(bh).map(([k, v]) => trialRow({ a: k, b: String(v).slice(0, 16) + "…" }, [(x) => x.a, (x) => x.b]))));
          const g = doc.stats?.broken_growth_max_delta_sampled ?? {};
          if (Object.keys(g).length) {
            lines.push(table("I1b sampled max|Δ| vs healthy", ["block frames", "max|Δ|"],
              Object.entries(g).map(([k, v]) => trialRow({ a: k, b: typeof v === "number" ? v.toExponential(2) : String(v) }, [(x) => x.a, (x) => x.b]))));
          }
          const w = doc.stats?.webaudio ?? {};
          if (w.available) {
            lines.push(table("I1c cross-engine vs node-web-audio-api (single-pass)", ["metric", "value"], [
              trialRow({ a: "duration", b: `${fmt(w.duration_sec, 0)} s` }, [(x) => x.a, (x) => x.b]),
              trialRow({ a: "max abs delta", b: w.max_abs_delta?.toExponential?.(3) ?? "—" }, [(x) => x.a, (x) => x.b]),
              trialRow({ a: "rms delta", b: w.rms_delta?.toExponential?.(3) ?? "—" }, [(x) => x.a, (x) => x.b]),
              trialRow({ a: "byte identical (not expected)", b: String(w.byte_identical) }, [(x) => x.a, (x) => x.b]),
              trialRow({ a: "reference buffer materialized", b: `${fmt(w.reference_buffer_mb, 0)} MB (disclosed)` }, [(x) => x.a, (x) => x.b]),
            ]));
          } else {
            lines.push(`\n_I1c SKIPPED: node-web-audio-api unavailable (${String(w.reason ?? "").slice(0, 120)})_\n`);
          }
          break;
        }
        case "J1_wav_vs_ffmpeg_stdin": {
          const rows = (doc.trials ?? []).map((t) =>
            `| ${t.label} | ${fmt(t.extras?.synth_wall_sec, 1)} | ${fmt(t.extras?.encode_wall_sec, 1)} | ${med(t, 1)} | ${mb(t.extras?.ffmpeg_peak_rss_bytes)} | ${mb(t.extras?.peak_workdir_bytes)} | ${mb(t.extras?.output_bytes)} | ${t.extras?.ffmpeg_exit} |`);
          lines.push(table("handoff comparison", ["point/mode", "synth s", "encode s", "total s", "ffmpeg RSS MB", "peak workdir MB", "out MB", "exit"], rows));
          break;
        }
        case "K1_summation_order_determinism": {
          const dh = doc.stats?.distinct_hashes_per_variant ?? {};
          const mag = doc.stats?.completion_vs_fixed_magnitude ?? {};
          lines.push(table("variants", ["variant", "distinct hashes / runs", "verdict"], [
            trialRow({ a: "sync_fixed", b: `${dh.sync_fixed} / 7` }, [(x) => x.a, (x) => x.b]),
            trialRow({ a: "async_fixed_order", b: `${dh.async_fixed_order} / 7` }, [(x) => x.a, (x) => x.b]),
            trialRow({ a: "async_completion (AGA pattern)", b: `${dh.async_completion} / 7` }, [(x) => x.a, (x) => x.b]),
          ]));
          if (mag.float_differ_fraction !== undefined) {
            lines.push(`\n_completion vs fixed: ${(mag.float_differ_fraction * 100).toFixed(2)}% of float samples differ, max|Δ| ${mag.max_abs_delta_float?.toExponential?.(2)}, ${(mag.pcm16_differ_fraction * 100).toFixed(4)}% of PCM16 words differ (${doc.stats?.differ_fraction_attempts} attempt(s))_\n`);
          }
          break;
        }
        case "L1_kernel_sweep_isolated": {
          const rows = (doc.stats?.rows ?? []).map((r) =>
            `| ${r.drones} | ${r.bank} | ${fmt(r.isolated_median_asc, 4)} | ${fmt(r.isolated_median_desc, 4)} | ${fmt(r.isolated_batched_asc_desc_ratio, 3)} | ${fmt(r.contaminated_median_asc, 4)} | ${fmt(r.contaminated_median_desc, 4)} | ${fmt(r.contaminated_batched_asc_desc_ratio, 3)} | ${fmt(r.events_per_beat, 1)} |`);
          lines.push(table("kernel config sweep: isolated (one process per config) vs contaminated (one process for all)", ["drones", "bank", "iso median asc ms", "iso median desc ms", "iso desc/asc", "contam median asc ms", "contam median desc ms", "contam desc/asc", "events/beat"], rows));
          break;
        }
        default:
          lines.push(`_(no table configured for ${doc.benchmark_id} — raw JSON available)_\n`);
      }
      if (doc.observations?.length) {
        lines.push(`\n**Observations (clearly separated from numbers):**\n`);
        for (const o of doc.observations) lines.push(`> ${o}\n`);
      }
      lines.push("</details>\n");
    }
    if (catDocs.length === 0) lines.push("_(no result files)_\n");
  }
  return lines.join("\n");
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(OUT, render());
console.log(`summary written → ${OUT}`);
