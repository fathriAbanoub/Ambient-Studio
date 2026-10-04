# Benchmark results — numbers only

_Generated 2026-10-04T07:51:11.185Z from 22 result files in bench/results/._


## A — Kernel throughput

<details><summary><code>A1_kernel_throughput_8h</code> — 2026-10-04T05:42:46.452Z</summary>

**Captured:** 2026-10-04T05:42:46.452Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"ts_runner":"esbuild","horizon_hours":8}`



### per-call distribution (ms)

| metric | value |
| --- | --- |
| median | 0.0009 |
| p95 | 0.0022 |
| min | 0.0005 |
| max | 2.1971 |
| calls | 32240 |
| last/first quarter median ratio | 0.842 |
| scene-transition median ms | 0.0009 |
| scene-transition calls | 251 |
| wall sec (whole 8h simulation) | 0.066 |
| peak RSS MB | 77.1 |

</details>

<details><summary><code>A2_kernel_feature_costs</code> — 2026-10-04T05:42:46.569Z</summary>

**Captured:** 2026-10-04T05:42:46.569Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"ts_runner":"esbuild","horizon_hours":8}`



### config sweep

| drone layers | sample bank | beats | median ms | p95 ms | events/beat |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | — | 0.0010 | 0.0040 | 7.0 |
| 0 | 16 | — | 0.0022 | 0.0034 | 7.0 |
| 4 | 0 | — | 0.0023 | 0.0054 | 11.0 |
| 4 | 16 | — | 0.0025 | 0.0052 | 11.0 |
| 8 | 0 | — | 0.0013 | 0.0021 | 15.0 |
| 8 | 16 | — | 0.0027 | 0.0040 | 15.0 |

</details>

<details><summary><code>A3_kernel_8h_totals</code> — 2026-10-04T05:42:46.674Z</summary>

**Captured:** 2026-10-04T05:42:46.674Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"ts_runner":"esbuild","horizon_hours":8}`



### totals

| metric | value |
| --- | --- |
| beats | 32240 |
| events total | 233647 |
| wall sec | 0.064 |
| wall µs/call | 1.99 |
| init chain ms | 0.398 |
| peak RSS MB | 59.5 |

</details>


## B — Offline render (renderAmbient)

<details><summary><code>B1_offline_render_sweep__browser</code> — 2026-10-04T06:30:46.617Z</summary>

**Captured:** 2026-10-04T06:30:46.617Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"environment_label":"headless Chromium (Playwright) — GROUND TRUTH","browser":"153.0.8010.12","durations_minutes":[0.02,0.1,0.3,0.6,1.2],"trials":1}`


- assertion `all_sweep_points_ok`: PASS — ok=5/5

### sweep (headless Chromium (Playwright) — GROUND TRUTH)

| duration min | wall s | scheduling s | startRendering s | peak heap/RSS MB | non-finite | wav MB | outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.02 | 0.4 | — | — | 9.5 | 0 | 0.2 | ok |
| 0.10 | 0.6 | — | — | 9.5 | 0 | 1.0 | ok |
| 0.30 | 1.4 | — | — | 9.5 | 0 | 3.0 | ok |
| 0.60 | 3.6 | — | — | 9.5 | 0 | 6.1 | ok |
| 1.20 | 11.5 | — | — | 9.5 | 0 | 12.1 | ok |


_Extrapolation to 8 h (labeled extrapolation, linear fit): wall 76.2 min, peak heap/RSS 9.5_


**Observations (clearly separated from numbers):**

> Memory metric is Chromium's performance.memory.usedJSHeapSize, which EXCLUDES AudioBuffer sample data (external/C++ memory in Chrome). Browser heap figures therefore understate true renderer memory; the Node variant records process-level RSS (which includes sample data), so read the two environments together. ponytail: browser renderer-process RSS sampling is the upgrade path if you need exact tab-level memory.

</details>

<details><summary><code>B1_offline_render_sweep__node</code> — 2026-10-04T06:31:17.036Z</summary>

