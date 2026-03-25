"""
Central configuration for Ambient Studio Backend.
All tuneable values live here — override with environment variables.
"""

import os
from pathlib import Path


class Settings:
    # ── Paths ──────────────────────────────────────────────────────────────
    BASE_DIR: Path = Path(__file__).parent
    ASSETS_DIR: str = str(BASE_DIR / "assets")
    TMP_DIR: str = str(BASE_DIR / "tmp")
    DEFAULT_BACKGROUND: str = str(BASE_DIR / "assets" / "background.jpg")

    # ── Server ─────────────────────────────────────────────────────────────
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", 3001))
    ALLOWED_ORIGINS: list[str] = os.getenv(
        "ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:3001"
    ).split(",")

    # ── Audio rendering ────────────────────────────────────────────────────
    SAMPLE_RATE: int = int(os.getenv("SAMPLE_RATE", 44100))
    CHANNELS: int = 2           # stereo output
    BIT_DEPTH: int = 16         # WAV PCM 16-bit
    MAX_DURATION: int = 28800    # 8 hours hard cap

    # 7-Band EQ center frequencies (Hz)
    EQ_BANDS: list[dict] = [
        {"label": "Sub",        "freq": 60,    "type": "lowshelf"},
        {"label": "Bass",       "freq": 200,   "type": "peaking"},
        {"label": "Low-Mid",    "freq": 500,   "type": "peaking"},
        {"label": "Mid",        "freq": 1000,  "type": "peaking"},
        {"label": "Upper-Mid",  "freq": 3000,  "type": "peaking"},
        {"label": "Presence",   "freq": 8000,  "type": "peaking"},
        {"label": "Air",        "freq": 16000, "type": "highshelf"},
    ]

    # ── Video rendering ────────────────────────────────────────────────────
    VIDEO_WIDTH: int  = int(os.getenv("VIDEO_WIDTH",  1920))
    VIDEO_HEIGHT: int = int(os.getenv("VIDEO_HEIGHT", 1080))
    VIDEO_FPS: int    = int(os.getenv("VIDEO_FPS",    25))
    VIDEO_CODEC: str  = os.getenv("VIDEO_CODEC",  "libx264")
    AUDIO_CODEC: str  = os.getenv("AUDIO_CODEC",  "aac")
    PRESET: str       = os.getenv("FFMPEG_PRESET", "veryfast")
    CRF: int          = int(os.getenv("CRF", 23))
    ZOOM_START: float = 1.0
    ZOOM_END: float   = 1.2


settings = Settings()