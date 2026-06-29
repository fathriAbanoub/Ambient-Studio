"""
LoopAnalyzer
============
Integrates PyMusicLooper to find optimal seamless loop points in short audio files.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from scipy.signal import butter, correlate, filtfilt
from scipy.spatial.distance import euclidean

logger = logging.getLogger(__name__)

try:
    from pymusiclooper.audio import MLAudio
    from pymusiclooper.core import LoopPair, MusicLooper
    from pymusiclooper.exceptions import LoopNotFoundError
except ImportError as e:
    raise ImportError(
        "pymusiclooper is required for loop analysis. "
        "Install with: pip install pymusiclooper"
    ) from e


def _safe_float(value: float) -> float:
    return float(np.nan_to_num(value, nan=0.0, posinf=0.0, neginf=0.0))


def _clamp01(value: float) -> float:
    return float(min(1.0, max(0.0, value)))


@lru_cache(maxsize=2)  # ponytail: was 8 (~420 MB worst case). Cleared in analyze_loop().
def _load_mono_audio(audio_path: str) -> tuple[np.ndarray, int]:
    audio, sample_rate = librosa.load(audio_path, sr=None, mono=False)
    if audio.ndim > 1:
        audio = librosa.to_mono(audio)
    return np.ascontiguousarray(audio, dtype=np.float32), int(sample_rate)


def _normalised_variance(values: np.ndarray) -> float:
    values = np.asarray(values, dtype=np.float32)
    if values.size <= 1:
        return 0.0
    variance = float(np.var(values))
    energy = float(np.mean(np.square(values)))
    if energy <= 1e-12:
        return 0.0
    return _clamp01(variance / (variance + energy + 1e-12))


def _slice_mono_segment(audio: np.ndarray, start_sample: int, end_sample: int) -> np.ndarray:
    start_sample = max(0, start_sample)
    end_sample = max(start_sample + 1, end_sample)
    return np.ascontiguousarray(audio[start_sample:end_sample], dtype=np.float32)


def _as_mono(audio_segment: np.ndarray) -> np.ndarray:
    segment = np.asarray(audio_segment, dtype=np.float32)
    if segment.ndim == 1:
        return segment
    if segment.shape[0] <= 8:
        return np.mean(segment, axis=0, dtype=np.float32)
    return np.mean(segment, axis=1, dtype=np.float32)


def _extract_stereo_pair(audio_segment: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    segment = np.asarray(audio_segment, dtype=np.float32)
    if segment.ndim != 2:
        return None
    if segment.shape[0] == 2:
        return segment[0], segment[1]
    if segment.shape[1] == 2:
        return segment[:, 0], segment[:, 1]
    return None


def _calculate_rms(audio_segment: np.ndarray) -> float:
    segment = _as_mono(audio_segment)
    if segment.size == 0:
        return 0.0
    return _safe_float(np.sqrt(np.mean(np.square(segment), dtype=np.float64)))


def _calculate_spectral_similarity(segment1: np.ndarray, segment2: np.ndarray, sr: int) -> float:
    del sr  # retained for interface compatibility
    mono1 = _as_mono(segment1)
    mono2 = _as_mono(segment2)
    if mono1.size == 0 or mono2.size == 0:
        return 0.0
    spectrum1 = np.abs(np.fft.rfft(mono1))
    spectrum2 = np.abs(np.fft.rfft(mono2))
    min_len = min(len(spectrum1), len(spectrum2))
    if min_len == 0:
        return 0.0
    spectrum1 = spectrum1[:min_len]
    spectrum2 = spectrum2[:min_len]
    denom = max(float(np.linalg.norm(spectrum1) + np.linalg.norm(spectrum2)), 1e-12)
    distance = float(euclidean(spectrum1, spectrum2))
    return _clamp01(1.0 - (distance / denom))


def _calculate_crossfade_correlation(segment1: np.ndarray, segment2: np.ndarray) -> float:
    mono1 = _as_mono(segment1)
    mono2 = _as_mono(segment2)
    if mono1.size == 0 or mono2.size == 0:
        return 0.0
    length = min(mono1.size, mono2.size)
    mono1 = mono1[:length]
    mono2 = mono2[:length]
    denom = float(np.linalg.norm(mono1) * np.linalg.norm(mono2))
    if denom <= 1e-12:
        return 0.0
    correlation = correlate(mono1, mono2, mode="valid")
    return _clamp01(float(np.max(correlation) / denom))


def _detect_transient(audio_segment: np.ndarray, sr: int) -> float:
    mono = _as_mono(audio_segment)
    if mono.size < max(2, int(sr * 0.02)):
        return 0.0
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
    if onset_env.size == 0:
        return 0.0
    return _clamp01(float(np.max(onset_env) / (np.max(onset_env) + np.mean(onset_env) + 1e-12)))


def _calculate_stereo_image_continuity(segment1: np.ndarray, segment2: np.ndarray) -> float:
    stereo1 = _extract_stereo_pair(segment1)
    stereo2 = _extract_stereo_pair(segment2)
    if stereo1 is None or stereo2 is None:
        return 1.0

    left1, right1 = stereo1
    left2, right2 = stereo2
    corr1 = float(np.corrcoef(left1, right1)[0, 1]) if left1.size > 1 else 1.0
    corr2 = float(np.corrcoef(left2, right2)[0, 1]) if left2.size > 1 else 1.0
    if np.isnan(corr1):
        corr1 = 1.0
    if np.isnan(corr2):
        corr2 = 1.0
    return _clamp01(1.0 - abs(corr1 - corr2))


def _calculate_low_end_continuity(segment1: np.ndarray, segment2: np.ndarray, sr: int) -> float:
    mono1 = _as_mono(segment1)
    mono2 = _as_mono(segment2)
    if mono1.size < 8 or mono2.size < 8:
        return 1.0
    b, a = butter(5, 200, btype="low", fs=sr)
    low1 = filtfilt(b, a, mono1)
    low2 = filtfilt(b, a, mono2)
    rms1 = max(_calculate_rms(low1), 1e-9)
    rms2 = max(_calculate_rms(low2), 1e-9)
    return _clamp01(1.0 - abs(rms1 - rms2) / max(rms1, rms2))


def _compute_repetition_salience(
    audio_path: Path,
    segment_start_ms: int,
    segment_end_ms: int,
) -> float:
    audio, sample_rate = _load_mono_audio(str(audio_path.resolve()))
    start_sample = int(round((segment_start_ms / 1000.0) * sample_rate))
    end_sample = int(round((segment_end_ms / 1000.0) * sample_rate))
    segment = _slice_mono_segment(audio, start_sample, end_sample)
    if segment.size < max(32, int(sample_rate * 0.25)):
        return 0.0

    rms_window = max(32, int(sample_rate * 0.10))
    rms_values = librosa.feature.rms(
        y=segment,
        frame_length=rms_window,
        hop_length=rms_window,
        center=False,
    )[0]
    transient_density_score = _normalised_variance(rms_values)

    chroma_hop = max(128, int(sample_rate * 0.05))
    chroma = librosa.feature.chroma_stft(
        y=segment,
        sr=sample_rate,
        hop_length=chroma_hop,
        center=False,
    )
    tonal_trace = np.mean(chroma, axis=0) if chroma.size else np.zeros(0, dtype=np.float32)
    if tonal_trace.size > 1:
        tonal_trace = tonal_trace - np.mean(tonal_trace)
        autocorrelation = np.correlate(tonal_trace, tonal_trace, mode="full")
        autocorrelation = autocorrelation[autocorrelation.size // 2 :]
        if autocorrelation.size and autocorrelation[0] > 0:
            autocorrelation = autocorrelation / autocorrelation[0]
            lag_scores: list[float] = []
            for lag_seconds in (0.5, 1.0, 2.0):
                lag = int(round((lag_seconds * sample_rate) / chroma_hop))
                if 0 < lag < autocorrelation.size:
                    lag_scores.append(_clamp01(float(autocorrelation[lag])))
            tonal_periodicity_score = float(np.mean(lag_scores)) if lag_scores else 0.0
        else:
            tonal_periodicity_score = 0.0
    else:
        tonal_periodicity_score = 0.0

    spectral_centroid = librosa.feature.spectral_centroid(
        y=segment,
        sr=sample_rate,
        hop_length=chroma_hop,
        center=False,
    )[0]
    spectral_centroid_variance = _normalised_variance(spectral_centroid)

    salience = (
        0.40 * transient_density_score
        + 0.35 * tonal_periodicity_score
        + 0.25 * spectral_centroid_variance
    )
    return _clamp01(salience)


def validate_loop_candidate(
    loop_pair: LoopPair,
    mlaudio: MLAudio,
    crossfade_samples: int,
) -> dict[str, float]:
    """
    Validate a single loop candidate using multiple sonic metrics.

    Args:
        loop_pair: The LoopPair object from PyMusicLooper.
        mlaudio: The MLAudio object containing the audio data.
        crossfade_samples: The number of samples to use for crossfade region.

    Returns:
        A dictionary of validation scores.
    """
    audio_data = np.asarray(mlaudio.audio)
    sr = int(mlaudio.rate)
    mono_audio = _as_mono(audio_data)

    max_head = max(0, int(loop_pair.loop_start))
    max_tail = max(0, int(len(mono_audio) - loop_pair.loop_end))
    crossfade_samples = min(max(1, int(crossfade_samples)), max_head, max_tail)
    if crossfade_samples <= 0:
        raise ValueError("Loop candidate does not have enough context for validation")

    if audio_data.ndim == 1:
        head_segment = audio_data[loop_pair.loop_start - crossfade_samples : loop_pair.loop_start]
        tail_segment = audio_data[loop_pair.loop_end : loop_pair.loop_end + crossfade_samples]
    elif audio_data.shape[0] <= 8:
        head_segment = audio_data[:, loop_pair.loop_start - crossfade_samples : loop_pair.loop_start]
        tail_segment = audio_data[:, loop_pair.loop_end : loop_pair.loop_end + crossfade_samples]
    else:
        head_segment = audio_data[loop_pair.loop_start - crossfade_samples : loop_pair.loop_start, :]
        tail_segment = audio_data[loop_pair.loop_end : loop_pair.loop_end + crossfade_samples, :]

    rms_head = max(_calculate_rms(head_segment), 1e-9)
    rms_tail = max(_calculate_rms(tail_segment), 1e-9)
    rms_continuity = _clamp01(1.0 - abs(rms_head - rms_tail) / max(rms_head, rms_tail))
    spectral_similarity = _calculate_spectral_similarity(head_segment, tail_segment, sr)
    correlation = _calculate_crossfade_correlation(head_segment, tail_segment)
    transient_penalty = _clamp01(
        _detect_transient(head_segment, sr) + _detect_transient(tail_segment, sr)
    )
    stereo_image_continuity = _calculate_stereo_image_continuity(head_segment, tail_segment)
    low_end_continuity = _calculate_low_end_continuity(head_segment, tail_segment, sr)

    combined_score = (
        correlation * 0.30
        + spectral_similarity * 0.25
        + rms_continuity * 0.20
        + stereo_image_continuity * 0.15
        + low_end_continuity * 0.10
        - transient_penalty * 0.50
    )
    combined_score = _clamp01(combined_score)

    return {
        "rms_continuity": rms_continuity,
        "spectral_similarity": spectral_similarity,
        "correlation": correlation,
        "transient_penalty": transient_penalty,
        "stereo_image_continuity": stereo_image_continuity,
        "low_end_continuity": low_end_continuity,
        "validator_score": combined_score,
    }


def analyze_loop(input_path: Path) -> dict[str, Any]:
    """
    Analyze an audio file to find the best seamless loop points.

    Args:
        input_path: Path to the audio file.

    Returns:
        Dictionary with keys:
            loop_start_ms: Loop start position in milliseconds
            loop_end_ms: Loop end position in milliseconds
            score: Confidence score (0.0-1.0)
            crossfade_ms: Recommended crossfade duration in milliseconds
            duration_ms: Original audio duration in milliseconds
            candidates: Top loop candidates suitable for LoopSegment construction

    Raises:
        ValueError: If no suitable loop points are found.
        RuntimeError: For other analysis failures.
    """
    try:
        try:
            looper = MusicLooper(str(input_path))
        except Exception as e:
            raise RuntimeError(f"Failed to load audio file: {e}") from e

        try:
            loop_pairs = looper.find_loop_pairs()
        except LoopNotFoundError as e:
            raise ValueError(f"No loop points found in '{input_path.name}': {e}") from e
        except Exception as e:
            raise RuntimeError(f"Loop analysis failed: {e}") from e

        if not loop_pairs:
            raise ValueError(f"No loop points found in '{input_path.name}'")

        top_n_candidates = sorted(loop_pairs, key=lambda pair: pair.score, reverse=True)[:5]
        validated_candidates: list[dict[str, Any]] = []

        for index, candidate in enumerate(top_n_candidates, start=1):
            loop_start_ms = int(looper.samples_to_seconds(candidate.loop_start) * 1000)
            loop_end_ms = int(looper.samples_to_seconds(candidate.loop_end) * 1000)
            loop_duration_ms = max(1, loop_end_ms - loop_start_ms)
            crossfade_ms = min(4000, max(250, int(loop_duration_ms * 0.07)))
            crossfade_samples = looper.mlaudio.seconds_to_samples(crossfade_ms / 1000.0)

            validation_scores = validate_loop_candidate(candidate, looper.mlaudio, crossfade_samples)
            repetition_salience_score = _compute_repetition_salience(
                input_path,
                loop_start_ms,
                loop_end_ms,
            )
            canonical_duration_ms = max(1, loop_duration_ms - crossfade_ms)

            validated_candidates.append(
                {
                    "segment_id": f"candidate_{index:02d}",
                    "source_path": str(input_path.resolve()),
                    "loop_start_ms": loop_start_ms,
                    "loop_end_ms": loop_end_ms,
                    "canonical_duration_ms": canonical_duration_ms,
                    "play_duration_ms": canonical_duration_ms,
                    "crossfade_duration_ms": crossfade_ms,
                    "trim_tail_ms": 0,
                    "raw_analyzer_score": float(candidate.score),
                    "validator_score": validation_scores["validator_score"],
                    "repetition_salience_score": repetition_salience_score,
                    "validation_metrics": validation_scores,
                }
            )

        validated_candidates.sort(key=lambda candidate: candidate["validator_score"], reverse=True)
        selected_candidates = validated_candidates[: min(5, max(1, len(validated_candidates)))]
        best_candidate = selected_candidates[0]

        logger.info(
            "Loop analysis complete: start=%sms, end=%sms, raw_score=%.3f, validator_score=%.3f, crossfade=%sms, salience=%.3f",
            best_candidate["loop_start_ms"],
            best_candidate["loop_end_ms"],
            best_candidate["raw_analyzer_score"],
            best_candidate["validator_score"],
            best_candidate["crossfade_duration_ms"],
            best_candidate["repetition_salience_score"],
        )

        return {
            "loop_start_ms": best_candidate["loop_start_ms"],
            "loop_end_ms": best_candidate["loop_end_ms"],
            "score": best_candidate["validator_score"],
            "crossfade_ms": best_candidate["crossfade_duration_ms"],
            "duration_ms": int(looper.mlaudio.total_duration * 1000),
            "raw_analyzer_score": best_candidate["raw_analyzer_score"],
            "candidates": [
                {
                    key: value
                    for key, value in candidate.items()
                    if key != "validation_metrics"
                }
                for candidate in selected_candidates
            ],
            "alternatives": [
                {
                    "segment_id": candidate["segment_id"],
                    "loop_start_ms": candidate["loop_start_ms"],
                    "loop_end_ms": candidate["loop_end_ms"],
                    "crossfade_ms": candidate["crossfade_duration_ms"],
                    "raw_analyzer_score": candidate["raw_analyzer_score"],
                    "validator_score": candidate["validator_score"],
                    "repetition_salience_score": candidate["repetition_salience_score"],
                    "validation_metrics": candidate["validation_metrics"],
                }
                for candidate in selected_candidates[1:]
            ],
        }
    finally:
        _load_mono_audio.cache_clear()
