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
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

import ffmpeg

if TYPE_CHECKING:
    from config import Settings

logger = logging.getLogger(__name__)


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
    ) -> None:
        """
        Encode an MP4 combining a static background image + audio.

        The video uses a simple scale filter to fit the background image to
        the target resolution, and outputs at 1 frame per second.
        """
        s = self.settings
        try:
            (
                ffmpeg.input(str(background_path), loop=1, framerate=1)
                .output(
                    ffmpeg.input(str(audio_path)).audio,
                    str(output_path),
                    vcodec=s.VIDEO_CODEC,
                    acodec=s.AUDIO_CODEC,
                    preset=s.PRESET,
                    crf=s.CRF,
                    pix_fmt="yuv420p",
                    movflags="+faststart",
                    vf=f"scale={s.VIDEO_WIDTH}:{s.VIDEO_HEIGHT}",
                    shortest=None,
                    t=duration_seconds,
                    r=1,  # 1 fps — tiny file, instant render
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
        progress_callback: Optional[Callable[[int], None]] = None,
    ) -> Optional[subprocess.Popen]:
        """
        Encode an MP4 asynchronously with progress tracking.

        Returns the subprocess for potential cancellation.
        """
        s = self.settings

        # Build ffmpeg command
        video_input = ffmpeg.input(str(background_path), loop=1, framerate=1)
        audio_input = ffmpeg.input(str(audio_path))

        cmd = (
            video_input.output(
                audio_input.audio,
                str(output_path),
                vcodec=s.VIDEO_CODEC,
                acodec=s.AUDIO_CODEC,
                preset=s.PRESET,
                crf=s.CRF,
                pix_fmt="yuv420p",
                movflags="+faststart",
                vf=f"scale={s.VIDEO_WIDTH}:{s.VIDEO_HEIGHT}",
                shortest=None,
                t=duration_seconds,
                r=1,
            )
            .overwrite_output()
            .compile()
        )

        logger.info(f"Running ffmpeg video command: {' '.join(cmd)}")

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
            logger.error("FFmpeg video error:\n%s", stderr)
            raise RuntimeError(f"FFmpeg video failed: {stderr[-500:]}")

        logger.info("Video rendered → %s", output_path)
        return process