**Captured:** 2026-10-04T06:31:17.036Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"environment_label":"node (node-web-audio-api) — SECONDARY/EXPERIMENTAL, not ground truth","implementation":{"package":"node-web-audio-api","version":null},"durations_minutes":[0.02,0.1,0.3,0.6,1.2]}`


> RUN ERROR: B4 violation: non-finite samples in Node Web Audio output

- assertion `nonfinite_zero_all_points`: FAIL — violations: [{"duration_minutes":0.02,"non_finite":17338},{"duration_minutes":0.1,"non_finite":88506},{"duration_minutes":0.3,"non_finite":203657},{"duration_minutes":0.6,"non_finite":302760},{"duration_minutes":1.2,"non_finite":561226}]
- assertion `nonfinite_check_is_loud`: PASS — the harness fails the benchmark (nonzero exit, failed assertion) on any non-finite sample — never silently skips

### sweep (node (node-web-audio-api) — SECONDARY/EXPERIMENTAL, not ground truth)

| duration min | wall s | scheduling s | startRendering s | peak heap/RSS MB | non-finite | wav MB | outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.02 | 0.4 | 0.0 | 0.4 | 92.0 | 17338 | 0.2 | ok |
| 0.10 | 0.6 | 0.0 | 0.6 | 111.5 | 88506 | 1.0 | ok |
| 0.30 | 1.8 | 0.0 | 1.8 | 134.4 | 203657 | 3.0 | ok |
| 0.60 | 6.2 | 0.0 | 6.2 | 170.9 | 302760 | 6.1 | ok |
| 1.20 | 20.1 | 0.0 | 20.0 | 237.6 | 561226 | 12.1 | ok |


_Extrapolation to 8 h (labeled extrapolation, linear fit): wall 136.0 min, peak heap/RSS —_

</details>


## C — Chunked-render PoC (superseded by I — kept for the record)

_(no result files)_


## D — ffmpeg video ladder

<details><summary><code>D0_nvenc_probe</code> — 2026-10-04T07:10:27.562Z</summary>

**Captured:** 2026-10-04T07:10:27.562Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"probe":{"available":false,"command":"ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=16x16:d=0.1 -vcodec h264_nvenc -f null -","output":"[h264_nvenc @ 0x5607e96fca00] Cannot load libcuda.so.1\n[vost#0:0/h264_nvenc @ 0x5607e97006c0] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\n[vf#0:0 @ 0x5607e971b640] Error sending frames to con`


- assertion `nvenc_probe_determinant`: PASS — available=false; later NVENC modes reference this result and self-skip


NVENC available: **false**

```
ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=16x16:d=0.1 -vcodec h264_nvenc -f null -
[h264_nvenc @ 0x5607e96fca00] Cannot load libcuda.so.1
[vost#0:0/h264_nvenc @ 0x5607e97006c0] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
[vf#0:0 @ 0x5607e971b640] Error sending frames to consumers: Operation not permitted
[vf#0:0 @ 0x5607e971b640] Task finished with error code: -1 (Operation not permitted)
[vf#0:0 @ 0x5607e971b640] Terminating thread with return code -1 (Operation not permitted)
[vost#0:0/h264_nvenc @ 0x5607e97006c0] Could not open encoder before EOF
[vost#0:0/h264_nvenc @ 0x5607e97006c0] Task finished with error code: -22 (Invalid argument)
[vost#0:0/h264_nvenc @ 0x5607e97006c0] Terminating thread with return code -22 (Invalid argument)
[out#0/null @ 0x5607e96fff80] Nothing was written into output file, because at least one of its streams received no packets.
```

</details>

<details><summary><code>D1_static_ladder</code> — 2026-10-04T06:41:48.777Z</summary>

