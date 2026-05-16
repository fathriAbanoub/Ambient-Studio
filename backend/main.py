"""
AMBIENT STUDIO — Python Backend (FastAPI)
=========================================
Handles audio mix rendering and video generation.

Features:
- Real-time progress tracking via job system
- Job cancellation support
- Render queue with position tracking
- Job history persistence
- Structured logging
- Auto cleanup of old files
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

import psutil
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from services.audio_renderer import AudioRenderer
from services.audio_debug import log_audio_debug
from services.loop_processor import make_loop, extend_loop_seamless
from services.loop_analyzer import analyze_loop  # <-- new import
from services.video_renderer import VideoRenderer

# New imports for stochastic variation and entropy
from services.entropy_layer import EntropyLayerParams, SlowDriftProcessor
from services.variation_scheduler import LoopSegment, StochasticVariationScheduler
from services.loop_processor import assemble_with_rotation

# ── Structured Logging Setup ──────────────────────────────────────────────────
LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

# Configure root logger to catch all module logs
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)

# Main app logger
logger = logging.getLogger("ambient_studio")
logger.setLevel(logging.INFO)

# Structured render log
render_logger = logging.getLogger("renders")
render_logger.setLevel(logging.INFO)
render_handler = RotatingFileHandler(
    LOG_DIR / "renders.log",
    maxBytes=10 * 1024 * 1024,  # 10MB
    backupCount=5,
)
render_handler.setFormatter(logging.Formatter("%(asctime)s | %(message)s"))
render_logger.addHandler(render_handler)


def log_render(
    duration: int,
    num_tracks: int,
    render_time: float,
    success: bool,
    error: Optional[str] = None,
):
    """Log render job to structured log file."""
    status = "SUCCESS" if success else "FAILED"
    log_msg = f"{status} | duration={duration}s | tracks={num_tracks} | render_time={render_time:.2f}s"
    if error:
        log_msg += f" | error={error}"
    render_logger.info(log_msg)


# ── Job Management System ─────────────────────────────────────────────────────
class JobManager:
    """Manages render jobs with progress tracking, cancellation, and queueing."""

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.job_processes: dict[str, asyncio.subprocess.Process] = {}
        self.job_tasks: dict[str, asyncio.Task] = {}
        self.queue: list[str] = []
        self.active_count = 0
        self.max_concurrent = 2
        self.history_file = Path(__file__).parent / "jobs_history.json"
        self._load_history()

    def _load_history(self):
        """Load job history from JSON file."""
        if self.history_file.exists():
            try:
                with open(self.history_file, "r") as f:
                    self.history = json.load(f)
            except (json.JSONDecodeError, IOError):
                self.history = []
        else:
            self.history = []

    def _save_history(self):
        """Save job history to JSON file."""
        try:
            with open(self.history_file, "w") as f:
                json.dump(self.history[-100:], f, indent=2)  # Keep last 100
        except IOError as e:
            logger.error(f"Failed to save job history: {e}")

    def create_job(self, duration: int) -> str:
        """Create a new job and return its ID."""
        job_id = str(uuid.uuid4())[:8]
        self.jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "duration": duration,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "output_path": None,
            "filename": None,
            "file_size": None,
            "queue_position": len(self.queue) + 1,
            "logs": [],  # Initialize logs array
            "stop_event": threading.Event(),
        }
        self.queue.append(job_id)
        return job_id

    def start_job(self, job_id: str):
        """Mark job as started."""
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = "processing"
            self.jobs[job_id]["started_at"] = datetime.now().isoformat()
            self.jobs[job_id]["queue_position"] = 0
            self.active_count += 1
            if job_id in self.queue:
                self.queue.remove(job_id)

    def update_progress(self, job_id: str, progress: int, time_info: dict = None):
        """Update job progress."""
        if job_id in self.jobs:
            self.jobs[job_id]["progress"] = progress
            if time_info:
                self.jobs[job_id]["time_info"] = time_info
                # Store log message if provided
                if "log_message" in time_info:
                    if "logs" not in self.jobs[job_id]:
                        self.jobs[job_id]["logs"] = []
                    self.jobs[job_id]["logs"].append(time_info["log_message"])

    def complete_job(
        self, job_id: str, output_path: str, filename: str, file_size: int
    ):
        """Mark job as completed."""
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = "completed"
            self.jobs[job_id]["progress"] = 100
            self.jobs[job_id]["finished_at"] = datetime.now().isoformat()
            self.jobs[job_id]["output_path"] = output_path
            self.jobs[job_id]["filename"] = filename
            self.jobs[job_id]["file_size"] = file_size
            self.active_count -= 1

            # Add to history
            job = self.jobs[job_id]
            self.history.append(
                {
                    "job_id": job_id,
                    "filename": filename,
                    "duration": self.jobs[job_id]["duration"],
                    "file_size": file_size,
                    "timestamp": job["finished_at"],
                    "file_path": output_path,
                }
            )
            self._save_history()

    def fail_job(self, job_id: str, error: str):
        """Mark job as failed."""
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = "failed"
            self.jobs[job_id]["error"] = error
            self.jobs[job_id]["finished_at"] = datetime.now().isoformat()
            self.active_count -= 1
            if job_id in self.queue:
                self.queue.remove(job_id)

    async def cancel_job(self, job_id: str) -> bool:
        """Cancel a running job."""
        if job_id not in self.jobs:
            return False

        job = self.jobs[job_id]
        if job["status"] in ["completed", "failed", "cancelled"]:
            return False

        # Set stop event to signal worker threads
        job["stop_event"].set()

        # Wait for the worker thread to finish naturally (shielded from cancellation)
        if job_id in self.job_tasks:
            task = self.job_tasks[job_id]
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass

        # Kill the subprocess if it exists
        if job_id in self.job_processes:
            try:
                process = self.job_processes[job_id]
                try:
                    process.terminate()
                    logger.info(f"Sent SIGTERM to process for job {job_id}")
                except Exception as e:
                    logger.warning(f"Failed to terminate process: {e}")

                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                    logger.info(f"Process for job {job_id} terminated gracefully")
                except asyncio.TimeoutError:
                    try:
                        process.kill()
                        logger.info(f"Sent SIGKILL to process for job {job_id}")
                    except Exception as e:
                        logger.error(f"Failed to kill process: {e}")
                except Exception as e:
                    logger.error(f"Error waiting for process termination: {e}")
                    try:
                        process.kill()
                    except:
                        pass
            except Exception as e:
                logger.error(f"Error killing process for job {job_id}: {e}")
            finally:
                if job_id in self.job_processes:
                    del self.job_processes[job_id]

        # Update job status
        was_processing = job.get("status") == "processing"
        job["status"] = "cancelled"
        job["finished_at"] = datetime.now().isoformat()
        if was_processing and self.active_count > 0:
            self.active_count -= 1

        if job_id in self.queue:
            self.queue.remove(job_id)

        return True

    def get_job(self, job_id: str) -> Optional[dict]:
        """Get job by ID."""
        return self.jobs.get(job_id)

    def get_queue_position(self, job_id: str) -> int:
        """Get position in queue (0 if processing or not found)."""
        try:
            return self.queue.index(job_id) + 1
        except ValueError:
            return 0

    def get_queue_info(self) -> dict:
        """Get queue information."""
        return {
            "queue_depth": len(self.queue),
            "active_jobs": self.active_count,
            "max_concurrent": self.max_concurrent,
            "queued_jobs": self.queue[:],
        }

    def get_history(self, limit: int = 10) -> list:
        """Get recent job history."""
        return self.history[-limit:][::-1]

    def register_process(self, job_id: str, process: asyncio.subprocess.Process):
        """Register a subprocess for cancellation support."""
        self.job_processes[job_id] = process

    def unregister_process(self, job_id: str):
        """Unregister a subprocess."""
        if job_id in self.job_processes:
            del self.job_processes[job_id]

    def register_task(self, job_id: str, task: asyncio.Task):
        """Register an asyncio task for cancellation support."""
        self.job_tasks[job_id] = task

    def unregister_task(self, job_id: str):
        """Unregister an asyncio task."""
        if job_id in self.job_tasks:
            del self.job_tasks[job_id]


job_manager = JobManager()

# ── Semaphore for limiting concurrent renders ───────────────────────────────────
render_semaphore = asyncio.Semaphore(2)


# ── Background Cleanup Scheduler ──────────────────────────────────────────────
async def cleanup_old_files():
    """Delete files older than 24 hours from output folder."""
    output_dir = Path("output")
    if not output_dir.exists():
        return

    cutoff = datetime.now() - timedelta(hours=24)
    deleted_count = 0

    for file_path in output_dir.iterdir():
        if file_path.is_file():
            mtime = datetime.fromtimestamp(file_path.stat().st_mtime)
            if mtime < cutoff:
                try:
                    file_path.unlink()
                    deleted_count += 1
                    logger.info(f"Deleted old file: {file_path}")
                except Exception as e:
                    logger.error(f"Failed to delete {file_path}: {e}")

    if deleted_count > 0:
        logger.info(f"Cleanup complete: deleted {deleted_count} old files")


async def periodic_cleanup():
    """Run cleanup every hour."""
    while True:
        await asyncio.sleep(3600)  # 1 hour
        await cleanup_old_files()


# ── Lifespan context manager for startup/shutdown ──────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle startup and shutdown events."""
    # Startup
    await cleanup_old_files()
    cleanup_task = asyncio.create_task(periodic_cleanup())
    
    yield
    
    # Shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="Ambient Studio API",
    version="3.0.0",
    description="Backend for Ambient Studio — ambient audio mix & video export engine",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ── Ensure required directories exist ─────────────────────────────────────────
