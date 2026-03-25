"""
AudioRenderer
=============
Uses ffmpeg natively for all audio processing.
Memory usage: ~20MB regardless of duration or track count.
No numpy, scipy, or pydub required.
"""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

import ffmpeg

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)


class AudioRenderer:
    def __init__(self, settings: "Settings"):
        self.settings = settings

    def render(
        self,
        *,
        track_paths: list[Path],
        output_path: Path,
        duration_seconds: int,
        volumes: list[float],
        pans: list[float],
        muted: list[bool],
        solo: list[bool],
        master_gain: float,
        eq_gains: list[float],
        progress_callback: Optional[Callable[[int], None]] = None,
    ) -> None:
        """
        Render audio mix synchronously.
        
        Args:
            track_paths: List of paths to audio track files
            output_path: Path for output WAV file
            duration_seconds: Output duration in seconds
            volumes: Per-track volume multipliers (0.0-1.5)
            pans: Per-track pan values (-1.0 left to 1.0 right)
            muted: Per-track mute flags
            solo: Per-track solo flags
            master_gain: Master gain multiplier
            eq_gains: 7-band EQ gains in dB
            progress_callback: Optional callback for progress updates (0-100)
        """
        is_solo_active = any(solo)

        # Filter to active tracks only
        active = []
        for i, path in enumerate(track_paths):
            vol = volumes[i] if i < len(volumes) else 1.0
            is_mut = muted[i] if i < len(muted) else False
            is_sol = solo[i] if i < len(solo) else False
            eff = 0.0 if (is_mut or (is_solo_active and not is_sol)) else vol
            if eff > 0.0:
                active.append((path, eff, pans[i] if i < len(pans) else 0.0))

        if not active:
            raise ValueError("No active tracks to render")

        try:
            # Build ffmpeg inputs — each track loops for the full duration
            inputs = []
            for path, vol, pan in active:
                stream = ffmpeg.input(
                    str(path),
                    stream_loop=-1,  # loop indefinitely
                    t=duration_seconds,
                )
                # Apply volume
                stream = stream.filter("volume", vol)
                # Apply pan (-1.0 to 1.0 → pan filter)
                if abs(pan) > 0.01:
                    # Convert pan to left/right gains
                    import math

                    angle = (pan + 1.0) / 2.0 * (math.pi / 2.0)
                    left_gain = math.cos(angle)
                    right_gain = math.sin(angle)
                    stream = stream.filter(
                        "pan",
                        "stereo",
                        c0=f"{left_gain}*c0",
                        c1=f"{right_gain}*c0",
                    )
                inputs.append(stream)

            # Mix all tracks together
            if len(inputs) == 1:
                mixed = inputs[0]
            else:
                mixed = ffmpeg.filter(
                    inputs,
                    "amix",
                    inputs=len(inputs),
                    duration="longest",
                    normalize=0,  # don't auto-normalize — we control gain
                )

            # Apply master gain
            mixed = mixed.filter("volume", master_gain)

            # Apply 7-band EQ using equalizer filter
            bands = self.settings.EQ_BANDS
            for i, band in enumerate(bands):
                gain_db = eq_gains[i] if i < len(eq_gains) else 0.0
                if abs(gain_db) < 0.1:
                    continue
                mixed = mixed.filter(
                    "equalizer",
                    f=band["freq"],
                    t="o",  # peaking filter type
                    w=1.0,  # bandwidth in octaves
                    g=gain_db,
                )

            # Build command
            cmd = (
                mixed.output(
                    str(output_path),
                    t=duration_seconds,
                    ar=self.settings.SAMPLE_RATE,
                    ac=self.settings.CHANNELS,
                    acodec="pcm_s16le",
                )
                .overwrite_output()
                .compile()
            )

            logger.info(f"Running ffmpeg audio command: {' '.join(cmd)}")

            # If progress callback is provided, run as subprocess and monitor stderr
            if progress_callback and duration_seconds > 0:
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                )

                # Monitor stderr for progress
                stderr_buffer = []
                for line in process.stderr:
                    stderr_buffer.append(line)
                    
                    # Parse progress from stderr
                    time_match = re.search(r"time=(\d+):(\d+):(\d+\.?\d*)", line)
                    if time_match:
                        hours = int(time_match.group(1))
                        minutes = int(time_match.group(2))
                        seconds = float(time_match.group(3))
                        current_time = hours * 3600 + minutes * 60 + seconds
                        progress = min(100, int((current_time / duration_seconds) * 100))
                        progress_callback(progress)

                process.wait()

                if process.returncode != 0:
                    stderr = "".join(stderr_buffer)
                    logger.error("FFmpeg audio error:\n%s", stderr)
                    raise RuntimeError(f"FFmpeg audio failed: {stderr[-500:]}")
            else:
                # Run without progress monitoring
                (
                    mixed.output(
                        str(output_path),
                        t=duration_seconds,
                        ar=self.settings.SAMPLE_RATE,
                        ac=self.settings.CHANNELS,
                        acodec="pcm_s16le",
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True)
                )

        except ffmpeg.Error as exc:
            stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
            logger.error("FFmpeg audio error:\n%s", stderr)
            raise RuntimeError(f"FFmpeg audio failed: {stderr[-500:]}") from exc

        logger.info("Audio rendered → %s", output_path)

    async def render_async(
        self,
        *,
        track_paths: list[Path],
        output_path: Path,
        duration_seconds: int,
        volumes: list[float],
        pans: list[float],
        muted: list[bool],
        solo: list[bool],
        master_gain: float,
        eq_gains: list[float],
        progress_callback: Optional[Callable[[int], None]] = None,
    ) -> Optional[asyncio.subprocess.Process]:
        """
        Render audio mix asynchronously with progress tracking.
        
        Returns the subprocess for potential cancellation.
        """
        is_solo_active = any(solo)

        # Filter to active tracks only
        active = []
        for i, path in enumerate(track_paths):
            vol = volumes[i] if i < len(volumes) else 1.0
            is_mut = muted[i] if i < len(muted) else False
            is_sol = solo[i] if i < len(solo) else False
            eff = 0.0 if (is_mut or (is_solo_active and not is_sol)) else vol
            if eff > 0.0:
                active.append((path, eff, pans[i] if i < len(pans) else 0.0))

        if not active:
            raise ValueError("No active tracks to render")

        # Build ffmpeg command using ffmpeg-python
        inputs = []
        for path, vol, pan in active:
            stream = ffmpeg.input(
                str(path),
                stream_loop=-1,
                t=duration_seconds,
            )
            stream = stream.filter("volume", vol)
            if abs(pan) > 0.01:
                import math
                angle = (pan + 1.0) / 2.0 * (math.pi / 2.0)
                left_gain = math.cos(angle)
                right_gain = math.sin(angle)
                stream = stream.filter(
                    "pan",
                    "stereo",
                    c0=f"{left_gain}*c0",
                    c1=f"{right_gain}*c0",
                )
            inputs.append(stream)

        if len(inputs) == 1:
            mixed = inputs[0]
        else:
            mixed = ffmpeg.filter(
                inputs,
                "amix",
                inputs=len(inputs),
                duration="longest",
                normalize=0,
            )

        mixed = mixed.filter("volume", master_gain)

        bands = self.settings.EQ_BANDS
        for i, band in enumerate(bands):
            gain_db = eq_gains[i] if i < len(eq_gains) else 0.0
            if abs(gain_db) < 0.1:
                continue
            mixed = mixed.filter(
                "equalizer",
                f=band["freq"],
                t="o",
                w=1.0,
                g=gain_db,
            )

        # Build command
        cmd = (
            mixed.output(
                str(output_path),
                t=duration_seconds,
                ar=self.settings.SAMPLE_RATE,
                ac=self.settings.CHANNELS,
                acodec="pcm_s16le",
            )
            .overwrite_output()
            .compile()
        )

        logger.info(f"Running ffmpeg audio command: {' '.join(cmd)}")

        # Run as subprocess
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Monitor stderr for progress
        stderr_buffer = []
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            line_str = line.decode("utf-8", errors="replace")
            stderr_buffer.append(line_str)

            # Parse progress from stderr
            if progress_callback and duration_seconds > 0:
                time_match = re.search(r"time=(\d+):(\d+):(\d+\.?\d*)", line_str)
                if time_match:
                    hours = int(time_match.group(1))
                    minutes = int(time_match.group(2))
                    seconds = float(time_match.group(3))
                    current_time = hours * 3600 + minutes * 60 + seconds
                    progress = min(100, int((current_time / duration_seconds) * 100))
                    progress_callback(progress)

        await process.wait()

        if process.returncode != 0:
            stderr = "".join(stderr_buffer)
            logger.error("FFmpeg audio error:\n%s", stderr)
            raise RuntimeError(f"FFmpeg audio failed: {stderr[-500:]}")

        logger.info("Audio rendered → %s", output_path)
        return process