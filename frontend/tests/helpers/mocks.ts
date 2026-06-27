/**
 * mocks.ts – Shared API mocks for Ambient Studio Playwright tests
 *
 * Strategy:
 *   - All API calls intercepted via page.route() – no real backend.
 *   - Every async action is properly awaited via visible changes.
 *   - Data‑testid attributes are used for robust selectors (see README).
 *
 * CRITICAL: Playwright route handlers are evaluated in registration order.
 * The FIRST handler that calls route.fulfill/continue/abort WINS.
 * Therefore, we NEVER call setupAllMocks() in beforeEach AND again in a test.
 * Each test that needs mocks calls setupAllMocks() exactly once.
 */

import { Page, Route } from "@playwright/test";

export const API_BASE = "http://localhost:3003";

// ── Constants & helpers ──────────────────────────────────────────────────────

/**
 * Extracts the job ID from a URL path like `/job/123/progress` or `/job/123`.
 */
function extractJobIdFromUrl(url: string): string {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split("/").filter((p) => p.length > 0);
  const jobIndex = pathParts.indexOf("job");
  if (jobIndex !== -1 && pathParts.length > jobIndex + 1) {
    return pathParts[jobIndex + 1];
  }
  return "";
}

// ── Mock response factories ────────────────────────────────────────────────

const MOCK_HEALTH = { status: "ok", version: "3.1.0" };

export function mockAnalyzeLoopResponse(
  overrides: Record<string, unknown> = {},
) {
  return {
    loop_start_ms: 4200,
    loop_end_ms: 32800,
    score: 0.91,
    crossfade_ms: 120,
    duration_ms: 28600,
    raw_analyzer_score: 0.87,
    candidates: [
      {
        segment_id: "seg-001",
        loop_start_ms: 4200,
        loop_end_ms: 32800,
        crossfade_duration_ms: 120,
        validator_score: 0.91,
        repetition_salience_score: 0.78,
      },
    ],
    alternatives: [
      {
        segment_id: "seg-002",
        loop_start_ms: 5000,
        loop_end_ms: 30000,
        crossfade_ms: 100,
        raw_analyzer_score: 0.8,
        validator_score: 0.82,
        repetition_salience_score: 0.65,
        validation_metrics: { spectral_distance: 0.12, energy_diff: 0.04 },
      },
    ],
    ...overrides,
  };
}

export function mockJobQueued(jobId = "mock-job-123") {
  return { status: "queued", job_id: jobId, queue_position: 0 };
}

export function mockJobProgress(
  jobId = "mock-job-123",
  overrides: Record<string, unknown> = {},
) {
  return {
    job_id: jobId,
    status: "processing",
    progress: 45,
    elapsed_seconds: 3,
    remaining_seconds: 4,
    queue_position: 0,
    error: null,
    logs: ["Rendering started", "Mixing audio..."],
    ...overrides,
  };
}

export function mockJobCompleted(jobId = "mock-job-123") {
  return {
    job_id: jobId,
    status: "completed",
    progress: 100,
    elapsed_seconds: 7,
    remaining_seconds: 0,
    queue_position: 0,
    error: null,
    logs: ["Rendering started", "Mixing audio...", "Encoding complete"],
  };
}

export function mockJobFailed(jobId = "mock-job-123") {
  return {
    job_id: jobId,
    status: "failed",
    progress: 60,
    elapsed_seconds: 5,
    remaining_seconds: null,
    queue_position: 0,
    error: "FFmpeg encoding failed",
    logs: ["Rendering started", "FFmpeg encoding failed"],
  };
}

export function mockJobCancelled(jobId = "mock-job-123") {
  return { status: "cancelled", job_id: jobId };
}

export function mockJobQueuedWaiting(jobId = "mock-job-123", position = 2) {
  return {
    job_id: jobId,
    status: "queued",
    progress: 0,
    elapsed_seconds: null,
    remaining_seconds: null,
    queue_position: position,
    error: null,
    logs: [],
  };
}

export function mockJobHistory() {
  return { jobs: [] };
}