os.makedirs(settings.TMP_DIR, exist_ok=True)
os.makedirs(settings.ASSETS_DIR, exist_ok=True)
os.makedirs("output", exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)


# ── File Validation ────────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {".wav", ".mp3", ".ogg", ".flac", ".aac"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB


def validate_audio_file(file: UploadFile) -> None:
    """Validate uploaded audio file."""
    ext = Path(file.filename).suffix.lower() if file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Invalid file format '{ext}'. Allowed: {', '.join(ALLOWED_EXTENSIONS)}",
        )


async def validate_file_size(file: UploadFile) -> int:
    """Validate file size and return size in bytes."""
    content = await file.read()
    size = len(content)
    await file.seek(0)
    if size > MAX_FILE_SIZE:
        raise HTTPException(
            400, f"File '{file.filename}' exceeds 50MB limit ({size / 1024 / 1024:.1f}MB)"
        )
    return size


# ── Progress Parser ────────────────────────────────────────────────────────────
def parse_ffmpeg_progress(stderr_line: str, total_duration: int) -> Optional[dict]:
    """Parse ffmpeg stderr for progress information."""
    # Match time=HH:MM:SS.ms or time=MM:SS.ms format
    time_match = re.search(r"time=(\d+):(\d+):(\d+\.?\d*)", stderr_line)
    if time_match:
        hours = int(time_match.group(1))
        minutes = int(time_match.group(2))
        seconds = float(time_match.group(3))
        current_time = hours * 3600 + minutes * 60 + seconds
        progress = min(100, int((current_time / total_duration) * 100)) if total_duration > 0 else 0
        return {
            "current_time": current_time,
            "total_duration": total_duration,
            "progress": progress,
        }
    return None


# ── Prevent garbage collection of cleanup tasks ───────────────────────────────
_background_tasks: set[asyncio.Task] = set()


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/health")
async def health_check():
    """Simple liveness probe."""
    return {"status": "ok", "version": "3.0.0"}

@app.post("/analyze-loop")
async def analyze_loop_endpoint(file: UploadFile = File(...)):
    """
    Analyze an uploaded audio file to find optimal loop points.
    Returns loop start, end, score, and recommended crossfade duration.
    """
    # Validate file
    validate_audio_file(file)
    await validate_file_size(file)

    # Save to temp location
    job_id = str(uuid.uuid4())[:8]
    temp_dir = Path(settings.TMP_DIR) / job_id
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        ext = Path(file.filename).suffix or ".wav"
        temp_path = temp_dir / f"input{ext}"
        with temp_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        # Analyze loop points
        result = await asyncio.to_thread(analyze_loop, temp_path)
        return result

    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Loop analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.get("/system")
async def get_system_info():
    """Get system resource information."""
    # CPU usage
    cpu_percent = psutil.cpu_percent(interval=0.1)

    # RAM usage
    memory = psutil.virtual_memory()
    ram_used = memory.used
    ram_total = memory.total
    ram_percent = memory.percent

    # Disk space for output folder
    output_dir = Path("output")
    output_dir.mkdir(exist_ok=True)
    disk_usage = 0
    file_count = 0
    for f in output_dir.iterdir():
        if f.is_file():
            disk_usage += f.stat().st_size
            file_count += 1

    # Completed renders today
    today = datetime.now().date()
    renders_today = sum(
        1
        for job in job_manager.history
        if datetime.fromisoformat(job["timestamp"]).date() == today
    )

    return {
        "cpu_percent": cpu_percent,
        "ram_used": ram_used,
        "ram_total": ram_total,
        "ram_percent": ram_percent,
        "output_folder_size": disk_usage,
        "output_folder_files": file_count,
        "renders_today": renders_today,
    }

