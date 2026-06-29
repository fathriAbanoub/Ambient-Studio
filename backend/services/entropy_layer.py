from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pedalboard import HighpassFilter, Limiter, Pedalboard
from pedalboard.io import AudioFile
from scipy.signal import butter, sosfiltfilt


@dataclass(frozen=True, slots=True)
class EntropyLayerParams:
    gain_drift_db: float = 1.5
    gain_min_frequency_hz: float = 1.0 / 240.0
    gain_max_frequency_hz: float = 1.0 / 45.0
    stereo_drift_amount: float = 0.06
    stereo_min_frequency_hz: float = 1.0 / 300.0
    stereo_max_frequency_hz: float = 1.0 / 75.0
    hf_drift_db: float = 1.25
    hf_min_frequency_hz: float = 1.0 / 360.0
    hf_max_frequency_hz: float = 1.0 / 90.0
    hf_cutoff_hz: float = 4000.0
    seed: int | None = None


def _lowpass_envelope(envelope: np.ndarray, cutoff_hz: float, sample_rate: int) -> np.ndarray:
    """Apply a gentle zero-phase low-pass filter to the gain envelope."""
    if envelope.size <= 1:
        return envelope.astype(np.float32)

    nyquist = sample_rate / 2.0
    normalized_cutoff = min(cutoff_hz / max(nyquist, 1e-9), 0.999)
    if normalized_cutoff <= 0.0:
        return envelope.astype(np.float32)

    sos = butter(2, normalized_cutoff, btype="low", output="sos")
    filtered = sosfiltfilt(sos, envelope.astype(np.float64))
    return filtered.astype(np.float32)


