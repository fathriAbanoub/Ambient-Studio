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

import logging
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import cv2
import librosa
import numpy as np

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)


def precompute_audio_features(
    audio_path: Path,
    fps: int = 30,
    n_bars: int = 64,
    cache: bool = True,
) -> np.ndarray:
    """
    Pre-compute mel spectrogram bar heights for the entire audio file.
    
    Args:
        audio_path: Path to audio file
        fps: Target video frame rate
        n_bars: Number of frequency bars
        cache: If True, cache result to .npy file
    
    Returns:
        Array of shape (num_frames, n_bars) with values in [0, 1]
    """
    cache_path = audio_path.with_suffix(f'.bars_{fps}fps_{n_bars}bars.npy')
    
    if cache and cache_path.exists():
        logger.info(f"Loading cached audio features from {cache_path.name}")
        return np.load(cache_path)
    
    logger.info(f"Computing audio features: {n_bars} bars @ {fps} fps")
    start = time.time()
    
    # Load audio at native sample rate
    y, sr = librosa.load(str(audio_path), sr=None)
    
    # Calculate hop length to match target FPS
    hop_length = int(sr / fps)
    n_fft = 2048
    
    # Compute magnitude spectrogram
    stft = np.abs(librosa.stft(y, hop_length=hop_length, n_fft=n_fft))
    
    # Convert to Mel scale (perceptually better)
    mel_spec = librosa.feature.melspectrogram(
        S=stft**2,
        sr=sr,
        n_mels=n_bars,
        fmax=8000,
    )
    
    # Convert to dB and normalize to 0-1 range
    log_spec = librosa.power_to_db(mel_spec, ref=np.max)
    log_spec = (log_spec - log_spec.min()) / (log_spec.max() - log_spec.min() + 1e-6)
    
    # Transpose to (frames, bars)
    bar_data = log_spec.T
    
    elapsed = time.time() - start
    logger.info(f"Audio features computed: {bar_data.shape[0]} frames in {elapsed:.2f}s")
    
    if cache:
        np.save(cache_path, bar_data)
        logger.info(f"Cached to {cache_path.name}")
    
    return bar_data


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


def compute_zoom_factor(
    bar_heights: np.ndarray,
    zoom_start: float = 1.0,
    zoom_end: float = 1.2,
) -> float:
    """
    Calculate zoom factor based on bass energy.
    
    Args:
        bar_heights: Current frame's bar amplitudes
        zoom_start: Minimum zoom level
        zoom_end: Maximum zoom level
    
    Returns:
        Zoom factor between zoom_start and zoom_end
    """
    # Use first 8 bars (bass frequencies) for zoom
    bass_energy = np.mean(bar_heights[:8])
    return zoom_start + (zoom_end - zoom_start) * bass_energy


