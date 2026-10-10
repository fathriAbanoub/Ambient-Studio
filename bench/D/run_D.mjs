/**
 * bench/D/run_D.mjs — ffmpeg video encode ladder (independently runnable):
 *   node bench/D/run_D.mjs [--scale S] [--long-2h] [--long-8h] [--full]
 *
 * D0 NVENC probe (ported verbatim from video_renderer.py:58-80)
 * D1 static-image @1fps (the repo's proven trick, video_renderer.py:123/262/325)
 * D2 still-image slow zoom via zoompan (corrected command — the crop-based
 *    variant from the design docs cannot animate: crop w/h are evaluated once)
 * D3 looping background (GIF and MP4 sources)
 * D4 build-once + stream-copy assembly vs naive full re-encode
 * D5 peak RSS / disk usage recorded for every ffmpeg run (in ffmpegRun)
 *
 * Command shapes mirror the repo: libx264 -preset veryfast -crf 23
 * (config.py), NVENC -preset p1 -rc vbr -cq 23 -b:v 5M
 * (video_renderer.py:100), -pix_fmt yuv420p, -movflags +faststart,
 * explicit -t (no -shortest, per the design discussion).
 */
import path from "node:path";
import fs from "node:fs";
import { Result, skipBench } from "../lib/result.mjs";
import { ffmpegRun, probeNvenc, lavfiAudioArgs, runProcess } from "../lib/ffmpeg.mjs";
import { DirSizeSampler } from "../lib/procmon.mjs";
import { diskFree } from "../lib/env.mjs";
import { ensureAssets } from "../lib/assets.mjs";
import {
  D_VIDEO_WIDTH, D_VIDEO_HEIGHT, D_CRF, D_X264_PRESET, D_NVENC_ARGS,
  D_AUDIO_CODEC, D_ZOOM_START, D_ZOOM_END, D_ZOOM_UPSCALE_WIDTH,
  D_STATIC_SWEEP_MIN, D_MOTION_SWEEP_MIN, D_ZOOM_FPS_DEFAULT, D_ZOOM_FPS_FULL,
  D_LOOP_FPS_DEFAULT, D_FADE_SEC, D_HEAD_TAIL_SEC, D4_BODY_SEC_STATIC,
  D4_ZOOM_SEGMENTS, D_LONG_MIN_2H, D_LONG_MIN_8H, DISK_SAFETY_MARGIN,
} from "../lib/constants.mjs";

const ENV = JSON.parse(process.env.BENCH_ENV ?? "{}");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR;
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const LONG_2H = process.env.BENCH_LONG_2H === "1";
const LONG_8H = process.env.BENCH_LONG_8H === "1";
const FULL = process.env.BENCH_FULL === "1";
const KEEP = process.env.BENCH_KEEP_ARTIFACTS === "1";
const WORK_ROOT = path.join(RESULTS_DIR, "..", "work");

const X264_ARGS = ["-c:v", "libx264", "-preset", D_X264_PRESET, "-crf", String(D_CRF)];
const NVENC_ARGS = ["-c:v", "h264_nvenc", ...D_NVENC_ARGS];

function scaleMinutes(mins) {
  const list = mins.map((m) => m * SCALE);
  if (LONG_2H) list.push(D_LONG_MIN_2H);
  if (LONG_8H) list.push(D_LONG_MIN_8H);
  return [...new Set(list)].sort((a, b) => a - b);
}

async function probeOutput(file) {
  const res = await runProcess("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,nb_frames",
    "-show_entries", "format=duration,size", "-of", "json", file,
  ]);
  try {
    const j = JSON.parse(res.stdout);
    return {
      ffprobe_duration_sec: Number(j.format?.duration ?? NaN),
      width: j.streams?.[0]?.width, height: j.streams?.[0]?.height,
      avg_frame_rate: j.streams?.[0]?.avg_frame_rate,
      ffprobe_size_bytes: Number(j.format?.size ?? NaN),
    };
  } catch {
    return { ffprobe_error: res.stderr.slice(-200) };
  }
}

function diskGuardBytes(durationMin, mode) {
  // Conservative pre-flight estimates (x264 1080p upper bounds), NOT expected
  // values: static ≈ 0.6 GB/h, loop ≈ 1.5 GB/h, zoom@10fps ≈ 4 GB/h.
  const perMin = mode === "static" ? 10 : mode === "loop" ? 25 : 66;
  return Math.ceil(durationMin * perMin * 1024 * 1024);
}

