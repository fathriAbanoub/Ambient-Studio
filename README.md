# AMBIENT.STUDIO

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-3.0.0-brightgreen)
![Stack](https://img.shields.io/badge/stack-Next.js%20%7C%20FastAPI%20%7C%20TypeScript%20%7C%20Python-orange)

> Create ambient soundscapes in your browser. Mix up to 8 audio tracks with volume, pan, EQ, loop analysis, stochastic variation, and export to WAV or MP4 video — with optional GPU acceleration.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [GPU Acceleration](#gpu-acceleration)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Multi-track Audio Mixer** — Browser-based interface with 8 track slots. The backend imposes no hard track limit.
- **Real-time EQ Control** — 7-band equalizer (Sub 60 Hz, Bass 200 Hz, Low-Mid 500 Hz, Mid 1 kHz, Upper-Mid 3 kHz, Presence 8 kHz, Air 16 kHz) with live frequency-response curve.
- **Per-track Controls** — Volume (0.0–1.5), pan (−1.0 to 1.0), mute, solo, color, and microphone input toggle.
- **Live VU Meter** — Real-time level visualizer driven by the Web Audio API analyser node.
- **Waveform Display** — Per-track canvas waveform rendered on file load.
- **Presets** — Built-in presets (Forest, Ocean, Space, Café) plus save/delete custom presets.
- **Loop Analysis** — Automatic detection of optimal loop points with crossfade and seamlessness scoring. Manual override via `loop_start` / `loop_end` parameters.
- **Stochastic Variation** — Per-loop randomization of volume, pan, and EQ micro-shifts via an entropy layer with slow drift — keeps long ambient tracks evolving.
- **WAV Export** — Rendered client-side via `OfflineAudioContext` (works offline) or server-side via the job system.
- **MP4 Video Export** — Server-side rendering via FFmpeg with three rendering paths:
  - CUDA GPU visualizer (6× faster than FFmpeg)
  - CPU-optimized visualizer (3–4× faster than FFmpeg)
  - FFmpeg `showfreqs` fallback
- **Frequency Visualizer** — Bar-style spectrum overlay on video output with configurable FPS and bar count.
- **Job Management** — Queue system with real-time progress tracking, cancellation, and concurrent render limiting (2 slots).
- **GPU Encoding** — Auto-detects NVIDIA NVENC for hardware-accelerated H.264 encoding; falls back to libx264.
- **System Monitoring** — View CPU, RAM, disk usage, and render statistics.
- **Responsive Design** — Optimized for various screen sizes.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18+ | Frontend runtime |
| Python | 3.9+ | Backend runtime |
| FFmpeg | 6.0+ | Audio/video processing (`ffmpeg` and `ffprobe` on PATH) |
| NVIDIA GPU (optional) | Compute Capability 7.0+ | Required for CUDA visualizer and NVENC encoding |
| CUDA Toolkit (optional) | 12.0+ | Required for CUDA visualizer |
| OpenCV with CUDA (optional) | 4.8+ | Custom build needed — see [GPU Acceleration](#gpu-acceleration) |

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/fathriAbanoub/Ambient-Studio.git
cd Ambient-Studio
```

### 2. Frontend setup

```bash
cd frontend
npm install
```

### 3. Backend setup

```bash
cd backend
pip install -r requirements.txt
```

### 4. Environment variables

Create `frontend/.env.local` (see [Configuration](#configuration)). The backend reads from environment variables — no `.env` file required.

## Usage

### Starting the frontend

```bash
cd frontend
npm run dev
```

Opens on `http://localhost:3002`.

### Starting the backend

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 3003
```

API available at `http://localhost:3003`.

Open `http://localhost:3002` in your browser, drag audio files onto track cards, adjust controls, and export.

> **Accepted audio formats:** WAV, MP3, OGG, FLAC, AAC (max 50 MB per file)
>
> **Rendered files** are saved to `backend/output/` and auto-deleted after 24 hours. Copy files before then.

## Configuration

### Frontend

Create `frontend/.env.local`:

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3003` | URL of the FastAPI backend |

> **Note:** `next.config.ts` sets `typescript: { ignoreBuildErrors: true }`. Resolve type errors before deploying.

### Backend

All settings are in `backend/config.py`. Override with environment variables.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3003` | Server port |
| `ALLOWED_ORIGINS` | `http://localhost:3002,http://localhost:3003` | Comma-separated CORS origins |
| `SAMPLE_RATE` | `44100` | Audio sample rate (Hz) |
| `CHANNELS` | `2` | Output channels (stereo) |
| `BIT_DEPTH` | `16` | WAV PCM bit depth |
| `MAX_DURATION` | `28800` | Maximum render duration in seconds (8 hours) |
| `VIDEO_WIDTH` | `1920` | Output video width (px) |
| `VIDEO_HEIGHT` | `1080` | Output video height (px) |
| `VIDEO_FPS` | `25` | Output video frame rate |
| `VIDEO_CODEC` | `h264_nvenc` | FFmpeg video codec (`h264_nvenc`, `libx264`, or `auto`) |
| `AUDIO_CODEC` | `aac` | FFmpeg audio codec |
| `FFMPEG_PRESET` | `veryfast` | libx264 encoding preset |
| `CRF` | `23` | Video quality (lower = better, larger file); used by libx264 |
| `NVENC_QP` | `23` | NVENC quality scale (0 = best, 51 = worst) |
| `USE_CUDA_VISUALIZER` | `true` | Use CUDA GPU visualizer when available; falls back to CPU or FFmpeg |
| `AUDIO_DEBUG` | `true` | Log detailed per-stage audio diagnostics |

## API Reference

### Health Check

```http
GET /health
```

Returns `{"status": "ok", "version": "3.0.0"}`.

---

### System Information

```http
GET /system
```

Returns CPU %, RAM used/total/%, output folder size/file count, and renders today.

---

### Job History

```http
GET /jobs
```

Returns the last 10 completed render jobs.

---

### Queue Status

```http
GET /queue
```

Returns `queue_depth`, `active_jobs`, `max_concurrent`, and `queued_jobs` list.

---

### Job Status

```http
GET /job/{job_id}
```

Returns full job dict: id, status, progress, duration, started_at, finished_at, error, output_path, filename, file_size, queue_position, logs, time_info.

---

### Job Progress

```http
GET /job/{job_id}/progress
```

Returns `job_id`, `status`, `progress`, `elapsed_seconds`, `remaining_seconds`, `queue_position`, `error`, `time_info`, `logs`.

---

### Cancel Job

```http
DELETE /job/{job_id}
```

Cancels a queued or processing job. Returns `{"status": "cancelled", "job_id": "..."}`.
Returns 404 if not found, 400 if not cancellable.

---

### Render Audio (synchronous)

```http
POST /render-audio
```

Renders a multi-track audio mix to WAV and returns the file immediately.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `duration` | int | *required* | Output duration in seconds (1–28800) |
| `files` | UploadFile[] | *required* | Audio track files |
| `volumes` | str | `""` | Comma-separated floats (0.0–1.5) per track |
| `pans` | str | `""` | Comma-separated floats (−1.0 to 1.0) per track |
| `muted` | str | `""` | Comma-separated "0"/"1" per track |
| `solo` | str | `""` | Comma-separated "0"/"1" per track |
| `master_gain` | float | `1.0` | Master gain multiplier (0.0–2.0) |
| `eq_gains` | str | `""` | Comma-separated EQ band gains in dB (7 bands) |

Returns: `FileResponse` — WAV file.

---

### Render Video (synchronous)

```http
POST /render-video
```

Combines a pre-rendered audio file with a background image to produce an MP4.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `audio` | UploadFile | *required* | Pre-rendered WAV/MP3 audio |
| `duration` | int | *required* | Duration in seconds (1–28800) |
| `background_image` | UploadFile | `None` | Optional custom background image |

Returns: `FileResponse` — MP4 file.

---

### Render Full Pipeline (async)

```http
POST /render-video-full
```

Asynchronous pipeline: audio mix → loop analysis → stochastic rotation → entropy layer → video encode. Returns a `job_id` immediately.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `duration` | int | *required* | Duration in seconds (1–28800) |
| `files` | UploadFile[] | *required* | Audio track files |
| `volumes` | str | `""` | Comma-separated floats per track |
| `pans` | str | `""` | Comma-separated floats per track |
| `muted` | str | `""` | Comma-separated "0"/"1" per track |
| `solo` | str | `""` | Comma-separated "0"/"1" per track |
| `master_gain` | float | `1.0` | Master gain multiplier |
| `eq_gains` | str | `""` | Comma-separated EQ band gains in dB (7 bands) |
| `background_image` | UploadFile | `None` | Optional custom background image |
| `show_visualizer` | str | `"0"` | `"0"` or `"1"` — show frequency spectrum overlay |
| `use_gpu_encoding` | str | `"1"` | `"0"` or `"1"` — use NVENC if available |
| `loop_start` | float | `None` | Manual loop start point in seconds |
| `loop_end` | float | `None` | Manual loop end point in seconds (must pair with `loop_start`) |

Returns: `{"status": "queued", "job_id": "...", "queue_position": N}`.
Poll `GET /job/{job_id}/progress` for status. Download via `GET /download/{job_id}`.

---

### Render Audio Job (async)

```http
POST /render-audio-job
```

Asynchronous audio-only pipeline: mix → loop analysis → stochastic rotation → entropy layer. Returns a `job_id` immediately.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `duration` | int | *required* | Duration in seconds (1–28800) |
| `files` | UploadFile[] | *required* | Audio track files |
| `volumes` | str | `""` | Comma-separated floats per track |
| `pans` | str | `""` | Comma-separated floats per track |
| `muted` | str | `""` | Comma-separated "0"/"1" per track |
| `solo` | str | `""` | Comma-separated "0"/"1" per track |
| `master_gain` | float | `1.0` | Master gain multiplier |
| `eq_gains` | str | `""` | Comma-separated EQ band gains in dB (7 bands) |
| `loop_start` | float | `None` | Manual loop start point in seconds |
| `loop_end` | float | `None` | Manual loop end point in seconds |

Returns: `{"status": "queued", "job_id": "...", "queue_position": N}`.

---

### Analyze Loop

```http
POST /analyze-loop
```

Analyzes a single audio file for optimal loop points.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file` | UploadFile | *required* | Audio file to analyze |

Returns: `{"loop_start_ms", "loop_end_ms", "score", "crossfade_ms", ...}`.

---

### Download Job Output

```http
GET /download/{job_id}
```

Downloads the completed output file (WAV or MP4) for a finished job.

Returns: `FileResponse`. Returns 404 if job/file not found, 400 if not completed.

## Architecture

### Rendering Pipeline

The full render pipeline (`POST /render-video-full`) processes jobs through these stages:

1. **Audio Mix** — Mixes all tracks with volume, pan, and 7-band EQ via `pedalboard`
2. **Loop Analysis** — Detects optimal loop points automatically (or uses manual override)
3. **Seamless Extension** — Extends short audio to target duration using crossfaded loops
4. **Stochastic Rotation** — Applies per-loop randomization of volume/pan/EQ micro-shifts via `StochasticVariationScheduler`
5. **Entropy Layer** — Adds slow drift (volume, pan, EQ) across the full duration for evolving texture
6. **Video Encode** — Combines background image + audio + optional visualizer into MP4

### Job Lifecycle

```text
queued → processing → completed / failed / cancelled
```

- **Concurrency** — Semaphore limits to 2 concurrent render slots
- **Cancellation** — `threading.Event` (stop_events) + subprocess kill + `asyncio.shield()` for clean shutdown
- **Progress** — Real-time progress percentage with elapsed/remaining time estimates
- **Persistence** — Last 100 jobs saved to `jobs_history.json`

### Frontend State

Single-page app with Zustand store (`studioStore.ts`) managing tracks, playback, EQ, export state, presets, loop analysis, and backend health. The `useAudioEngine` hook bridges Web Audio API to React.

## GPU Acceleration

### Rendering Paths (ordered by speed)

| Path | Speed | Requirements |
|---|---|---|
| CUDA visualizer + NVENC | ~6× faster than FFmpeg | NVIDIA GPU, CUDA 12.0+, OpenCV built with CUDA |
| CPU visualizer + NVENC | ~3–4× faster than FFmpeg | NVIDIA GPU (NVENC only) |
| FFmpeg showfreqs + NVENC | Baseline | NVIDIA GPU (NVENC only) |
| FFmpeg showfreqs + libx264 | Slowest | CPU only |

Auto-detection runs at startup: the backend probes `cv2.cuda.getCudaEnabledDeviceCount()` and `ffmpeg h264_nvenc` to select the best available path.

### Building OpenCV with CUDA

A build script is provided at `backend/build_opencv_cuda.sh` for OpenCV 4.8.0 with CUDA 12.0, targeting compute capability 7.5 (GTX 1650 Ti). Adjust `CUDA_ARCH_BIN` for your GPU.

```bash
cd backend
chmod +x build_opencv_cuda.sh
./build_opencv_cuda.sh   # Takes 20–30 minutes
pip uninstall opencv-contrib-python opencv-python  # Remove pip version
```

After building, set the CUDA library path:

```bash
source backend/set_cuda_env.sh
```

## Project Structure

```text
ambient-studio/
├── start.sh                          # One-command startup script (frontend + backend)
├── config.json                       # Project configuration (ports, workspace paths)
├── frontend/                         # Next.js 16 frontend (React 19, TypeScript)
│   ├── src/
│   │   ├── app/                      # Next.js App Router
│   │   │   ├── page.tsx              # Single-page studio app
│   │   │   ├── layout.tsx            # Root layout (fonts, providers)
│   │   │   ├── globals.css           # Tailwind + custom styles
│   │   │   └── api/render-video/     # API route proxying to backend
│   │   ├── components/studio/        # Core UI components
│   │   │   ├── TrackCard.tsx         # Track mixer card (volume, pan, mute, solo)
│   │   │   ├── Transport.tsx         # Play/stop, master volume, time display
│   │   │   ├── EQPanel.tsx           # 7-band EQ with frequency response canvas
│   │   │   ├── ExportPanel.tsx        # Export dialog with job progress tracking
│   │   │   ├── VideoPreview.tsx      # Video preview canvas
│   │   │   ├── PresetBar.tsx         # Preset selector (built-in + custom)
│   │   │   ├── Header.tsx            # Top bar with backend health indicator
│   │   │   └── LogConsole.tsx        # Timestamped render event log
│   │   ├── hooks/
│   │   │   └── useAudioEngine.ts     # Web Audio API bridge (playback, analyser)
│   │   ├── store/
│   │   │   └── studioStore.ts        # Zustand store (tracks, EQ, presets, export)
│   │   ├── types/
│   │   │   └── index.ts              # Shared TypeScript types and constants
│   │   └── lib/
│   │       ├── api.ts                # Backend API client
│   │       ├── audioRenderer.ts      # Client-side OfflineAudioContext renderer
│   │       └── utils.ts             # Tailwind utility (cn)
│   ├── public/                       # Static assets
│   └── package.json
├── backend/                          # FastAPI backend (Python 3.9+)
│   ├── main.py                       # App entry: endpoints, JobManager, job lifecycle
│   ├── config.py                     # Settings class (all env var overrides)
│   ├── requirements.txt              # Python dependencies
│   ├── services/
│   │   ├── audio_renderer.py         # Multi-track mixing with pedalboard EQ
│   │   ├── video_renderer.py         # FFmpeg-based video encoding (NVENC/libx264)
│   │   ├── cuda_visualizer.py        # GPU-accelerated spectrum visualizer (OpenCV CUDA)
│   │   ├── cpu_visualizer.py         # CPU-optimized spectrum visualizer (3–4× faster)
│   │   ├── loop_processor.py         # Loop creation, seamless extension, rotation assembly
│   │   ├── loop_analyzer.py          # Automatic loop point detection
│   │   ├── variation_scheduler.py    # Stochastic per-loop variation scheduling
│   │   ├── entropy_layer.py          # Slow-drift volume/pan/EQ across full duration
│   │   ├── audio_debug.py            # Per-stage audio diagnostics logger
│   │   └── visualizer_generator.py   # Visualizer frame generation utilities
│   ├── assets/                       # Default background image
│   ├── output/                       # Rendered MP4/WAV files (auto-cleaned after 24h)
│   ├── tmp/                          # Temporary render work files
│   ├── logs/                         # Structured render logs (rotating 10 MB)
│   ├── build_opencv_cuda.sh          # OpenCV CUDA build script
│   └── set_cuda_env.sh               # CUDA library path setup
└── LICENSE                           # MIT License
```

## Roadmap

- [ ] More audio effects (reverb, delay, chorus)
- [ ] Additional video animation options (zoom, particle effects)
- [ ] User authentication and project saving
- [ ] Improve real-time audio playback performance
- [ ] Expand preset library
- [ ] Drag-and-drop track reordering
- [ ] Real-time collaborative mixing

## Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/your-feature`).
3. Make your changes.
4. Run tests and ensure code quality.
5. Commit (`git commit -m 'feat: Add new feature'`).
6. Push (`git push origin feature/your-feature`).
7. Open a Pull Request.

## License

MIT License — see [LICENSE](./LICENSE) for details.
