"""
CPU-Optimized Audio Visualizer
===============================
Fast CPU-based video renderer that replaces the FFmpeg showfreqs filter.

Uses pre-computed audio features (librosa) and optimized PIL/NumPy rendering.
No CUDA required, but still 3-4× faster than FFmpeg showfreqs.

Performance: 5-min video in ~90-120s (vs 395s with showfreqs)
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

import numpy as np
from PIL import Image, ImageDraw

from .visualizer_base import precompute_audio_features, compute_zoom_factor, create_ffmpeg_encoder

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)


class CPUVisualizerRenderer:
    """
    CPU-optimized visualizer renderer using PIL/NumPy.
    
    Renders background zoom + frequency bars on CPU with optimized operations.
    """
    
    def __init__(
        self,
        bg_path: Path,
        width: int = 1920,
        height: int = 1080,
        bar_height_scale: float = 0.3,
    ):
        """
        Initialize renderer and load background.
        
        Args:
            bg_path: Path to background image
            width: Output video width
            height: Output video height
            bar_height_scale: Max bar height as fraction of video height
        """
        logger.info(f"Initializing CPU renderer ({width}×{height})")
        
        # Load and resize background
        self.bg_image = Image.open(bg_path).convert('RGB')
        self.bg_image = self.bg_image.resize((width, height), Image.LANCZOS)
        
        self.width = width
        self.height = height
        self.max_bar_height = int(height * bar_height_scale)
        
        # Color palette for bars (cyan, purple, green)
        self.colors = [
            (0, 229, 255),   # Cyan
            (124, 77, 255),  # Purple
            (0, 230, 118),   # Green
        ]
        
        logger.info("CPU renderer initialized")
    
    def render_frame(
        self,
        bar_heights: np.ndarray,
        zoom_factor: float = 1.0,
    ) -> bytes:
        """
        Render a single frame with background zoom + visualizer bars.
        
        Args:
            bar_heights: Array of bar amplitudes (0-1) for this frame
            zoom_factor: Background zoom level (1.0 = no zoom)
        
        Returns:
            Raw RGB bytes ready for FFmpeg
        """
        # 1. Apply zoom to background
        if zoom_factor > 1.0:
            # Calculate crop box for zoom
            new_w = int(self.width / zoom_factor)
            new_h = int(self.height / zoom_factor)
            left = (self.bg_image.width - new_w) // 2
            top = (self.bg_image.height - new_h) // 2
            
            # Crop and resize
            frame = self.bg_image.crop((left, top, left + new_w, top + new_h))
            frame = frame.resize((self.width, self.height), Image.LANCZOS)
        else:
            # No zoom - copy background
            frame = self.bg_image.copy()
        
        # 2. Draw bars
        draw = ImageDraw.Draw(frame)
        n_bars = len(bar_heights)
        bar_width = self.width // n_bars
        
        for i, amplitude in enumerate(bar_heights):
            bar_h = int(amplitude * self.max_bar_height)
            if bar_h < 2:
                continue
            
            x1 = i * bar_width
            y1 = self.height - bar_h
            x2 = x1 + bar_width - 2  # 2px gap
            y2 = self.height
            
            # Color based on amplitude
            if amplitude < 0.33:
                color = self.colors[0]  # Cyan
            elif amplitude < 0.66:
                color = self.colors[1]  # Purple
            else:
                color = self.colors[2]  # Green
            
            draw.rectangle([x1, y1, x2, y2], fill=color)
        
        # 3. Convert to raw RGB bytes
        return frame.tobytes()


def _render_cpu_blocking(
    audio_path: Path,
    background_path: Path,
    output_path: Path,
    settings: "Settings",
    fps: int,
    n_bars: int,
    job_id: Optional[str],
    job_manager,
    start_time: float,
    progress_callback: Optional[Callable[[int], None]] = None,
    use_nvenc: bool = True,
) -> None:
    """Synchronous CPU render — called from a thread via asyncio.to_thread."""

    def log_with_time(message):
        elapsed = time.time() - start_time
        timestamp_msg = f"[{elapsed:.2f}s] {message}"
        logger.info(timestamp_msg)
        if job_manager and job_id:
            job_manager.update_progress(
                job_id,
                job_manager.jobs[job_id]["progress"],
                {"log_message": timestamp_msg}
            )

    # Step 1: Pre-compute audio features
    log_with_time(f"🎵 Analyzing audio ({n_bars} bars @ {fps} fps)...")
    bar_data = precompute_audio_features(audio_path, fps=fps, n_bars=n_bars)
    num_frames = len(bar_data)
    log_with_time(f"✓ Audio analysis complete ({num_frames} frames)")

    # Step 2: Initialize CPU renderer
    log_with_time("💻 Initializing CPU renderer...")
    renderer = None
    try:
        renderer = CPUVisualizerRenderer(
            background_path,
            width=settings.VIDEO_WIDTH,
            height=settings.VIDEO_HEIGHT,
            bar_height_scale=0.30,
        )
    except Exception as e:
        log_with_time(f"❌ CPU renderer initialization failed: {e}")
        raise
    log_with_time("✓ CPU renderer ready")

    # Step 3: Start FFmpeg encoder
    log_with_time("🎬 Starting encoder...")
    ffmpeg_proc = None
    render_success = False
    try:
        ffmpeg_proc = create_ffmpeg_encoder(
            output_path,
            audio_path,
            fps=fps,
            width=settings.VIDEO_WIDTH,
            height=settings.VIDEO_HEIGHT,
            use_nvenc=use_nvenc,
            input_pix_fmt="rgb24",
            output_pix_fmt="yuv420p",
        )
    except Exception as e:
        log_with_time(f"❌ Encoder startup failed: {e}")
        raise
    log_with_time("✓ Encoder started")

    # Step 4: Render loop
    log_with_time(f"🎨 Rendering {num_frames} frames...")
    render_start = time.time()

    # Grab the stop event for cooperative cancellation
    stop_event = job_manager.job_stop_events.get(job_id) if job_manager and job_id else None

    try:
        for frame_idx in range(num_frames):
            # Check cancellation before rendering each frame
            if stop_event and stop_event.is_set():
                log_with_time(f"⏹️ Job {job_id} cancelled during CPU render")
                ffmpeg_proc.terminate()
                try:
                    ffmpeg_proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    ffmpeg_proc.kill()
                    ffmpeg_proc.wait()
                # ✅ FIX: Raise asyncio.CancelledError so the parent task's
                # except asyncio.CancelledError block handles it as a
                # cancellation, not a generic render failure.
                raise asyncio.CancelledError()

            # Get bar heights for this frame
            bar_heights = bar_data[frame_idx]

            # Calculate zoom based on bass energy
            zoom = compute_zoom_factor(
                bar_heights,
                zoom_start=settings.ZOOM_START,
                zoom_end=settings.ZOOM_END,
            )

            # Render frame on CPU
            frame_bytes = renderer.render_frame(bar_heights, zoom)

            # Write to FFmpeg stdin, handle sudden encoder death (cross-platform)
            try:
                ffmpeg_proc.stdin.write(frame_bytes)
            except OSError as e:
                # FFmpeg died mid-render; wait for exit to get return code
                ffmpeg_proc.wait()
                raise RuntimeError(
                    f"FFmpeg died mid-render (exit code {ffmpeg_proc.returncode})"
                ) from e

            # Progress update every 50 frames
            if frame_idx % 50 == 0:
                progress = int((frame_idx / num_frames) * 100)
                if progress_callback:
                    progress_callback(progress)
                elif job_manager and job_id:
                    # ponytail: direct write when no callback — bypasses main pipeline's 55-100 mapping.
                    # Upgrade path: always require progress_callback from callers.
                    job_manager.update_progress(job_id, progress, {})

        # Mark success before cleanup
        render_success = True

    except Exception as e:
        log_with_time(f"❌ Render loop error: {e}")
        raise
    finally:
        if ffmpeg_proc is not None:
            try:
                ffmpeg_proc.stdin.close()
            except OSError:
                pass

            if not render_success:
                try:
                    ffmpeg_proc.terminate()
                    ffmpeg_proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    ffmpeg_proc.kill()
                    ffmpeg_proc.wait()
                except OSError:
                    pass

    # If we reach here, render_success is True
    render_elapsed = time.time() - render_start
    log_with_time(f"✓ Rendering complete ({render_elapsed:.2f}s, {num_frames/render_elapsed:.1f} fps)")

    # Wait for FFmpeg to finish encoding
    log_with_time("⏳ Waiting for encoder to finish...")
    returncode = ffmpeg_proc.wait()

    if returncode != 0:
        logger.error(f"FFmpeg encoding failed with exit code {returncode}")
        raise RuntimeError(f"FFmpeg encoding failed (exit code {returncode})")

    total_elapsed = time.time() - start_time
    file_size = output_path.stat().st_size / (1024 * 1024)  # MB
    log_with_time(f"✅ Complete! Total: {total_elapsed:.2f}s | Size: {file_size:.1f}MB")


async def render_video_cpu(
    audio_path: Path,
    background_path: Path,
    output_path: Path,
    settings: "Settings",
    fps: int = 10,
    n_bars: int = 64,
    job_id: Optional[str] = None,
    job_manager = None,
    start_time: Optional[float] = None,
    progress_callback: Optional[Callable[[int], None]] = None,
    use_nvenc: bool = True,
) -> None:
    """
    Main entry point for CPU-optimized video rendering.
    
    Offloads all blocking CPU + FFmpeg work to a thread so the
    asyncio event loop stays responsive for health checks, progress
    polls, and cancellation requests.
    """
    if start_time is None:
        start_time = time.time()

    await asyncio.to_thread(
        _render_cpu_blocking,
        audio_path,
        background_path,
        output_path,
        settings,
        fps,
        n_bars,
        job_id,
        job_manager,
        start_time,
        progress_callback,
        use_nvenc,
    )