async function encodeOnce(workDir, label, args, sampler) {
  const out = path.join(workDir, `${label}.mp4`);
  const res = await ffmpegRun([...args, "-y", out]);
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
  const probe = res.code === 0 ? await probeOutput(out) : {};
  if (!KEEP && res.code === 0) fs.rmSync(out, { force: true });
  return { label, ...res, output_bytes: size, ...probe, dir_samples: sampler ? sampler.samples.length : 0 };
}

export async function runD() {
  console.log("[D] ffmpeg video encode ladder");
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const assets = await ensureAssets();
  if (!assets.still.path) {
    await skipBench(RESULTS_DIR, "D0_nvenc_probe", "D", ENV, `ffmpeg could not generate synthetic assets: ${assets.still.error}`);
    await skipBench(RESULTS_DIR, "D1_static_ladder", "D", ENV, "no background asset (ffmpeg generation failed)");
    await skipBench(RESULTS_DIR, "D2_zoom_ladder", "D", ENV, "no background asset (ffmpeg generation failed)");
    await skipBench(RESULTS_DIR, "D3_loop_ladder", "D", ENV, "no loop asset (ffmpeg generation failed)");
    await skipBench(RESULTS_DIR, "D4_assembly_vs_naive", "D", ENV, "no assets (ffmpeg generation failed)");
    return;
  }

  // ── D0: NVENC probe ──────────────────────────────────────────────────────
  const nvenc = await probeNvenc();
  const d0 = new Result("D0_nvenc_probe", "D", ENV, { probe: nvenc, encoders_scan: ENV.ffmpeg?.nvenc_encoders },
    { measured: "h264_nvenc usability (exact port of video_renderer.py:58-80)", granularity: "single probe run, exit code", trials: 1, warmup: "none", outliers: "n/a", statistic: "pass/fail + raw probe output" });
  d0.addAssertion("nvenc_probe_determinant", true, `available=${nvenc.available}; later NVENC modes reference this result and self-skip`);
  console.log(`  D0: NVENC ${nvenc.available ? "AVAILABLE" : "unavailable"}`);
  await d0.write(RESULTS_DIR);
  const codecs = nvenc.available ? ["libx264", "h264_nvenc"] : ["libx264"];

  const codecArgs = (codec) => (codec === "h264_nvenc" ? NVENC_ARGS : X264_ARGS);

  // Optional per-ladder selection (BENCH_D_LADDERS=D3,D4) for run windows
  // shorter than the whole category. Default: every ladder runs.
  const ONLY = (process.env.BENCH_D_LADDERS ?? "").split(",").filter(Boolean);
  const want = (id) => ONLY.length === 0 || ONLY.includes(id);

  // ── shared run helper ────────────────────────────────────────────────────
  async function ladder(benchId, modes) {
    if (!want(benchId.slice(0, 2))) {
      console.log(`  ${benchId}: SKIPPED (BENCH_D_LADDERS=${ONLY.join(",")})`);
      return undefined;
    }
    const workDir = fs.mkdtempSync(path.join(WORK_ROOT, `${benchId}__`));
    const result = new Result(benchId, "D", ENV, {
      video: `${D_VIDEO_WIDTH}x${D_VIDEO_HEIGHT}`, crf: D_CRF, x264_preset: D_X264_PRESET, nvenc_args: D_NVENC_ARGS,
      audio: "lavfi anoisesrc (deterministic seed) streamed — no WAV temp",
      assets: { bg: assets.still.source, loop_gif: assets.gif?.source, loop_mp4: assets.loopMp4?.source },
      modes,
    }, {
      measured: "wall-clock encode time and output size per mode/duration/fps/codec; peak ffmpeg RSS and peak work-dir size (D5) recorded per run",
      granularity: "per ffmpeg invocation; ffprobe of each output for duration/fps truth",
      trials: "1 per combination (encodes are minutes-long; medians across combos are meaningless, ratios are the point)",
      warmup: "none",
      outliers: "none removed; failed runs recorded with stderr tail",
      statistic: "per-run wall_sec, output_bytes, peak_rss_bytes, ffprobe_duration_sec",
    });
    const sampler = new DirSizeSampler(workDir);
    for (const mode of modes) {
      for (const codec of codecs) {
        if (codec === "h264_nvenc" && !nvenc.available) continue;
        if (mode.disk_guard_min) {
          const free = await diskFree(WORK_ROOT);
          const need = diskGuardBytes(mode.disk_guard_min, mode.kind) * DISK_SAFETY_MARGIN;
          if (free.free_bytes !== null && free.free_bytes < need) {
            result.addTrial(`${mode.label}__${codec}`, mode, [],
              { skipped_within_run: `insufficient disk: need ≈ ${need} bytes, free ${free.free_bytes}` });
            continue;
          }
        }
        const run = await encodeOnce(workDir, `${mode.label}__${codec}`, mode.args(codec), sampler);
        result.addTrial(`${mode.label}__${codec}`, { ...mode.params, kind: mode.kind }, [run.wall_sec], {
          command: run.command, output_bytes: run.output_bytes, peak_rss_bytes: run.peak_rss_bytes,
          ffprobe: { duration_sec: run.ffprobe_duration_sec, avg_frame_rate: run.avg_frame_rate, width: run.width, height: run.height },
          timed_out: run.timedOut, stderr_tail: run.code === 0 ? undefined : run.stderr_tail,
        });
        console.log(`  ${mode.label} [${codec}]: ${run.wall_sec.toFixed(1)}s → ${(run.output_bytes / 1048576).toFixed(1)} MB`);
      }
    }
    sampler.stop();
    result.doc.stats.peak_workdir_bytes = sampler.peakBytes;
    await result.write(RESULTS_DIR);
    if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
    return result;
  }

  // ── D1: static @1fps ────────────────────────────────────────────────────
  console.log("  D1: static-image @1fps");
  {
    const modes = scaleMinutes(D_STATIC_SWEEP_MIN).map((min) => {
      const sec = Math.round(min * 60);
      return {
        kind: "static", label: `static_${min}min`, disk_guard_min: min,
        params: { duration_min: min, fps: 1, zoom: null, loop_source: null },
        args: (codec) => [
          "-loop", "1", "-framerate", "1", "-i", assets.still.path,
          ...lavfiAudioArgs(sec),
          "-map", "0:v", "-map", "1:a",
          ...codecArgs(codec), "-pix_fmt", "yuv420p", "-r", "1",
          "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(sec),
        ],
      };
    });
    await ladder("D1_static_ladder", modes);
  }

  // ── D2: zoompan slow zoom ────────────────────────────────────────────────
  console.log("  D2: still-image zoom (zoompan)");
  {
    const fpsChoices = FULL ? D_ZOOM_FPS_FULL : D_ZOOM_FPS_DEFAULT;
    const modes = [];
    for (const min of scaleMinutes(D_MOTION_SWEEP_MIN)) {
      const sec = Math.round(min * 60);
      for (const fps of fpsChoices) {
        const totalFrames = fps * sec;
        const zoomRate = (D_ZOOM_END - D_ZOOM_START) / totalFrames;
        modes.push({
          kind: "zoom", label: `zoom_${min}min_${fps}fps`, disk_guard_min: min,
          params: { duration_min: min, fps, zoompan: `z='${D_ZOOM_START}+${zoomRate.toExponential(6)}*on'`, upscale_width: D_ZOOM_UPSCALE_WIDTH },
          args: (codec) => [
            "-loop", "1", "-framerate", String(fps), "-i", assets.still.path,
            ...lavfiAudioArgs(sec),
            "-map", "0:v", "-map", "1:a",
            "-vf", `scale=${D_ZOOM_UPSCALE_WIDTH}:-2,zoompan=z='${D_ZOOM_START}+${zoomRate.toExponential(6)}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${D_VIDEO_WIDTH}x${D_VIDEO_HEIGHT},format=yuv420p`,
            ...codecArgs(codec), "-r", String(fps),
            "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(sec),
          ],
        });
      }
    }
    await ladder("D2_zoom_ladder", modes);
  }

  // ── D3: looping background (gif + mp4) ──────────────────────────────────
  console.log("  D3: looping background");
  {
    const modes = [];
    for (const min of scaleMinutes(D_MOTION_SWEEP_MIN)) {
      const sec = Math.round(min * 60);
      for (const fps of D_LOOP_FPS_DEFAULT) {
        for (const [srcKind, srcAsset, srcPath] of [
          ["gif", assets.gif, assets.gif.path],
          ["mp4", assets.loopMp4, assets.loopMp4.path],
        ]) {
          if (!srcAsset?.path) continue;
          modes.push({
            kind: "loop", label: `loop_${srcKind}_${min}min_${fps}fps`, disk_guard_min: min,
            params: { duration_min: min, fps, loop_source: srcKind, loop_source_sec: srcKind === "gif" ? 30 : 10 },
            args: (codec) => [
              "-stream_loop", "-1", "-i", srcPath,
              ...lavfiAudioArgs(sec),
              "-map", "0:v", "-map", "1:a",
              "-vf", `scale=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT},fps=${fps},format=yuv420p`,
              ...codecArgs(codec),
              "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(sec),
            ],
          });
        }
      }
    }
    await ladder("D3_loop_ladder", modes);
  }

  // ── D4: build-once + stream-copy assembly vs naive full re-encode ───────
  if (want("D4")) {
    console.log("  D4: assembly vs naive");
    await runD4(assets, codecs, codecArgs, nvenc.available);
  } else {
    console.log(`  D4: SKIPPED (BENCH_D_LADDERS=${ONLY.join(",")})`);
  }
}

