# Ambient Studio Benchmark Harness

Replaces every open architectural estimate with a number measured on **your**
machine. Numbers only — interpretation happens after you have results.

```bash
# one-time
cd ui && npm install && npx playwright install chromium   # playwright is optional
npm install --save-dev node-web-audio-api                       # optional (categories C, F, B-node)

# run everything with sane defaults (no 8-hour runs, ~30–75 min total)
npm run bench

# smoke-test the harness itself first (~2–5 min)
npm run bench -- --scale 0.2

# run one category
npm run bench -- --categories D

# opt into long cases
npm run bench -- --long-2h      # one 2-hour case per category
npm run bench -- --long-8h      # the 8-hour cases (plan hours of wall clock)
```

Every result lands in `bench/results/<benchmark_id>__<timestamp>.json`.
After any run, `npm run bench:aggregate` (also run automatically) renders
`bench/results/summary.md` — one Markdown table per category, environment
stamped, numbers only.

## Hard rules this harness obeys

- **Environment attached to every number** (OS, CPU, RAM, Node, ffmpeg
  version + nvenc encoders, GPU if detectable, exact command/params).
- **Skip, don't fail**: missing tools → `SKIPPED: <reason>` + exact install
  command; nothing is ever installed for you; no NVENC → NVENC modes skip;
  insufficient disk → long runs skip with the byte estimate.
- **`--scale S`** divides durations everywhere for a smoke pass. The 8-hour
  cases are opt-in only, per category.
- **No fabricated thresholds**: assertions check real invariants only
  (byte-identity, zero non-finite samples, header/size consistency,
  ffprobe-valid outputs). Performance numbers are never asserted.
- **One schema** for every result: `{schema_version, benchmark_id, category,
  timestamp, params, environment, methodology, skipped, skip_reason,
  assertions, trials, stats, raw_samples, derived, observations}`.
  `observations` is the only place commentary may live.

## Execution environments

| Env | Used by | Ground truth? |
|---|---|---|
| headless Chromium via Playwright | B | **Yes** — what ships to users |
| Node + node-web-audio-api | B-node, C, F | No — labeled SECONDARY/EXPERIMENTAL; F exists to validate it before anything trusts it |
| plain Node (kernel only) | A | Yes — the kernel is pure TS with no audio APIs |
| ffmpeg CLI | D, E | Yes — same binary the pipeline uses |

The real engine sources (`musicalLogic.ts`, `renderAmbient.ts`) are bundled
**unmodified** from `frontend/src/lib/ambient-engine/` at bench time
(esbuild if present, else tsc). No copies, no forks.

---

## A — Kernel throughput (`node bench/A/run_A.mjs`)

Measures `getMusicalEvents()` — the one code path that must scale to 8 hours
of beats with no per-call growth. The beat loop mirrors
`renderAmbient.ts:318-404` (advance by `60 / effectiveBpm`, thread
`nextState`); init follows the exact RNG order (`createInitialState →
advanceRngPastNoiseBuffer → initializeBell → initializeSampleLane`).
Params = the repo's own defaults (`studioStore.ts:214`, seed 42, tempo 72).

- **A1** — per-call time across a full simulated **8-hour** sequence
  (~30k calls). Methodology: one pass over all beats; 30 s warm-up run
  discarded first; first 100 measured calls discarded (JIT); median/p95/min/max
  over all calls; 48 bucket medians over the horizon expose growth; per-call
  times at scene transitions (scene = 32 bars) are split out so boundary
  spikes are visible. `--scale` divides the horizon.
- **A2** — same measurement at drone layers 0/4/8 × sample bank 0/16
  entries, 2000 beats per config, warm-up per config, median/p95.
  Sample-bank entries are metadata-only (the kernel never fetches).
- **A3** — total wall + peak RSS (`resourceUsage().maxRSS`) to *generate*
  the full 8-hour beat sequence with no per-call timing overhead and no
  audio graph.

Measured cost: seconds (A runs the whole category in well under a minute).

## B — Offline render sweep (`node bench/B/run_B.mjs`)

Calls the real `renderAmbient(params, durationSeconds)` unmodified.

