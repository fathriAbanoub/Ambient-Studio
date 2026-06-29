// API utilities for AMBIENT STUDIO backend communication

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3003";

// ── Health Check ──────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  version: string;
}

export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Loop Analysis ─────────────────────────────────────────────────────────────

export interface LoopCandidate {
  segment_id: string;
  loop_start_ms: number;
  loop_end_ms: number;
  crossfade_duration_ms: number;
  validator_score: number;
  repetition_salience_score: number;
}

export interface LoopAlternative {
  segment_id: string;
  loop_start_ms: number;
  loop_end_ms: number;
  crossfade_ms: number;
  raw_analyzer_score: number;
  validator_score: number;
  repetition_salience_score: number;
  validation_metrics: Record<string, number>;
}

export interface LoopAnalysisResult {
  loop_start_ms: number;
  loop_end_ms: number;
  score: number;
  crossfade_ms: number;
  duration_ms: number;
  raw_analyzer_score: number;
  candidates: LoopCandidate[];
  alternatives: LoopAlternative[];
}

export async function analyzeLoop(file: File): Promise<LoopAnalysisResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/analyze-loop`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Loop analysis failed: ${errorText}`);
  }

  return await res.json();
}

// ── Render Audio ──────────────────────────────────────────────────────────────

export interface RenderAudioParams {
  duration: number; // seconds
  files: File[];
  volumes: number[];
  pans: number[];
  muted: boolean[];
  solo: boolean[];
  masterGain: number;
  eqGains: number[];
  loopStart?: number;   // seconds
  loopEnd?: number;     // seconds
}

export interface RenderAudioJobResponse {
  status: string;
  job_id: string;
  queue_position: number;
}

export async function renderAudioJob(
  params: RenderAudioParams,
): Promise<RenderAudioJobResponse> {
  const formData = new FormData();

  params.files.forEach((file) => {
    formData.append("files", file);
  });

  formData.append("duration", String(params.duration));
  formData.append("volumes", params.volumes.map((v) => v.toFixed(2)).join(","));
  formData.append("pans", params.pans.map((p) => p.toFixed(2)).join(","));
  formData.append("muted", params.muted.map((m) => (m ? "1" : "0")).join(","));
  formData.append("solo", params.solo.map((s) => (s ? "1" : "0")).join(","));
  formData.append("master_gain", String(params.masterGain));
  formData.append("eq_gains", params.eqGains.join(","));

  if (params.loopStart !== undefined) {
    formData.append("loop_start", String(params.loopStart));
  }
  if (params.loopEnd !== undefined) {
    formData.append("loop_end", String(params.loopEnd));
  }

  const res = await fetch(`${API_BASE}/render-audio-job`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Audio render failed: ${errorText}`);
  }

  return await res.json();
}

export async function downloadJobOutput(jobId: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/download/${jobId}`, { method: "GET" });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Download failed: ${errorText}`);
  }
  return await res.blob();
}


// ── Render Video Full (Audio + Video pipeline) ────────────────────────────────

export interface RenderVideoFullParams extends RenderAudioParams {
  backgroundImage?: File;
  showVisualizer?: boolean;
  useGpuEncoding?: boolean;
  loopStart?: number;   // seconds
  loopEnd?: number;     // seconds
}

export interface RenderVideoFullResponse {
  status: string;
  job_id: string;
  queue_position: number;
}

export async function renderVideoFull(
  params: RenderVideoFullParams,
): Promise<RenderVideoFullResponse> {
  const formData = new FormData();

  params.files.forEach((file) => {
    formData.append("files", file);
  });

  formData.append("duration", String(params.duration));
  formData.append("volumes", params.volumes.map((v) => v.toFixed(2)).join(","));
  formData.append("pans", params.pans.map((p) => p.toFixed(2)).join(","));
  formData.append("muted", params.muted.map((m) => (m ? "1" : "0")).join(","));
  formData.append("solo", params.solo.map((s) => (s ? "1" : "0")).join(","));
  formData.append("master_gain", String(params.masterGain));
  formData.append("eq_gains", params.eqGains.join(","));
  formData.append("show_visualizer", params.showVisualizer ? "1" : "0");
  formData.append("use_gpu_encoding", params.useGpuEncoding ? "1" : "0");

  if (params.backgroundImage) {
    formData.append("background_image", params.backgroundImage);
  }
  if (params.loopStart !== undefined) {
    formData.append("loop_start", String(params.loopStart));
  }
  if (params.loopEnd !== undefined) {
    formData.append("loop_end", String(params.loopEnd));
  }

  const res = await fetch(`${API_BASE}/render-video-full`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30000), // 30 seconds for initial response
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Video render failed: ${errorText}`);
  }

  return await res.json();
}