async function runD4(assets, codecs, codecArgs, nvencAvailable) {
  const TARGET_MIN = 30 * SCALE;
  const targetSec = Math.round(TARGET_MIN * 60);
  const workDir = fs.mkdtempSync(path.join(WORK_ROOT, "D4_assembly_vs_naive__"));
  const sampler = new DirSizeSampler(workDir);
  const result = new Result("D4_assembly_vs_naive", "D", ENV, {
    target_min: TARGET_MIN, head_tail_sec: D_HEAD_TAIL_SEC, fade_sec: D_FADE_SEC,
    body_sec_static: D4_BODY_SEC_STATIC, zoom_segments: D4_ZOOM_SEGMENTS,
    segment_format: "mpegts → concat -c copy -bsf:a aac_adtstoasc -movflags +faststart",
  }, {
    measured: "build-once segment encode time + stream-copy assembly time vs naive full-duration re-encode, per mode and codec",
    granularity: "per ffmpeg invocation; assembly wall clock = concat run only",
    trials: "1 per mode/codec",
    warmup: "none",
    outliers: "none removed",
    statistic: "build_sec, assemble_sec, naive_sec, speedup_ratio (naive / (build+assemble))",
  });

  const segArgs = (codec, vf, sec, framesPerSec) => [
    ...lavfiAudioArgs(sec),
    "-vf", vf, ...codecArgs(codec),
    ...(framesPerSec ? ["-r", String(framesPerSec)] : []),
    "-c:a", D_AUDIO_CODEC, "-f", "mpegts", "-t", String(sec),
  ];

  for (const codec of codecs) {
    if (codec === "h264_nvenc" && !nvencAvailable) continue;

    // static: body encoded once, reused for every repeat
    {
      const bodySec = D4_BODY_SEC_STATIC;
      const repeats = Math.max(1, Math.floor((targetSec - 2 * D_HEAD_TAIL_SEC) / bodySec));
      const t0 = performance.now();
      console.error(`  D4 static [${codec}]: encoding head/body/tail segments…`);
      const head = await ffmpegRun([
        "-loop", "1", "-framerate", "1", "-i", assets.still.path,
        ...segArgs(codec, `scale=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT},fade=t=in:d=${D_FADE_SEC},format=yuv420p`, D_HEAD_TAIL_SEC, 1),
        path.join(workDir, `head_${codec}.ts`),
      ]);
      const body = await ffmpegRun([
        "-loop", "1", "-framerate", "1", "-i", assets.still.path,
        ...segArgs(codec, `scale=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT},format=yuv420p`, bodySec, 1),
        path.join(workDir, `body_${codec}.ts`),
      ]);
      const tail = await ffmpegRun([
        "-loop", "1", "-framerate", "1", "-i", assets.still.path,
        ...segArgs(codec, `scale=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT},fade=t=out:st=${D_HEAD_TAIL_SEC - D_FADE_SEC}:d=${D_FADE_SEC},format=yuv420p`, D_HEAD_TAIL_SEC, 1),
        path.join(workDir, `tail_${codec}.ts`),
      ]);
      const buildSec = (performance.now() - t0) / 1000;
      const list = [head, body, tail].every((r) => r.code === 0)
        ? [path.join(workDir, `head_${codec}.ts`),
           ...Array(repeats).fill(path.join(workDir, `body_${codec}.ts`)),
           path.join(workDir, `tail_${codec}.ts`)]
        : [];
      const listFile = path.join(workDir, `concat_${codec}.txt`);
      fs.writeFileSync(listFile, list.map((l) => `file '${l.replace(/\\/g, "/")}'`).join("\n"));
      const t1 = performance.now();
      const asm = list.length
        ? await ffmpegRun(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", path.join(workDir, `assembled_static_${codec}.mp4`)])
        : { code: -1, stderr_tail: "segment encode failed", wall_sec: NaN };
      const assembleSec = (performance.now() - t1) / 1000;
      const naive = await ffmpegRun([
        "-loop", "1", "-framerate", "1", "-i", assets.still.path,
        ...lavfiAudioArgs(targetSec),
        "-map", "0:v", "-map", "1:a",
        ...codecArgs(codec), "-pix_fmt", "yuv420p", "-r", "1",
        "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(targetSec),
        path.join(workDir, `naive_static_${codec}.mp4`),
      ]);
      const probe = asm.code === 0 ? await probeOutput(path.join(workDir, `assembled_static_${codec}.mp4`)) : {};
      result.addTrial(`static__${codec}`, { mode: "static", codec, repeats }, [naive.wall_sec], {
        build_sec: buildSec, assemble_sec: assembleSec, naive_sec: naive.wall_sec,
        speedup_ratio: naive.wall_sec / (buildSec + assembleSec),
        assembled_ffprobe: probe, segment_failures: [head, body, tail].filter((r) => r.code !== 0).length,
      });
      console.log(`  static [${codec}]: build ${buildSec.toFixed(1)}s + assemble ${assembleSec.toFixed(1)}s vs naive ${naive.wall_sec.toFixed(1)}s`);
    }

    // loop (mp4 source): body = one encoded loop pass, reused
    if (assets.loopMp4.path) {
      const loopSec = 10;
      const repeats = Math.max(1, Math.floor((targetSec - 2 * D_HEAD_TAIL_SEC) / loopSec));
      const t0 = performance.now();
      console.error(`  D4 loop [${codec}]: encoding head/body/tail segments…`);
      const vfBase = `scale=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${D_VIDEO_WIDTH}:${D_VIDEO_HEIGHT},fps=10,format=yuv420p`;
      const head = await ffmpegRun(["-stream_loop", "-1", "-i", assets.loopMp4.path, ...segArgs(codec, `${vfBase},fade=t=in:d=${D_FADE_SEC}`, D_HEAD_TAIL_SEC, 10), path.join(workDir, `head_loop_${codec}.ts`)]);
      const body = await ffmpegRun(["-i", assets.loopMp4.path, ...segArgs(codec, vfBase, loopSec, 10), path.join(workDir, `body_loop_${codec}.ts`)]);
      const tail = await ffmpegRun(["-stream_loop", "-1", "-i", assets.loopMp4.path, ...segArgs(codec, `${vfBase},fade=t=out:st=${D_HEAD_TAIL_SEC - D_FADE_SEC}:d=${D_FADE_SEC}`, D_HEAD_TAIL_SEC, 10), path.join(workDir, `tail_loop_${codec}.ts`)]);
      const buildSec = (performance.now() - t0) / 1000;
      const list = [head, body, tail].every((r) => r.code === 0)
        ? [path.join(workDir, `head_loop_${codec}.ts`),
           ...Array(repeats).fill(path.join(workDir, `body_loop_${codec}.ts`)),
           path.join(workDir, `tail_loop_${codec}.ts`)]
        : [];
      const listFile = path.join(workDir, `concat_loop_${codec}.txt`);
      fs.writeFileSync(listFile, list.map((l) => `file '${l.replace(/\\/g, "/")}'`).join("\n"));
      const t1 = performance.now();
      const asm = list.length
        ? await ffmpegRun(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", path.join(workDir, `assembled_loop_${codec}.mp4`)])
        : { code: -1, stderr_tail: "segment encode failed", wall_sec: NaN };
      const assembleSec = (performance.now() - t1) / 1000;
      const naive = await ffmpegRun([
        "-stream_loop", "-1", "-i", assets.loopMp4.path,
        ...lavfiAudioArgs(targetSec),
        "-map", "0:v", "-map", "1:a",
        "-vf", vfBase, ...codecArgs(codec),
        "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(targetSec),
        path.join(workDir, `naive_loop_${codec}.mp4`),
      ]);
      const probe = asm.code === 0 ? await probeOutput(path.join(workDir, `assembled_loop_${codec}.mp4`)) : {};
      result.addTrial(`loop__${codec}`, { mode: "loop", codec, repeats }, [naive.wall_sec], {
        build_sec: buildSec, assemble_sec: assembleSec, naive_sec: naive.wall_sec,
        speedup_ratio: naive.wall_sec / (buildSec + assembleSec),
        assembled_ffprobe: probe, segment_failures: [head, body, tail].filter((r) => r.code !== 0).length,
      });
      console.log(`  loop [${codec}]: build ${buildSec.toFixed(1)}s + assemble ${assembleSec.toFixed(1)}s vs naive ${naive.wall_sec.toFixed(1)}s`);
    }

    // zoom: monotonic zoom cannot loop — segments carry a continuing zoom
    {
      const fps = 10;
      const segSec = targetSec / 4; // D4_ZOOM_SEGMENTS scaled to a 30-min budget
      const segCount = Math.max(2, Math.min(D4_ZOOM_SEGMENTS, Math.round(targetSec / segSec)));
      const framesPerSeg = fps * segSec;
      const totalFrames = fps * targetSec;
      const zoomRate = (D_ZOOM_END - D_ZOOM_START) / totalFrames;
      const t0 = performance.now();
      console.error(`  D4 zoom [${codec}]: encoding ${segCount} continuing-zoom segments (this is the slowest D4 case)…`);
      const segs = [];
      let failures = 0;
      for (let k = 0; k < segCount; k++) {
        const fade = k === 0 ? `fade=t=in:d=${D_FADE_SEC},` : k === segCount - 1 ? `fade=t=out:st=${segSec - D_FADE_SEC}:d=${D_FADE_SEC},` : "";
        const r = await ffmpegRun([
          "-loop", "1", "-framerate", String(fps), "-i", assets.still.path,
          ...segArgs(codec,
            `scale=${D_ZOOM_UPSCALE_WIDTH}:-2,zoompan=z='${D_ZOOM_START}+${(k * framesPerSeg * zoomRate).toExponential(6)}+${zoomRate.toExponential(6)}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${D_VIDEO_WIDTH}x${D_VIDEO_HEIGHT},${fade}format=yuv420p`,
            segSec, fps),
          path.join(workDir, `zoomseg_${codec}_${k}.ts`),
        ]);
        segs.push(path.join(workDir, `zoomseg_${codec}_${k}.ts`));
        if (r.code !== 0) failures++;
      }
      const buildSec = (performance.now() - t0) / 1000;
      const listFile = path.join(workDir, `concat_zoom_${codec}.txt`);
      fs.writeFileSync(listFile, segs.map((l) => `file '${l.replace(/\\/g, "/")}'`).join("\n"));
      const t1 = performance.now();
      const asm = failures === 0
        ? await ffmpegRun(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", path.join(workDir, `assembled_zoom_${codec}.mp4`)])
        : { code: -1, stderr_tail: `${failures} segment encodes failed`, wall_sec: NaN };
      const assembleSec = (performance.now() - t1) / 1000;
      const naive = await ffmpegRun([
        "-loop", "1", "-framerate", String(fps), "-i", assets.still.path,
        ...lavfiAudioArgs(targetSec),
        "-map", "0:v", "-map", "1:a",
        "-vf", `scale=${D_ZOOM_UPSCALE_WIDTH}:-2,zoompan=z='${D_ZOOM_START}+${zoomRate.toExponential(6)}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${D_VIDEO_WIDTH}x${D_VIDEO_HEIGHT},format=yuv420p`,
        ...codecArgs(codec), "-r", String(fps),
        "-c:a", D_AUDIO_CODEC, "-movflags", "+faststart", "-t", String(targetSec),
        path.join(workDir, `naive_zoom_${codec}.mp4`),
      ]);
      const probe = asm.code === 0 ? await probeOutput(path.join(workDir, `assembled_zoom_${codec}.mp4`)) : {};
      result.addTrial(`zoom__${codec}`, { mode: "zoom", codec, seg_count: segCount, seg_sec: segSec }, [naive.wall_sec], {
        build_sec: buildSec, assemble_sec: assembleSec, naive_sec: naive.wall_sec,
        speedup_ratio: naive.wall_sec / (buildSec + assembleSec),
        assembled_ffprobe: probe, segment_failures: failures,
      });
      console.log(`  zoom [${codec}]: build ${buildSec.toFixed(1)}s + assemble ${assembleSec.toFixed(1)}s vs naive ${naive.wall_sec.toFixed(1)}s`);
    }
  }
  sampler.stop();
  result.doc.stats.peak_workdir_bytes = sampler.peakBytes;
  await result.write(RESULTS_DIR);
  if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runD();
}