- **B1 (browser, ground truth)** — Playwright Chromium, durations
  1/5/15/30/60 min (×`--scale`; `--long-2h`/`--long-8h` append 120/480).
  Records phase split (scheduling vs `startRendering`) from the renderer's
  own progress callbacks, `performance.memory` peak heap (100 ms sampler),
  output frames, and WAV-encode time/size (B3) separately per point.
  Durations ascend; a renderer crash records `outcome:"error"` and stops the
  sweep preserving shorter results — that outcome is a measurement, not a
  failure. Trials: 1 per point by default (`--trials N` to repeat);
  B2 (consecutive ratios + linear fit) is computed and **labeled
  extrapolation** into `derived.scaling`.
- **B1 (Node, secondary/experimental)** — same sweep via
  node-web-audio-api, process-level RSS (includes AudioBuffer external
  memory; Chromium's heap metric does not — read them together).
- **B4** — every Node output is scanned sample-by-sample; any NaN/Infinity
  **fails the benchmark loudly** (failed assertion + error in the result
  file). Never a silent skip.

Planning: the browser sweep is the expensive part — roughly
1/30th-of-realtime×duration per point on a fast machine (measure with your
own `--scale 0.2` pass first). The 60-min default point is the worst one;
`--long-8h` is an explicit, hours-long commitment.

## C — Chunked-render PoC (`node bench/C/run_C.mjs`)

One question: can a Web-Audio-graph render be split into sequential chunks
whose output is indistinguishable from one continuous render?

The public API exposes **no way to read a DelayNode's buffer or a
BiquadFilterNode's state** — exact hand-off is impossible by construction
(recorded in the result as `web_audio_state_api_limitation`, not worked
around silently). What is measured instead is the honest approximation:
each chunk re-renders the last `C_PRIMER_SEC` (5 s) of input history and
discards it, letting delay/filter state reconverge before the seam.

Graph (smallest engine-shaped one): two oscillators → automated lowpass
(Q=1) → master gain → automated panner → destination, plus a 0.2→0.35 s
automated feedback delay (0.35). Linear automations shift exactly; one
exponential `setTargetAtTime` automation is included deliberately so
non-linear state loss is exercised.

- **C1** — per-sample comparison against the single-pass render:
  `byte_identical`, `max_abs_delta`, `rms_delta`, zero-non-finite asserted
  (loud failure). Single-pass determinism is asserted first (two renders,
  hash-equal) because chunk comparison is meaningless without it. A
  **seam-window diagnostic** (max delta within 1 s of a seam vs elsewhere)
  distinguishes seam-localized divergence from systematic offset.
- **C2** — wall-clock overhead of chunking at 60 s vs 600 s chunks
  (`--long` runs a 1-hour program so both configs have real seams; the
  default 30-min program gives the 600 s config only 2 seams). Priming's
  wall-share is reported separately. Per-chunk RSS sampled.

Requires node-web-audio-api. Default run ≈ 1 min; `--long` ≈ 3–5 min.

## D — ffmpeg video ladder (`node bench/D/run_D.mjs`)

Command shapes are ports, not inventions: libx264 `-preset veryfast -crf 23`
(`config.py`), NVENC `-preset p1 -rc vbr -cq 23 -b:v 5M`
(`video_renderer.py:100`), `-pix_fmt yuv420p`, `-movflags +faststart`,
explicit `-t` (no `-shortest`). Audio is streamed deterministic pink noise
(`anoisesrc seed=42`) so no WAV temp inflates disk numbers; E3 measures the
real-with-WAV pipeline separately. Assets: your own files win if present
(`bench/assets/bg.png`, `bg.gif`, `loop.mp4`), else busy synthetic testsrc2
stand-ins are generated deterministically.

- **D0** — NVENC probe, verbatim port of `video_renderer.py:58-80`; exact
  command + output recorded; every NVENC mode references this and self-skips.
- **D1** — static image @1fps (the repo's trick): 1/10/30/120 min sweep
  (×`--scale`), per codec. The "nearly free" claim gets its number.
- **D2** — zoom via `zoompan` on an upscaled (7680-wide) source, zoom
  1.0→1.2 (matching `ZOOM_START/END`), fps 5/10 (add 15/24 with `--full`), ×
  durations × codecs.
- **D3** — looping background, GIF **and** MP4 sources, fps 10, × durations
  × codecs.
- **D4** — build-once + stream-copy assembly (mpegts segments →
  `-f concat -c copy -bsf:a aac_adtstoasc -movflags +faststart`) vs naive
  full re-encode, per mode. Static/loop bodies encode once and are reused;
  zoom is segment-continuous (monotonic zoom cannot loop). Speedup is a
  measured ratio.
- **D5** — every ffmpeg run records peak RSS (Linux `VmHWM`; 1 s-granularity
  sampling elsewhere — documented ceiling) and the work-dir is size-sampled
  every 2 s (peak includes all intermediates). Every output is ffprobed
  (duration/fps truth).

Planning: the default sweep is dominated by D2/D4 zoom encodes — expect
~20–60 min on a 4-core laptop at default scale, more with `--full`.
`--long-8h` per mode is hours of wall clock on CPU; NVENC (if probed) is
minutes. Disk guards estimate worst-case output and skip if free space is
insufficient.

## E — Disk and I/O (`node bench/E/run_E.mjs`)

- **E1** — on-disk WAV size at each sweep duration vs the theoretical
  `44 + frames × channels × 2` (header shape mirrored from
  `audioBufferToWav`); equality is asserted. Cross-reads any B1 results'
  recorded `wav_bytes` against the same formula.
- **E2** — sustained sequential write MB/s via Node `fs` (512 MB, the app's
  own write path; no fio/dd dependency), then instantaneous disk-consumption
  MB/s sampled per second during a real static encode.
- **E3** — peak simultaneous disk usage of one full pipeline run (WAV
  artifact → 6 mpegts segment encodes → concat MP4) with 2 s dir-size
  sampling. Default 10 min; `--long-2h`/`--long-8h` measure 2 h/8 h for
  real (8 h needs ~6 GB free; the harness checks and skips otherwise).

## F — Node Web Audio battery (`node bench/F/run_F.mjs`)

Before anything trusts a Node Web Audio implementation, this exercises every
node type the real engine uses — gain/ADSR, lowpass+automated feedback
delay, DynamicsCompressor (repo's exact settings), automated StereoPanner,
BufferSource with a mulberry32 noise buffer — and asserts real invariants:
render completes, zero non-finite samples, non-silent output, feedback tail
present. Peak is recorded but NOT asserted (Q≥1 resonance legitimately
exceeds ±1.0 inside a graph). Realtime factor per graph recorded. Tests every
detected implementation (node-web-audio-api, web-audio-engine) separately.
Prior investigation reported a delay/feedback automation bug in at least one
implementation — this battery exists to catch exactly that, per primitive,
before it corrupts a timing measurement.

---

# G–L — the in-process streaming render path (Product A PoC)

These six categories build and benchmark a **real, working** proof-of-concept
of the converged architecture: kernel (`musicalLogic.ts`, unmodified)
generates the event timeline in-process → a new in-process TS block synth
(`bench/G_streaming_synth/blockSynth.ts`) synthesizes fixed-size blocks and
streams each one out immediately → worker/child isolation off the main
thread. D1–D5 are executable structure, not documentation:

- **D1** timeline sorted by (t, type-priority, insertion-order), consumed
  through one monotonic pointer; regressions throw.
- **D2** voices sum in spawn order (= D1 order); async completion can never
  influence summation order (K1 demonstrates the contrast).
- **D3** the synth owns zero randomness; the drum noise table is drawn from
  the kernel's mulberry32 stream in renderAmbient's exact order.
- **D4** every exponential automation is a per-sample carried geometric
  recurrence — never re-anchored at block boundaries (I1 proves the tests
  detect the anti-pattern).
- **D5** malformed/unknown events fail loudly at a single ingest chokepoint.

## G — In-process streaming synth (`node bench/G_streaming_synth/run_G.mjs`)

The core claim, measured. Every duration point is a **fresh child process**
(isolation by construction), rendering the real kernel's event timeline to a
streaming WAV while sampling RSS continuously in-process (sampled at block
cadence — a `setInterval` sampler starves during the synchronous render,
which the first draft measured and fixed).

- **G1** — RSS over time at 5 min / 30 min / 2 h / **8 h** (96× span) + one
  automation-heavy 30-min point (4 drone layers). Reports per-point curve
  stats + a linear fit of peak RSS vs duration. Category C's failed test,
  redone conclusively: the complete allocation inventory is documented in
  `blockSynth.ts` (block-sized accumulators, a 2 s delay ring, the noise
  table, polyphony-bounded voices, and the O(beats) event list — ~0.2 KB per
  event, ~3 orders of magnitude under PCM).
- **G2** — realtime factor at the same points (wall includes WAV write).
- **G3** — byte-identical determinism: same seed, two full 30-min runs in
  fresh processes; block-size invariance (1024/4096/16384 frames → identical
  sha256); and an order-reversal audit (sweep points re-run after all other
  G work — hash must match; wall/RSS ratios reported). Verification is
  streaming everywhere; generation and verification memory are never
  conflated.

## H — Worker isolation (`node bench/H_worker_isolation/run_H.mjs`)

The same render path runs inside a `worker_threads` Worker while the main
thread probes event-loop lag every 50 ms: a no-render baseline window, then
the full render. Reports lag distributions per window and render-vs-baseline
ratios — the quantified version of "an 8-hour render must not block request
handling". Also asserts cross-topology determinism: the worker's WAV hash
must equal a fresh child-process hash of the same seed.

## I — Automation state-carry (`node bench/I_automation_state_carry/run_I.mjs`)

The direct successor to C (C itself is neither re-run nor patched). Renders
category C's exact minimal graph through the in-process discipline:

- **I1a** — block-size invariance including a **single-block partition**:
  1024/4096/16384 frames and one block for the whole program must hash
  identically. (c_graph renders per-sample and flushes in bounded slices, so
  the single-block partition allocates no giant accumulator — partition size
  parameterizes only where boundaries fall.)
- **I1b** — broken variant: re-anchoring + block-relative coefficient quanta
  (the two mechanisms per-chunk OfflineAudioContext rendering actually
  applies) must re-introduce divergence; its magnitude scales with
  re-anchoring frequency. This proves the tests can detect the failure mode.
- **I1c** — cross-engine proximity vs node-web-audio-api's single-pass
  render of the same graph (120 s): measured max|Δ|/rms, reported never
  asserted. The reference buffer is materialized by the Web Audio API itself
  (bounded, disclosed in the result) — the one materializing verification in
  the suite.

## J — Direct-to-ffmpeg streaming (`node bench/J_ffmpeg_streaming/run_J.mjs`)

Same seeded render, two handoffs: **WAV file → ffmpeg** vs **raw s16le
piped into ffmpeg's stdin** (encode overlapping synthesis). Per point:
synth/encode/total wall, ffmpeg peak RSS (VmHWM), peak work-dir bytes (the
WAV mode's duration-proportional intermediate IS the disk claim), ffprobe
truth, and per-point assertion that both handoffs carry identical PCM bytes.

## K — Determinism stress (`node bench/K_determinism_stress/run_K.mjs`)

Controlled experiment for D2, with a deliberately-broken variant: eight
seeded layer buffers, summed (a) synchronously in index order, (b) after
jittered async execution but re-sorted to index order (the production
pattern), (c) summed in **arrival order** — the AGA failure pattern.
7 runs per variant, same seed: fixed-order variants must be byte-identical
across runs and to each other; the arrival-order variant must not be.
Methodology note: `Promise.all` resolves in **input** order (the first
draft's "broken" variant therefore measured zero divergence — the harness
had the bug the brief warned about); the real AGA pattern appends results as
they arrive and sums in arrival order. Magnitudes reported at float level
and after PCM16 quantization.

## L — Corrected re-runs (`node bench/L_corrected_reruns/run_L.mjs`)

- **L1** — A2's config sweep re-run with one fresh process **per config**,
  spawned in both ascending and descending order; the original
  sequential-in-one-process pattern is re-created in both orders as the
  "before" picture. Order sensitivity is judged on **batched means**
  (A3-style single wall clock) because per-call timers cost ~100–200 ns —
  comparable to the 2–3 µs medians themselves. The old A2 JSON (user's
  hardware) is neither re-claimed nor altered.
- **L2** — `bench/results/L2_supersession_note.md`: what C got wrong
  (memory claim half-true; divergence mechanisms) and how G/I supersede it.

## Smoke check for the synth core

`bench/G_streaming_synth/smoke_blockSynth.ts` is a runnable assert-based
self-check (frame counts, non-finite zero, block-size invariance, D5 throws,
broken-variant detectability):

```bash
node -e "require('esbuild')" 2>/dev/null || (cd ui && npm i -D esbuild)
npx esbuild bench/G_streaming_synth/smoke_blockSynth.ts --bundle --platform=node --format=cjs --outfile=bench/.build/smoke_synth.cjs && node bench/.build/smoke_synth.cjs
```

## Results & aggregation

`bench/aggregate.mjs` reads all `bench/results/*.json` and writes
`bench/results/summary.md`: one table per benchmark per category, each
stamped with its capture environment, plus `SKIPPED` rows and the contents
of `observations` (kept visually separate from tables). Numbers only.

## Files

```
bench/
  run.mjs            entry point + preflight + skip logic (A–F default; G–L via --categories)
  aggregate.mjs      results → summary.md
  selftest.mjs       assert-based checks of the suite's own libs
  lib/               env capture, detection, schema, stats, wav writer,
                     procmon (RSS/dir-size), ffmpeg helpers, TS runner
  A/ B/ C/ D/ E/ F/  one independently-runnable runner per category
  G_streaming_synth/   blockSynth.ts (the PoC core), sinks.ts, render_entry.ts,
                       worker_entry.ts, smoke_blockSynth.ts, run_G.mjs
  H_worker_isolation/  run_H.mjs (worker topology + event-loop lag)
  I_automation_state_carry/  c_graph.ts, c_webaudio.ts, i_entry.ts, run_I.mjs
  J_ffmpeg_streaming/  run_J.mjs (WAV handoff vs stdin pipe)
  K_determinism_stress/ run_K.mjs (D2 controlled experiment)
  L_corrected_reruns/  kernel_sweep_one.ts, l1_contaminated.ts, run_L.mjs
  assets/            drop bg.png / bg.gif / loop.mp4 here to bench real content
  results/           one JSON per run + summary.md (gitignored)
```

G–L run: `npm run bench -- --categories G,H,I,J,K,L` (defaults: `--scale 1`
means the full sweep including the 8-hour render — pass `--scale 0.1` for a
scaled pass; `--keep-artifacts` keeps the WAV/M4A outputs).

## Results directories — two sources, never merged

| directory | what it holds |
| --- | --- |
| `results/` | runs captured on **this machine's** current environment (each file embeds its own environment stamp + `params.scale`) |
| `results-user-hardware/` | an archived capture from a different machine (Intel i5-10300H, 4 cores, node v22, ffmpeg 6.1.1), kept verbatim including its own `summary.md` |

The two were captured on different hardware and are **not** meant to be
compared number-to-number — only each used to sanity-check the other's shape
(flat-vs-not RSS curves, roughly-consistent realtime multipliers).

`results/` is regenerated by every run; `results-user-hardware/` is never
written to by the harness.

## Category notes

- **C — chunked-render PoC**: superseded by **I** and kept for the record
  (see `L_corrected_reruns/L2_supersession_note.md` for what C got wrong and
  why the chunked path was abandoned). C is not re-run by default; the
  consolidated harness treats I1 as its replacement.
- **Per-category methodology** (what each category measures, trial counts,
  warm-up handling, outlier policy) is documented inline in each runner's
  `methodology` block — every result JSON carries it verbatim — and in the
  `Hard rules` section above. Category D accepts
  `BENCH_D_LADDERS=D1,D2,D3,D4` to run a subset of its ladders within short
  execution windows; each result records its own `params.scale`.
- **Where the consolidated repo's summary lives**: `results/summary.md`
  (regenerated after every run by `aggregate.mjs`, which reads each trial's
  stored `stats.median` — the primary statistic — back out of the result
  JSON).
