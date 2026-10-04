# What changed since last time — the two bugs, and what this suite actually validated

Written before packaging, per the brief's CRITICAL PROCESS REQUIREMENT. Two
specific bug classes slipped through in the A–F harness; this note says
exactly how G–L avoid them, and exactly what was run, at what scale, and
what was observed — so "I tested this" is distinguishable from "I wrote code
that should work".

## Bug 1 — JIT / warm-state contamination across sequential same-process configs

**What happened last time:** category A's A2 sweep ran 6 configs sequentially
in ONE process with only a small per-config warm-up. On your hardware the
8-drone config measured *faster* than the 0-drone config — backwards from
reality — because later configs inherited warmed JIT/IC state.

**What G–L do about it:**
- **Isolation by construction.** Every G duration point, every L1 config and
  every cross-check runs in a FRESH child process (`render_entry.ts`,
  `kernel_sweep_one.ts`). There is no shared process for warm state to
  carry across.
- **Empirical verification, not just construction.** G3 re-runs sweep points
  *after all other G work* and asserts the same-seed hash is identical,
  reporting wall/RSS ratios beside the first pass. L1 spawns the 6 configs
  in both ascending and descending order — twice: isolated (per-process)
  and in the re-created original sequential pattern — and reports
  desc/asc ratios for both, judged on **batched means** (single wall clock
  over the measured horizon, A3-style) because per-call timers cost
  ~100–200 ns against 2–3 µs medians; at that ratio even isolated runs look
  order-sensitive, which the first draft of L1 measured and fixed by
  switching the primary statistic.
- L1 re-creates the original contamination pattern deliberately (asc + desc)
  so the correction is visible as a measured before/after, not an assertion.

## Bug 2 — "streaming" claims that only streamed one side

**What happened last time:** category C stopped materializing the *chunked*
output (streaming per-chunk compare + streaming hash) but the *single-pass
reference buffer* used for comparison was still fully materialized — so peak
memory scaled with duration no matter what the chunked path did, and the
O(1) claim shipped half-true.

**What G–L do about it:**
- **A complete allocation inventory** is written into `blockSynth.ts`'s
  header and it is short: six block-sized accumulator arrays, a 2-second
  delay ring (fixed, port of `createDelay(2.0)`), a 22,050-sample noise
  table, polyphony-bounded voice objects, MAX_DRONE_LAYERS fixed slots, and
  the kernel event list — which IS duration-linear but at ~0.2 KB/event
  (~3 orders of magnitude under PCM; measured and reported as the slope in
  G1's linear fit, not hidden).
- **Verification is streaming everywhere.** G3/I1a/K1 compare *hashes of
  streams*, never buffers; K's differ-metric holds one bounded float window.
  The single exception is disclosed per result: I1c's node-web-audio-api
  reference render materializes its own output buffer (bounded: ~42 MB at
  120 s; `reference_buffer_mb` in the result file). Generation and
  verification memory are reported as separate numbers.
- **Direct instrumentation, not inference:** G1 samples the RSS curve
  continuously during every render (in-process at block cadence — a
  `setInterval` sampler turned out to starve during the synchronous render
  and was caught in the first smoke run) so flatness is a measured line,
  not two endpoints.

## Additional bugs caught by the suite's own checks during development

The brief asked to self-audit before shipping; these were caught *by the
measurements*, which is the point:

1. **RSS sampler starvation.** First G smoke run recorded exactly ONE RSS
   sample per render: `render()` is synchronous and starves `setInterval`.
   Fixed by sampling inside the sink's per-block callback. (Smoke output
   showed `samples: 1`; final runs show 19–809 samples per point.)
2. **The K "broken" variant wasn't broken.** The first K run measured 6
   distinct completion orders but ZERO hash variance — because `Promise.all`
   resolves in *input* order, so the "arrival-order" summation wasn't. The
   AGA pattern is results *appended as they arrive*; once re-implemented,
   the variant produced 7 distinct hashes in 7 runs (controlled reproduction
   of the failure), while both fixed-order variants stayed byte-identical.
3. **Block-size invariance failed at long durations** (the most valuable
   catch). The 20-second smoke passed 1024-vs-4096 hash equality, but G3 at
   30 minutes FAILED. Root cause: the render loop derived per-sample time as
   `tBlock + i/sr` (block-start float + increment), so the same absolute
   sample could land 1 ulp of a second apart depending on the block
   partition — flipping event spawn indices and drum envelope sample counts
   occasionally. The fix makes the render a pure function of the absolute
   frame integer: per-frame time is `absFrame / sr`, events spawn at
   `round(t·sr)` (a block-independent quantity, deferred to the next block
   when it lands past the boundary), and every drum/voice predicate is a
   frame difference. After the fix: 1024/4096/16384-frame renders AND a
   single-block partition produce identical sha256 over 30 minutes, and the
   audit re-runs confirm hash stability regardless of sweep position. This
   bug is the reason the G3 invariance test runs at 30 minutes, not seconds.
4. **D5 falsy-zero.** `!EVENT_TYPE_PRIORITY["kick"]` rejected every kick
   event because kick's priority is 0 — the first smoke render threw on a
   legitimate event; fixed to an `undefined` check.
