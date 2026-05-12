"""
LoopProcessor
=============
Creates a seamless audio loop from a specified segment of a source file, and
extends it to a target duration.

This is a two-step process:
1. `make_loop`: Extracts a segment (`loop_start` to `loop_end`) from a source
   file and applies a single, high-quality equal-power crossfade to its ends
   to create a "canonical loop unit". This unit is perfectly seamless, and its
   duration will be `(loop_end - loop_start) - crossfade_seconds`.
2. `extend_loop_seamless`: Takes the canonical loop unit and efficiently repeats
   it to fill the target duration using FFmpeg's `concat` demuxer, which avoids
   re-encoding and quality degradation. The result is then trimmed to the exact
   final length.
"""
from __future__ import annotations

import logging
import math
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
from pydub import AudioSegment

from services.variation_scheduler import AssemblyPlan, TransitionType

logger = logging.getLogger(__name__)

_MICRO_FADE_MS = 5


def get_audio_duration(file_path: Path) -> float:
    """Get the duration of an audio file in seconds using ffprobe."""
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(file_path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return float(probe.stdout.strip())


def make_loop(
    input_path: Path,
    output_path: Path,
    crossfade_seconds: float,
    loop_start_seconds: float,
    loop_end_seconds: float,
) -> None:
    """
    Creates a single, seamless 'canonical loop unit' from a specified
    segment of the input audio file. The output duration will be
    (loop_end_seconds - loop_start_seconds) - crossfade_seconds.
    """
    if not (crossfade_seconds > 0):
        raise ValueError("Crossfade duration must be greater than 0.")
    if not (loop_end_seconds > loop_start_seconds):
        raise ValueError("Loop end time must be greater than loop start time.")
    if not (loop_start_seconds >= 0):
        raise ValueError("Loop start time must be non-negative.")

    segment_duration = loop_end_seconds - loop_start_seconds
    if segment_duration <= 2 * crossfade_seconds:
        raise ValueError(
            f"Loop segment duration ({segment_duration:.2f}s) must be greater than "
            f"twice the crossfade duration ({2 * crossfade_seconds:.2f}s)."
        )

    cf = crossfade_seconds
    sd = segment_duration
    filter_complex = (
        f"[0:a]atrim={loop_start_seconds:.6f}:{loop_end_seconds:.6f},asetpts=PTS-STARTPTS[full];"
        f"[full]asplit=3[head_split][middle_split][tail_split];"
        f"[head_split]atrim=0:{cf:.6f},asetpts=PTS-STARTPTS[h];"
        f"[middle_split]atrim={cf:.6f}:{sd - cf:.6f},asetpts=PTS-STARTPTS[m];"
        f"[tail_split]atrim={sd - cf:.6f}:{sd:.6f},asetpts=PTS-STARTPTS[t];"
        f"[t][h]acrossfade=d={cf:.6f}:c1=tri:c2=tri:overlap=1[seam];"
        f"[m][seam]concat=n=2:v=0:a=1[out]"
    )

    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        str(input_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-acodec",
        "pcm_s16le",
        str(output_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed to create loop unit: {result.stderr}")

    logger.info("Created seamless loop unit at %s", output_path)


def extend_loop_seamless(
    input_path: Path,
    output_path: Path,
    duration_seconds: float,
    crossfade_seconds: Optional[float] = None,
) -> None:
    """
    Extends a seamless loop unit to a target duration.

    Uses acrossfade between every repeat so loud sections never produce a hard
    splice at the repeat boundary. crossfade_seconds defaults to 20 ms which is
    inaudible but sufficient to eliminate the inter-repeat clipping entirely.
    """
    try:
        loop_duration = get_audio_duration(input_path)
    except (subprocess.CalledProcessError, ValueError) as exc:
        raise RuntimeError(f"Could not get duration of loop unit {input_path}: {exc}") from exc

    if loop_duration <= 0:
        raise ValueError("Loop unit has zero or negative duration.")

    xf = float(crossfade_seconds) if crossfade_seconds and crossfade_seconds > 0 else 0.020
    repeats = max(1, math.ceil((duration_seconds - loop_duration) / max(loop_duration - xf, 1e-6)) + 1)

    if repeats == 1:
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(input_path),
            "-t", f"{duration_seconds:.6f}",
            "-acodec", "pcm_s16le",
            str(output_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed to extend loop: {result.stderr}")
        logger.info("Extended loop to %ss at %s", duration_seconds, output_path)
        return

    # Chain acrossfade between each repeat in a single filter_complex pass.
    inputs = []
    for _ in range(repeats):
        inputs += ["-i", str(input_path)]

    filter_parts = []
    prev = "[0:a]"
    for i in range(1, repeats):
        out_label = "[out]" if i == repeats - 1 else f"[x{i}]"
        filter_parts.append(
            f"{prev}[{i}:a]acrossfade=d={xf:.6f}:c1=tri:c2=tri{out_label}"
        )
        prev = out_label

    filter_complex = ";".join(filter_parts)

    cmd = [
        "ffmpeg", "-y", "-v", "error",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-t", f"{duration_seconds:.6f}",
        "-acodec", "pcm_s16le",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed to extend loop: {result.stderr}")

    logger.info("Extended loop to %ss at %s", duration_seconds, output_path)

def _apply_edge_fade(
    segment: AudioSegment,
    *,
    fade_in_ms: int = 0,
    fade_out_ms: int = 0,
) -> AudioSegment:
    """Apply short edge ramps in float space to suppress boundary discontinuities."""
    if len(segment) <= 0:
        return segment

    fade_in_ms = max(0, min(int(fade_in_ms), len(segment)))
    fade_out_ms = max(0, min(int(fade_out_ms), len(segment)))
    if fade_in_ms <= 0 and fade_out_ms <= 0:
        return segment

    if segment.sample_width != 2:
        segment = segment.set_sample_width(2)

    samples = np.array(segment.get_array_of_samples(), dtype=np.float32)
    channels = max(1, int(segment.channels))
    frame_count = samples.size // channels
    if frame_count <= 0:
        return segment

    if fade_in_ms > 0:
        fade_in_frames = min(frame_count, int(round(segment.frame_rate * fade_in_ms / 1000.0)))
        if fade_in_frames > 0:
            ramp = np.linspace(0.0, 1.0, fade_in_frames, dtype=np.float32)
            for channel_index in range(channels):
                channel_view = samples[channel_index::channels]
                channel_view[:fade_in_frames] *= ramp

    if fade_out_ms > 0:
        fade_out_frames = min(frame_count, int(round(segment.frame_rate * fade_out_ms / 1000.0)))
        if fade_out_frames > 0:
            ramp = np.linspace(1.0, 0.0, fade_out_frames, dtype=np.float32)
            for channel_index in range(channels):
                channel_view = samples[channel_index::channels]
                channel_view[-fade_out_frames:] *= ramp

    samples_int16 = np.clip(np.round(samples), -32768, 32767).astype(np.int16)
    return segment._spawn(samples_int16.tobytes())


def _apply_micro_fade(segment: AudioSegment, fade_ms: int) -> AudioSegment:
    """Apply a short ramp at both ends of a planned segment."""
    half_duration_ms = len(segment) // 2
    effective_fade_ms = max(0, min(int(fade_ms), half_duration_ms))
    if effective_fade_ms <= 0:
        return segment
    return _apply_edge_fade(
        segment,
        fade_in_ms=effective_fade_ms,
        fade_out_ms=effective_fade_ms,
    )


def _to_float_array(segment: AudioSegment) -> np.ndarray:
    """Convert an AudioSegment to a float32 array shaped as (channels, frames)."""
    if segment.sample_width != 2:
        segment = segment.set_sample_width(2)
    raw = np.frombuffer(segment.raw_data, dtype=np.int16).astype(np.float32)
    channels = max(1, int(segment.channels))
    if raw.size % channels != 0:
        raw = raw[: raw.size - (raw.size % channels)]
    if channels > 1:
        raw = raw.reshape(-1, channels).T
    else:
        raw = raw[np.newaxis, :]
    return raw / 32768.0


def _from_float_array(array: np.ndarray, template: AudioSegment) -> AudioSegment:
    """Convert a float32 array shaped as (channels, frames) to an AudioSegment."""
    clipped = np.clip(array, -1.0, 1.0)
    int16 = np.round(clipped * 32767.0).astype(np.int16)
    if int16.shape[0] > 1:
        interleaved = int16.T.reshape(-1)
    else:
        interleaved = int16.reshape(-1)
    template = template.set_sample_width(2)
    return template._spawn(interleaved.tobytes())


def _crossfade_float(
    segment_a: AudioSegment,
    segment_b: AudioSegment,
    crossfade_ms: int,
) -> AudioSegment:
    """Run an equal-power crossfade in float space to avoid integer clipping."""
    if crossfade_ms <= 0:
        return segment_a + segment_b

    if segment_b.frame_rate != segment_a.frame_rate:
        segment_b = segment_b.set_frame_rate(segment_a.frame_rate)
    if segment_b.channels != segment_a.channels:
        segment_b = segment_b.set_channels(segment_a.channels)
    if segment_b.sample_width != segment_a.sample_width:
        segment_b = segment_b.set_sample_width(segment_a.sample_width)

    fade_frames = min(
        int(round(segment_a.frame_rate * crossfade_ms / 1000.0)),
        int(segment_a.frame_count()),
        int(segment_b.frame_count()),
    )
    if fade_frames <= 0:
        return segment_a + segment_b

    array_a = _to_float_array(segment_a)
    array_b = _to_float_array(segment_b)

    theta = np.linspace(0.0, np.pi / 2.0, fade_frames, dtype=np.float32)
    fade_out = np.cos(theta)
    fade_in = np.sin(theta)

    body_a = array_a[:, :-fade_frames]
    tail_a = array_a[:, -fade_frames:] * fade_out[np.newaxis, :]
    head_b = array_b[:, :fade_frames] * fade_in[np.newaxis, :]
    body_b = array_b[:, fade_frames:]
    seam = tail_a + head_b

    merged = np.concatenate([body_a, seam, body_b], axis=1)

    peak = float(np.max(np.abs(merged))) if merged.size else 0.0
    if peak > 1.0:
        merged /= peak

    return _from_float_array(merged, segment_a)


def assemble_with_rotation(plan: AssemblyPlan, output_path: Path) -> None:
    if not plan.segments:
        raise ValueError("Assembly plan must contain at least one segment")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    def _load_planned_audio(source_path: str, play_duration_ms: int) -> AudioSegment:
        audio = AudioSegment.from_wav(str(source_path))
        trimmed_duration = max(1, min(len(audio), int(play_duration_ms)))
        segment = audio[:trimmed_duration]
        return _apply_micro_fade(segment, _MICRO_FADE_MS)

    first_segment = plan.segments[0]
    result = _load_planned_audio(first_segment.source_path, first_segment.play_duration_ms)

    for segment, transition in zip(plan.segments[1:], plan.transitions):
        if transition.trim_tail_ms > 0 and len(result) > transition.trim_tail_ms:
            result = _apply_edge_fade(
                result[:-transition.trim_tail_ms],
                fade_out_ms=_MICRO_FADE_MS,
            )

        segment_audio = _load_planned_audio(segment.source_path, segment.play_duration_ms)
        if transition.transition_type is TransitionType.CROSSFADE:
            crossfade_ms = min(
                int(transition.crossfade_duration_ms),
                len(result),
                len(segment_audio),
            )
        else:
            crossfade_ms = 0

        result = _crossfade_float(result, segment_audio, crossfade_ms)

    target_duration_ms = int(round(plan.total_duration_seconds * 1000.0))
    if len(result) > target_duration_ms:
        result = result[:target_duration_ms]

    result.export(
        str(output_path),
        format="wav",
        parameters=["-acodec", "pcm_s16le"],
    )
    logger.info(
        "Assembled rotated mix with %s segments at %s",
        len(plan.segments),
        output_path,
    )