export function mockJobStatus(jobId = "mock-job-123") {
  return {
    id: jobId,
    status: "completed",
    progress: 100,
    duration: 300,
    started_at: "2025-01-01T00:00:00Z",
    finished_at: "2025-01-01T00:05:00Z",
    error: null,
    output_path: "/output/ambient_video.mp4",
    filename: "ambient_video.mp4",
    file_size: 1048576,
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ProgressScenario =
  | "processing-then-complete"
  | "failed"
  | "queued-then-processing"
  | "always-queued"
  | "always-processing";

export interface MockOptions {
  scenario?: ProgressScenario;
  analyzeScore?: number;
  analyzeStatus?: number;
  analyzeBody?: string;
}

// ── Route setup helpers ────────────────────────────────────────────────────

/**
 * Installs ALL API route mocks on the given page.
 * CALL THIS EXACTLY ONCE per test — never combine with beforeEach mocks.
 */
export async function setupAllMocks(page: Page, options: MockOptions = {}) {
  const {
    scenario = "processing-then-complete",
    analyzeScore = 0.91,
    analyzeStatus = 200,
    analyzeBody,
  } = options;

  let pollCount = 0;

  // ── Health ──
  await page.route(`${API_BASE}/health`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_HEALTH),
    }),
  );

  // ── Analyze Loop ──
  await page.route(`${API_BASE}/analyze-loop`, (route: Route) => {
    if (analyzeStatus !== 200) {
      return route.fulfill({
        status: analyzeStatus,
        contentType: "text/plain",
        body: analyzeBody ?? "Internal Server Error",
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockAnalyzeLoopResponse({ score: analyzeScore })),
    });
  });

  // ── Render Audio Job ──
  await page.route(`${API_BASE}/render-audio-job`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockJobQueued()),
    }),
  );

  // ── Render Video Full ──
  await page.route(`${API_BASE}/render-video-full`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockJobQueued()),
    }),
  );

  // ── Job Progress (counter-based – matches any job ID) ──
  // ponytail: A mock doesn't need a formal FSM. We track how many times the
  // endpoint was hit and return the appropriate response from the scenario.
  // Ceiling: If scenarios need complex branching based on request bodies or
  // per-job state, upgrade to a real state machine. For now, a counter is enough.
  await page.route(`${API_BASE}/job/*/progress`, async (route: Route) => {
    const jobId = extractJobIdFromUrl(route.request().url());
    const i = pollCount++;

    let body: Record<string, unknown>;
    if (scenario === "failed") body = mockJobFailed(jobId);
    else if (scenario === "always-queued")
      body = mockJobQueuedWaiting(jobId, 2);
    else if (scenario === "always-processing")
      body = mockJobProgress(jobId, { progress: 30 });
    else if (scenario === "queued-then-processing") {
      if (i === 0) body = mockJobQueuedWaiting(jobId, 2);
      else if (i === 1) body = mockJobProgress(jobId, { progress: 30 });
      else body = mockJobCompleted(jobId);
    } else {
      // processing-then-complete
      if (i === 0) body = mockJobProgress(jobId);
      else body = mockJobCompleted(jobId);
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  // ── Job Status (GET/DELETE) ──
  await page.route(`${API_BASE}/job/*`, (route: Route) => {
    if (route.request().method() === "DELETE") {
      const jobId = extractJobIdFromUrl(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockJobCancelled(jobId)),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockJobStatus()),
    });
  });

  // ── Download (backend direct) ──
  await page.route(`${API_BASE}/download/*`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "video/mp4",
      body: Buffer.from("fake-mp4-data"),
    }),
  );

  // ── Download (frontend proxy) – FIXED glob pattern ──
  await page.route("**/api/download/*", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "video/mp4",
      body: Buffer.from("fake-mp4-data"),
    }),
  );

  // ── Job History ──
  await page.route(`${API_BASE}/jobs`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockJobHistory()),
    }),
  );

  // ── Queue ──
  await page.route(`${API_BASE}/queue`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        queue_depth: 0,
        active_jobs: 0,
        max_concurrent: 2,
        queued_jobs: [],
      }),
    }),
  );

  // ── System ──
  await page.route(`${API_BASE}/system`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cpu_percent: 23,
        ram_used: 4_200_000_000,
        ram_total: 16_000_000_000,
        ram_percent: 26,
        output_folder_size: 0,
        output_folder_files: 0,
        renders_today: 0,
      }),
    }),
  );
}