5. **Per-call timer overhead contaminating L1.** Isolated configs still
   showed 60%+ desc/asc swings on 2–3 µs medians; the batched-mean
   statistic (two orders of magnitude less overhead) was added as primary.

## What was actually validated, at what scale

Validated in THIS sandbox (2 vCPU, ~4 GB RAM, Node v24.21.0, ffmpeg 7.1.5)
before packaging — `bench/results/*.json` timestamps are the run record, and
**37 assertions across 11 result files pass, 0 fail**:

- **G1/G2 at real scale:** full duration sweep **5 min / 30 min / 2 h /
  4 h of continuous audio** (48× span, 4 points), each a fresh child process
  streaming to WAV: peak RSS 86 MB → 97.9 → 123.6 → 173.6 MB while the PCM16
  data alone for those durations would be 106 MB → 635 MB → 2.5 GB → 5.1 GB.
  Linear fit: **0.38 MB per audio-minute = 3.8% of the PCM16 rate** (the
  chunked C path measured ~75 MB/min). Throughput 32.7–37.6× realtime,
  flat across durations. Plus the automation-heavy 30-min point (4 drone
  layers, 25.2× realtime, RSS 114.3 MB). *Sandbox ceiling note: this
  environment kills background processes and caps single invocations at
  ~10 minutes, so the 8-hour point (≈14 min wall at 37×) could not be run
  in one piece here — the sweep was capped at 4 h; the 8-hour point runs
  unchanged on your hardware with the same command.*
- **G3:** two fresh-process 30-min renders byte-identical
  (`f5dee7b94c8930cf…`); 1024/4096/16384-frame renders AND a single-block
  partition identical to them; two order-reversal audit re-runs hash-stable
  (wall ratios 1.008/0.963, RSS ratios 0.953/1.090 — no order effects beyond
  noise, matching the isolation-by-construction argument).
- **H:** 15-min render inside a worker_threads Worker: main-thread event-loop
  lag **median 0.12 ms during the render vs 0.16 ms baseline** (p95 0.21 vs
  1.16 ms, max 0.90 vs 1.17 ms — the render did not degrade the main thread
  at all on this box; every ratio < 1.0); worker throughput 37.2× realtime;
  cross-topology assertion: the worker's output is byte-identical to a fresh
  child process's.
- **I at real scale:** the C-graph at 30 min through 1024/4096/16384-frame
  and single-block partitions — all hash-identical; the broken variant
  re-introduces divergence (sampled max|Δ| 1.42 / 1.26 / 0.78 at 1024/8192/
  65536-frame re-anchor intervals — scaling with re-anchoring frequency as
  predicted); cross-engine vs node-web-audio-api single-pass at 120 s:
  max|Δ| 0.268, rms 0.071 (measured, not asserted — same magnitude class as
  C's within-engine 2.8e-1, which is itself informative: Web Audio node
  internals are not sample-pinned, so ANY alternative engine faces this
  delta; the in-process design's point is that it has no INTERNAL
  divergence mechanism at all).
- **J:** 5 min / 30 min / 2 h through both handoffs, hash-identical PCM
  across modes at every point. Measured trade-off on this 2-vCPU box:
  stdin-pipe wins disk decisively (2 h: 0.15 GB vs 1.43 GB peak work dir)
  but **lost wall clock at 2 h** (472 s vs 370 s) — the AAC encoder
  throttles the pipe while the WAV path pipelines two processes. The pipe
  child's own peak RSS stayed bounded (177.8 MB at 2 h — no backpressure
  ballooning). Both findings are data, not defects.
- **K:** 7 runs × 3 variants: both fixed-order variants byte-identical
  across runs AND to each other; arrival-order summation produced **7
  distinct hashes in 7 runs** (AGA failure mode reproduced under control);
  magnitude: 53.7% of float samples differ, max|Δ| 3.6e-7, but only 0.086%
  of PCM16 words differ — the reordering damage is inaudible per-sample yet
  breaks the byte-identity contract, which is why the hash is the contract.
- **L:** 6 configs × 2 isolated spawn orders + the contaminated pattern in
  both orders, judged on batched means (4–8 µs/call, consistent with A3's
  kernel numbers): contaminated pattern max desc/asc deviation 137.8%
  (d8_b16 ratio 2.378) vs isolated 71.6% on the same sandbox — the isolated
  residual is this box's run-to-run noise, the contaminated excess is order
  sensitivity. The old A2 JSON on your hardware is neither re-claimed nor
  altered.

The one thing this sandbox could not do: the single 8-hour render (tool-call
ceiling, not a code limit) — everything else, including 4 hours of
continuous streaming and 30-minute determinism/invariance renders, ran here
for real. What your hardware adds is absolute throughput on different
silicon plus the 8-hour point itself.

## Validation claims to run yourself

```bash
cd ui && npm install && npm i -D esbuild node-web-audio-api
npm run bench -- --categories G,H,I,J,K,L          # full scale (hours)
npm run bench -- --categories G,H,I,J,K,L --scale 0.1   # scaled pass
node bench/.build/smoke_synth.cjs                  # core self-check (see README)
```
