"""
CUDA-Accelerated Audio Visualizer
==================================
GPU-based video renderer that replaces the CPU-bound showfreqs filter.

Architecture:
1. Pre-compute audio features with librosa (CPU, ~2s for 5min audio)
2. Render frames entirely on GPU with OpenCV CUDA
3. Stream raw frames to FFmpeg NVENC encoder via stdin

Performance: 5-min video in ~45-60s (6× faster than showfreqs)
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

import cv2
import numpy as np

from .visualizer_base import precompute_audio_features, compute_zoom_factor, create_ffmpeg_encoder

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)

# Serialize CUDA renders to avoid device resets stepping on each other
_cuda_lock = threading.Lock()


class CudaVisualizerRenderer:
    """
    GPU-accelerated visualizer renderer using OpenCV CUDA.
    
    Renders background zoom + frequency bars entirely on GPU,
    then downloads final frames to CPU for FFmpeg encoding.
    """
    
    def __init__(
        self,
        bg_path: Path,
        width: int = 1920,
        height: int = 1080,
        bar_height_scale: float = 0.3,
    ):
        """
        Initialize renderer and upload background to GPU.
        
        Args:
            bg_path: Path to background image
            width: Output video width
            height: Output video height
            bar_height_scale: Max bar height as fraction of video height
        """
        # Check CUDA availability
        if cv2.cuda.getCudaEnabledDeviceCount() == 0:
            raise RuntimeError("No CUDA-enabled GPU detected")
        
        logger.info(f"Initializing CUDA renderer ({width}×{height})")
        
        # Load and upload background to GPU
        bg_cpu = cv2.imread(str(bg_path))
        if bg_cpu is None:
            raise ValueError(f"Failed to load background: {bg_path}")
        
        bg_cpu = cv2.resize(bg_cpu, (width, height))
        self.bg_gpu = cv2.cuda_GpuMat()
        self.bg_gpu.upload(bg_cpu)
        
        # Pre-allocate GPU buffers (reused every frame)
        self.zoomed_gpu = cv2.cuda_GpuMat(height, width, cv2.CV_8UC3)
        self.cropped_gpu = cv2.cuda_GpuMat()
        
        self.width = width
        self.height = height
        self.max_bar_height = int(height * bar_height_scale)
        
        # Enable buffer pool for better VRAM management
        cv2.cuda.setBufferPoolUsage(True)
        
        logger.info("CUDA renderer initialized")
    
    def render_frame(
        self,
        bar_heights: np.ndarray,
        zoom_factor: float = 1.0,
    ) -> np.ndarray:
        """
        Render a single frame with background zoom + visualizer bars.
        
        Args:
            bar_heights: Array of bar amplitudes (0-1) for this frame
            zoom_factor: Background zoom level (1.0 = no zoom)
        
        Returns:
            BGR frame as numpy array (height, width, 3)
        """
        # 1. Zoom background on GPU
        if zoom_factor > 1.0:
            new_w = int(self.width / zoom_factor)
            new_h = int(self.height / zoom_factor)
            x = (self.width - new_w) // 2
            y = (self.height - new_h) // 2
            
            # Crop center region
            self.cropped_gpu = self.bg_gpu.colRange(x, x + new_w).rowRange(y, y + new_h)
            
            # Resize back to full size
            cv2.cuda.resize(self.cropped_gpu, (self.width, self.height), self.zoomed_gpu)
        else:
            # No zoom - copy background directly
            self.bg_gpu.copyTo(self.zoomed_gpu)
        
        # 2. Download to CPU for bar drawing
        # (OpenCV CUDA doesn't have rectangle drawing, so we do this part on CPU)
        frame_cpu = self.zoomed_gpu.download()
        
        # 3. Draw bars on CPU
        n_bars = len(bar_heights)
        bar_width = self.width // n_bars
        
        for i, amplitude in enumerate(bar_heights):
            bar_h = int(amplitude * self.max_bar_height)
            if bar_h < 2:
                continue
            
            x1 = i * bar_width
            y1 = self.height - bar_h
            x2 = x1 + bar_width - 2  # 2px gap between bars
            y2 = self.height
            
            # Color gradient based on amplitude (cyan -> purple -> green)
            if amplitude < 0.33:
                color = (255, 229, 0)  # Cyan
            elif amplitude < 0.66:
                color = (255, 77, 124)  # Purple
            else:
                color = (118, 230, 0)  # Green
            
            cv2.rectangle(frame_cpu, (x1, y1), (x2, y2), color, -1)
        
        return frame_cpu
    
    def cleanup(self):
        """Release GPU resources."""
        self.bg_gpu.release()
        self.zoomed_gpu.release()
        self.cropped_gpu.release()
        cv2.cuda.resetDevice()




def _render_cuda_blocking(
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
) -> None:
    """Synchronous CUDA render — called from a thread via asyncio.to_thread."""
    # Serialize CUDA renders to avoid device resets interfering with each other.
    with _cuda_lock:
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

        # Step 2: Initialize GPU renderer
        log_with_time("🚀 Initializing CUDA renderer...")
        renderer = None
        try:
            renderer = CudaVisualizerRenderer(
                background_path,
                width=settings.VIDEO_WIDTH,
                height=settings.VIDEO_HEIGHT,
                bar_height_scale=0.30,
            )
        except Exception as e:
            log_with_time(f"❌ CUDA renderer initialization failed: {e}")
            raise
        log_with_time("✓ CUDA renderer ready")

        # Step 3: Start FFmpeg encoder
        log_with_time("🎬 Starting NVENC encoder...")
        ffmpeg_proc = None
        render_success = False
        try:
            ffmpeg_proc = create_ffmpeg_encoder(
                output_path,
                audio_path,
                fps=fps,
                width=settings.VIDEO_WIDTH,
                height=settings.VIDEO_HEIGHT,
                use_nvenc=True,
                input_pix_fmt="bgr24",
            )
        except Exception as e:
            log_with_time(f"❌ FFmpeg encoder startup failed: {e}")
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
                    log_with_time(f"⏹️ Job {job_id} cancelled during CUDA render")
                    ffmpeg_proc.terminate()
                    try:
                        ffmpeg_proc.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        ffmpeg_proc.kill()
                        ffmpeg_proc.wait()
                    raise RuntimeError("Job cancelled by user")

                bar_heights = bar_data[frame_idx]

                zoom = compute_zoom_factor(
                    bar_heights,
                    zoom_start=settings.ZOOM_START,
                    zoom_end=settings.ZOOM_END,
                )

                frame = renderer.render_frame(bar_heights, zoom)
                # Write to FFmpeg stdin, handle sudden encoder death (cross-platform)
                try:
                    ffmpeg_proc.stdin.write(frame.tobytes())
                except OSError as e:
                    # FFmpeg died mid-render; wait for exit to get return code
                    ffmpeg_proc.wait()
                    raise RuntimeError(
                        f"FFmpeg died mid-render (exit code {ffmpeg_proc.returncode})"
                    ) from e

                if frame_idx % 100 == 0:
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
            # Log the error but re-raise after cleanup
            log_with_time(f"❌ Render loop error: {e}")
            raise
        finally:
            if ffmpeg_proc is not None:
                try:
                    ffmpeg_proc.stdin.close()
                except OSError:
                    pass

                if not render_success:
                    # Render failed: terminate FFmpeg and clean up CUDA immediately
                    try:
                        ffmpeg_proc.terminate()
                        ffmpeg_proc.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        ffmpeg_proc.kill()
                        ffmpeg_proc.wait()
                    except OSError:
                        pass

                    # Safe to reset CUDA context now because FFmpeg is dead
                    if renderer is not None:
                        renderer.cleanup()

        # If we reach here, render_success is True (otherwise exception propagated)
        render_elapsed = time.time() - render_start
        log_with_time(f"✓ Rendering complete ({render_elapsed:.2f}s, {num_frames/render_elapsed:.1f} fps)")

        # Wait for FFmpeg to finish encoding
        log_with_time("⏳ Waiting for encoder to finish...")
        returncode = ffmpeg_proc.wait()

        # NOW clean up CUDA resources, after FFmpeg is completely done
        if renderer is not None:
            renderer.cleanup()

        if returncode != 0:
            logger.error(f"FFmpeg encoding failed with exit code {returncode}")
            raise RuntimeError(f"FFmpeg encoding failed (exit code {returncode})")

        total_elapsed = time.time() - start_time
        file_size = output_path.stat().st_size / (1024 * 1024)  # MB
        log_with_time(f"✅ Complete! Total: {total_elapsed:.2f}s | Size: {file_size:.1f}MB")


async def render_video_cuda(
    audio_path: Path,
    background_path: Path,
    output_path: Path,
    settings: "Settings",
    fps: int = 30,
    n_bars: int = 64,
    job_id: Optional[str] = None,
    job_manager = None,
    start_time: Optional[float] = None,
    progress_callback: Optional[Callable[[int], None]] = None,
) -> None:
    """
    Main entry point for CUDA-accelerated video rendering.
    
    Offloads all blocking GPU + FFmpeg work to a thread so the
    asyncio event loop stays responsive for health checks, progress
    polls, and cancellation requests.
    """
    if start_time is None:
        start_time = time.time()

    await asyncio.to_thread(
        _render_cuda_blocking,
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
    )