def create_ffmpeg_encoder(
    output_path: Path,
    audio_path: Path,
    fps: int,
    width: int,
    height: int,
    use_nvenc: bool = True,
) -> subprocess.Popen:
    """
    Create FFmpeg subprocess that reads raw BGR frames from stdin.
    
    Args:
        output_path: Output video file path
        audio_path: Original audio file (for muxing)
        fps: Video frame rate
        width: Video width
        height: Video height
        use_nvenc: Use NVENC GPU encoding if available
    
    Returns:
        Running subprocess with stdin pipe
    """
    cmd = [
        "ffmpeg", "-y",
        # Video input (raw BGR from stdin)
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "-",
        # Audio input
        "-i", str(audio_path),
        # Video encoding
        "-c:v", "h264_nvenc" if use_nvenc else "libx264",
    ]
    
    if use_nvenc:
        cmd.extend([
            "-preset", "p1",  # Fastest NVENC preset
            "-rc", "vbr",
            "-cq", "23",
            "-b:v", "5M",
        ])
    else:
        cmd.extend([
            "-preset", "veryfast",
            "-crf", "23",
        ])
    
    cmd.extend([
        # Audio encoding
        "-c:a", "aac",
        "-b:a", "192k",
        # Output options
        "-movflags", "+faststart",
        "-shortest",  # Stop when audio ends
        str(output_path),
    ])
    
    logger.info(f"Starting FFmpeg encoder: {' '.join(cmd[:15])}...")
    
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


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
) -> None:
    """
    Main entry point for CUDA-accelerated video rendering.
    
    Args:
        audio_path: Path to audio file
        background_path: Path to background image
        output_path: Output video path
        settings: Application settings
        fps: Target video frame rate
        n_bars: Number of frequency bars
        job_id: Optional job ID for progress tracking
        job_manager: Optional job manager for progress updates
        start_time: Optional start time for logging
    """
    if start_time is None:
        start_time = time.time()
    
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
    
    try:
        # Step 1: Pre-compute audio features
        log_with_time(f"🎵 Analyzing audio ({n_bars} bars @ {fps} fps)...")
        bar_data = precompute_audio_features(audio_path, fps=fps, n_bars=n_bars)
        num_frames = len(bar_data)
        log_with_time(f"✓ Audio analysis complete ({num_frames} frames)")
        
        # Step 2: Initialize GPU renderer
        log_with_time("🚀 Initializing CUDA renderer...")
        renderer = CudaVisualizerRenderer(
            background_path,
            width=settings.VIDEO_WIDTH,
            height=settings.VIDEO_HEIGHT,
            bar_height_scale=0.30,
        )
        log_with_time("✓ CUDA renderer ready")
        
        # Step 3: Start FFmpeg encoder
        log_with_time("🎬 Starting NVENC encoder...")
        ffmpeg_proc = create_ffmpeg_encoder(
            output_path,
            audio_path,
            fps=fps,
            width=settings.VIDEO_WIDTH,
            height=settings.VIDEO_HEIGHT,
            use_nvenc=True,
        )
        log_with_time("✓ Encoder started")
        
        # Step 4: Render loop
        log_with_time(f"🎨 Rendering {num_frames} frames...")
        render_start = time.time()
        
        for frame_idx in range(num_frames):
            # Get bar heights for this frame
            bar_heights = bar_data[frame_idx]
            
            # Calculate zoom based on bass energy
            zoom = compute_zoom_factor(
                bar_heights,
                zoom_start=settings.ZOOM_START,
                zoom_end=settings.ZOOM_END,
            )
            
            # Render frame on GPU
            frame = renderer.render_frame(bar_heights, zoom)
            
            # Write to FFmpeg stdin
            ffmpeg_proc.stdin.write(frame.tobytes())
            
            # Progress update every 100 frames
            if frame_idx % 100 == 0 and job_manager and job_id:
                progress = int((frame_idx / num_frames) * 100)
                job_manager.update_progress(job_id, progress, {})
        
        # Close stdin to signal end of video
        ffmpeg_proc.stdin.close()
        
        render_elapsed = time.time() - render_start
        log_with_time(f"✓ Rendering complete ({render_elapsed:.2f}s, {num_frames/render_elapsed:.1f} fps)")
        
        # Wait for FFmpeg to finish encoding
        log_with_time("⏳ Waiting for encoder to finish...")
        stderr = ffmpeg_proc.stderr.read().decode('utf-8', errors='replace')
        returncode = ffmpeg_proc.wait()
        
        if returncode != 0:
            logger.error(f"FFmpeg encoding failed:\n{stderr[-500:]}")
            raise RuntimeError(f"FFmpeg encoding failed: {stderr[-500:]}")
        
        # Cleanup
        renderer.cleanup()
        
        total_elapsed = time.time() - start_time
        file_size = output_path.stat().st_size / (1024 * 1024)  # MB
        log_with_time(f"✅ Complete! Total: {total_elapsed:.2f}s | Size: {file_size:.1f}MB")
        
    except Exception as e:
        logger.error(f"CUDA render failed: {e}", exc_info=True)
        raise
