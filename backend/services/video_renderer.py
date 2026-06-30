"""
VideoRenderer
=============
Python port of renderVideo.js using ffmpeg-python.

Produces a 1920×1080 MP4 from a background image + audio using a very efficient
1‑frame‑per‑second encoding. For static‑background ambient videos this yields
tiny file sizes and nearly instant render times, regardless of duration.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

import ffmpeg

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)

# Try to import CUDA visualizer (graceful fallback if not available)
_cuda_available = False
try:
    from services.cuda_visualizer import render_video_cuda
    import cv2
    device_count = cv2.cuda.getCudaEnabledDeviceCount()
    logger.info(f"DEBUG: cv2.__version__ = {cv2.__version__}")
    logger.info(f"DEBUG: cv2.__file__ = {cv2.__file__}")
    logger.info(f"DEBUG: CUDA device count = {device_count}")
    if device_count > 0:
        _cuda_available = True
        logger.info("✓ CUDA visualizer available")
    else:
        logger.info("CUDA visualizer not available: No CUDA-enabled GPU detected")
except ImportError as e:
    logger.error(f"CUDA visualizer not available: {e}")
except Exception as e:
    logger.error(f"CUDA visualizer check failed with exception: {e}", exc_info=True)

# Import CPU visualizer (always available, 3-4× faster than FFmpeg showfreqs)
try:
    from services.cpu_visualizer import render_video_cpu
    _cpu_visualizer_available = True
    logger.info("✓ CPU visualizer available (3-4× faster than FFmpeg)")
except ImportError as e:
    _cpu_visualizer_available = False
    logger.warning(f"CPU visualizer not available: {e}")

_nvenc_available: Optional[bool] = None


def _check_nvenc() -> bool:
    """Probe whether h264_nvenc is usable on this machine."""
    global _nvenc_available
    if _nvenc_available is not None:
        return _nvenc_available
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=black:s=16x16:d=0.1",
                "-vcodec", "h264_nvenc", "-f", "null", "-",
            ],
            capture_output=True,
            timeout=10,
        )
        _nvenc_available = result.returncode == 0
    except Exception:
        _nvenc_available = False
    if _nvenc_available:
        logger.info("NVENC detected — using h264_nvenc for video encoding")
    else:
        logger.info("NVENC not available — falling back to libx264")
    return _nvenc_available


def _resolve_codec(settings: "Settings", use_gpu: bool = True) -> tuple[str, dict]:
    """
    Return (codec_name, extra_ffmpeg_kwargs) based on settings and hardware.
    When use_gpu=True and NVENC is available, uses h264_nvenc. Otherwise uses libx264.
    """
    if not use_gpu:
        logger.info("🖥️  CPU encoding selected (libx264)")
        return "libx264", {"preset": settings.PRESET, "crf": settings.CRF}
    
    codec = settings.VIDEO_CODEC
    if codec == "auto":
        codec = "h264_nvenc" if _check_nvenc() else "libx264"
    
    if codec == "h264_nvenc":
        logger.info("🚀 GPU encoding selected (NVENC h264_nvenc)")
        # Use p1 (fastest) preset for much faster encoding
        # For visualizer content, speed is more important than max quality
        return codec, {"preset": "p1", "rc": "vbr", "cq": "23", "b:v": "5M"}
    else:
        logger.info("🖥️  CPU encoding selected (libx264)")
        return codec, {"preset": settings.PRESET, "crf": settings.CRF}


class VideoRenderer:
    def __init__(self, settings: "Settings"):
        self.settings = settings

    def render(
        self,
        *,
        audio_path: Path,
        background_path: Path,
        output_path: Path,
        duration_seconds: int,
        show_visualizer: bool = False,
    ) -> None:
        s = self.settings
        codec, codec_kwargs = _resolve_codec(s)
        
        try:
            video_input = ffmpeg.input(str(background_path), loop=1, framerate=1)
            audio_input = ffmpeg.input(str(audio_path))
            
            if show_visualizer:
                # Create frequency spectrum visualizer using showfreqs filter
                # This creates vertical bars like the preview
                visualizer = audio_input.filter(
                    'showfreqs',
                    s=f'{s.VIDEO_WIDTH}x{int(s.VIDEO_HEIGHT * 0.35)}',
                    mode='bar',
                    ascale='log',
                    fscale='log',
                    win_size=2048,
                    rate=s.VIDEO_FPS,
                    colors='0x00e5ff|0x7c4dff|0x00e676|0xff6b35',
                )
                
                # Add transparency and blend with background
                # Scale background
                scaled_bg = video_input.filter('scale', s.VIDEO_WIDTH, s.VIDEO_HEIGHT)
                
                # Make visualizer semi-transparent
                alpha_viz = visualizer.filter('colorchannelmixer', aa=0.7)
                
                # Overlay visualizer at bottom
                video_stream = ffmpeg.overlay(
                    scaled_bg,
                    alpha_viz,
                    x=0,
                    y=f'H-h',  # Position at bottom
                    format='auto',
                    shortest=1,
                )
            else:
                video_stream = video_input.filter('scale', s.VIDEO_WIDTH, s.VIDEO_HEIGHT)
            
            (
                video_stream.output(
                    audio_input.audio,
                    str(output_path),
                    vcodec=codec,
                    acodec=s.AUDIO_CODEC,
                    pix_fmt="yuv420p",
                    movflags="+faststart",
                    shortest=None,
                    t=duration_seconds,
                    r=1 if not show_visualizer else s.VIDEO_FPS,
                    **codec_kwargs,
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
        except ffmpeg.Error as exc:
            stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
            logger.error("FFmpeg error:\n%s", stderr)
            raise RuntimeError(f"FFmpeg failed: {stderr[-500:]}") from exc

        logger.info("Video rendered → %s", output_path)

    async def render_async(
        self,
        *,
        audio_path: Path,
        background_path: Path,
        output_path: Path,
        duration_seconds: int,
        show_visualizer: bool = False,
        use_gpu: bool = True,
        use_cuda_visualizer: bool = True,
        job_id: str = None,
        job_manager = None,
        start_time: float = None,
        progress_callback: Optional[Callable[[int], None]] = None,
    ) -> Optional[subprocess.Popen]:
        """
        Render video asynchronously.
        
        Args:
            use_cuda_visualizer: If True and CUDA available, use GPU-accelerated renderer
                                 (6× faster than FFmpeg showfreqs filter)
                                 Falls back to CPU visualizer (3-4× faster) if CUDA unavailable
        """
        # Use CUDA visualizer if requested, available, and visualizer is enabled
        if show_visualizer and use_cuda_visualizer and _cuda_available:
            logger.info("🚀 Using CUDA-accelerated visualizer")
            await render_video_cuda(
                audio_path=audio_path,
                background_path=background_path,
                output_path=output_path,
                settings=self.settings,
                fps=10,  # 10 fps is optimal balance of smoothness and speed
                n_bars=64,
                job_id=job_id,
                job_manager=job_manager,
                start_time=start_time,
                progress_callback=progress_callback,
            )
            return None
        
        # Use CPU visualizer if CUDA not available but CPU visualizer is
        if show_visualizer and use_cuda_visualizer and not _cuda_available and _cpu_visualizer_available:
            logger.info("💻 Using CPU-optimized visualizer (CUDA not available)")
            await render_video_cpu(
                audio_path=audio_path,
                background_path=background_path,
                output_path=output_path,
                settings=self.settings,
                fps=10,  # Lower FPS for CPU (still smooth)
                n_bars=64,
                job_id=job_id,
                job_manager=job_manager,
                start_time=start_time,
                progress_callback=progress_callback,
            )
            return None
        
        # Fallback to original FFmpeg-based renderer
        if show_visualizer and use_cuda_visualizer and not _cuda_available and not _cpu_visualizer_available:
            logger.warning("⚠️  No optimized visualizer available, falling back to FFmpeg showfreqs")
        
        s = self.settings
        codec, codec_kwargs = _resolve_codec(s, use_gpu)
        
        if start_time is None:
            start_time = time.time()
        
        def log_with_time(message):
            """Helper to log with timestamp"""
            elapsed = time.time() - start_time
            timestamp_msg = f"[{elapsed:.2f}s] {message}"
            logger.info(timestamp_msg)
            if job_manager and job_id:
                job_manager.update_progress(job_id, job_manager.jobs[job_id]["progress"], {"log_message": timestamp_msg})

        video_input = ffmpeg.input(str(background_path), loop=1, framerate=s.VIDEO_FPS if show_visualizer else 1)
        audio_input = ffmpeg.input(str(audio_path))

        if show_visualizer:
            log_with_time(f"🎬 Building FFmpeg showfreqs fallback visualizer...")
            
            # showfreqs runs on CPU (no CUDA equivalent exists)
            # but we upload to GPU immediately after for overlay+encode
            visualizer = audio_input.filter(
                'showfreqs',
                s=f'{s.VIDEO_WIDTH}x{int(s.VIDEO_HEIGHT * 0.30)}',
                mode='bar',
                ascale='log',
                fscale='log',
                win_size=2048,
                rate=10,  # 10fps - cuts CPU work by 60%
                colors='0x00e5ff|0x7c4dff|0x00e676',
            )
            
            # Upload both streams to GPU and convert to nv12 format
            # First convert yuva420p to yuv420p (remove alpha) before GPU upload
            viz_cuda = (
                visualizer
                .filter('format', 'yuv420p')  # Remove alpha channel before GPU upload
                .filter('hwupload_cuda')
                .filter('scale_cuda', s.VIDEO_WIDTH, int(s.VIDEO_HEIGHT * 0.30), format='nv12')
            )
            bg_cuda = (
                video_input
                .filter('scale', s.VIDEO_WIDTH, s.VIDEO_HEIGHT)
                .filter('hwupload_cuda')
                .filter('scale_cuda', s.VIDEO_WIDTH, s.VIDEO_HEIGHT, format='nv12')
            )
            
            # Overlay and encode entirely on GPU
            video_stream = ffmpeg.filter(
                [bg_cuda, viz_cuda],
                'overlay_cuda',
                x=0,
                y=s.VIDEO_HEIGHT - int(s.VIDEO_HEIGHT * 0.30),
            )
            
            output_fps = 10
            log_with_time(f"🎬 Starting CUDA encode ({codec} @ {output_fps}fps)...")
        else:
            video_stream = video_input.filter('scale', s.VIDEO_WIDTH, s.VIDEO_HEIGHT)
            output_fps = 1
            log_with_time(f"🎬 Starting ffmpeg encode ({codec})...")

        # NVENC reads nv12 directly from GPU memory — no pix_fmt needed for CUDA path
        output_kwargs = dict(
            vcodec=codec,
            acodec=s.AUDIO_CODEC,
            movflags="+faststart",
            shortest=None,
            t=duration_seconds,
            r=output_fps,
            **codec_kwargs,
        )
        if not show_visualizer:
            # CPU path needs explicit yuv420p for compatibility
            output_kwargs["pix_fmt"] = "yuv420p"

        cmd = (
            video_stream.output(
                audio_input.audio,
                str(output_path),
                **output_kwargs,
            )
            .overwrite_output()
            .compile()
        )

        logger.info(f"Running ffmpeg video command: {' '.join(cmd)}")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Register process immediately for cancellation support
        if job_manager and job_id:
            job_manager.register_process(job_id, process)

        # Use communicate() to avoid buffer overflow from massive stderr output
        try:
            stdout, stderr_bytes = await asyncio.wait_for(
                process.communicate(),
                timeout=duration_seconds * 3 + 120,
            )
        except asyncio.TimeoutError:
            process.kill()
            raise RuntimeError("FFmpeg video timed out")

        if process.returncode != 0:
            stderr = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
            logger.error("FFmpeg video error:\n%s", stderr)
            raise RuntimeError(f"FFmpeg video failed: {stderr[-800:]}")

        logger.info("Video rendered → %s", output_path)
        return process