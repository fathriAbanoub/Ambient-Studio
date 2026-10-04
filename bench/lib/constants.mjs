/**
 * bench/lib/constants.mjs — every literal used by the benchmark suite.
 *
 * A benchmark full of unnamed magic numbers is worthless for reproducing
 * later. Constants ported from the actual codebase carry a `// port:` comment
 * naming the source file:line so future drift is visible.
 */

// ── Schema ───────────────────────────────────────────────────────────────
export const RESULT_SCHEMA_VERSION = 1;

// ── Kernel benchmark (A) — ports from ui/src/store/studioStore.ts:214
//    (the store's initial generator state) and
//    frontend/src/hooks/useProceduralEngine.ts:13 (DEFAULT_ROOT_HZ).
export const KERNEL_DEFAULT_PARAMS = {
  scale: "majorPent",
  rootHz: 220, // port: useProceduralEngine.ts:13 DEFAULT_ROOT_HZ
  bpm: 72, // port: studioStore.ts generator.tempo
  complexity: 0.35,
  mix: 0.4,
  sceneDurationBars: 32,
  enableScenes: true,
  enableHarmonicLoop: true,
  enableBeats: true,
  seed: 42,
  drumLevel: 0.5,
  swing: 0,
  drumStyle: "euclideanTrap",
  sidechainAmount: 0,
};
export const A_HORIZON_HOURS = 8; // A1/A3 simulate a full 8-hour beat sequence
export const A_WARMUP_CALLS = 100; // discarded JIT warm-up calls (A1/A2)
export const A_BUCKETS = 48; // distribution buckets across the full horizon
export const A2_HORIZON_BEATS = 2000; // per-configuration horizon for A2
export const A2_DRONE_LAYER_COUNTS = [0, 4, 8]; // 8 === MAX_DRONE_LAYERS
export const A2_SAMPLE_BANK_SIZES = [0, 16]; // 16 === MAX_SAMPLE_BANK_ENTRIES
export const A2_SAMPLE_ENTRY_TEMPLATE = { url: "file:///bench-nonexistent.wav", gain: 0.25, pan: 0 };

// ── Offline render benchmark (B) — ports from renderAmbient.ts ───────────
export const B_SWEEP_MINUTES = [1, 5, 15, 30, 60]; // renderAmbient UI cap = 60 (ProceduralTrack.tsx:41)
export const B_LONG_MINUTES_2H = 120;
export const B_LONG_MINUTES_8H = 480;
export const B_HEAP_POLL_INTERVAL_MS = 100; // in-page performance.memory sampler
export const B_SCALE_FACTOR_DEFAULT = 1; // --scale multiplies every sweep duration

// ── Chunked-render PoC (C) — ports from renderAmbient.ts graph shape ─────
export const C_SAMPLE_RATE = 44100; // port: renderAmbient.ts:143
export const C_TOTAL_SEC = 1800; // default PoC program length (30 min — so the 600s chunk config has real seams)
export const C_LONG_SEC = 3600; // --long-2h variant (1 h keeps runtime sane)
export const C_PRIMER_SEC = 5; // warm-up audio rendered+discarded before each chunk seam
export const C_CHUNK_SIZES_SEC = [60, 600]; // "chunk every 1 min vs every 10 min"
export const C_CARRIER_HZ = 220;
export const C_SUBOSC_HZ = 55;
export const C_FILTER_START_HZ = 600;
export const C_FILTER_END_HZ = 2400;
export const C_FILTER_Q = 1.0; // port: renderAmbient.ts:172 filter.Q.value
export const C_DELAY_START_SEC = 0.2;
export const C_DELAY_END_SEC = 0.35;
export const C_DELAY_MAX_SEC = 2.0; // port: renderAmbient.ts:161 createDelay(2.0)
export const C_FEEDBACK_GAIN = 0.35;
export const C_MASTER_GAIN = 0.5;
export const C_PAN_PERIOD_SEC = 10; // exponential (setTargetAtTime) pan automation period
export const C_PAN_TARGET_TIME_CONSTANT = 0.08;

// ── ffmpeg video ladder (D) — ports from backend/config.py:46-66 and
//    backend/services/video_renderer.py ────────────────────────────────────
export const D_VIDEO_WIDTH = 1920; // port: config.py VIDEO_WIDTH
export const D_VIDEO_HEIGHT = 1080; // port: config.py VIDEO_HEIGHT
export const D_CRF = 23; // port: config.py CRF
export const D_X264_PRESET = "veryfast"; // port: config.py PRESET
export const D_NVENC_ARGS = ["-preset", "p1", "-rc", "vbr", "-cq", "23", "-b:v", "5M"]; // port: video_renderer.py:100
export const D_NVENC_PROBE_ARGS = [
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=black:s=16x16:d=0.1",
  "-vcodec", "h264_nvenc", "-f", "null", "-",
]; // port: video_renderer.py:64-72
export const D_NVENC_PROBE_TIMEOUT_MS = 10_000; // port: video_renderer.py:71
export const D_AUDIO_CODEC = "aac"; // port: config.py AUDIO_CODEC
export const D_ZOOM_START = 1.0; // port: config.py ZOOM_START
export const D_ZOOM_END = 1.2; // port: config.py ZOOM_END
export const D_ZOOM_UPSCALE_WIDTH = 7680; // design-discussion upscale-before-zoompan figure
export const D_STATIC_SWEEP_MIN = [1, 10, 30, 120]; // D1 duration sweep (minutes)
export const D_MOTION_SWEEP_MIN = [1, 10, 30]; // D2/D3 duration sweep (minutes)
export const D_LONG_MIN_2H = 120; // opt-in long case per D mode
export const D_LONG_MIN_8H = 480; // opt-in 8-hour case per D mode
export const D_ZOOM_FPS_FULL = [5, 10, 15, 24];
export const D_ZOOM_FPS_DEFAULT = [5, 10];
export const D_LOOP_FPS_DEFAULT = [10];
export const D_FADE_SEC = 5; // head/tail fades for D4 assembly segments
export const D_HEAD_TAIL_SEC = 5;
export const D4_BODY_SEC_STATIC = 60;
export const D4_ZOOM_SEGMENTS = 10;
export const D_SYNTH_AUDIO_SEED = 42; // anoisesrc seed → identical audio across compared runs
export const D_SYNTH_AUDIO_AMPLITUDE = 0.1;
export const D_AUDIO_SAMPLE_RATE = 44100; // port: config.py SAMPLE_RATE

