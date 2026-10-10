# ambientd

A daemon that renders a music recipe into long-form (up to 8 h) generative
ambient audio — optionally muxed with a background video — controlled entirely
through an MCP server. v1.

```
recipe (kernel params + duration + output format)
  → musicalLogic kernel (vendored, byte-identical, unmodified)
  → blockSynth (benchmark PoC, unmodified DSP, D1–D5 determinism enforced)
  → sink: WAV | M4A/AAC | MP3 | MP4 (loop-muxed video + AAC, or 1 fps static image)
  → ffprobe-verified → atomic rename → provenance sidecar
```

## Run

```sh
npm install
npm run build          # esbuild bundles + strict typecheck
npm test               # full suite: parity, smoke, phases 2–7 (≈6 min)

npm start              # daemon on 127.0.0.1:7781 (AMBIENTD_PORT/AMBIENTD_DATA override)
node build/mcp.cjs     # MCP stdio shim; auto-spawns the daemon if not running
```

Env: `AMBIENTD_PORT` (7781), `AMBIENTD_DATA` (./data),
`PEXELS_API_KEY` / `PIXABAY_API_KEY` for stock-video search.

## Layout

```
vendor/kernel/   musicalLogic.ts + scheduling.ts — byte-identical copies of
                 Product A's engine (parity-checked by scripts/check_kernel_parity.mjs)
src/
  blockSynth.ts  benchmark PoC block synth — UNMODIFIED except import paths.
                 D1 fixed event order, D2 spawn-order summation, D3 kernel-only
                 randomness, D4 carried automation, D5 loud failure (all intact).
  sinks.ts       benchmark PoC sinks — UNMODIFIED except import paths.
                 WavFileSink, HashSink, FfmpegStdinSink (MP3 = codec-args swap).
  cadence.ts     snap-to-bar (integer frame math) + linear outro fade sink
  ffmpeg.ts      run/ffprobe/NVENC probe/streaming sha256 helpers
  providers.ts   Pexels + Pixabay video search (429 backoff, test-seam base URL)
  assets.ts      content-hashed asset registry + one-time normalize/ingest
  video.ts       two-input loop-mux + static-image fallback (+ default bg gen)
  render_worker.ts  per-job worker: render → sink, progress posts, loud failure
  jobs.ts        job registry (UUID jobs, seeds NEVER from job ids), one-at-a-time
                 runner, tmp→verify→rename finalize, provenance sidecar
  server.ts      HTTP API + lockfile + NVENC probe at startup
  mcp.ts         MCP stdio shim (10 tools) — thin client over the HTTP API
test/            phase tests + run_all.mjs
scripts/         build, typecheck, parity check, 8h runner
```

## HTTP API (mirrored 1:1 by the MCP tools)

| Route | Purpose |
|---|---|
| `POST /recipes` | create recipe (CSPRNG seed generated + persisted if omitted) |
| `GET /recipes/:id` | fetch |
| `POST /jobs` | submit (returns 202 immediately; `{duration_sec, preview_format}` overrides allowed) |
| `GET /jobs/:id` | status + progress |
| `GET /jobs/:id/result` | output files + provenance |
| `POST /assets/search` | Pexels/Pixabay shortlist (thumbnails, duration, license) |
| `POST /assets/select` | download + normalize + cache a candidate (or a direct URL) |
| `POST /assets/upload` | same ingest for a local file / URL |
| `GET /assets` · `DELETE /assets/:id` | registry introspection / manual eviction |

## Guarantees v1 makes (and how they're checked)

- **Same-machine determinism** — same seed ⇒ identical PCM16 stream regardless
  of block size, worker topology, or prior jobs on the daemon
  (test/phase5: cross-job isolation against fresh-process references).
- **Bounded memory** — every buffer in the render AND verification path is
  block-sized or fixed; measured 1 h ⇒ 152 MB peak RSS vs 635 MB of PCM
  (test/phase2b; 8 h curve in scripts/run_8h.mjs).
- **Atomic artifacts** — temp file → ffprobe/WAV-header verify → rename;
  failed jobs leave no half-written outputs.
- **Provenance** — per-job sidecar: seed, kernel/synth sha256, snapped bars,
  exact ffmpeg commands, output hash.
