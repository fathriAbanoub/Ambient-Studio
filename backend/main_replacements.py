import asyncio
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import File, Form, HTTPException, UploadFile

from config import settings
from services.audio_debug import log_audio_debug
from services.audio_renderer import AudioRenderer
from services.entropy_layer import EntropyLayerParams, SlowDriftProcessor
from services.loop_analyzer import analyze_loop
from services.loop_processor import assemble_with_rotation, extend_loop_seamless, make_loop
from services.variation_scheduler import LoopSegment, StochasticVariationScheduler
from services.video_renderer import VideoRenderer

app = None
job_manager = None
render_semaphore = None
logger = None

def validate_audio_file(file):
    ...

async def validate_file_size(file):
    ...

def log_render(*args, **kwargs):
    ...


@app.post("/render-video-full")
async def render_video_full(
    duration: int = Form(..., gt=0, le=settings.MAX_DURATION),
    files: list[UploadFile] = File(...),
    volumes: str = Form(""),
    pans: str = Form(""),
    muted: str = Form(""),
    solo: str = Form(""),
    master_gain: float = Form(1.0),
    eq_gains: str = Form(""),
    background_image: UploadFile | None = File(None),
    show_visualizer: str = Form("0"),
    use_gpu_encoding: str = Form("1"),
    loop_start: Optional[float] = Form(None),
    loop_end: Optional[float] = Form(None),
):
    if duration > settings.MAX_DURATION:
        raise HTTPException(400, f"Duration exceeds maximum of {settings.MAX_DURATION}s")

    for f in files:
        validate_audio_file(f)
        await validate_file_size(f)

    job_id = job_manager.create_job(duration)
    job_dir = Path(settings.TMP_DIR) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    track_paths: list[Path] = []
    for i, upload in enumerate(files):
        ext = Path(upload.filename).suffix or ".audio"
        dest = job_dir / f"track_{i:02d}{ext}"
        with dest.open("wb") as f:
            shutil.copyfileobj(upload.file, f)
        track_paths.append(dest)

    def parse_floats(s: str, count: int, default: float) -> list[float]:
        parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
        result = [float(p) for p in parts]
        while len(result) < count:
            result.append(default)
        return result[:count]

    def parse_bools(s: str, count: int) -> list[bool]:
        parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
        result = [bool(int(p)) for p in parts]
        while len(result) < count:
            result.append(False)
        return result[:count]

    n = len(track_paths)
    vol_list = parse_floats(volumes, n, 1.0)
    pan_list = parse_floats(pans, n, 0.0)
    muted_list = parse_bools(muted, n)
    solo_list = parse_bools(solo, n)
    eq_list = parse_floats(eq_gains, 7, 0.0)
    show_viz = show_visualizer == "1"
    use_gpu = use_gpu_encoding == "1"

    if background_image:
        img_ext = Path(background_image.filename).suffix or ".jpg"
        bg_path = job_dir / f"background{img_ext}"
        with bg_path.open("wb") as f:
            shutil.copyfileobj(background_image.file, f)
    else:
        bg_path = Path(settings.DEFAULT_BACKGROUND)

    async def render_task() -> None:
        start_time = time.time()

        def log_with_time(message: str) -> None:
            elapsed = time.time() - start_time
            timestamp_msg = f"[{elapsed:.2f}s] {message}"
            logger.info(timestamp_msg)
            job_manager.update_progress(
                job_id,
                job_manager.jobs[job_id]["progress"],
                {"log_message": timestamp_msg},
            )

        def debug_audio_stage(label: str, path: Path) -> None:
            if not settings.AUDIO_DEBUG:
                return

            def _sink(msg: str) -> None:
                log_with_time(f"🧪 {label} | {msg}")

            try:
                log_audio_debug(path, log_fn=_sink)
            except Exception as exc:
                log_with_time(f"🧪 {label} | debug failed: {exc}")

        audio_renderer = AudioRenderer(settings)
        video_renderer = VideoRenderer(settings)
        entropy_processor = SlowDriftProcessor()
        source_mix_path = job_dir / "mix.wav"
        video_path = job_dir / "ambient_video.mp4"

        try:
            log_with_time("⏳ Waiting for render slot...")
            job_manager.update_progress(job_id, 0, {"status": "waiting_for_slot"})

            async with render_semaphore:
                job_manager.start_job(job_id)
                log_with_time("🎬 Starting render job...")
                job_manager.update_progress(job_id, 5, {"status": "initializing"})

                audio_start = time.time()

                def audio_progress_cb(progress_percent: int) -> None:
                    overall = 10 + int(progress_percent * 0.25)
                    job_manager.update_progress(job_id, overall)

                log_with_time(f"🎵 Rendering source mix ({n} tracks)...")
                job_manager.update_progress(job_id, 10, {"status": "rendering_audio"})
                await asyncio.to_thread(
                    audio_renderer.render,
                    track_paths=track_paths,
                    output_path=source_mix_path,
                    duration_seconds=duration,
                    volumes=vol_list,
                    pans=pan_list,
                    muted=muted_list,
                    solo=solo_list,
                    master_gain=master_gain,
                    eq_gains=eq_list,
                    progress_callback=audio_progress_cb,
                    render_source_once=True,
                )

                audio_time = time.time() - audio_start
                log_with_time(f"✓ Source mix rendered ({audio_time:.2f}s)")
                await asyncio.to_thread(debug_audio_stage, "mix.wav", source_mix_path)
                job_manager.update_progress(job_id, 35, {"status": "mix_complete"})

                def manual_candidate(loop_start_seconds: float, loop_end_seconds: float) -> dict[str, object]:
                    loop_start_ms = int(round(loop_start_seconds * 1000.0))
                    loop_end_ms = int(round(loop_end_seconds * 1000.0))
                    loop_duration_ms = max(1, loop_end_ms - loop_start_ms)
                    crossfade_ms = min(4000, max(500, int(loop_duration_ms * 0.07)))
                    canonical_duration_ms = max(1, loop_duration_ms - crossfade_ms)
                    return {
                        "segment_id": "candidate_01",
                        "source_path": str(source_mix_path.resolve()),
                        "loop_start_ms": loop_start_ms,
                        "loop_end_ms": loop_end_ms,
                        "canonical_duration_ms": canonical_duration_ms,
                        "play_duration_ms": canonical_duration_ms,
                        "crossfade_duration_ms": crossfade_ms,
                        "trim_tail_ms": 0,
                        "raw_analyzer_score": 1.0,
                        "validator_score": 1.0,
                        "repetition_salience_score": 0.0,
                    }

                if loop_start is not None and loop_end is not None:
                    analysis = {
                        "loop_start_ms": int(round(loop_start * 1000.0)),
                        "loop_end_ms": int(round(loop_end * 1000.0)),
                        "score": 1.0,
                        "crossfade_ms": manual_candidate(loop_start, loop_end)["crossfade_duration_ms"],
                        "candidates": [manual_candidate(loop_start, loop_end)],
                    }
                    log_with_time(
                        f"📍 Using manual loop points: {loop_start:.3f}s → {loop_end:.3f}s"
                    )
                else:
                    log_with_time("🧠 Analyzing loop points with PyMusicLooper...")
                    analysis = await asyncio.to_thread(analyze_loop, source_mix_path)
                    log_with_time(
                        f"🧠 Best loop points: {analysis['loop_start_ms'] / 1000.0:.3f}s → "
                        f"{analysis['loop_end_ms'] / 1000.0:.3f}s "
                        f"(score={analysis['score']:.3f}, crossfade={analysis['crossfade_ms'] / 1000.0:.3f}s)"
                    )
                job_manager.update_progress(job_id, 40, {"status": "loop_analyzed"})

                analysis_candidates = list(analysis.get("candidates") or [])
                if not analysis_candidates:
                    fallback_crossfade_ms = int(analysis["crossfade_ms"])
                    fallback_duration_ms = max(
                        1,
                        int(analysis["loop_end_ms"]) - int(analysis["loop_start_ms"]) - fallback_crossfade_ms,
                    )
                    analysis_candidates = [
                        {
                            "segment_id": "candidate_01",
                            "source_path": str(source_mix_path.resolve()),
                            "loop_start_ms": int(analysis["loop_start_ms"]),
                            "loop_end_ms": int(analysis["loop_end_ms"]),
                            "canonical_duration_ms": fallback_duration_ms,
                            "play_duration_ms": fallback_duration_ms,
                            "crossfade_duration_ms": fallback_crossfade_ms,
                            "trim_tail_ms": 0,
                            "raw_analyzer_score": float(analysis.get("raw_analyzer_score", analysis["score"])),
                            "validator_score": float(analysis["score"]),
                            "repetition_salience_score": 0.0,
                        }
                    ]

                log_with_time(f"🎛️ Preparing {len(analysis_candidates)} loop candidate(s)...")
                loop_palette: list[LoopSegment] = []
                for candidate in analysis_candidates:
                    segment_id = str(candidate["segment_id"])
                    loop_unit_path = job_dir / f"{segment_id}.wav"
                    crossfade_ms = int(candidate.get("crossfade_duration_ms", candidate.get("crossfade_ms", analysis["crossfade_ms"])))
                    loop_start_seconds = int(candidate["loop_start_ms"]) / 1000.0
                    loop_end_seconds = int(candidate["loop_end_ms"]) / 1000.0
                    try:
                        await asyncio.to_thread(
                            make_loop,
                            source_mix_path,
                            loop_unit_path,
                            crossfade_ms / 1000.0,
                            loop_start_seconds,
                            loop_end_seconds,
                        )
                    except Exception as exc:
                        log_with_time(f"⚠️ Skipping {segment_id}: {exc}")
                        continue

                    canonical_duration_ms = max(
                        1,
                        int(
                            candidate.get(
                                "canonical_duration_ms",
                                max(1, int(candidate["loop_end_ms"]) - int(candidate["loop_start_ms"]) - crossfade_ms),
                            )
                        ),
                    )
                    loop_palette.append(
                        LoopSegment(
                            segment_id=segment_id,
                            source_path=str(loop_unit_path),
                            loop_start_ms=int(candidate["loop_start_ms"]),
                            loop_end_ms=int(candidate["loop_end_ms"]),
                            canonical_duration_ms=canonical_duration_ms,
                            play_duration_ms=canonical_duration_ms,
                            crossfade_duration_ms=crossfade_ms,
                            trim_tail_ms=0,
                            raw_analyzer_score=float(candidate.get("raw_analyzer_score", analysis.get("raw_analyzer_score", analysis["score"]))),
                            validator_score=float(candidate.get("validator_score", analysis["score"])),
                            repetition_salience_score=float(candidate.get("repetition_salience_score", 0.0)),
                        )
                    )

                if not loop_palette:
                    raise RuntimeError("Unable to build any valid loop units from the analyzed candidates")

                if len(loop_palette) == 1:
                    log_with_time("↩️ Using single-candidate fallback pipeline...")
                    assembled_path = job_dir / "mix_loop_filled.wav"
                    await asyncio.to_thread(
                        extend_loop_seamless,
                        Path(loop_palette[0].source_path),
                        assembled_path,
                        float(duration),
                        crossfade_seconds=loop_palette[0].crossfade_duration_ms / 1000.0,
                    )
                else:
                    log_with_time(f"🎲 Scheduling stochastic rotation across {len(loop_palette)} candidates...")
                    scheduler = StochasticVariationScheduler(
                        max_consecutive_repeats=2,
                        salience_budget=0.55,
                        seed=int(job_id, 16),
                    )
                    plan = await asyncio.to_thread(scheduler.schedule, loop_palette, float(duration))
                    assembled_path = job_dir / "mix_rotated.wav"
                    await asyncio.to_thread(assemble_with_rotation, plan, assembled_path)
                    log_with_time(
                        f"🎲 Rotation plan assembled ({len(plan.segments)} segments, final_trim={plan.final_trim_seconds:.3f}s)"
                    )
                job_manager.update_progress(job_id, 48, {"status": "loop_complete"})

                log_with_time("🌫️ Applying entropy layer...")
                entropy_path = job_dir / "mix_entropy.wav"
                await asyncio.to_thread(
                    entropy_processor.process,
                    assembled_path,
                    entropy_path,
                    EntropyLayerParams(seed=int(job_id, 16)),
                    settings.SAMPLE_RATE,
                )
                final_mix_path = entropy_path
                await asyncio.to_thread(debug_audio_stage, final_mix_path.name, final_mix_path)
                job_manager.update_progress(job_id, 50, {"status": "audio_complete"})

                encoder_type = "🚀 GPU (NVENC)" if use_gpu else "🖥️  CPU (libx264)"
                log_with_time(f"🎬 Starting video render with {encoder_type}")
                job_manager.update_progress(job_id, 55, {"status": "rendering_video"})
                if show_viz:
                    log_with_time("📊 Visualizer enabled (showfreqs)")

                video_start = time.time()
                video_process = await video_renderer.render_async(
                    audio_path=final_mix_path,
                    background_path=bg_path,
                    output_path=video_path,
                    duration_seconds=duration,
                    show_visualizer=show_viz,
                    use_gpu=use_gpu,
                    use_cuda_visualizer=settings.USE_CUDA_VISUALIZER,
                    job_id=job_id,
                    job_manager=job_manager,
                    start_time=start_time,
                    progress_callback=lambda p: job_manager.update_progress(
                        job_id,
                        55 + int(p * 0.45),
                    ),
                )
                if video_process:
                    job_manager.register_process(job_id, video_process)

                video_time = time.time() - video_start
                log_with_time(f"✓ Video render complete ({video_time:.2f}s)")
                job_manager.unregister_process(job_id)

                log_with_time("📦 Copying to output folder...")
                job_manager.update_progress(job_id, 95, {"status": "finalizing"})
                output_dir = Path("output")
                output_dir.mkdir(exist_ok=True)
                timestamp = int(time.time())
                filename = f"ambient_video_{timestamp}.mp4"
                final_path = output_dir / filename
                shutil.copy(video_path, final_path)

                file_size = final_path.stat().st_size
                file_size_mb = file_size / (1024 * 1024)
                job_manager.complete_job(job_id, str(final_path), filename, file_size)
                render_time = time.time() - start_time
                log_render(duration, n, render_time, True)
                log_with_time(
                    f"✅ Complete! Total: {render_time:.2f}s | Audio: {audio_time:.2f}s | "
                    f"Video: {video_time:.2f}s | Size: {file_size_mb:.1f}MB"
                )
                job_manager.update_progress(job_id, 100)
                shutil.rmtree(job_dir, ignore_errors=True)

        except asyncio.CancelledError:
            render_time = time.time() - start_time
            log_render(duration, n, render_time, False, "Cancelled by user")
            job_manager.fail_job(job_id, "Cancelled by user")
            job_manager.unregister_process(job_id)
            log_with_time("❌ Render cancelled by user")
            shutil.rmtree(job_dir, ignore_errors=True)
            raise
        except Exception as e:
            render_time = time.time() - start_time
            error_msg = str(e)
            logger.error(f"Render failed for job {job_id}: {error_msg}", exc_info=True)
            log_render(duration, n, render_time, False, error_msg)
            job_manager.fail_job(job_id, error_msg)
            job_manager.unregister_process(job_id)
            log_with_time(f"❌ Error: {error_msg}")
            shutil.rmtree(job_dir, ignore_errors=True)

    asyncio.create_task(render_task())
    return {
        "status": "queued",
        "job_id": job_id,
        "queue_position": job_manager.get_queue_position(job_id),
    }


