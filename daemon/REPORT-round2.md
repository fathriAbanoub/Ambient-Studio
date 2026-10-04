# ambientd — round 2 report: signal-path divergence investigation & fix

Scope of this round: ambientd rendered the same recipe **worse** than the
browser's own "Export WAV" (`renderAmbient.ts`). The underlying harshness of
the offline engine itself is a Product A sound-design matter (out of scope —
matched faithfully, flaws included). The goal was: find and fix what makes
`src/blockSynth.ts` deviate from `renderAmbient.ts`'s actual signal path.

Method: no guessing. The real `renderAmbient.ts` was read line-level, and the
real browser was used as ground truth: headless Chromium (Playwright) running
the **unmodified** `renderAmbient.ts` in a real `OfflineAudioContext`, plus
minimal graph/impulse probes (scripts/browser_ref.mjs, delay_probe.mjs,
impulse_probe.mjs — all kept under scripts/ and test/round2/).

Test recipe (note: the exact params from the first session were lost to
conversation summarization; reconstructed from the description): 3 drone
layers — 110 Hz sine, 330 Hz FM, 880 Hz triangle — `enableBeats:false`
(pure drones), mix 0.4, rootHz 110, bpm 72, seed 4242, 60 s.

## 1. The four-point diff (what the real source actually says)

**Point 1 — "Master bus compressor". PREMISE CORRECTED; no master compressor
exists in either implementation.**
- `renderAmbient.ts:159-189`: the graph is tonal-bus `gain` (TONAL_BUS_GAIN
  0.3) → master `filter` (lowpass) → {direct → `out`, `delay` ⇄ `fb` →
  `out`} → destination. The **only** compressor is `drumCompressor`
  (lines 183–187: threshold −20, ratio 3, attack 0.003, release 0.25) and it
  sits on the **drum bus only**, joining at `out`. The master `out` is a bare
  GainNode straight to destination.
- `blockSynth.ts` master chain (lines ~850–885): same topology — tonal ×
  duck-gain → masterFilter → {dry + delay} + drums → out.
- Verdict: for a drone recipe the compressor is out of the signal path in
  BOTH implementations, so it cannot explain the symptom. One real divergence
  remains here: blockSynth does not port the **drum-bus** compressor either
  (see "Known remaining divergence" below). No master-bus dynamics was added
  — adding one would have been an unfaithful "improvement".

**Point 2 — per-voice lowpass Q convention. CONFIRMED DIVERGENCE (measured
to zero error).**
- `blockSynth.ts` `Biquad.set` (was line ~318): `alpha = sin(w0)/(2q)` —
  **linear Q** for all filter kinds.