def _edge_taper(envelope: np.ndarray, taper_samples: int) -> np.ndarray:
    """Fade the envelope back toward unity at both edges."""
    tapered = np.asarray(envelope, dtype=np.float32).copy()
    edge_samples = min(max(0, int(taper_samples)), tapered.size // 2)
    if edge_samples <= 0:
        return tapered

    ramp = np.linspace(0.0, 1.0, edge_samples, dtype=np.float32)
    tapered[:edge_samples] = 1.0 + (tapered[:edge_samples] - 1.0) * ramp
    tapered[-edge_samples:] = 1.0 + (tapered[-edge_samples:] - 1.0) * ramp[::-1]
    return tapered


class SlowDriftProcessor:
    def _build_band_limited_pink_noise(
        self,
        *,
        sample_count: int,
        sample_rate: int,
        min_frequency_hz: float,
        max_frequency_hz: float,
        rng: np.random.Generator,
    ) -> np.ndarray:
        if sample_count <= 0:
            return np.zeros(0, dtype=np.float32)

        white = rng.standard_normal(sample_count).astype(np.float32)
        spectrum = np.fft.rfft(white)
        freqs = np.fft.rfftfreq(sample_count, d=1.0 / sample_rate)
        freqs[0] = max(min_frequency_hz, 1.0 / max(sample_count / sample_rate, 1e-6))

        pink_weight = 1.0 / np.sqrt(np.maximum(freqs, 1e-9))
        band_mask = (freqs >= max(min_frequency_hz, 0.0)) & (freqs <= max_frequency_hz)
        filtered_spectrum = spectrum * pink_weight * band_mask
        noise = np.fft.irfft(filtered_spectrum, n=sample_count)
        noise = np.asarray(noise, dtype=np.float32)
        noise -= float(np.mean(noise))
        max_abs = float(np.max(np.abs(noise))) if noise.size else 0.0
        if max_abs > 0:
            noise /= max_abs
        return noise.astype(np.float32)

    def build_gain_envelope(
        self,
        duration_seconds: float,
        sample_rate: int,
        params: EntropyLayerParams,
    ) -> np.ndarray:
        sample_count = max(1, int(round(duration_seconds * sample_rate)))
        rng = np.random.default_rng(params.seed)
        noise = self._build_band_limited_pink_noise(
            sample_count=sample_count,
            sample_rate=sample_rate,
            min_frequency_hz=params.gain_min_frequency_hz,
            max_frequency_hz=params.gain_max_frequency_hz,
            rng=rng,
        )
        gain_db = noise * params.gain_drift_db
        linear_gain = np.power(10.0, gain_db / 20.0, dtype=np.float32)

        if sample_count > 40:
            linear_gain = _lowpass_envelope(
                linear_gain,
                cutoff_hz=20.0,
                sample_rate=sample_rate,
            )

        taper_samples = int(round(0.050 * sample_rate))
        linear_gain = _edge_taper(linear_gain, taper_samples)
        return linear_gain.astype(np.float32)

    # ponytail: 2h hard cap. 8h render at 44.1kHz stereo float32 ≈ 10 GB RAM.
    # Upgrade path: rewrite as FFmpeg filter chain to avoid loading to numpy entirely.
    MAX_ENTROPY_SECONDS = 7200

    def process(
        self,
        audio_path: Path,
        output_path: Path,
        params: EntropyLayerParams,
        sample_rate: int,
    ) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with AudioFile(str(audio_path)) as probe:
            duration_seconds = probe.frames / max(probe.samplerate, 1)
        if duration_seconds > self.MAX_ENTROPY_SECONDS:
            shutil.copy2(audio_path, output_path)
            return

        with AudioFile(str(audio_path)).resampled_to(sample_rate) as source_file:
            audio = source_file.read(source_file.frames)
            working_sample_rate = int(source_file.samplerate)

        if audio.ndim == 1:
            audio = np.expand_dims(audio, axis=0)
        audio = np.asarray(audio, dtype=np.float32)
        duration_seconds = audio.shape[1] / float(working_sample_rate)

        gain_envelope = self.build_gain_envelope(duration_seconds, working_sample_rate, params)
        processed = audio * gain_envelope[np.newaxis, :]

        if processed.shape[0] >= 2 and params.stereo_drift_amount > 0.0:
            stereo_noise = self._build_band_limited_pink_noise(
                sample_count=processed.shape[1],
                sample_rate=working_sample_rate,
                min_frequency_hz=params.stereo_min_frequency_hz,
                max_frequency_hz=params.stereo_max_frequency_hz,
                rng=np.random.default_rng(None if params.seed is None else params.seed + 1),
            )
            left_gain = (1.0 + (stereo_noise * params.stereo_drift_amount)).astype(np.float32)
            right_gain = (1.0 - (stereo_noise * params.stereo_drift_amount)).astype(np.float32)

            if processed.shape[1] > 40:
                left_gain = _lowpass_envelope(
                    left_gain,
                    cutoff_hz=20.0,
                    sample_rate=working_sample_rate,
                )
                right_gain = _lowpass_envelope(
                    right_gain,
                    cutoff_hz=20.0,
                    sample_rate=working_sample_rate,
                )

            taper_samples = int(round(0.050 * working_sample_rate))
            left_gain = _edge_taper(left_gain, taper_samples)
            right_gain = _edge_taper(right_gain, taper_samples)
            processed[0] *= left_gain
            processed[1] *= right_gain

        if params.hf_drift_db > 0.0:
            pad_samples = int(round(0.100 * working_sample_rate))
            padded = np.concatenate(
                [
                    np.zeros((processed.shape[0], pad_samples), dtype=np.float32),
                    processed,
                    np.zeros((processed.shape[0], pad_samples), dtype=np.float32),
                ],
                axis=1,
            )
            hf_board = Pedalboard([HighpassFilter(cutoff_frequency_hz=params.hf_cutoff_hz)])
            padded_hf = hf_board(padded, working_sample_rate)
            high_frequency_content = padded_hf[:, pad_samples:-pad_samples]

            hf_noise = self._build_band_limited_pink_noise(
                sample_count=processed.shape[1],
                sample_rate=working_sample_rate,
                min_frequency_hz=params.hf_min_frequency_hz,
                max_frequency_hz=params.hf_max_frequency_hz,
                rng=np.random.default_rng(None if params.seed is None else params.seed + 2),
            )
            hf_gain = np.power(10.0, (hf_noise * params.hf_drift_db) / 20.0).astype(np.float32)

            if processed.shape[1] > 40:
                hf_gain = _lowpass_envelope(
                    hf_gain,
                    cutoff_hz=20.0,
                    sample_rate=working_sample_rate,
                )

            taper_samples = int(round(0.050 * working_sample_rate))
            hf_gain = _edge_taper(hf_gain, taper_samples)
            processed += high_frequency_content * (hf_gain[np.newaxis, :] - 1.0)

        # Pre-attenuate by 2 dB so the limiter isn't constantly slamming the
        # ceiling. Without this, a file already at 0.0 dB peak causes the
        # limiter to engage on every loud section and its release (gain pumping
        # back up over ~100ms) produces the overdriven-speaker artifact.
        processed *= 0.794  # -2.0 dB in linear

        # release_ms=200 is slow enough that the gain recovery is inaudible
        # on ambient material. threshold_db=-1.0 gives 1 dB of headroom above
        # the attenuated signal.
        limiter = Limiter(threshold_db=-1.0, release_ms=200.0)
        processed = limiter(processed, working_sample_rate)

        with AudioFile(
            str(output_path),
            "w",
            working_sample_rate,
            num_channels=processed.shape[0],
        ) as output_file:
            output_file.write(np.asarray(processed, dtype=np.float32))