@app.post("/render-audio-job")
async def render_audio_job(
    duration: int = Form(..., gt=0, le=settings.MAX_DURATION),
    files: list[UploadFile] = File(...),
    volumes: str = Form(""),
    pans: str = Form(""),
    muted: str = Form(""),
    solo: str = Form(""),
    master_gain: float = Form(1.0),
    eq_gains: str = Form(""),
    loop_start: Optional[float] = Form(None),
    loop_end: Optional[float] = Form(None),
):
    if duration > settings.MAX_DURATION:
        raise HTTPException(400, f"Duration exceeds maximum of {settings.MAX_DURATION}s")

    for f in files:
        validate_audio_file(f)
        await validate_file_size(f)

    job_id = job_manager.create_job(duration)
    job_dir = Path(settings.TMP_DIR) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    track_paths: list[Path] = []
    for i, upload in enumerate(files):
        ext = Path(upload.filename).suffix or ".audio"
        dest = job_dir / f"track_{i:02d}{ext}"
        with dest.open("wb") as f:
            shutil.copyfileobj(upload.file, f)
        track_paths.append(dest)

    def parse_floats(s: str, count: int, default: float) -> list[float]:
        parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
        result = [float(p) for p in parts]
        while len(result) < count:
            result.append(default)
        return result[:count]

    def parse_bools(s: str, count: int) -> list[bool]:
        parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
        result = [bool(int(p)) for p in parts]
        while len(result) < count:
            result.append(False)
        return result[:count]

    n = len(track_paths)
    vol_list = parse_floats(volumes, n, 1.0)
    pan_list = parse_floats(pans, n, 0.0)
    muted_list = parse_bools(muted, n)
    solo_list = parse_bools(solo, n)
    eq_list = parse_floats(eq_gains, 7, 0.0)

    async def render_task() -> None:
        start_time = time.time()

        def log_with_time(message: str) -> None:
            elapsed = time.time() - start_time
            timestamp_msg = f"[{elapsed:.2f}s] {message}"
            logger.info(timestamp_msg)
            job_manager.update_progress(
                job_id,
                job_manager.jobs[job_id]["progress"],
                {"log_message": timestamp_msg},
            )

        def debug_audio_stage(label: str, path: Path) -> None:
            if not settings.AUDIO_DEBUG:
                return

            def _sink(msg: str) -> None:
                log_with_time(f"🧪 {label} | {msg}")

            try:
                log_audio_debug(path, log_fn=_sink)
            except Exception as exc:
                log_with_time(f"🧪 {label} | debug failed: {exc}")

        audio_renderer = AudioRenderer(settings)
        entropy_processor = SlowDriftProcessor()
        source_mix_path = job_dir / "mix.wav"

        try:
            log_with_time("⏳ Waiting for render slot...")
            job_manager.update_progress(job_id, 0, {"status": "waiting_for_slot"})

            async with render_semaphore:
                job_manager.start_job(job_id)
                log_with_time("🎵 Starting audio render...")
                job_manager.update_progress(job_id, 5, {"status": "initializing"})

                audio_start = time.time()

                def audio_progress_cb(progress_percent: int) -> None:
                    overall = 5 + int(progress_percent * 0.35)
                    job_manager.update_progress(job_id, overall)

                await asyncio.to_thread(
                    audio_renderer.render,
                    track_paths=track_paths,
                    output_path=source_mix_path,
                    duration_seconds=duration,
                    volumes=vol_list,
                    pans=pan_list,
                    muted=muted_list,
                    solo=solo_list,
                    master_gain=master_gain,
                    eq_gains=eq_list,
                    progress_callback=audio_progress_cb,
                    render_source_once=True,
                )

                audio_time = time.time() - audio_start
                log_with_time(f"✓ Source mix rendered ({audio_time:.2f}s)")
                await asyncio.to_thread(debug_audio_stage, "mix.wav", source_mix_path)
                job_manager.update_progress(job_id, 40, {"status": "mix_complete"})

                def manual_candidate(loop_start_seconds: float, loop_end_seconds: float) -> dict[str, object]:
                    loop_start_ms = int(round(loop_start_seconds * 1000.0))
                    loop_end_ms = int(round(loop_end_seconds * 1000.0))
                    loop_duration_ms = max(1, loop_end_ms - loop_start_ms)
                    crossfade_ms = min(4000, max(500, int(loop_duration_ms * 0.07)))
                    canonical_duration_ms = max(1, loop_duration_ms - crossfade_ms)
                    return {
                        "segment_id": "candidate_01",
                        "source_path": str(source_mix_path.resolve()),
                        "loop_start_ms": loop_start_ms,
                        "loop_end_ms": loop_end_ms,
                        "canonical_duration_ms": canonical_duration_ms,
                        "play_duration_ms": canonical_duration_ms,
                        "crossfade_duration_ms": crossfade_ms,
                        "trim_tail_ms": 0,
                        "raw_analyzer_score": 1.0,
                        "validator_score": 1.0,
                        "repetition_salience_score": 0.0,
                    }

                if loop_start is not None and loop_end is not None:
                    analysis = {
                        "loop_start_ms": int(round(loop_start * 1000.0)),
                        "loop_end_ms": int(round(loop_end * 1000.0)),
                        "score": 1.0,
                        "crossfade_ms": manual_candidate(loop_start, loop_end)["crossfade_duration_ms"],
                        "candidates": [manual_candidate(loop_start, loop_end)],
                    }
                    log_with_time(
                        f"📍 Using manual loop points: {loop_start:.3f}s → {loop_end:.3f}s"
                    )
                else:
                    log_with_time("🧠 Analyzing loop points with PyMusicLooper...")
                    analysis = await asyncio.to_thread(analyze_loop, source_mix_path)
                    log_with_time(
                        f"🧠 Best loop points: {analysis['loop_start_ms'] / 1000.0:.3f}s → "
                        f"{analysis['loop_end_ms'] / 1000.0:.3f}s "
                        f"(score={analysis['score']:.3f}, crossfade={analysis['crossfade_ms'] / 1000.0:.3f}s)"
                    )
                job_manager.update_progress(job_id, 50, {"status": "loop_analyzed"})

                analysis_candidates = list(analysis.get("candidates") or [])
                if not analysis_candidates:
                    fallback_crossfade_ms = int(analysis["crossfade_ms"])
                    fallback_duration_ms = max(
                        1,
                        int(analysis["loop_end_ms"]) - int(analysis["loop_start_ms"]) - fallback_crossfade_ms,
                    )
                    analysis_candidates = [
                        {
                            "segment_id": "candidate_01",
                            "source_path": str(source_mix_path.resolve()),
                            "loop_start_ms": int(analysis["loop_start_ms"]),
                            "loop_end_ms": int(analysis["loop_end_ms"]),
                            "canonical_duration_ms": fallback_duration_ms,
                            "play_duration_ms": fallback_duration_ms,
                            "crossfade_duration_ms": fallback_crossfade_ms,
                            "trim_tail_ms": 0,
                            "raw_analyzer_score": float(analysis.get("raw_analyzer_score", analysis["score"])),
                            "validator_score": float(analysis["score"]),
                            "repetition_salience_score": 0.0,
                        }
                    ]

                log_with_time(f"🎛️ Preparing {len(analysis_candidates)} loop candidate(s)...")
                loop_palette: list[LoopSegment] = []
                for candidate in analysis_candidates:
                    segment_id = str(candidate["segment_id"])
                    loop_unit_path = job_dir / f"{segment_id}.wav"
                    crossfade_ms = int(candidate.get("crossfade_duration_ms", candidate.get("crossfade_ms", analysis["crossfade_ms"])))
                    loop_start_seconds = int(candidate["loop_start_ms"]) / 1000.0
                    loop_end_seconds = int(candidate["loop_end_ms"]) / 1000.0
                    try:
                        await asyncio.to_thread(
                            make_loop,
                            source_mix_path,
                            loop_unit_path,
                            crossfade_ms / 1000.0,
                            loop_start_seconds,
                            loop_end_seconds,
                        )
                    except Exception as exc:
                        log_with_time(f"⚠️ Skipping {segment_id}: {exc}")
                        continue

                    canonical_duration_ms = max(
                        1,
                        int(
                            candidate.get(
                                "canonical_duration_ms",
                                max(1, int(candidate["loop_end_ms"]) - int(candidate["loop_start_ms"]) - crossfade_ms),
                            )
                        ),
                    )
                    loop_palette.append(
                        LoopSegment(
                            segment_id=segment_id,
                            source_path=str(loop_unit_path),
                            loop_start_ms=int(candidate["loop_start_ms"]),
                            loop_end_ms=int(candidate["loop_end_ms"]),
                            canonical_duration_ms=canonical_duration_ms,
                            play_duration_ms=canonical_duration_ms,
                            crossfade_duration_ms=crossfade_ms,
                            trim_tail_ms=0,
                            raw_analyzer_score=float(candidate.get("raw_analyzer_score", analysis.get("raw_analyzer_score", analysis["score"]))),
                            validator_score=float(candidate.get("validator_score", analysis["score"])),
                            repetition_salience_score=float(candidate.get("repetition_salience_score", 0.0)),
                        )
                    )
                job_manager.update_progress(job_id, 60, {"status": "loop_complete"})

                if not loop_palette:
                    raise RuntimeError("Unable to build any valid loop units from the analyzed candidates")

                if len(loop_palette) == 1:
                    log_with_time("↩️ Using single-candidate fallback pipeline...")
                    assembled_path = job_dir / "mix_loop_filled.wav"
                    await asyncio.to_thread(
                        extend_loop_seamless,
                        Path(loop_palette[0].source_path),
                        assembled_path,
                        float(duration),
                        crossfade_seconds=loop_palette[0].crossfade_duration_ms / 1000.0,
                    )
                else:
                    log_with_time(f"🎲 Scheduling stochastic rotation across {len(loop_palette)} candidates...")
                    scheduler = StochasticVariationScheduler(
                        max_consecutive_repeats=2,
                        salience_budget=0.55,
                        seed=int(job_id, 16),
                    )
                    plan = await asyncio.to_thread(scheduler.schedule, loop_palette, float(duration))
                    assembled_path = job_dir / "mix_rotated.wav"
                    await asyncio.to_thread(assemble_with_rotation, plan, assembled_path)
                    log_with_time(
                        f"🎲 Rotation plan assembled ({len(plan.segments)} segments, final_trim={plan.final_trim_seconds:.3f}s)"
                    )
                    job_manager.update_progress(job_id, 82, {"status": "rotation_complete"})

                log_with_time("🌫️ Applying entropy layer...")
                entropy_path = job_dir / "mix_entropy.wav"
                await asyncio.to_thread(
                    entropy_processor.process,
                    assembled_path,
                    entropy_path,
                    EntropyLayerParams(seed=int(job_id, 16)),
                    settings.SAMPLE_RATE,
                )
                final_audio_path = entropy_path
                await asyncio.to_thread(debug_audio_stage, final_audio_path.name, final_audio_path)
                job_manager.update_progress(job_id, 90, {"status": "finalizing"})

                output_dir = Path("output")
                output_dir.mkdir(exist_ok=True)
                timestamp = int(time.time())
                filename = f"ambient_audio_{timestamp}.wav"
                final_path = output_dir / filename
                shutil.copy(final_audio_path, final_path)

                file_size = final_path.stat().st_size
                job_manager.complete_job(job_id, str(final_path), filename, file_size)
                render_time = time.time() - start_time
                log_render(duration, n, render_time, True)
                log_with_time(f"✅ Audio complete ({render_time:.2f}s)")
                job_manager.update_progress(job_id, 100)

        except asyncio.CancelledError:
            render_time = time.time() - start_time
            log_render(duration, n, render_time, False, "Cancelled by user")
            job_manager.fail_job(job_id, "Cancelled by user")
            log_with_time("❌ Audio render cancelled by user")
            raise
        except Exception as exc:
            render_time = time.time() - start_time
            error_msg = str(exc)
            logger.error(f"Audio render failed for job {job_id}: {error_msg}", exc_info=True)
            log_render(duration, n, render_time, False, error_msg)
            job_manager.fail_job(job_id, error_msg)
            log_with_time(f"❌ Error: {error_msg}")
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)

    asyncio.create_task(render_task())
    return {
        "status": "queued",
        "job_id": job_id,
        "queue_position": job_manager.get_queue_position(job_id),
    }