// ── Job Progress API ────────────────────────────────────────────────────────

export interface JobProgressResponse {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  elapsed_seconds: number | null;
  remaining_seconds: number | null;
  queue_position: number;
  error: string | null;
  time_info?: {
    status?: string;
    log_message?: string;
  };
  logs?: string[];
}

export async function getJobProgress(
  jobId: string,
): Promise<JobProgressResponse> {
  const res = await fetch(`${API_BASE}/job/${jobId}/progress`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get job progress: ${errorText}`);
  }

  return await res.json();
}

// ── Job Status API ────────────────────────────────────────────────────────────

export interface JobStatusResponse {
  id: string;
  status: string;
  progress: number;
  duration: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  output_path: string | null;
  filename: string | null;
  file_size: number | null;
}

export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const res = await fetch(`${API_BASE}/job/${jobId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get job status: ${errorText}`);
  }

  return await res.json();
}

// ── Cancel Job API ────────────────────────────────────────────────────────────

export async function cancelJob(
  jobId: string,
): Promise<{ status: string; job_id: string }> {
  const res = await fetch(`${API_BASE}/job/${jobId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to cancel job: ${errorText}`);
  }

  return await res.json();
}

// ── Queue API ───────────────────────────────────────────────────────────────

export interface QueueInfoResponse {
  queue_depth: number;
  active_jobs: number;
  max_concurrent: number;
  queued_jobs: string[];
}

export async function getQueueInfo(): Promise<QueueInfoResponse> {
  const res = await fetch(`${API_BASE}/queue`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get queue info: ${errorText}`);
  }

  return await res.json();
}

// ── Job History API ──────────────────────────────────────────────────────────

export interface JobHistoryItem {
  job_id: string;
  filename: string;
  duration: number;
  file_size: number;
  timestamp: string;
  file_path: string;
}

export interface JobHistoryResponse {
  jobs: JobHistoryItem[];
}

export async function getJobHistory(): Promise<JobHistoryResponse> {
  const res = await fetch(`${API_BASE}/jobs`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get job history: ${errorText}`);
  }

  return await res.json();
}

// ── System Info API ──────────────────────────────────────────────────────────

export interface SystemInfoResponse {
  cpu_percent: number;
  ram_used: number;
  ram_total: number;
  ram_percent: number;
  output_folder_size: number;
  output_folder_files: number;
  renders_today: number;
}

export async function getSystemInfo(): Promise<SystemInfoResponse> {
  const res = await fetch(`${API_BASE}/system`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to get system info: ${errorText}`);
  }

  return await res.json();
}

// ── Utility Functions ────────────────────────────────────────────────────────

/**
 * Download a blob as a file
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function triggerVideoDownload(jobId: string, filename?: string): void {
  const a = document.createElement("a");
  a.href = `/api/download/${encodeURIComponent(jobId)}`;
  a.download = filename ?? `ambient_video_${jobId}.mp4`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Format bytes to human-readable file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format duration in seconds to MM:SS
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format time remaining in human-readable format
 */
export function formatTimeRemaining(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}