@app.post("/render-video-full")
async def render_video_full(
    duration: int = Form(..., gt=0, le=settings.MAX_DURATION),
    files: list[UploadFile] = File(...),
    volumes: str = Form(""),
    pans: str = Form(""),
    muted: str = Form(""),
    solo: str = Form(""),
    master_gain: float = Form(1.0),
    eq_gains: str = Form(""),
    background_image: UploadFile | None = File(None),
    show_visualizer: str = Form("0"),
    use_gpu_encoding: str = Form("1"),
    loop_start: Optional[float] = Form(None),
    loop_end: Optional[float] = Form(None),
):
    """
    One-shot pipeline: render audio mix → encode MP4 video.
    Saves the final video to the "output" folder and returns its path.
    
    Returns job_id immediately for progress tracking, then processes in background.
    """
    # Duration cap (explicit check)
    if duration > settings.MAX_DURATION:
        raise HTTPException(400, f"Duration exceeds maximum of {settings.MAX_DURATION}s")

    # Validate files
    for f in files:
        validate_audio_file(f)
        await validate_file_size(f)

    # Generate temporary directory name before job creation
    temp_id = str(uuid.uuid4())[:8]
    job_dir = Path(settings.TMP_DIR) / temp_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Save uploaded files to temp directory
        track_paths: list[Path] = []
        for i, upload in enumerate(files):
            ext = Path(upload.filename).suffix or ".audio"
            dest = job_dir / f"track_{i:02d}{ext}"
            with dest.open("wb") as f:
                shutil.copyfileobj(upload.file, f)
            track_paths.append(dest)

        # Parse parameters
        def parse_floats(s, count, default):
            parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
            result = [float(p) for p in parts]
            while len(result) < count:
                result.append(default)
            return result[:count]

        def parse_bools(s, count):
            parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
            result = [bool(int(p)) for p in parts]
            while len(result) < count:
                result.append(False)
            return result[:count]

        n = len(track_paths)
        try:
            vol_list = parse_floats(volumes, n, 1.0)
            pan_list = parse_floats(pans, n, 0.0)
            muted_list = parse_bools(muted, n)
            solo_list = parse_bools(solo, n)
            eq_list = parse_floats(eq_gains, 7, 0.0)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Invalid numeric form values: {exc}") from exc
        show_viz = show_visualizer == "1"
        use_gpu = use_gpu_encoding == "1"

        # Resolve background
        bg_path = None
        if background_image:
            img_ext = Path(background_image.filename).suffix or ".jpg"
            bg_path = job_dir / f"background{img_ext}"
            with bg_path.open("wb") as f:
                shutil.copyfileobj(background_image.file, f)
        else:
            bg_path = Path(settings.DEFAULT_BACKGROUND)
            if not bg_path.is_file():
                raise HTTPException(
                    status_code=404,
                    detail="Default background image not found. Please upload a background image or add assets/background.jpg.",
                )

        # Validate manual loop points before creating job
        if (loop_start is not None) != (loop_end is not None):
            raise HTTPException(status_code=422, detail="Both loop_start and loop_end must be provided together")
        if loop_start is not None and loop_end is not None:
            if loop_start < 0 or loop_end < 0:
                raise HTTPException(status_code=422, detail="Loop points must be non-negative")
            if loop_end <= loop_start:
                raise HTTPException(status_code=422, detail="loop_end must be greater than loop_start")

        # Create job after all validation and file operations succeed
        job_id = job_manager.create_job(duration)

    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    # Rename temp directory to match job_id
    final_job_dir = Path(settings.TMP_DIR) / job_id
    job_dir.rename(final_job_dir)
    job_dir = final_job_dir

    # Update track paths to reflect new directory
    track_paths = [job_dir / path.name for path in track_paths]
    if background_image:
        bg_path = job_dir / bg_path.name

    # Start background render task
    async def render_task():
        start_time = time.time()
        
        def log_with_time(message):
            """Helper to log with timestamp to both backend and UI"""
            elapsed = time.time() - start_time
            timestamp_msg = f"[{elapsed:.2f}s] {message}"
            logger.info(timestamp_msg)
            job_manager.update_progress(job_id, job_manager.jobs[job_id]["progress"], {"log_message": timestamp_msg})

        def debug_audio_stage(label: str, path: Path):
            if not settings.AUDIO_DEBUG:
                return

            def _sink(msg: str):
                log_with_time(f"🧪 {label} | {msg}")

            try:
                log_audio_debug(path, log_fn=_sink)
            except Exception as exc:
                log_with_time(f"🧪 {label} | debug failed: {exc}")
        
        audio_renderer = AudioRenderer(settings)
        video_renderer = VideoRenderer(settings)
        entropy_processor = SlowDriftProcessor()
        mix_path = job_dir / "mix.wav"
        video_path = job_dir / "ambient_video.mp4"

        try:
            # Wait for semaphore
            log_with_time("⏳ Waiting for render slot...")
            job_manager.update_progress(job_id, 0, {"status": "waiting_for_slot"})

            async with render_semaphore:
                # Mark as processing
                job_manager.start_job(job_id)
                log_with_time("🎬 Starting render job...")
                job_manager.update_progress(job_id, 5, {"status": "initializing"})

                # Step 1: Render the source mix ONCE without looping
                log_with_time(f"🎵 Rendering source mix ({n} tracks)...")
                job_manager.update_progress(job_id, 10, {"status": "rendering_audio"})
                
                audio_start = time.time()

                # Progress callback for audio (10-35% of total progress)
                def audio_progress_cb(progress_percent):
                    overall = 10 + int(progress_percent * 0.25)
                    job_manager.update_progress(job_id, overall)

                # Render source mix once, no looping
                await asyncio.to_thread(
                    audio_renderer.render,
                    track_paths=track_paths,
                    output_path=mix_path,
                    duration_seconds=duration,  # Not used when render_source_once=True
                    volumes=vol_list,
                    pans=pan_list,
                    muted=muted_list,
                    solo=solo_list,
                    master_gain=master_gain,
                    eq_gains=eq_list,
                    progress_callback=audio_progress_cb,
                    render_source_once=True,  # KEY: Don't loop source tracks
                )
                
                audio_time = time.time() - audio_start
                log_with_time(f"✓ Source mix rendered ({audio_time:.2f}s)")
                await asyncio.to_thread(debug_audio_stage, "mix.wav", mix_path)
                job_manager.update_progress(job_id, 35, {"status": "mix_complete"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                # Step 2: Determine loop points
                # Use manual points if provided, otherwise auto-analyze
                def manual_candidate(loop_start_seconds: float, loop_end_seconds: float) -> dict[str, object]:
                    loop_start_ms = int(round(loop_start_seconds * 1000.0))
                    loop_end_ms = int(round(loop_end_seconds * 1000.0))
                    loop_duration_ms = max(1, loop_end_ms - loop_start_ms)
                    crossfade_ms = min(4000, max(500, int(loop_duration_ms * 0.07)))
                    canonical_duration_ms = max(1, loop_duration_ms - crossfade_ms)
                    return {
                        "segment_id": "candidate_01",
                        "source_path": str(mix_path.resolve()),
                        "loop_start_ms": loop_start_ms,
                        "loop_end_ms": loop_end_ms,
                        "canonical_duration_ms": canonical_duration_ms,
                        "play_duration_ms": canonical_duration_ms,
                        "crossfade_duration_ms": crossfade_ms,
                        "trim_tail_ms": 0,
                        "raw_analyzer_score": 1.0,
                        "validator_score": 1.0,
                        "repetition_salience_score": 0.0,
                    }

                if loop_start is not None and loop_end is not None:
                    analysis = {
                        "loop_start_ms": int(round(loop_start * 1000.0)),
                        "loop_end_ms": int(round(loop_end * 1000.0)),
                        "score": 1.0,
                        "crossfade_ms": manual_candidate(loop_start, loop_end)["crossfade_duration_ms"],
                        "candidates": [manual_candidate(loop_start, loop_end)],
                    }
                    log_with_time(
                        f"📍 Using manual loop points: {loop_start:.3f}s → {loop_end:.3f}s"
                    )
                else:
                    log_with_time("🧠 Analyzing loop points with PyMusicLooper...")
                    analysis = await asyncio.to_thread(analyze_loop, mix_path)
                    log_with_time(
                        f"🧠 Best loop points: {analysis['loop_start_ms'] / 1000.0:.3f}s → "
                        f"{analysis['loop_end_ms'] / 1000.0:.3f}s "
                        f"(score={analysis['score']:.3f}, crossfade={analysis['crossfade_ms'] / 1000.0:.3f}s)"
                    )
                job_manager.update_progress(job_id, 40, {"status": "loop_analyzed"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                # Step 3: Build loop palette from candidates
                analysis_candidates = list(analysis.get("candidates") or [])
                if not analysis_candidates:
                    fallback_crossfade_ms = int(analysis["crossfade_ms"])
                    fallback_duration_ms = max(
                        1,
                        int(analysis["loop_end_ms"]) - int(analysis["loop_start_ms"]) - fallback_crossfade_ms,
                    )
                    analysis_candidates = [
                        {
                            "segment_id": "candidate_01",
                            "source_path": str(mix_path.resolve()),
                            "loop_start_ms": int(analysis["loop_start_ms"]),
                            "loop_end_ms": int(analysis["loop_end_ms"]),
                            "canonical_duration_ms": fallback_duration_ms,
                            "play_duration_ms": fallback_duration_ms,
                            "crossfade_duration_ms": fallback_crossfade_ms,
                            "trim_tail_ms": 0,
                            "raw_analyzer_score": float(analysis.get("raw_analyzer_score", analysis["score"])),
                            "validator_score": float(analysis["score"]),
                            "repetition_salience_score": 0.0,
                        }
                    ]

                log_with_time(f"🎛️ Preparing {len(analysis_candidates)} loop candidate(s)...")
                loop_palette: list[LoopSegment] = []
                for candidate in analysis_candidates:
                    segment_id = str(candidate["segment_id"])
                    loop_unit_path = job_dir / f"{segment_id}.wav"
                    crossfade_ms = int(candidate.get("crossfade_duration_ms", candidate.get("crossfade_ms", analysis["crossfade_ms"])))
                    loop_start_seconds = int(candidate["loop_start_ms"]) / 1000.0
                    loop_end_seconds = int(candidate["loop_end_ms"]) / 1000.0
                    try:
                        await asyncio.to_thread(
                            make_loop,
                            mix_path,
                            loop_unit_path,
                            crossfade_ms / 1000.0,
                            loop_start_seconds,
                            loop_end_seconds,
                        )
                    except Exception as exc:
                        log_with_time(f"⚠️ Skipping {segment_id}: {exc}")
                        continue

                    canonical_duration_ms = max(
                        1,
                        int(
                            candidate.get(
                                "canonical_duration_ms",
                                max(1, int(candidate["loop_end_ms"]) - int(candidate["loop_start_ms"]) - crossfade_ms),
                            )
                        ),
                    )
                    loop_palette.append(
                        LoopSegment(
                            segment_id=segment_id,
                            source_path=str(loop_unit_path),
                            loop_start_ms=int(candidate["loop_start_ms"]),
                            loop_end_ms=int(candidate["loop_end_ms"]),
                            canonical_duration_ms=canonical_duration_ms,
                            play_duration_ms=canonical_duration_ms,
                            crossfade_duration_ms=crossfade_ms,
                            trim_tail_ms=0,
                            raw_analyzer_score=float(candidate.get("raw_analyzer_score", analysis.get("raw_analyzer_score", analysis["score"]))),
                            validator_score=float(candidate.get("validator_score", analysis["score"])),
                            repetition_salience_score=float(candidate.get("repetition_salience_score", 0.0)),
                        )
                    )

                if not loop_palette:
                    raise RuntimeError("Unable to build any valid loop units from the analyzed candidates")

                if len(loop_palette) == 1:
                    log_with_time("↩️ Using single-candidate fallback pipeline...")
                    assembled_path = job_dir / "mix_loop_filled.wav"
                    await asyncio.to_thread(
                        extend_loop_seamless,
                        Path(loop_palette[0].source_path),
                        assembled_path,
                        float(duration),
                        crossfade_seconds=loop_palette[0].crossfade_duration_ms / 1000.0,
                    )
                else:
                    log_with_time(f"🎲 Scheduling stochastic rotation across {len(loop_palette)} candidates...")
                    scheduler = StochasticVariationScheduler(
                        max_consecutive_repeats=2,
                        salience_budget=0.55,
                        seed=int(job_id, 16),
                    )
                    plan = await asyncio.to_thread(scheduler.schedule, loop_palette, float(duration))
                    assembled_path = job_dir / "mix_rotated.wav"
                    await asyncio.to_thread(assemble_with_rotation, plan, assembled_path)
                    log_with_time(
                        f"🎲 Rotation plan assembled ({len(plan.segments)} segments, final_trim={plan.final_trim_seconds:.3f}s)"
                    )
                job_manager.update_progress(job_id, 48, {"status": "loop_complete"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                log_with_time("🌫️ Applying entropy layer...")
                entropy_path = job_dir / "mix_entropy.wav"
                await asyncio.to_thread(
                    entropy_processor.process,
                    assembled_path,
                    entropy_path,
                    EntropyLayerParams(seed=int(job_id, 16)),
                    settings.SAMPLE_RATE,
                )
                final_mix_path = entropy_path
                await asyncio.to_thread(debug_audio_stage, final_mix_path.name, final_mix_path)
                job_manager.update_progress(job_id, 50, {"status": "audio_complete"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                # Step 5: render video with progress
                encoder_type = "🚀 GPU (NVENC)" if use_gpu else "🖥️  CPU (libx264)"
                log_with_time(f"🎬 Starting video render with {encoder_type}")
                job_manager.update_progress(job_id, 55, {"status": "rendering_video"})
                
                if show_viz:
                    log_with_time(f"📊 Visualizer enabled (showfreqs)")
                
                video_start = time.time()

                # Run video render with ffmpeg progress parsing
                video_process = await video_renderer.render_async(
                    audio_path=final_mix_path,
                    background_path=bg_path,
                    output_path=video_path,
                    duration_seconds=duration,
                    show_visualizer=show_viz,
                    use_gpu=use_gpu,
                    use_cuda_visualizer=settings.USE_CUDA_VISUALIZER,
                    job_id=job_id,
                    job_manager=job_manager,
                    start_time=start_time,
                    progress_callback=lambda p: job_manager.update_progress(
                        job_id, 55 + int(p * 0.45)
                    ),
                )
                if video_process:
                    job_manager.register_process(job_id, video_process)
                
                video_time = time.time() - video_start
                log_with_time(f"✓ Video render complete ({video_time:.2f}s)")

                # Unregister process after completion
                job_manager.unregister_process(job_id)

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                # Step 6: Copy to output folder
                log_with_time("📦 Copying to output folder...")
                job_manager.update_progress(job_id, 95, {"status": "finalizing"})
                output_dir = Path("output")
                output_dir.mkdir(exist_ok=True)

                timestamp = int(time.time())
                filename = f"ambient_video_{timestamp}_{job_id}.mp4"
                final_path = output_dir / filename
                shutil.copy(video_path, final_path)

                # Get file size
                file_size = final_path.stat().st_size
                file_size_mb = file_size / (1024 * 1024)

                # Mark complete
                job_manager.complete_job(job_id, str(final_path), filename, file_size)
                render_time = time.time() - start_time
                log_render(duration, n, render_time, True)
                
                log_with_time(f"✅ Complete! Total: {render_time:.2f}s | Audio: {audio_time:.2f}s | Video: {video_time:.2f}s | Size: {file_size_mb:.1f}MB")
                job_manager.update_progress(job_id, 100)

                # Cleanup temp dir
                shutil.rmtree(job_dir, ignore_errors=True)

        except asyncio.CancelledError:
            render_time = time.time() - start_time
            log_render(duration, n, render_time, False, "Cancelled by user")
            job_manager.unregister_process(job_id)
            log_with_time("❌ Render cancelled by user")
            shutil.rmtree(job_dir, ignore_errors=True)
            raise

        except Exception as e:
            render_time = time.time() - start_time
            error_msg = str(e)
            logger.error(f"Render failed for job {job_id}: {error_msg}", exc_info=True)
            log_render(duration, n, render_time, False, error_msg)
            job_manager.fail_job(job_id, error_msg)
            job_manager.unregister_process(job_id)
            log_with_time(f"❌ Error: {error_msg}")
            shutil.rmtree(job_dir, ignore_errors=True)
        finally:
            job_manager.unregister_task(job_id)

    # Start the background task and register it
    task = asyncio.create_task(render_task())
    job_manager.register_task(job_id, task)

    # Return job_id immediately
    return {
        "status": "queued",
        "job_id": job_id,
        "queue_position": job_manager.get_queue_position(job_id),
    }


@app.post("/render-audio-job")
async def render_audio_job(
    duration: int = Form(..., gt=0, le=settings.MAX_DURATION),
    files: list[UploadFile] = File(...),
    volumes: str = Form(""),
    pans: str = Form(""),
    muted: str = Form(""),
    solo: str = Form(""),
    master_gain: float = Form(1.0),
    eq_gains: str = Form(""),
    loop_start: Optional[float] = Form(None),
    loop_end: Optional[float] = Form(None),
):
    """
    Audio-only pipeline using the job system.
    Returns job_id immediately; the WAV can be downloaded via /download/{job_id}.
    
    Args:
        loop_start: Optional manual loop start point in seconds
        loop_end: Optional manual loop end point in seconds
    """
    if duration > settings.MAX_DURATION:
        raise HTTPException(400, f"Duration exceeds maximum of {settings.MAX_DURATION}s")

    for f in files:
        validate_audio_file(f)
        await validate_file_size(f)

    # Generate temporary directory name before job creation
    temp_id = str(uuid.uuid4())[:8]
    job_dir = Path(settings.TMP_DIR) / temp_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        track_paths: list[Path] = []
        for i, upload in enumerate(files):
            ext = Path(upload.filename).suffix or ".audio"
            dest = job_dir / f"track_{i:02d}{ext}"
            with dest.open("wb") as f:
                shutil.copyfileobj(upload.file, f)
            track_paths.append(dest)

        def parse_floats(s, count, default):
            parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
            result = [float(p) for p in parts]
            while len(result) < count:
                result.append(default)
            return result[:count]

        def parse_bools(s, count):
            parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
            result = [bool(int(p)) for p in parts]
            while len(result) < count:
                result.append(False)
            return result[:count]

        n = len(track_paths)
        try:
            vol_list = parse_floats(volumes, n, 1.0)
            pan_list = parse_floats(pans, n, 0.0)
            muted_list = parse_bools(muted, n)
            solo_list = parse_bools(solo, n)
            eq_list = parse_floats(eq_gains, 7, 0.0)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Invalid numeric form values: {exc}") from exc

        # Validate manual loop points before creating job
        if (loop_start is not None) != (loop_end is not None):
            raise HTTPException(status_code=422, detail="Both loop_start and loop_end must be provided together")
        if loop_start is not None and loop_end is not None:
            if loop_start < 0 or loop_end < 0:
                raise HTTPException(status_code=422, detail="Loop points must be non-negative")
            if loop_end <= loop_start:
                raise HTTPException(status_code=422, detail="loop_end must be greater than loop_start")

        # Create job after all validation and file operations succeed
        job_id = job_manager.create_job(duration)

    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    # Rename temp directory to match job_id
    final_job_dir = Path(settings.TMP_DIR) / job_id
    job_dir.rename(final_job_dir)
    job_dir = final_job_dir

    # Update track paths to reflect new directory
    track_paths = [job_dir / path.name for path in track_paths]

    async def render_task():
        start_time = time.time()

        def log_with_time(message: str):
            elapsed = time.time() - start_time
            timestamp_msg = f"[{elapsed:.2f}s] {message}"
            logger.info(timestamp_msg)
            job_manager.update_progress(
                job_id,
                job_manager.jobs[job_id]["progress"],
                {"log_message": timestamp_msg},
            )

        def debug_audio_stage(label: str, path: Path):
            if not settings.AUDIO_DEBUG:
                return

            def _sink(msg: str):
                log_with_time(f"🧪 {label} | {msg}")

            try:
                log_audio_debug(path, log_fn=_sink)
            except Exception as exc:
                log_with_time(f"🧪 {label} | debug failed: {exc}")

        audio_renderer = AudioRenderer(settings)
        entropy_processor = SlowDriftProcessor()
        mix_path = job_dir / "mix.wav"

        try:
            log_with_time("⏳ Waiting for render slot...")
            job_manager.update_progress(job_id, 0, {"status": "waiting_for_slot"})

            async with render_semaphore:
                job_manager.start_job(job_id)
                log_with_time("🎵 Starting audio render...")
                job_manager.update_progress(job_id, 5, {"status": "initializing"})

                audio_start = time.time()

                def audio_progress_cb(progress_percent):
                    overall = 5 + int(progress_percent * 0.35)
                    job_manager.update_progress(job_id, overall)

                # Step 1: Render the source mix ONCE without looping
                # This gives us the natural length of the mixed audio
                await asyncio.to_thread(
                    audio_renderer.render,
                    track_paths=track_paths,
                    output_path=mix_path,
                    duration_seconds=duration,  # Not used when render_source_once=True
                    volumes=vol_list,
                    pans=pan_list,
                    muted=muted_list,
                    solo=solo_list,
                    master_gain=master_gain,
                    eq_gains=eq_list,
                    progress_callback=audio_progress_cb,
                    render_source_once=True,  # KEY: Don't loop source tracks
                )

                audio_time = time.time() - audio_start
                log_with_time(f"✓ Source mix rendered ({audio_time:.2f}s)")
                await asyncio.to_thread(debug_audio_stage, "mix.wav", mix_path)
                job_manager.update_progress(job_id, 40, {"status": "mix_complete"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                # Step 2: Determine loop points
                # Use manual points if provided, otherwise auto-analyze
                def manual_candidate(loop_start_seconds: float, loop_end_seconds: float) -> dict[str, object]:
                    loop_start_ms = int(round(loop_start_seconds * 1000.0))
                    loop_end_ms = int(round(loop_end_seconds * 1000.0))
                    loop_duration_ms = max(1, loop_end_ms - loop_start_ms)
                    crossfade_ms = min(4000, max(500, int(loop_duration_ms * 0.07)))
                    canonical_duration_ms = max(1, loop_duration_ms - crossfade_ms)
                    return {
                        "segment_id": "candidate_01",
                        "source_path": str(mix_path.resolve()),
                        "loop_start_ms": loop_start_ms,
                        "loop_end_ms": loop_end_ms,
                        "canonical_duration_ms": canonical_duration_ms,
                        "play_duration_ms": canonical_duration_ms,
                        "crossfade_duration_ms": crossfade_ms,
                        "trim_tail_ms": 0,
                        "raw_analyzer_score": 1.0,
                        "validator_score": 1.0,
                        "repetition_salience_score": 0.0,
                    }

                if loop_start is not None and loop_end is not None:
                    analysis = {
                        "loop_start_ms": int(round(loop_start * 1000.0)),
                        "loop_end_ms": int(round(loop_end * 1000.0)),
                        "score": 1.0,
                        "crossfade_ms": manual_candidate(loop_start, loop_end)["crossfade_duration_ms"],
                        "candidates": [manual_candidate(loop_start, loop_end)],
                    }
                    log_with_time(
                        f"📍 Using manual loop points: {loop_start:.3f}s → {loop_end:.3f}s"
                    )
                else:
                    log_with_time("🧠 Analyzing loop points with PyMusicLooper...")
                    analysis = await asyncio.to_thread(analyze_loop, mix_path)
                    log_with_time(
                        f"🧠 Best loop points: {analysis['loop_start_ms'] / 1000.0:.3f}s → "
                        f"{analysis['loop_end_ms'] / 1000.0:.3f}s "
                        f"(score={analysis['score']:.3f}, crossfade={analysis['crossfade_ms'] / 1000.0:.3f}s)"
                    )
                job_manager.update_progress(job_id, 50, {"status": "loop_analyzed"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                analysis_candidates = list(analysis.get("candidates") or [])
                if not analysis_candidates:
                    fallback_crossfade_ms = int(analysis["crossfade_ms"])
                    fallback_duration_ms = max(
                        1,
                        int(analysis["loop_end_ms"]) - int(analysis["loop_start_ms"]) - fallback_crossfade_ms,
                    )
                    analysis_candidates = [
                        {
                            "segment_id": "candidate_01",
                            "source_path": str(mix_path.resolve()),
                            "loop_start_ms": int(analysis["loop_start_ms"]),
                            "loop_end_ms": int(analysis["loop_end_ms"]),
                            "canonical_duration_ms": fallback_duration_ms,
                            "play_duration_ms": fallback_duration_ms,
                            "crossfade_duration_ms": fallback_crossfade_ms,
                            "trim_tail_ms": 0,
                            "raw_analyzer_score": float(analysis.get("raw_analyzer_score", analysis["score"])),
                            "validator_score": float(analysis["score"]),
                            "repetition_salience_score": 0.0,
                        }
                    ]

                log_with_time(f"🎛️ Preparing {len(analysis_candidates)} loop candidate(s)...")
                loop_palette: list[LoopSegment] = []
                for candidate in analysis_candidates:
                    segment_id = str(candidate["segment_id"])
                    loop_unit_path = job_dir / f"{segment_id}.wav"
                    crossfade_ms = int(candidate.get("crossfade_duration_ms", candidate.get("crossfade_ms", analysis["crossfade_ms"])))
                    loop_start_seconds = int(candidate["loop_start_ms"]) / 1000.0
                    loop_end_seconds = int(candidate["loop_end_ms"]) / 1000.0
                    try:
                        await asyncio.to_thread(
                            make_loop,
                            mix_path,
                            loop_unit_path,
                            crossfade_ms / 1000.0,
                            loop_start_seconds,
                            loop_end_seconds,
                        )
                    except Exception as exc:
                        log_with_time(f"⚠️ Skipping {segment_id}: {exc}")
                        continue

                    canonical_duration_ms = max(
                        1,
                        int(
                            candidate.get(
                                "canonical_duration_ms",
                                max(1, int(candidate["loop_end_ms"]) - int(candidate["loop_start_ms"]) - crossfade_ms),
                            )
                        ),
                    )
                    loop_palette.append(
                        LoopSegment(
                            segment_id=segment_id,
                            source_path=str(loop_unit_path),
                            loop_start_ms=int(candidate["loop_start_ms"]),
                            loop_end_ms=int(candidate["loop_end_ms"]),
                            canonical_duration_ms=canonical_duration_ms,
                            play_duration_ms=canonical_duration_ms,
                            crossfade_duration_ms=crossfade_ms,
                            trim_tail_ms=0,
                            raw_analyzer_score=float(candidate.get("raw_analyzer_score", analysis.get("raw_analyzer_score", analysis["score"]))),
                            validator_score=float(candidate.get("validator_score", analysis["score"])),
                            repetition_salience_score=float(candidate.get("repetition_salience_score", 0.0)),
                        )
                    )
                job_manager.update_progress(job_id, 60, {"status": "loop_complete"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                if not loop_palette:
                    raise RuntimeError("Unable to build any valid loop units from the analyzed candidates")

                if len(loop_palette) == 1:
                    log_with_time("↩️ Using single-candidate fallback pipeline...")
                    assembled_path = job_dir / "mix_loop_filled.wav"
                    await asyncio.to_thread(
                        extend_loop_seamless,
                        Path(loop_palette[0].source_path),
                        assembled_path,
                        float(duration),
                        crossfade_seconds=loop_palette[0].crossfade_duration_ms / 1000.0,
                    )
                else:
                    log_with_time(f"🎲 Scheduling stochastic rotation across {len(loop_palette)} candidates...")
                    scheduler = StochasticVariationScheduler(
                        max_consecutive_repeats=2,
                        salience_budget=0.55,
                        seed=int(job_id, 16),
                    )
                    plan = await asyncio.to_thread(scheduler.schedule, loop_palette, float(duration))
                    assembled_path = job_dir / "mix_rotated.wav"
                    await asyncio.to_thread(assemble_with_rotation, plan, assembled_path)
                    log_with_time(
                        f"🎲 Rotation plan assembled ({len(plan.segments)} segments, final_trim={plan.final_trim_seconds:.3f}s)"
                    )
                    job_manager.update_progress(job_id, 82, {"status": "rotation_complete"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                log_with_time("🌫️ Applying entropy layer...")
                entropy_path = job_dir / "mix_entropy.wav"
                await asyncio.to_thread(
                    entropy_processor.process,
                    assembled_path,
                    entropy_path,
                    EntropyLayerParams(seed=int(job_id, 16)),
                    settings.SAMPLE_RATE,
                )
                final_audio_path = entropy_path
                await asyncio.to_thread(debug_audio_stage, final_audio_path.name, final_audio_path)
                job_manager.update_progress(job_id, 90, {"status": "finalizing"})

                # Check for cancellation
                if job_manager.jobs[job_id].get("stop_event", threading.Event()).is_set():
                    raise asyncio.CancelledError()

                output_dir = Path("output")
                output_dir.mkdir(exist_ok=True)
                timestamp = int(time.time())
                filename = f"ambient_audio_{timestamp}_{job_id}.wav"
                final_path = output_dir / filename
                shutil.copy(final_audio_path, final_path)

                file_size = final_path.stat().st_size
                job_manager.complete_job(job_id, str(final_path), filename, file_size)
                render_time = time.time() - start_time
                log_render(duration, n, render_time, True)
                log_with_time(f"✅ Audio complete ({render_time:.2f}s)")
                job_manager.update_progress(job_id, 100)

        except asyncio.CancelledError:
            render_time = time.time() - start_time
            log_render(duration, n, render_time, False, "Cancelled by user")
            log_with_time("❌ Audio render cancelled by user")
            raise
        except Exception as exc:
            render_time = time.time() - start_time
            error_msg = str(exc)
            logger.error(f"Audio render failed for job {job_id}: {error_msg}", exc_info=True)
            log_render(duration, n, render_time, False, error_msg)
            job_manager.fail_job(job_id, error_msg)
            log_with_time(f"❌ Error: {error_msg}")
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)
            job_manager.unregister_task(job_id)

    task = asyncio.create_task(render_task())
    job_manager.register_task(job_id, task)

    return {
        "status": "queued",
        "job_id": job_id,
        "queue_position": job_manager.get_queue_position(job_id),
    }


@app.get("/download/{job_id}")
async def download_job_output(job_id: str):
    """Download the completed job output file (audio or video)."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    if job.get("status") != "completed":
        raise HTTPException(400, f"Job {job_id} is not completed")
    output_path = job.get("output_path")
    filename = job.get("filename") or "output"
    if not output_path:
        raise HTTPException(404, f"No output for job {job_id}")

    path = Path(output_path)
    output_dir = Path("output").resolve()
    try:
        resolved = path.resolve()
    except FileNotFoundError:
        raise HTTPException(404, f"File not found for job {job_id}")
    if output_dir not in resolved.parents:
        raise HTTPException(403, "Invalid output path")
    if not resolved.exists():
        raise HTTPException(404, f"File not found for job {job_id}")

    from fastapi.responses import FileResponse

    media_type = "application/octet-stream"
    if resolved.suffix.lower() == ".wav":
        media_type = "audio/wav"
    elif resolved.suffix.lower() == ".mp4":
        media_type = "video/mp4"

    return FileResponse(
        path=str(resolved),
        media_type=media_type,
        filename=filename,
    )

@app.get("/jobs")
async def get_jobs():
    """Get recent completed renders."""
    return {"jobs": job_manager.get_history(10)}


@app.get("/queue")
async def get_queue():
    """Get current queue information."""
    return job_manager.get_queue_info()


@app.get("/job/{job_id}")
async def get_job_status(job_id: str):
    """Get job status and progress."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@app.get("/job/{job_id}/progress")
async def get_job_progress(job_id: str):
    """Get real-time job progress."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    # Calculate elapsed and remaining time
    elapsed = None
    remaining = None
    if job.get("started_at"):
        start = datetime.fromisoformat(job["started_at"])
        elapsed_seconds = (datetime.now() - start).total_seconds()
        elapsed = int(elapsed_seconds)

        if job["progress"] > 0 and job["progress"] < 100:
            # Estimate remaining time
            estimated_total = elapsed_seconds * 100 / job["progress"]
            remaining = int(estimated_total - elapsed_seconds)

    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "elapsed_seconds": elapsed,
        "remaining_seconds": remaining,
        "queue_position": job_manager.get_queue_position(job_id),
        "error": job.get("error"),
        "time_info": job.get("time_info"),
        "logs": job.get("logs", []),  # Include all logs
    }


@app.delete("/job/{job_id}")
async def cancel_job_endpoint(job_id: str):
    """Cancel a running job."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    if job["status"] not in ["queued", "processing"]:
        raise HTTPException(400, f"Cannot cancel job in '{job['status']}' state")

    success = await job_manager.cancel_job(job_id)

    # Clean up temp files after task is cancelled
    job_dir = Path(settings.TMP_DIR) / job_id
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)

    if success:
        return {"status": "cancelled", "job_id": job_id}
    else:
        raise HTTPException(500, "Failed to cancel job")


@app.post("/render-audio")
async def render_audio(
    duration: int = Form(
        ..., description="Output duration in seconds", gt=0, le=settings.MAX_DURATION
    ),
    files: list[UploadFile] = File(..., description="One or more audio track files"),
    volumes: str = Form("", description="Comma-separated float volumes (0.0–1.5) per track"),
    pans: str = Form("", description="Comma-separated float pans (-1.0 to 1.0) per track"),
    muted: str = Form("", description="Comma-separated booleans per track (0/1)"),
    solo: str = Form("", description="Comma-separated booleans per track (0/1)"),
    master_gain: float = Form(1.0, description="Master gain multiplier (0.0–2.0)"),
    eq_gains: str = Form("", description="Comma-separated EQ band gains in dB (7 bands)"),
):
    """
    Render a multi-track audio mix server-side.

    Accepts multiple uploaded audio files, applies per-track volume / pan / mute / solo,
    a 7-band EQ, and a master gain, then returns a rendered WAV file.
    """
    # Duration cap (explicit check)
    if duration > settings.MAX_DURATION:
        raise HTTPException(400, f"Duration exceeds maximum of {settings.MAX_DURATION}s")

    # Validate files
    for f in files:
        validate_audio_file(f)
        await validate_file_size(f)

    job_id = str(uuid.uuid4())[:8]
    job_dir = Path(settings.TMP_DIR) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        def debug_audio_stage(label: str, path: Path):
            if not settings.AUDIO_DEBUG:
                return

            def _sink(msg: str):
                logger.info("AUDIO_DEBUG render-audio %s | %s", label, msg)

            try:
                log_audio_debug(path, log_fn=_sink)
            except Exception as exc:
                logger.warning(
                    "AUDIO_DEBUG render-audio %s failed: %s",
                    label,
                    exc,
                )

        # 1. Save uploaded files to disk
        track_paths: list[Path] = []
        for i, upload in enumerate(files):
            ext = Path(upload.filename).suffix or ".audio"
            dest = job_dir / f"track_{i:02d}{ext}"
            with dest.open("wb") as f:
                shutil.copyfileobj(upload.file, f)
            track_paths.append(dest)

        # 2. Parse per-track parameters
        def parse_floats(s: str, count: int, default: float) -> list[float]:
            parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
            result = [float(p) for p in parts]
            while len(result) < count:
                result.append(default)
            return result[:count]

        def parse_bools(s: str, count: int) -> list[bool]:
            parts = [x.strip() for x in s.split(",") if x.strip()] if s else []
            result = [bool(int(p)) for p in parts]
            while len(result) < count:
                result.append(False)
            return result[:count]

        n = len(track_paths)
        vol_list = parse_floats(volumes, n, 1.0)
        pan_list = parse_floats(pans, n, 0.0)
        muted_list = parse_bools(muted, n)
        solo_list = parse_bools(solo, n)
        eq_list = parse_floats(eq_gains, 7, 0.0)

        # 3. Render (with semaphore to limit concurrency)
        renderer = AudioRenderer(settings)
        output_path = job_dir / "mix.wav"

        start_time = time.time()
        async with render_semaphore:
            await asyncio.to_thread(
                renderer.render,
                track_paths=track_paths,
                output_path=output_path,
                duration_seconds=duration,
                volumes=vol_list,
                pans=pan_list,
                muted=muted_list,
                solo=solo_list,
                master_gain=master_gain,
                eq_gains=eq_list,
                render_source_once=True,
            )
        render_time = time.time() - start_time
        await asyncio.to_thread(debug_audio_stage, "mix.wav", output_path)

        # Analyze loop points
        logger.info("Analyzing loop points for render-audio...")
        analysis = await asyncio.to_thread(analyze_loop, output_path)
        resolved_loop_start = analysis["loop_start_ms"] / 1000.0
        resolved_loop_end = analysis["loop_end_ms"] / 1000.0
        resolved_crossfade_seconds = max(0.5, analysis["crossfade_ms"] / 1000.0)

        # Apply seamless loop crossfade
        looped_path = job_dir / "mix_loop.wav"
        await asyncio.to_thread(
            make_loop,
            output_path,
            looped_path,
            crossfade_seconds=resolved_crossfade_seconds,
            loop_start_seconds=resolved_loop_start,
            loop_end_seconds=resolved_loop_end,
        )
        await asyncio.to_thread(debug_audio_stage, "mix_loop.wav", looped_path)

        # Extend loop to full duration with seamless crossfading
        final_audio_path = job_dir / "mix_loop_filled.wav"
        await asyncio.to_thread(
            extend_loop_seamless,
            looped_path,
            final_audio_path,
            float(duration),
            crossfade_seconds=resolved_crossfade_seconds,
        )
        await asyncio.to_thread(
            debug_audio_stage, "mix_loop_filled.wav", final_audio_path
        )

        log_render(duration, n, render_time, True)

        # Schedule cleanup
        async def cleanup():
            await asyncio.sleep(30)
            shutil.rmtree(job_dir, ignore_errors=True)

        task = asyncio.create_task(cleanup())
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

        from fastapi.responses import FileResponse

        return FileResponse(
            path=str(final_audio_path),
            media_type="audio/wav",
            filename=f"ambient_mix_{duration}s.wav",
        )

    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        log_render(duration, len(files), 0, False, str(exc))
        raise HTTPException(status_code=500, detail=f"Audio render failed: {exc}") from exc


@app.post("/render-video")
async def render_video(
    audio: UploadFile = File(..., description="Pre-rendered WAV/MP3 audio file"),
    duration: int = Form(
        ..., description="Duration in seconds", gt=0, le=settings.MAX_DURATION
    ),
    background_image: UploadFile | None = File(
        None, description="Optional custom background image"
    ),
):
    """
    Combine an audio file with a (optionally custom) background image to produce
    an MP4 video with a slow Ken Burns / zoom-pan effect.
    """
    job_id = str(uuid.uuid4())[:8]
    job_dir = Path(settings.TMP_DIR) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Save audio
        audio_ext = Path(audio.filename).suffix or ".wav"
        audio_path = job_dir / f"audio{audio_ext}"
        with audio_path.open("wb") as f:
            shutil.copyfileobj(audio.file, f)

        # 2. Resolve background
        if background_image:
            img_ext = Path(background_image.filename).suffix or ".jpg"
            bg_path = job_dir / f"background{img_ext}"
            with bg_path.open("wb") as f:
                shutil.copyfileobj(background_image.file, f)
        else:
            bg_path = Path(settings.DEFAULT_BACKGROUND)
            if not bg_path.exists():
                raise HTTPException(
                    status_code=404,
                    detail="No default background image found at assets/background.jpg.",
                )

        # 3. Render
        renderer = VideoRenderer(settings)
        output_path = job_dir / "ambient_video.mp4"

        await asyncio.to_thread(
            renderer.render,
            audio_path=audio_path,
            background_path=bg_path,
            output_path=output_path,
            duration_seconds=duration,
        )

        # Schedule cleanup
        async def cleanup():
            await asyncio.sleep(30)
            shutil.rmtree(job_dir, ignore_errors=True)

        task = asyncio.create_task(cleanup())
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

        from fastapi.responses import FileResponse

        return FileResponse(
            path=str(output_path),
            media_type="video/mp4",
            filename="ambient_video.mp4",
        )

    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Video render failed: {exc}") from exc


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=3001, reload=True)