- The browser's `BiquadFilterNode` interprets Q **in dB for lowpass and
  highpass** (α = sin(ω0)/(2·10^(Q/20))) and linear for bandpass. Measured
  with `getFrequencyResponse` in Chromium and compared to both models:
  dB-Q matches with **max|err| = 0.000000** for lpf 3600/Q0.7, lpf
  6600/Q1.0, bpf 2000/Q1.5, hpf 7000/Q1.0; the PoC's linear-Q lpf was wrong
  by up to 0.40 magnitude (at 3400 Hz: browser 1.141 vs PoC 0.740 — a
  −3.9 dB timbre error right where the 880 Hz triangle's harmonics live).
  Evidence: test/round2/biquad_response.json, bp_hp_response.json.

**Point 3 — sweep/LFO cutoff modulation. MATCH, with one minor divergence.**
- Browser (`renderAmbient.ts:719-729`): LFO = OscillatorNode at 1/sweepSec,
  gain ±800 (DRONE_FILTER_LFO_DEPTH_HZ), wired into `filter.frequency`
  (sums with the automation); filter coefficients recomputed per 128-frame
  render quantum by the platform itself.
- blockSynth (`render()` step 2): `fc = filterHz.v + 800·sin(lfoPhase)`,
  coefficients recomputed on the same 128-frame absolute-aligned quantum.
  No zipper/stepping divergence exists — both step at quantum granularity.
- Minor divergence fixed: the browser sets the LFO frequency **once** at
  layer start and never updates it; blockSynth re-applied `sweepSec` on
  later events (blockSynth.ts:587). Now frozen at layer start.

**Point 4 — gain staging. MATCH.**
- TONAL_BUS_GAIN 0.3 applied to the tonal bus incl. drones (blockSynth
  duck machine steadyV, line ~479 ≡ renderAmbient.ts:167).
- Drone envelope: per-beat `cancelAndHold` + `setTargetAtTime(amp, τ=
  DRONE_FADE_SEC/3)` + sustain anchor + linear release to 0.0001 at the
  piece end (renderAmbient.ts:769-798) ≡ blockSynth's carried ExpApproach +
  pendingRelease linear segment (D4).
- Pan law, detune, hz glide (τ 0.5), master filter/delay/feedback
  automation (τ 0.1), int16 clamp (sinks.ts:14-17 ≡ renderAmbient.ts:1014):
  all match. Raw-render peaks confirmed non-clipping (0.26 pre-fix, 0.28
  post-fix, browser 0.2863 — zero samples at or near full scale in all
  three).

**Additional confirmed divergences beyond the four checkpoints:**
- **Delay feedback cycle — THE root cause.** Web Audio breaks feedback
  cycles with one extra render quantum: impulse probe in Chromium
  (scripts/impulse_probe.mjs → test/round2/impulse_probe_result.json)
  shows echoes at samples 20286, **40700 (+20414 = Δ+128)**, 61114, gains
  1, 0.4, 0.16 — i.e. `d(t) = x(t−Δ) + fb·d(t−Δ−128)`. The PoC fed back at
  Δ with no extra quantum (`this.delayL[write] = filt + fb·d`, old line
  828), rotating every comb peak/notch (2.0 rad at 110 Hz) and mistuning
  the entire echo/comb coloration. The browser's steady-state 110 Hz
  amplitude (0.0663) matches the +128 model (0.0687); ambientd's matched
  the no-extra-quantum model (0.0489) — both verified against a literal
  Python transcription of each chain before the fix.
- **Drone FM mod-index tracking** (renderAmbient.ts:900-902 with its own
  ponytail note at 761-765): the browser's modGain is set once at layer
  creation and never re-scaled; blockSynth recomputed depth from the
  glided frequency every sample. Fixed: depth frozen at layer-start hz·1.8.

## 2. What was fixed (each tied to a measured discrepancy)

All in `src/blockSynth.ts` (+ drain plumbing in `src/sinks.ts`,
`src/render_worker.ts`, `src/cadence.ts`), each marked `round2:` in code:
1. Delay feedback tap now reads 128 samples deeper (`d(t) = x(t−Δ) +
   fb·d(t−Δ−128)`); ring buffer enlarged by one quantum so the tap is
   always valid.
2. `Biquad`: dB-Q for lpf/hpf, linear-Q for bpf — matches the browser with
   max|err| ≤ 8.8e-8 (regression-pinned against the captured fixtures by
   test/round2_extra.ts).
3. Drone FM depth frozen at layer start; sweep rate frozen at layer start.
4. `render()` is async and awaits an optional `sink.drain()` hook (see
   small fix 2 below — same mechanism, one design).

`renderAmbient.ts`'s sound-design numbers were copied, never improved.
`musicalLogic.ts` / `scheduling.ts` remain byte-identical (parity-checked,
sha256 b8832596543fa272… / 4d3aa5e9845e4b4d…). D1–D5 enforcement untouched:
fixed event order, fixed summation order, kernel-stream-only randomness,
carried automation state (the drain await touches no DSP state), loud D5
failure — the full suite proves all five still hold.

**Known remaining divergence (documented, not fixed):** the drum-bus
compressor (renderAmbient.ts:183-187) is not ported — blockSynth sums drums
straight to `out`. Zero effect on drone or any tonal-only recipe (no drum
events → compressor out of the path in the browser too); it only affects
recipes with drums, which is a separate verification effort (a faithful
DynamicsCompressorNode kernel port should be validated against the browser
probes the same way this round's fixes were). Marked `ponytail:` in code.

## 3. Objective comparison — a proxy, not a listening confirmation

Same recipe, same seed, 60 s: (a) browser export = real renderAmbient.ts in
headless Chromium; (b) ambientd BEFORE the fix; (c) ambientd AFTER.
Spectral stats over the full file (mono-averaged, 16384-pt FFT):

| metric            | (a) browser | (b) before | (c) after |
|-------------------|-------------|------------|-----------|
| peak              | 0.2863      | 0.2598     | 0.2824    |
| RMS               | 0.10986     | 0.10522    | 0.10946   |
| spectral centroid | 637.9 Hz    | 557.2 Hz   | 627.2 Hz  |
| 95 % rolloff      | 1330 Hz     | 1322 Hz    | 1324 Hz   |
| band 800–2500 Hz  | 38.96 %     | 32.09 %    | 38.79 %   |
| band 2500–4000 Hz | 1.46 %      | 0.71 %     | 1.37 %    |
| samples ≥ 0.999   | 0           | 0          | 0         |

Sample-level vs the browser: correlation **0.7667 → 0.9880**; rms(delta)
**0.0736 → 0.0170** (4.3× lower); max|delta| 0.1513 → 0.0497. Per-layer
after the fix: 110 Hz sine corr 0.9997 (essentially exact), FM 0.9881,
triangle 0.9804 — the residual is phase drift between Chromium's band-
limited wavetable oscillators and pure Math.sin-based phase integration,
which changes numbers but not the spectrum, envelope, or character.

**This is an objective proxy, not a confirmation that it sounds right.**
The metrics were chosen for the bugs found (comb-phase error → full-band
correlation and band energies; filter-Q error → rolloff/centroid). The
human ear still needs to make the final call; if the character still reads
wrong, the next suspects are the residual wavetable differences above and
the drum-bus compressor for drum content.

Artifacts kept: test/round2/{ref_browser,ambientd_before,ambientd_after}.wav
(+ per-layer and mix-sweep probe WAVs), analysis via scripts/analyze.py.

## 4. Full suite still green

`npm test` → **120 checks PASS, 0 FAIL** across parity / typecheck / smoke /
phase2 / phase3 / phase4 / phase5 (incl. the mandated cross-job isolation
test — hashes still byte-identical to fresh-process references) / phase6-7
(MCP cold start + full E2E) / phase2b extras (1 h render: 31.5× realtime,
peak RSS 152.1 MB) / the new round2_extra (14 checks). The smoke test's
reference hash changed (184f84f8… → c88e25ae…) — expected and documented:
the old hash encoded the buggy signal path; the test itself is
self-relative (block-size invariance), nothing was hand-tuned.

## 5. The two bundled small fixes (both confirmed working)

**1. check_kernel_parity.mjs path (scripts/check_kernel_parity.mjs).**
The upstream kernel directory is now `process.argv[2] ??
process.env.KERNEL_SRC_PATH` with a clear two-line error and exit 2 if
missing (default still derives from the zip-extraction layout).
run_all.mjs passes it explicitly. The PoC-identity assertions for
blockSynth/sinks became pinned-sha regression gates (the divergence is now
deliberate and documented in the script header; kernel byte-identity
checking is unchanged).

**2. ffmpeg stdin backpressure + finalize verification.**
- Confirmed by reading the code: `FfmpegStdinSink.writeBlock` (sinks.ts,
  old line 199) and the mp4 pipe sink (render_worker.ts, old line 113)
  ignored `.write()`'s boolean and never waited for `'drain'`.
- Fix: `drainWritable()` helper (resolve on drain, reject on
  error/close — loud, no deadlock); both sinks track backpressure and
  expose `drain()`; `BlockSynth.render()` is now async and suspends
  between blocks only when a drain is pending (sync sinks: zero change).
- Stress test with a REAL throttle: ffmpeg `-readrate 2` (consumer capped
  at 2× native = 352 KB/s vs ~5 MB/s production) → `drainWaits = 9 > 0`
  (the path actually suspended), exit 0, output **byte-identical** to the
  unthrottled reference (sha256 equal), duration exact.
- Finalize verification strengthened (`verifyRenderedOutput`, exported for
  negative testing): parseable + container duration within
  max(0.5 s, 2 %) of the snapped duration — **plus a decoded-content
  check** (full null-mux decode, final stats time). The container check
  alone provably misses the reported defect: a truncated MP3's Xing header
  still claims full duration (measured — 40 % truncated file reports
  12.04 s container duration with 4.78 s of real audio). The new check
  fails such a file loudly: "decoded audio content is 4.78s but expected
  12.00s (container claims 12.04s)". Tested: truncated mp3 → throws;
  truncated wav → throws; good files pass.

## 6. Explicit non-violation confirmations

- `vendor/kernel/musicalLogic.ts` and `scheduling.ts`: **byte-identical**,
  re-verified this round (parity suite OK).
- D1–D5: **untouched and re-proven** — the cross-job isolation test, block
  invariance, D5 loud-failure and broken-variant tests all pass on the
  fixed code; the async render only suspends the loop between blocks and
  touches no DSP state.
- No sound-design "improvements": every changed line copies
  `renderAmbient.ts`'s actual behavior — including its flaws — verified
  numerically against the browser. The one deviation not ported (drum-bus
  compressor) is documented above and out of the drone path.
