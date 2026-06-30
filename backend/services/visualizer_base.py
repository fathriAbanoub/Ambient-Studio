"""
Shared Visualizer Infrastructure
=================================
Common utilities for both CPU and CUDA visualizers.
"""

from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path

import librosa
import numpy as np

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
    input_pix_fmt: str = "bgr24",
    output_pix_fmt: str | None = None,
) -> "subprocess.Popen[bytes]":
    """
    Create FFmpeg subprocess that reads raw frames from stdin.

    Args:
        output_path: Output video file path
        audio_path: Original audio file (for muxing)
        fps: Video frame rate
        width: Video width
        height: Video height
        use_nvenc: Use NVENC GPU encoding if available
        input_pix_fmt: Pixel format of input frames ("bgr24" for OpenCV CUDA, "rgb24" for PIL CPU)
        output_pix_fmt: Pixel format for output (e.g., "yuv420p"). None to omit.

    Returns:
        Running subprocess with stdin pipe
    """
    cmd = [
        "ffmpeg", "-y",
        # Video input (raw frames from stdin)
        "-f", "rawvideo",
        "-pix_fmt", input_pix_fmt,
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
    ])

    # Output pixel format (CPU needs yuv420p for compatibility)
    if output_pix_fmt:
        cmd.extend(["-pix_fmt", output_pix_fmt])

    cmd.extend([
        # Output options
        "-movflags", "+faststart",
        "-shortest",  # Stop when audio ends
        str(output_path),
    ])

    logger.info(f"Starting FFmpeg encoder: {' '.join(cmd[:15])}...")

    # ponytail: stderr is DEVNULL to avoid pipe buffer deadlock on long renders.
    # Ceiling: We lose FFmpeg's diagnostic output on failure.
    # Upgrade path: If we need stderr for debugging, drain it in a background
    # thread or write it to a per-job log file instead of capturing via pipe.
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
