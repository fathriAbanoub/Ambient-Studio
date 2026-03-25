# AMBIENT.STUDIO

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-3.0.0-brightgreen)
![Stack](https://img.shields.io/badge/stack-Next.js%20%7C%20FastAPI%20%7C%20TypeScript%20%7C%20Python-orange)

> Create ambient soundscapes in your browser. Mix up to 8 audio tracks with volume, pan, EQ, and export to WAV or MP4 video.

## 📖 Table of Contents

- [Features](#-features)
- [Demo](#-demo)
- [Prerequisites](#️-prerequisites)
- [Installation](#-installation)
- [Usage](#-usage)
- [Configuration](#️-configuration)
- [Project Structure](#-project-structure)
- [API Reference](#-api-reference)
- [Roadmap](#️-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

- **Multi-track Audio Mixer**: Intuitive browser-based interface with 8 track slots. The backend imposes no hard track limit.
- **Real-time EQ Control**: Apply 7-band equalizer effects to your audio mix.
- **Per-track Controls**: Adjust volume, pan, mute, and solo for individual tracks.
- **Live VU Meter**: Real‑time level visualizer driven by the Web Audio API analyser node.
- **Waveform Display**: Per‑track canvas waveform rendered on file load.
- **EQ Frequency Response Curve**: Live canvas visualization of the EQ curve as you adjust bands.
- **Presets**: Four built‑in presets (Forest, Ocean, Space, Café) that apply per‑track volumes and EQ settings in one click.
- **WAV Export**: Rendered entirely in‑browser using the Web Audio API (`OfflineAudioContext`). No backend connection required — works fully offline.
- **MP4 Video Export**: Rendered server‑side via FFmpeg (backend required). Combines a static background image with your audio mix, encoded at 1 fps for minimal file size.
- **Job Management System**: Backend queue for handling render jobs, with real‑time progress tracking and cancellation.
- **System Monitoring**: View backend system resource usage and render history.
- **Responsive Design**: Optimized for various screen sizes.

## 📸 Demo

> Screenshots and a live demo are coming soon.

## ⚠️ Prerequisites

- Node.js 18+
- Python 3.9+
- FFmpeg (for backend audio/video processing)

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/ambient-studio.git
cd ambient-studio
```

### 2. Frontend Setup

```bash
cd frontend
npm install
```

### 3. Backend Setup

```bash
cd backend
pip install -r requirements.txt
```

### 4. Set up environment variables

Create a `.env.local` file in the `frontend` directory (see [Configuration](#️-configuration) for details).  
The backend reads configuration from environment variables – no `.env` file is required.

## 💻 Usage

### Starting the Frontend

```bash
cd frontend
npm run dev
```

The frontend application will start on `http://localhost:3000`.

### Starting the Backend

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 3001
```

The backend API will be available at `http://localhost:3001`.

Once both are running, open your browser to `http://localhost:3000` to access the Ambient Studio interface. You can drag and drop audio files onto the track cards, adjust settings, and export your creations.

> **Accepted audio formats:** WAV, MP3, OGG, FLAC, AAC (max 50 MB per file)

> **Note:** Rendered MP4 files are saved to `backend/output/` and are automatically deleted after 24 hours. Copy your files before then.

## ⚙️ Configuration

### Frontend Environment Variables

Create `frontend/.env.local` with the following variable:

| Variable              | Default                 | Description                |
| --------------------- | ----------------------- | -------------------------- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | URL of the FastAPI backend |

> **Note:** `next.config.ts` sets `typescript: { ignoreBuildErrors: true }`. TypeScript errors will not fail the production build. It is recommended to resolve all type errors before deploying.

### Backend Environment Variables

The backend reads from environment variables (no `.env` file required). All settings are defined in `backend/config.py`.

| Variable          | Default                                       | Description                                  |
| ----------------- | --------------------------------------------- | -------------------------------------------- |
| `HOST`            | `0.0.0.0`                                     | Server bind address                          |
| `PORT`            | `3001`                                        | Server port                                  |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:3001` | Comma‑separated CORS origins                 |
| `SAMPLE_RATE`     | `44100`                                       | Audio sample rate (Hz)                       |
| `VIDEO_WIDTH`     | `1920`                                        | Output video width (px)                      |
| `VIDEO_HEIGHT`    | `1080`                                        | Output video height (px)                     |
| `VIDEO_FPS`       | `25`                                          | Output video frame rate                      |
| `VIDEO_CODEC`     | `libx264`                                     | FFmpeg video codec                           |
| `AUDIO_CODEC`     | `aac`                                         | FFmpeg audio codec                           |
| `FFMPEG_PRESET`   | `veryfast`                                    | FFmpeg encoding preset                       |
| `CRF`             | `23`                                          | Video quality (lower = better, larger file)  |
| `MAX_DURATION`    | `28800`                                       | Maximum render duration in seconds (8 hours) |

## 📁 Project Structure

```
ambient-studio/
├── frontend/                     # Next.js frontend application
│   ├── src/                      # Source code
│   │   ├── app/                  # Next.js app router pages and API routes
│   │   ├── components/studio/    # Core UI components (Header, Transport, EQPanel, etc.)
│   │   ├── hooks/                # React hooks
│   │   ├── lib/                  # Utility functions and API clients
│   │   ├── store/                # Zustand store
│   │   └── types/                # TypeScript type definitions
│   ├── public/                   # Static assets
│   ├── package.json              # Frontend dependencies and scripts
│   └── tsconfig.json             # TypeScript configuration
├── backend/                      # FastAPI backend application
│   ├── main.py                   # Main FastAPI application, defines API endpoints
│   ├── services/                 # Audio and video rendering logic
│   ├── config.py                 # Backend configuration settings
│   ├── requirements.txt          # Python dependencies
│   ├── assets/                   # Default assets (e.g., background image)
│   ├── logs/                     # Log files
│   ├── tmp/                      # Temporary files for rendering
│   ├── output/                   # Rendered MP4 files (auto‑cleaned after 24h)
│   └── jobs_history.json         # Persisted render job history (last 100 jobs)
```

## 📈 API Reference

### Health Check

`GET /health`
Returns the status of the backend.

### System Information

`GET /system`
Returns CPU, RAM, and disk usage, plus render statistics.

### Job Management

`GET /jobs`
Retrieves recent completed render jobs.

`GET /queue`
Retrieves current rendering queue information.

`GET /job/{job_id}`
Retrieves the status of a specific job.

`GET /job/{job_id}/progress`
Retrieves real‑time progress for a specific job.

`DELETE /job/{job_id}`
Cancels a running or queued job.

### Audio Rendering

`POST /render-audio`
Renders a multi-track audio mix to a WAV file.
**Parameters:** `duration`, `files` (audio tracks), `volumes`, `pans`, `muted`, `solo`, `master_gain`, `eq_gains`.

### Video Rendering

`POST /render-video`
Combines an audio file with a background image to produce an MP4 video.
**Parameters:** `audio` (WAV/MP3), `duration`, `background_image` (optional).

### Full Audio & Video Rendering Pipeline

`POST /render-video-full`
Asynchronous pipeline: submits an audio+video render job and returns a `job_id` immediately. Poll `GET /job/{job_id}/progress` for status. The final MP4 is saved to `backend/output/`.
**Parameters:** `duration`, `files` (audio tracks), `volumes`, `pans`, `muted`, `solo`, `master_gain`, `eq_gains`, `background_image` (optional).

## 🗺️ Roadmap

- [ ] Implement more audio effects (e.g., reverb, delay)
- [ ] Add more video animation options
- [ ] User authentication and project saving
- [ ] Improve real‑time audio playback performance
- [ ] Expand preset library

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/your-feature`).
3. Make your changes.
4. Run tests (if applicable) and ensure code quality.
5. Commit your changes (`git commit -m 'feat: Add new feature'`).
6. Push to the branch (`git push origin feature/your-feature`).
7. Open a Pull Request.

## 📜 License

MIT License — see [LICENSE](./LICENSE) for details.
