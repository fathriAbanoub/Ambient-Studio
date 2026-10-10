> **ROUND 2 UPDATE (2026-10-03):** signal-path divergences from the browser renderer were found and fixed — see REPORT-round2.md. blockSynth.ts / sinks.ts now intentionally diverge from the bench PoC (pinned in scripts/check_kernel_parity.mjs); the kernel remains byte-identical.

# ambientd — build & verification report

Everything below labeled **measured** was run in this sandbox (2 vCPU, 4 GB
RAM, Node v24.21.0, ffmpeg 7.1.5, Linux) and observed directly. Anything not
measured is labeled as such. Every number in this report is real.

## What was built

`/home/z/my-project/ambientd/` — a from-scratch daemon wrapping the proven
render core, per the spec's build order:

- **Daemon** (`src/server.ts`): HTTP API on 127.0.0.1:7781 (`AMBIENTD_PORT`),
  state in `AMBIENTD_DATA`. Lockfile (`daemon.lock`, O_EXCL + pid liveness)
  with the port bind as final arbiter. NVENC probed at startup (256×256 frame —
  the benchmark's D0 16×16 probe shape false-negatives even on working GPUs;
  their own result JSON shows encoders present but probe unavailable).
- **Job registry** (`src/jobs.ts`): full-UUID jobs, frozen recipe copies,
  pending queue drained by a one-at-a-time runner (`MAX_CONCURRENT = 1` const;
  raising it later re-requires the cross-job test, which is automated). Jobs
  render in a **fresh `worker_threads` Worker, terminated on completion**.
  Finalize: temp file → WAV-header/ffprobe verification → atomic rename →
  provenance sidecar. Failed/crashed renders leave no final artifacts.
- **Render worker** (`src/render_worker.ts`): kernel timeline → PoC block synth
  → sink. WAV (PoC sink), M4A (PoC AAC sink), MP3 (same PoC sink, libmp3lame
  args — the "new" MP3 sink is a codec swap at the call site, per the PoC's own
  args design), MP4 (two-input mux or 1 fps static-image fallback, one pass).
- **Cadence snap** (`src/cadence.ts`): `round(dur/barSec)` with integer
  per-bar frame math (`framesPerBar = round(barSec·sr)`, total = bars×fpb),
  clamped to ≥ 1 bar; linear outro fade (min(3 s, 10 %)) applied by a
  frame-index-pure sink wrapper.
- **Assets** (`src/assets.ts`, `src/providers.ts`): content-hashed registry
  (`sha256:<hex>` ids), one-time normalize (h264-in-mp4, −an, yuv420p,
  scale+crop only when larger or AR-mismatched — no upscaling; target 2.5 Mbps
  @1080p scaled by pixel area, clamp 0.5–2.5), search→select wiring with
  in-memory candidate cache, Pexels + Pixabay clients (429/5xx backoff,
  base-URL test seam), direct-URL ingest.
- **Video** (`src/video.ts`): the spec's loop-mux (looped cached asset,
  stream-copy, PCM16 pipe, AAC 160k, `-shortest -movflags +faststart`) plus
  deterministic generated default background for the static path.
- **MCP shim** (`src/mcp.ts`): official SDK stdio server; health-checks the
  daemon, spawns it detached if down; all 10 spec tools as thin HTTP calls.
- **Reused unchanged**: kernel (`musicalLogic.ts` + `scheduling.ts`) vendored
  byte-identical (sha256-checked by `scripts/check_kernel_parity.mjs`);
  `blockSynth.ts` + `sinks.ts` identical to the benchmark PoC modulo import
  paths (verified by the same script). D1–D5, sample-event stub, all
  determinism enforcement intact.

## What was actually run and observed

