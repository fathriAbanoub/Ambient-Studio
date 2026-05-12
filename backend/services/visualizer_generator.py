"""
Visualizer Frame Generator
===========================
Generates visualizer frames that match the VideoPreview component's style.
Creates frequency bars with the same colors and styling as the frontend preview.
"""

import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw
import librosa
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


def _generate_single_frame(args):
    """Generate a single visualizer frame. Used for parallel processing."""
    frame_idx, frame_data, width, height, bar_count, output_dir = args
    
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Sample bar_count frequencies
    bar_width = width / bar_count - 1
    step = len(frame_data) // bar_count
    
    for i in range(bar_count):
        # Get average magnitude for this bar
        start_idx = i * step
        end_idx = min((i + 1) * step, len(frame_data))
        val = np.mean(frame_data[start_idx:end_idx])
        
        # Calculate bar height
        bar_height = int(val * height * 0.9)
        
        # Smooth color gradient
        if val < 0.5:
            t = val * 2
            r = int(0 + t * 124)
            g = int(229 - t * 152)
            b = int(255)
        else:
            t = (val - 0.5) * 2
            r = int(124 - t * 124)
            g = int(77 + t * 153)
            b = int(255 - t * 137)
        
        color = (r, g, b, int(140))
        
        # Draw bar
        x = int(i * (bar_width + 1))
        y = height - bar_height
        
        if bar_height > 0:
            draw.rectangle([x, y, x + int(bar_width), height], fill=color)
    
    # Save with minimal compression for speed
    frame_path = output_dir / f"viz_{frame_idx:06d}.png"
    img.save(frame_path, compress_level=1)  # Fast compression
    
    return frame_idx


def generate_visualizer_frames(
    audio_path: Path,
    output_dir: Path,
    duration_seconds: int,
    width: int = 1920,
    height: int = 378,
    fps: int = 25,
    bar_count: int = 48,
) -> tuple[int, dict]:
    """
    Generate visualizer frames from audio file.
    Returns (frame_count, timing_info).
    """
    start_time = time.time()
    output_dir.mkdir(parents=True, exist_ok=True)
    
    timing = {}
    
    # Load audio
    load_start = time.time()
    y, sr = librosa.load(str(audio_path), sr=44100, mono=True)
    timing['audio_load'] = time.time() - load_start
    
    # Calculate frames
    total_frames = duration_seconds * fps
    hop_length = int(sr / fps)
    
    # Compute spectrogram
    spec_start = time.time()
    D = np.abs(librosa.stft(y, hop_length=hop_length, n_fft=2048))
    D_db = librosa.amplitude_to_db(D, ref=np.max)
    D_norm = (D_db - D_db.min()) / (D_db.max() - D_db.min())
    
    # Apply smoothing
    from scipy.ndimage import gaussian_filter1d
    D_smooth = gaussian_filter1d(D_norm, sigma=1.5, axis=1)
    timing['spectrogram'] = time.time() - spec_start
    
    # Prepare frame data
    frame_data_list = []
    for frame_idx in range(total_frames):
        data_idx = frame_idx % D_smooth.shape[1]
        frame_data_list.append((
            frame_idx,
            D_smooth[:, data_idx],
            width,
            height,
            bar_count,
            output_dir
        ))
    
    # Generate frames in parallel
    gen_start = time.time()
    
    max_workers = 12  # Increase to 12 threads
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        list(executor.map(_generate_single_frame, frame_data_list))
    
    timing['frame_generation'] = time.time() - gen_start
    timing['total'] = time.time() - start_time
    timing['fps'] = total_frames / timing['frame_generation']
    
    return total_frames, timing