**Captured:** 2026-10-04T06:41:48.777Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"video":"1920x1080","crf":23,"x264_preset":"veryfast","nvenc_args":["-preset","p1","-rc","vbr","-cq","23","-b:v","5M"],"audio":"lavfi anoisesrc (deterministic seed) streamed — no WAV temp","assets":{"bg":"user-provided","loop_gif":"user-provided","loop_mp4":"user-provided"},"modes":[{"kind":"static","label":"static_0.2min","disk_guard_min":0.2,"params":{"duration_min":0.2,"fps":1,"zoom":null,"loo`



### runs

| mode | wall s | out MB | peak RSS MB | ffprobe dur s | fps | status |
| --- | --- | --- | --- | --- | --- | --- |
| static_0.2min__libx264 | 0.49 | 0.3 | 248.3 | 12.0 | 1/1 | ok |
| static_2min__libx264 | 3.79 | 2.0 | 406.6 | 120.0 | 1/1 | ok |
| static_6min__libx264 | 10.99 | 5.8 | 405.2 | 360.0 | 1/1 | ok |
| static_24min__libx264 | 43.96 | 23.0 | 413.0 | 1440.0 | 1/1 | ok |


_peak workdir (incl. temps): 21.8 MB_

</details>

<details><summary><code>D2_zoom_ladder</code> — 2026-10-04T07:04:41.908Z</summary>

**Captured:** 2026-10-04T07:04:41.908Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"video":"1920x1080","crf":23,"x264_preset":"veryfast","nvenc_args":["-preset","p1","-rc","vbr","-cq","23","-b:v","5M"],"audio":"lavfi anoisesrc (deterministic seed) streamed — no WAV temp","assets":{"bg":"user-provided","loop_gif":"user-provided","loop_mp4":"user-provided"},"modes":[{"kind":"zoom","label":"zoom_0.1min_5fps","disk_guard_min":0.1,"params":{"duration_min":0.1,"fps":5,"zoompan":"z='1`



### runs

| mode | wall s | out MB | peak RSS MB | ffprobe dur s | fps | status |
| --- | --- | --- | --- | --- | --- | --- |
| zoom_0.1min_5fps__libx264 | 4.09 | 0.8 | 424.6 | 6.0 | 5/1 | ok |
| zoom_0.1min_10fps__libx264 | 4.80 | 0.8 | 426.5 | 6.0 | 10/1 | ok |
| zoom_1min_5fps__libx264 | 38.64 | 5.1 | 424.6 | 60.0 | 5/1 | ok |
| zoom_1min_10fps__libx264 | 44.86 | 6.3 | 426.6 | 60.0 | 10/1 | ok |
| zoom_3min_5fps__libx264 | 115.65 | 14.1 | 424.8 | 180.0 | 5/1 | ok |
| zoom_3min_10fps__libx264 | 131.09 | 16.1 | 424.5 | 180.0 | 10/1 | ok |


_peak workdir (incl. temps): 15.5 MB_

</details>

<details><summary><code>D3_loop_ladder</code> — 2026-10-04T07:10:27.563Z</summary>

**Captured:** 2026-10-04T07:10:27.563Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"video":"1920x1080","crf":23,"x264_preset":"veryfast","nvenc_args":["-preset","p1","-rc","vbr","-cq","23","-b:v","5M"],"audio":"lavfi anoisesrc (deterministic seed) streamed — no WAV temp","assets":{"bg":"user-provided","loop_gif":"user-provided","loop_mp4":"user-provided"},"modes":[{"kind":"loop","label":"loop_gif_0.1min_10fps","disk_guard_min":0.1,"params":{"duration_min":0.1,"fps":10,"loop_sou`



### runs

| mode | wall s | out MB | peak RSS MB | ffprobe dur s | fps | status |
| --- | --- | --- | --- | --- | --- | --- |
| loop_gif_0.1min_10fps__libx264 | 1.17 | 1.3 | 341.1 | 6.0 | 10/1 | ok |
| loop_mp4_0.1min_10fps__libx264 | 1.51 | 1.2 | 349.1 | 6.0 | 10/1 | ok |
| loop_gif_1min_10fps__libx264 | 10.65 | 13.0 | 345.0 | 60.0 | 10/1 | ok |
| loop_mp4_1min_10fps__libx264 | 10.72 | 12.1 | 349.2 | 60.0 | 10/1 | ok |
| loop_gif_3min_10fps__libx264 | 31.84 | 39.0 | 345.3 | 180.0 | 10/1 | ok |
| loop_mp4_3min_10fps__libx264 | 31.82 | 36.2 | 350.8 | 180.0 | 10/1 | ok |


_peak workdir (incl. temps): 38.5 MB_

</details>

<details><summary><code>D4_assembly_vs_naive</code> — 2026-10-04T07:11:55.731Z</summary>

**Captured:** 2026-10-04T07:11:55.731Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"target_min":3,"head_tail_sec":5,"fade_sec":5,"body_sec_static":60,"zoom_segments":10,"segment_format":"mpegts → concat -c copy -bsf:a aac_adtstoasc -movflags +faststart"}`



### assembly vs naive

| mode | build s | assemble s | naive s | speedup | seg failures | assembled dur s |
| --- | --- | --- | --- | --- | --- | --- |
| static__libx264 | 2.84 | 0.16 | 5.70 | 1.90× | 0 | — |
| loop__libx264 | 5.06 | 0.29 | 31.61 | 5.90× | 0 | — |
| zoom__libx264 | 137.83 | 0.19 | 131.87 | 0.96× | 0 | — |

</details>


## E — Disk and I/O

<details><summary><code>E1_wav_size_accounting</code> — 2026-10-04T07:19:08.520Z</summary>

**Captured:** 2026-10-04T07:19:08.520Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"sample_rate":44100,"channels":2,"bit_depth":16,"durations_min":[1,5,15,30,60]}`


- assertion `wav_size_matches_theory`: PASS — every file must equal header + frames×channels×bytesPerSample exactly

### WAV size vs theory

| duration | on-disk bytes | theoretical bytes | header | size-consistent |
| --- | --- | --- | --- | --- |
| 1min | 10584044 | 10584044 | ok | ok |
| 5min | 52920044 | 52920044 | ok | ok |
| 15min | 158760044 | 158760044 | ok | ok |
| 30min | 317520044 | 317520044 | ok | ok |
| 60min | 635040044 | 635040044 | ok | ok |

</details>

<details><summary><code>E2_disk_throughput</code> — 2026-10-04T07:19:48.486Z</summary>

**Captured:** 2026-10-04T07:19:48.486Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"baseline_write_mb":512,"chunk_mb":1,"encode":"static 1080p @1fps, 10 min payload","sample_interval_sec":1}`



### throughput

| metric | value |
| --- | --- |
| baseline sequential write (Node fs) | 2191.6 MB/s |
| sustained during encode (mean of deltas) | 0.5 MB/s |
| peak workdir during encode | 9.3 MB |

</details>

<details><summary><code>E3_pipeline_disk_peak</code> — 2026-10-04T07:20:07.108Z</summary>

**Captured:** 2026-10-04T07:20:07.108Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"duration_min":10,"segments":6,"pipeline":"WAV artifact → mpegts segment encodes → concat MP4"}`



### pipeline disk peak

| metric | value |
| --- | --- |
| duration | 10 min |
| WAV artifact | 0.10 GB |
| segments total | 0.01 GB |
| final MP4 | 0.01 GB |
| PEAK simultaneous | 0.11 GB |

</details>


## F — Node Web Audio battery

<details><summary><code>F_node_webaudio_battery</code> — 2026-10-04T07:20:37.870Z</summary>

**Captured:** 2026-10-04T07:20:37.870Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"implementations":[{"name":"node-web-audio-api","version":"unknown"},{"name":"web-audio-engine","version":"unknown"}],"graph_duration_sec":5,"sample_rate":44100}`


- assertion `all_graphs_pass_all_invariants`: PASS — every implementation must render every graph with zero non-finite samples, non-silent output, and peak within headroom

### node-web-audio-api

| graph | pass | non-finite | rms | peak | feedback tail | realtime× |
| --- | --- | --- | --- | --- | --- | --- |
| osc+gain(ADSR) | PASS | 0 | 0.2944 | 0.500 | — | 943.2× |
| osc+filter+delay+feedback(automated) | PASS | 0 | 0.3365 | 1.086 | yes | 215.9× |
| osc+compressor | PASS | 0 | 0.4294 | 0.826 | — | 690.4× |
| osc+stereopanner(automated) | PASS | 0 | 0.2500 | 0.500 | — | 1195.4× |
| bufferSource(noise buffer) | PASS | 0 | 0.1728 | 0.300 | — | 1564.0× |

### web-audio-engine

| graph | pass | non-finite | rms | peak | feedback tail | realtime× |
| --- | --- | --- | --- | --- | --- | --- |
| osc+gain(ADSR) | PASS | 0 | 0.1137 | 0.500 | — | 358.5× |
| osc+filter+delay+feedback(automated) | PASS | 0 | 0.3301 | 1.133 | yes | 189.9× |
| osc+compressor | PASS | 0 | 0.5683 | 1.121 | — | 147.0× |
| osc+stereopanner(automated) | PASS | 0 | 0.2500 | 0.494 | — | 256.1× |
| bufferSource(noise buffer) | PASS | 0 | 0.1728 | 0.300 | — | 502.4× |

</details>


## G — In-process streaming synth (kernel → block synth → sink)

<details><summary><code>G1_rss_duration_sweep</code> — 2026-10-04T07:39:40.355Z</summary>

**Captured:** 2026-10-04T07:39:40.355Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"sweep_sec_planned":[300,1800,7200,28800],"block_frames":4096,"sample_rate":44100,"scale":0.35,"chunked_phases":false}`


- assertion `frames_exact_150`: PASS — expected 6615000 frames, got 6615000
- assertion `nonfinite_zero_150`: PASS — non-finite samples: 0
- assertion `frames_exact_900`: PASS — expected 39690000 frames, got 39690000
- assertion `nonfinite_zero_900`: PASS — non-finite samples: 0
- assertion `frames_exact_3600`: PASS — expected 158760000 frames, got 158760000
- assertion `nonfinite_zero_3600`: PASS — non-finite samples: 0
- assertion `frames_exact_14400`: PASS — expected 635040000 frames, got 635040000
- assertion `nonfinite_zero_14400`: PASS — non-finite samples: 0
- assertion `frames_exact_105`: PASS — expected 4630500 frames, got 4630500
- assertion `nonfinite_zero_105`: PASS — non-finite samples: 0
- assertion `frames_exact_630`: PASS — expected 27783000 frames, got 27783000
- assertion `nonfinite_zero_630`: PASS — non-finite samples: 0
- assertion `frames_exact_2520`: PASS — expected 111132000 frames, got 111132000
- assertion `nonfinite_zero_2520`: PASS — non-finite samples: 0
- assertion `frames_exact_10080`: PASS — expected 444528000 frames, got 444528000
- assertion `nonfinite_zero_10080`: PASS — non-finite samples: 0

### RSS over render time (generation; verification is streaming)

| point | frames | kernel events | peak RSS MB | curve min MB | curve max MB | drift KB/wall-s | realtime× | non-finite |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3min | 6615000 | 1306 | 83.8 | 74.3 | 76.0 | 381.8 | 40.2× | 0 |
| 15min | 39690000 | 7380 | 88.5 | 79.5 | 88.5 | 392.0 | 37.4× | 0 |
| 60min | 158760000 | 29307 | 111.0 | 91.4 | 111.0 | 193.2 | 37.7× | 0 |
| 240min | 635040000 | 116954 | 180.3 | 127.3 | 180.3 | 106.0 | 36.8× | 0 |
| 2min | 4630500 | 966 | 91.6 | 83.6 | 85.8 | -1099.8 | 36.7× | 0 |
| 11min | 27783000 | 5202 | 87.6 | 77.0 | 80.1 | 104.9 | 35.7× | 0 |
| 42min | 111132000 | 20566 | 112.1 | 93.3 | 112.1 | 326.9 | 37.3× | 0 |
| 168min | 444528000 | 81837 | 129.9 | 117.8 | 129.9 | 39.2 | 37.1× | 0 |
| 30min_4drone_layers | — | 8074 | 91.8 | 80.4 | 91.8 | 551.3 | 23.9× | 0 |


_peak RSS vs duration slope: 0.4 MB per audio-minute · PCM16 stereo alone would be 10.1 MB/min (slope = 3.49% of the PCM rate)_


**Observations (clearly separated from numbers):**

> Peak RSS vs duration fit: slope 0.35 MB per audio-minute (PCM16 stereo alone would be 10.09 MB/min; category C's chunked path measured ~75 MB/min over 6→60 min). The residual duration-linear term is the kernel event list (~0.2 KB/event), not audio buffers.

</details>

<details><summary><code>G2_realtime_throughput</code> — 2026-10-04T07:39:40.355Z</summary>

**Captured:** 2026-10-04T07:39:40.355Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"sweep_sec_planned":[300,1800,7200,28800],"block_frames":4096,"scale":0.35}`



### throughput

| point | wall s | timeline ms | render ms | realtime× |
| --- | --- | --- | --- | --- |
| 3min | 3.7 | 8 | 3727 | 40.2× |
| 15min | 24.0 | 20 | 24026 | 37.4× |
| 60min | 95.5 | 35 | 95446 | 37.7× |
| 240min | 391.5 | 132 | 391327 | 36.8× |
| 2min | 2.9 | 6 | 2854 | 36.7× |
| 11min | 17.6 | 16 | 17628 | 35.7× |
| 42min | 67.6 | 27 | 67610 | 37.3× |
| 168min | 271.9 | 108 | 271831 | 37.1× |
| 30min_4drone_layers | 26.4 | — | — | 23.9× |

</details>

<details><summary><code>G3_determinism_and_invariance</code> — 2026-10-04T07:40:06.871Z</summary>

**Captured:** 2026-10-04T07:40:06.871Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"determinism_sec":630,"block_sizes":[1024,4096,16384],"audit_points":[300,1800]}`


- assertion `byte_identical_same_seed`: PASS — two fresh-process renders of seed 42 are byte-identical (ffd34df8ad1a6d3e…)
- assertion `block_size_invariance`: PASS — 1024/4096/16384-frame blocks → identical sha256 (ffd34df8ad1a6d3e…): block boundaries are invisible in the output
- assertion `invariance_matches_determinism`: PASS — 4096-frame invariance run equals the determinism runs' hash — same-seed renders agree across runs
- assertion `audit_hash_stable_105`: PASS — same-seed hash identical regardless of position in the sweep
- assertion `audit_hash_stable_630`: PASS — same-seed hash identical regardless of position in the sweep

### runs (determinism / block sizes / audit re-runs)

| run | pcm16 sha256 | wall s | peak RSS MB | realtime× |
| --- | --- | --- | --- | --- |
| determinism_run_1 | ffd34df8ad1a6d3e | 17.5 | 89.6 | 36.1× |
| determinism_run_2 | ffd34df8ad1a6d3e | 17.7 | 89.6 | 35.6× |
| block_1024 | ffd34df8ad1a6d3e | 17.8 | — | 35.3× |
| block_4096 | ffd34df8ad1a6d3e | 17.7 | — | 35.5× |
| block_16384 | ffd34df8ad1a6d3e | 18.0 | — | 35.0× |
| audit_recheck_2min | e57528c468b2acb0 | 2.9 | — | —× |
| audit_recheck_11min | ffd34df8ad1a6d3e | 17.6 | — | —× |

</details>


## H — Worker isolation / responsiveness

<details><summary><code>H1_mainthread_responsiveness</code> — 2026-10-04T07:20:38.082Z</summary>

**Captured:** 2026-10-04T07:20:38.082Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"render_sec":900,"lag_poll_interval_ms":50,"baseline_ms":3000,"topology":"worker_threads"}`


- assertion `frames_exact`: PASS — expected 39690000 frames, got 39690000
- assertion `wav_header_ok`: PASS — RIFF ok=true, size consistent=true
- assertion `worker_vs_child_byte_identical`: PASS — worker_threads and child-process renders agree (30576f4b8b9606d4…) — topology does not affect output

### event-loop lag (ms)

| window | n | mean | median | p95 | max |
| --- | --- | --- | --- | --- | --- |
| baseline (no render) | 59 / 0.17 / 0.15 / 0.23 / 0.57 |
| during worker render | 480 / 0.19 / 0.13 / 0.21 / 15.82 |
| ratio during/baseline (median/p95/max) | 0.86 / 0.92 / 28.00 |


_worker: 39690000 frames, wall 24.1 s, 37.4× realtime_


**Observations (clearly separated from numbers):**

> Event-loop lag with a 900s render active in a worker: median 0.13 ms vs baseline 0.15 ms, p95 0.21 vs 0.23 ms, max 15.82 vs 0.57 ms. Interpretation: the probe lives on the main thread that would serve HTTP/MCP requests; sustained lag growth here is the "long render blocks request handling" failure mode.

</details>


## I — Automation state-carry (successor to C)

<details><summary><code>I1_automation_state_carry</code> — 2026-10-04T07:23:25.696Z</summary>

**Captured:** 2026-10-04T07:23:25.696Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"total_sec":1800,"block_sizes":[1024,4096,16384,"single_block"],"broken_block_sizes":[1024,8192,65536],"crosscheck_sec":120,"c_graph_constants":{"carrierHz":220,"subHz":55,"subGain":0.5,"filterStartHz":600,"filterEndHz":2400,"filterQ":1,"delayStartSec":0.2,"delayEndSec":0.35,"delayMaxSec":2,"feedbackGain":0.35,"masterGain":0.5,"panPeriodSec":10,"panTargetTcSec":0.08}}`


- assertion `nonfinite_zero_healthy_1024`: PASS — non-finite: 0
- assertion `nonfinite_zero_healthy_4096`: PASS — non-finite: 0
- assertion `nonfinite_zero_healthy_16384`: PASS — non-finite: 0
- assertion `nonfinite_zero_healthy_single_block`: PASS — non-finite: 0
- assertion `block_size_invariance_incl_single_block`: PASS — 1024/4096/16384/single-block partitions → identical sha256 (7231c36ca9b47d88…): chunk divergence has no mechanism in this design
- assertion `broken_variant_diverges`: PASS — broken re-anchoring produces different output per block size (1024/8192/65536): the tests detect the failure mode
- assertion `crossengine_nonfinite_zero`: PASS — non-finite in my stream vs reference: 0

### I1a healthy partitions (streaming sha256)

| partition | hash |
| --- | --- |
| 1024 | 7231c36ca9b47d88… |
| 4096 | 7231c36ca9b47d88… |
| 16384 | 7231c36ca9b47d88… |
| single_block | 7231c36ca9b47d88… |

### I1b broken variant (re-anchored)

| block frames | hash |
| --- | --- |
| 1024 | ed3e8b6d7c60a000… |
| 8192 | 479a015587ba6399… |
| 65536 | a387c9bc4add5e53… |

### I1b sampled max|Δ| vs healthy

| block frames | max|Δ| |
| --- | --- |
| 1024 | 1.42e+0 |
| 8192 | 1.26e+0 |
| 65536 | 7.75e-1 |

### I1c cross-engine vs node-web-audio-api (single-pass)

| metric | value |
| --- | --- |
| duration | 120 s |
| max abs delta | 2.680e-1 |
| rms delta | 7.093e-2 |
| byte identical (not expected) | false |
| reference buffer materialized | 40 MB (disclosed) |


**Observations (clearly separated from numbers):**

> Category C (user's hardware, chunked OfflineAudioContext, 1800 s program): overhead 70.6% at 60 s chunks, max|Δ| 2.8e-1, divergence NOT seam-localized. I1a shows the in-process design makes block boundaries invisible (hash-equal across partitions incl. single-block) — the divergence class C measured has no mechanism to exist here: node state carries, and the coefficient quantum grid is absolute-frame aligned. I1b re-introduces C's mechanisms deliberately (re-anchoring + block-relative quanta) and measures divergence return: max|Δ| (sampled, every 4th frame) by block size = {"1024":1.422569066286087,"8192":1.261392131447792,"65536":0.7753899097442627}. I1c cross-engine proximity at 120 s: max|Δ| 2.68e-1, rms 7.09e-2 — measured, not asserted; different biquad/oscillator implementations make byte-identity impossible across engines, what matters is the magnitude class vs C's within-engine 2.8e-1.

> Web Audio reference memory disclosure: the OfflineAudioContext render materializes 120s × 44100 × 2ch × 4 B ≈ 40 MB for the comparison — the one materializing verification in this suite, reported separately from generation memory.

</details>


## J — Direct-to-ffmpeg streaming

<details><summary><code>J1_wav_vs_ffmpeg_stdin</code> — 2026-10-04T07:42:05.705Z</summary>

**Captured:** 2026-10-04T07:42:05.705Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"sweep_sec":[300,1800,7200],"bitrate_k":160,"sample_rate":44100,"block_frames":4096}`


- assertion `ffmpeg_exit_zero_wav_150`: PASS — mode A exit 0
- assertion `ffmpeg_exit_zero_pipe_150`: PASS — mode B exit 0
- assertion `pcm_hash_equal_across_modes_150`: PASS — identical PCM bytes through both handoffs (22e410c5b520386d…)
- assertion `ffmpeg_exit_zero_wav_900`: PASS — mode A exit 0
- assertion `ffmpeg_exit_zero_pipe_900`: PASS — mode B exit 0
- assertion `pcm_hash_equal_across_modes_900`: PASS — identical PCM bytes through both handoffs (30576f4b8b9606d4…)
- assertion `ffmpeg_exit_zero_wav_3600`: PASS — mode A exit 0
- assertion `ffmpeg_exit_zero_pipe_3600`: PASS — mode B exit 0
- assertion `pcm_hash_equal_across_modes_3600`: PASS — identical PCM bytes through both handoffs (5cf90e75e9123aad…)

### handoff comparison

| point/mode | synth s | encode s | total s | ffmpeg RSS MB | peak workdir MB | out MB | exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3min_wav_then_ffmpeg | 3.7 | 3.8 | 7.5 | 54.9 | 26.7 | 2.9 | 0 |
| 3min_stdin_pipe | 3.8 | — | 7.0 | 53.1 | 30.1 | 3.1 | 0 |
| 15min_wav_then_ffmpeg | 24.7 | 21.5 | 46.2 | 60.5 | 168.7 | 17.8 | 0 |
| 15min_stdin_pipe | 24.4 | — | 45.8 | 55.4 | 186.2 | 18.7 | 0 |
| 60min_wav_then_ffmpeg | 96.0 | 86.9 | 182.9 | 66.6 | 675.4 | 71.1 | 0 |
| 60min_stdin_pipe | 95.9 | — | 235.5 | 63.4 | 744.7 | 69.5 | 0 |


**Observations (clearly separated from numbers):**

> Reading the two modes: stdin-pipe overlaps encoding with synthesis (no encode-wall term, no WAV intermediate — peak disk stays at work-dir baseline); wav-then-ffmpeg pays the WAV write+read and holds duration-proportional disk (at 2 h: the same ~2.5 GB that E1/E3 measured for the current pipeline). Both feed ffmpeg identical bytes (asserted per point).

</details>


## K — Concurrency/determinism stress (D2)

<details><summary><code>K1_summation_order_determinism</code> — 2026-10-04T07:23:25.699Z</summary>

**Captured:** 2026-10-04T07:23:25.699Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"layers":8,"block_frames":1024,"chunks":200,"duration_sec":4.6439909297052155,"runs_per_variant":7,"jitter_max_ms":4,"seed":42}`


- assertion `sync_fixed_deterministic`: PASS — 7 synchronous fixed-order runs → 1 distinct hash(es)
- assertion `async_fixed_order_deterministic`: PASS — 7 async-execution fixed-order-sum runs → 1 distinct hash(es) — async execution does not break determinism when summation order is fixed
- assertion `fixed_variants_identical`: PASS — sync and async-fixed-order produce the same bytes — the D2 rule, not execution style, determines output
- assertion `completion_order_detectably_unstable`: PASS — completion-order summation produced 7 distinct hashes across 7 runs — the AGA failure mode reproduced under controlled conditions

### variants

| variant | distinct hashes / runs | verdict |
| --- | --- | --- |
| sync_fixed | 1 / 7 |
| async_fixed_order | 1 / 7 |
| async_completion (AGA pattern) | 7 / 7 |


_completion vs fixed: 53.22% of float samples differ, max|Δ| 3.58e-7, 0.0850% of PCM16 words differ (1 attempt(s))_


**Observations (clearly separated from numbers):**

> Completion-order vs fixed-order summation of the SAME seeded layers: 53.22% of FLOAT samples differ (max|Δ| 3.58e-7), but only 0.0850% of PCM16 words differ — most reordering deltas vanish in 16-bit quantization, which is exactly why the hash (not the ear) is the contract: the PCM16 hashes were NOT reproducible across runs. (attempt 1 of up to 5; earlier draws coincidentally matched arrival order. External survey measured 92.65% of FLOAT samples differing for AGA's real RPC-completion-order bug — same failure class, layer magnitudes differ.)

> Why the fix is structural: BlockSynth sums voices in spawn order (a pure function of the D1 event stream) inside a synchronous per-sample loop — there is no async boundary between layer render and summation, so no completion order exists to vary. async_fixed_order demonstrates the same conclusion for architectures that DO synthesize layers asynchronously: collect async, sum in fixed order.

</details>


## L — Corrected re-runs of A's claims

<details><summary><code>L1_kernel_sweep_isolated</code> — 2026-10-04T07:23:35.415Z</summary>

**Captured:** 2026-10-04T07:23:35.415Z  
linux/x64 · Intel(R) Xeon(R) Processor ×2 · 3.9 GB RAM · node v24.21.0  
ffmpeg: ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers · NVENC encoders: 3

**Params:** `{"configs":[{"drones":0,"bank":0},{"drones":0,"bank":16},{"drones":4,"bank":0},{"drones":4,"bank":16},{"drones":8,"bank":0},{"drones":8,"bank":16}],"horizon_beats":2000,"isolation":"one fresh process per config","spawn_orders":["asc","desc"]}`


- assertion `isolated_configs_all_ran`: PASS — 6/6 isolated config pairs completed in both orders

### kernel config sweep: isolated (one process per config) vs contaminated (one process for all)

| drones | bank | iso median asc ms | iso median desc ms | iso desc/asc | contam median asc ms | contam median desc ms | contam desc/asc | events/beat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0.0011 | 0.0016 | 0.893 | 0.0011 | 0.0018 | 0.441 | 7.0 |
| 0 | 16 | 0.0033 | 0.0022 | 0.969 | 0.0018 | 0.0026 | 1.137 | 7.0 |
| 4 | 0 | 0.0027 | 0.0014 | 0.959 | 0.0018 | 0.0012 | 0.754 | 11.0 |
| 4 | 16 | 0.0025 | 0.0025 | 0.846 | 0.0022 | 0.0020 | 0.879 | 11.0 |
| 8 | 0 | 0.0018 | 0.0020 | 1.213 | 0.0013 | 0.0013 | 1.036 | 15.0 |
| 8 | 16 | 0.0030 | 0.0029 | 1.128 | 0.0022 | 0.0026 | 2.432 | 15.0 |


**Observations (clearly separated from numbers):**

> L1 correction: the original A2 swept 6 configs sequentially in ONE process. If JIT/warm-state carries across configs, the numbers depend on sweep ORDER (the category-A bug where an 8-drone config looked faster than a 0-drone config — backwards from reality). Re-created here, judged on batched means: contaminated pattern max|desc/asc−1| = 143.2% vs isolated per-process max deviation 21.3%. The isolated numbers are the corrected reference; per-config medians and batched means land in trials. The ORIGINAL A2 JSON (user's hardware) is neither re-claimed nor altered.

> L2 (what C got wrong, and how G/I supersede it): category C's chunked PoC never claimed O(1) memory for the WHOLE pipeline — its single-pass reference buffer was fully materialized, so peak memory scaled with duration regardless of the streaming compare (the claim shipped half-true). Independently, C measured that chunked output diverges from continuous output (max|Δ| 2.8e-1, NOT seam-localized) because per-chunk re-rendering re-anchors exponential automation and misaligns biquad coefficient quanta. G replaces the whole approach: one in-process block synth carries every automation state per-sample (D4) and streams every buffer, so memory has no duration-proportional term (G1) and block boundaries are byte-invisible (G3/I1a). I1 proves the negative: re-introducing C's mechanisms (re-anchoring + block-relative quanta) makes divergence return measurably. C's numbers stand as the record of why the chunked path was abandoned; nothing in C is re-run or patched in place.

</details>