**Baseline (the PoC's own self-check, re-pointed at the vendored kernel):**
8/8 PASS — exact frames, zero non-finite, non-silent, block-size invariance
(seed-42 20 s hash `184f84f89af6a623…`), D5 throws, broken-variant detectable.

**Phase 2 — asset pipeline (18/18)** on 4 real clips, measured:
- 1080p 6 Mbps h264 (15.0 MB) → re-encoded 2.51 Mbps, **6.3 MB (42 % of source)**
- VP9/WebM → transcoded to h264-in-mp4 (1.12 Mbps)
- 800×600 4:3 → scale+crop to 1066×600 (16:9)
- already-compliant 421 kbps clip → cached byte-as-is (no re-encode), and
  re-ingest dedups to the same `sha256:` asset id
- list/get/evict verified (file deleted with entry)

**Phase 3 — MP3 + cadence (14/14)**, measured:
- snap: 200 s@72 → 60 bars exactly; 28800 s@72 → 8640 bars; 240 s@120 → 120
  bars; 3600 s@144 → 2160 bars; 1.5 s and 0.3 s@120 → clamped to 1 bar (2 s);
  100 s@71 → 30 bars = 101.408 s (nearest-bar); same inputs ⇒ identical frames
- fade: block-invariant (1024 vs 4096 identical hash), ends at silence,
  differs from unfaded
- MP3: piped PCM **byte-identical** to the reference render, decodes,
  ffprobe duration 12.04 s vs 12 s

**Phase 4 — two-input mux (14/14)** with a real normalized asset, measured:
- video stream **copied, not re-encoded**: output bitrate 2.68 Mbps = asset
  2.51 + 0.16 audio; resolution matches asset; frames continuous across loop
- duration exactly 30.000 s vs 30.000 s snapped (0.000 s overshoot, after the
  `-t` fix below); static fallback exact at 1 fps, 390 kB/17 s
- mux wall 2.2 s for 30 s of video (copy+audio-encode only)

**Phase 5 — daemon + the mandated cross-job state-isolation test (19/19)**, measured:
- jobs A (seed 42, wav) then B (seed 777, bpm 92, fourFloor, sidechain, mp3)
  submitted back-to-back to one daemon; **A's hash == fresh-process reference**
  (`c70a50abda3e8c57…`), **B's hash == fresh-process reference**
  (`f3b5d0299eefde9e…`); resubmitting A after B reproduces A byte-for-byte —
  no cross-job state bleed
- seeds: omitted seed ⇒ CSPRNG generated once, persisted; two seedless recipes
  ⇒ different seeds; a seedless recipe's output == fresh-ref of its stored
  seed only — never a function of job id or submission order
- atomic finalize: no tmp debris, WAV header size-consistency verified,
  provenance sidecar complete (seed, bars, kernel sha, commands)

**Phase 6/7 — MCP cold start + full E2E (21/21)**, observed:
- no daemon on the port → `build/mcp.cjs` cold → initialize handshake → all
  10 spec tools listed → **daemon auto-spawned** (detached, lockfile held)
- entirely via MCP tools: upload → create_recipe (mp4, seed 424242) →
  render_preview (12 s mp3 audition) → submit → status polls → job_result:
  MP4 exists, h264 stream-copied at asset resolution, AAC audio, 33.333 s =
  10 bars exactly, provenance sidecar correct (seed, kernel hash, spec mux
  command, output sha256 matches file)

**Full-scale — 4-hour continuous render through the daemon (measured)**:
- wall 481.5 s (**29.9× realtime**), 16136 beats, 149226 kernel events, peak
  13 concurrent voices
- output **2,540,160,044 bytes — byte-exact** vs `44 + frames×4`
- snapped 14400.000 s = 4320 bars exactly
- **peak RSS 210.1 MB against 2.54 GB of PCM16 data**; in-render RSS curve
  sampled every 10 s is essentially flat: 193.8 → 206.5 MB over the whole
  run (~0.26 MB per audio-minute), dropping to 86.3 MB after the worker exits
- 8 hours: **not measured** — this sandbox caps single commands at 10 min and
  reaps background processes (tested; even `setsid` is killed). By the
  measured 1 h/4 h points, expect ~870 s wall (~16 min) and ~220 MB peak —
  extrapolation, not measurement. The code path is identical; the previous
  hardware's 8-h point (G1) also remains valid for the PoC path.

**Suite**: `npm test` → 105 checks across parity/typecheck/smoke/phases — all
passing, re-run after every fix.

## Bugs caught by my own verification (the "go back and test harder" list)

1. **`-shortest` does not bound a looped stream-copy mux** (ffmpeg 7.1.5):
   30 s of audio produced a 72.467 s file — demuxed-ahead looped video packets
   keep muxing. Static path overshot too (37 s vs 16.67 s). Fixed with the
   repo's own bench-D pattern, explicit `-t` alongside `-shortest` → 0.000 s
   overshoot. Found by exactly the end-to-end test the spec ordered for this
   never-run-before path.
2. **Temp filename broke ffmpeg's muxer inference**: atomic-write temp
   `output.mp3.tmp` → "Unable to find a suitable output format" → instant
   encoder death → EPIPE. Only surfaced when a queued MP3 job ran inside the
   daemon (standalone phase-3 test used `out.mp3`). Fixed to
   `output.tmp.<ext>`; encoder stderr is now surfaced in job errors.
3. **`assetFile` out of scope in `finalize()`** — mp4 jobs failed at finalize
   after a clean render ("assetFile is not defined"). esbuild strips types
   without checking, so it compiled clean; caught by the E2E, and a strict
   `tsc` pass was added to the build (`scripts/typecheck.mjs`; PoC files are
   compiled `strict:false` upstream — one documented cosmetic exception there,
   `sinks.ts:88`, allowed; PoC remains byte-identical).
4. **Full-file read in verification — the bug class this project exists to
   catch.** `finalize()` hashed outputs via `fs.readFileSync`: the 1 h daemon
   render peaked at **734.6 MB RSS** (whole 635 MB WAV in memory; 5.08 GB at
   8 h). Bisected by instrumented RSS runs (with job polling 698 MB /
   health-only 699.8 / zero requests 699.6 / plain worker 135.2) → isolated to
   the output hash. Replaced with a streaming 1 MiB-buffer hash (outputs and
   assets). Re-measured: **210.1 MB peak for 4 h**, identical output hash.
   Verification is now streaming everywhere, per hard rule 2.
5. **Sandbox-vs-code distinctions I checked rather than assumed**: two test
   failures were test bugs, not product bugs (HashSink method name; a missing
   fade in the MP3 reference render), and a stale daemon from an earlier run
   initially contaminated the MCP test (the test now aborts if the port isn't
   cold and cleans up via the lockfile pid).

## Out-of-scope discipline (confirmed not drifted)

No nature-ambience synthesis or new layer types (sample-event stub untouched,
counted-and-discarded); no oscillator/filter math changes (`Math.sin/cos/exp`
limitations accepted for v1); no GPU/NVENC dependence (probe is informational;
everything runs CPU); no concurrent scheduling (queue shape only); no web UI;
nothing from Product B (no PyMusicLooper/FastAPI; loop-point detection absent
— the mux test showed no visible seam concern for v1's stream-copy loop, and
`xfade` exists at ingest as the spec's step 2 if ever needed); no LUFS
normalization (stretch item, not built); no automatic eviction (job-ID-scoped
directories make manual cleanup trivial; `evict_asset` covers assets).

## Deferred / noted for later

- **LUFS loudness normalization** — stretch item per spec; not built.
- **Loop-seam xfade** — not built; plain stream-copy loop is the v1 output,
  and the seam is a one-line ingest flag away (`xfade` at normalize time) if
  inspection of real content ever demands it.
- **Persistent search-candidate cache** — in-memory only; a daemon restart
  between search and select requires re-searching (or a direct URL).
- **8 h on this sandbox** — extrapolated as above; the command
  (`scripts/run_8h.mjs`) is ready for a machine without the 10-min cap.
- **Concurrency > 1** — flip `MAX_CONCURRENT` and re-run the cross-job test.