// ── Disk / I/O (E) ────────────────────────────────────────────────────────
export const E1_SWEEP_MIN = [1, 5, 15, 30, 60];
export const E2_BASELINE_WRITE_MB = 512;
export const E2_WRITE_CHUNK_MB = 1;
export const E2_SAMPLE_INTERVAL_SEC = 1;
export const E3_DEFAULT_MIN = 10;
export const E3_LONG_MIN_2H = 120;
export const E3_LONG_MIN_8H = 480;
export const E3_SEGMENT_COUNT = 6;
export const E_DIR_SAMPLE_INTERVAL_SEC = 2;

// ── Node Web Audio battery (F) ───────────────────────────────────────────
export const F_GRAPH_DURATION_SEC = 5;
export const F_SAMPLE_RATE = 44100;
export const F_COMPRESSOR = { threshold: -20, ratio: 3, attack: 0.003, release: 0.25 }; // port: renderAmbient.ts:184-187
export const F_DELAY_SEC = 0.3; // port: renderAmbient.ts:168 (mix=0.4 → 0.3+0.4*0.4=0.46; battery uses the base 0.3)
export const F_FEEDBACK = 0.35;

// ── G — in-process streaming synth (the D1–D5 render-path PoC) ───────────
export const G_SAMPLE_RATE = C_SAMPLE_RATE; // same 44.1 kHz engine rate
export const G_BLOCK_FRAMES = 4096; // primary block size (~93 ms)
export const G_BLOCK_SIZE_INVARIANCE = [1024, 4096, 16384]; // hash-equality set
export const G_SWEEP_SEC = [300, 1800, 7200, 28800]; // 5 min → 8 h (96× span)
export const G_DETERMINISM_SEC = 1800; // G3 duration (two full runs + invariance)
export const G_AUDIT_RECHECK_SEC = [300, 1800]; // order-reversal audit points
export const G_DRONE_LAYERS = 0; // sweep uses repo-default params (B-comparable)
export const G_DRONE_LAYERS_HEAVY = 4; // automation-heavy 30-min extra point
export const G_RSS_SAMPLE_INTERVAL_MS = 500; // in-child RSS curve sampler
export const G_PANIC_TIMEOUT_MS = 6 * 3600 * 1000; // child kill guard

// ── H — worker isolation / responsiveness ────────────────────────────────
export const H_RENDER_SEC = 900; // 15 min render inside the worker
export const H_LAG_POLL_INTERVAL_MS = 50; // event-loop lag probe cadence
export const H_BASELINE_MS = 3000; // no-render baseline measurement window

// ── I — automation state-carry (supersedes C's chunking) ─────────────────
export const I_TOTAL_SEC = 1800; // match C's 30-min program
export const I_BLOCK_SIZES = [1024, 4096, 16384, 44100 * 30]; // last = single-block
export const I_CROSSCHECK_SEC = 120; // Web Audio single-pass reference (memory-bounded)
export const I_BROKEN_BLOCK_SIZES = [1024, 8192, 65536]; // divergence must grow
// C-graph constants are re-used from the C_ section above.

// ── J — direct-to-ffmpeg streaming ───────────────────────────────────────
export const J_SWEEP_SEC = [300, 1800, 7200]; // 5 min / 30 min / 2 h
export const J_AUDIO_BITRATE_K = 160; // port: repo AAC bitrate (160k)

// ── K — concurrency/determinism stress (D2) ──────────────────────────────
export const K_LAYERS = 8; // simultaneous layer buffers
export const K_BLOCK_FRAMES = 1024;
export const K_CHUNKS = 200; // blocks per run (~4.6 s of audio)
export const K_RUNS = 7; // runs per variant
export const K_JITTER_MAX_MS = 4; // completion-order jitter window (broken variant)

// ── L — corrected re-runs of A's sweep ───────────────────────────────────
export const L_HORIZON_BEATS = A2_HORIZON_BEATS; // 2000, same as A2
export const L_CONFIGS = [
  { drones: 0, bank: 0 }, { drones: 0, bank: 16 },
  { drones: 4, bank: 0 }, { drones: 4, bank: 16 },
  { drones: 8, bank: 0 }, { drones: 8, bank: 16 },
]; // same grid as A2

// ── Suite-wide ───────────────────────────────────────────────────────────
export const DISK_SAFETY_MARGIN = 1.25; // required-free = estimate × this
export const PROC_RSS_POLL_INTERVAL_MS = 100; // Linux /proc granularity
export const PROC_RSS_POLL_INTERVAL_MS_WIN = 1000; // tasklist is too slow to poll faster
export const DIR_SIZE_SAMPLE_INTERVAL_MS = 2000;
export const PREFIX_WIDTH = 1920; // synthetic testsrc2 background width pre-scale
export const PREFIX_HEIGHT = 1080;
export const LOOP_GIF_SEC = 30;
export const LOOP_GIF_FPS = 10;
export const LOOP_GIF_WIDTH = 640;
export const LOOP_GIF_HEIGHT = 360;
export const LOOP_MP4_SEC = 10;
