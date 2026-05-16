from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)


def _run(cmd: list[str], timeout: int = 60) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        logger.warning(f"Command timed out after {timeout}s: {' '.join(cmd)}")
        return 1, "", f"Command timed out after {timeout}s"
    except FileNotFoundError as e:
        logger.error(f"Command not found: {cmd[0]}")
        return 1, "", f"Command not found: {e}"


def ffprobe_audio_summary(path: Path) -> str:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,sample_rate,channels:format=duration,bit_rate,size",
        "-of",
        "json",
        str(path),
    ]
    code, stdout, stderr = _run(cmd)
    if code != 0:
        return f"ffprobe failed for {path.name}: {stderr[-300:]}"
    try:
        data = json.loads(stdout)
        fmt = data.get("format", {})
        streams = data.get("streams", [])
        audio = streams[0] if streams else {}
        duration = float(fmt.get("duration", 0.0))
        bitrate = int(fmt.get("bit_rate", 0) or 0)
        size = int(fmt.get("size", 0) or 0)
        return (
            f"{path.name} | dur={duration:.3f}s sr={audio.get('sample_rate')}Hz "
            f"ch={audio.get('channels')} codec={audio.get('codec_name')} "
            f"bitrate={bitrate} size={size}"
        )
    except Exception as exc:  # pragma: no cover
        return f"ffprobe parse failed for {path.name}: {exc}"


def silence_summary(path: Path, noise_db: int = -45, min_silence: float = 1.0) -> str:
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
        "-af",
        f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f",
        "null",
        "-",
    ]
    code, _, stderr = _run(cmd, timeout=120)
    if code != 0 and not stderr:
        return f"silencedetect failed for {path.name}"

    starts: list[float] = []
    ends: list[tuple[float, float]] = []
    for line in stderr.splitlines():
        line = line.strip()
        if "silence_start:" in line:
            try:
                starts.append(float(line.split("silence_start:")[1].strip()))
            except Exception:
                continue
        if "silence_end:" in line and "silence_duration:" in line:
            try:
                right = line.split("silence_end:")[1].strip()
                end_str, dur_str = right.split("| silence_duration:")
                ends.append((float(end_str.strip()), float(dur_str.strip())))
            except Exception:
                continue

    if not starts and not ends:
        return f"{path.name} | silences=none (>{min_silence:.1f}s @ {noise_db}dB)"

    windows: list[str] = []
    for i, (end, dur) in enumerate(ends[:8]):
        start = starts[i] if i < len(starts) else max(0.0, end - dur)
        windows.append(f"{start:.2f}-{end:.2f}s({dur:.2f}s)")
    more = f" +{len(ends) - 8} more" if len(ends) > 8 else ""
    return f"{path.name} | silences={len(ends)} [{', '.join(windows)}]{more}"


def log_audio_debug(
    path: Path,
    log_fn: Callable[[str], None] | None = None,
    prefix: str = "",
) -> None:
    sink = log_fn or logger.info
    sink(f"{prefix}{ffprobe_audio_summary(path)}")
    sink(f"{prefix}{silence_summary(path)}")
