/**
 * export-and-jobs.spec.ts – Production‑ready Playwright test suite for Ambient Studio
 * Focus: Loop analysis, preview seam, audio/video export, job cancellation, and error handling.
 */

import { test, expect, FIXTURE_WAV } from "./helpers/base-test";
import { setupAllMocks } from "./helpers/mocks";

// ──────────────────────────────────────────────────────────────────────────────

test.describe("Loop Analysis", () => {
  test("should perform successful loop analysis and display results", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("analyze-loop").click();
    await expect(page.getByTestId("analysis-result")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("analysis-score")).toHaveText(/91\.0%/);
    await expect(page.getByTestId("analysis-loop-start")).toHaveText(/4\.2\s*s/);
    await expect(page.getByTestId("analysis-loop-end")).toHaveText(/32\.8\s*s/);
    await expect(page.getByTestId("analysis-candidates")).toHaveText(/1 candidate/);
    await expect(page.getByTestId("analysis-alternatives")).toHaveText(/1 alternative/);
  });

  test("should show warning for low-score analysis", async ({ page }) => {
    await setupAllMocks(page, { analyzeScore: 0.55 });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("analyze-loop").click();
    await expect(page.getByTestId("low-score-warning")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("analysis-score")).toHaveText(/55\.0%/);
  });

  test("should handle analysis failure gracefully", async ({ page }) => {
    await setupAllMocks(page, { analyzeStatus: 500, analyzeBody: "Internal Server Error" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("analyze-loop").click();
    await expect(page.getByTestId("analysis-error")).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Preview Seam", () => {
  test("should preview seam after successful analysis", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("analyze-loop").click();
    await expect(page.getByTestId("analysis-result")).toBeVisible({ timeout: 15000 });
    const previewBtn = page.getByTestId("preview-seam");
    await expect(previewBtn).toBeVisible();
    await previewBtn.click();
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Previewing loop seam...")).toBeVisible({ timeout: 5000 });
  });

  test("should not show Preview Seam button without analysis", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("export-tab").click();
    await expect(page.getByTestId("preview-seam")).not.toBeVisible();
  });
});

test.describe("Audio Export", () => {
  test("should submit audio export job and show progress then completion", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("export-wav").click();
    await expect(page.getByTestId("export-progress-label")).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText(/Audio rendered successfully|Audio render completed/).first()
    ).toBeVisible({ timeout: 20000 });
  });

  test("should show progress updates during rendering", async ({ page }) => {
    await setupAllMocks(page, { scenario: "processing-then-complete" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("export-wav").click();
    await expect(page.getByTestId("export-progress-bar")).toBeVisible({ timeout: 10000 });
  });

  test("should disable export when no tracks loaded", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("export-tab").click();
    await expect(page.getByTestId("no-tracks-warning")).toBeVisible();
    await expect(page.getByTestId("export-wav")).toBeDisabled();
  });

  // NEW: Export duration input changes (Test 7) – case-insensitive
  test("export duration input updates the value", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("export-tab").click();
    const durationInput = page
      .getByText(/DURATION/i)
      .locator("..")
      .locator("input");
    await expect(durationInput).toHaveValue("5");
    await durationInput.fill("12");
    await expect(durationInput).toHaveValue("12");
    await durationInput.fill("3");
    await expect(durationInput).toHaveValue("3");
  });

  // NEW: Export filename input changes (Test 8)
  test("export filename input updates the value", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("export-tab").click();
    const filenameInput = page.getByRole("textbox");
    await expect(filenameInput).toHaveValue("ambient_mix");
    await filenameInput.fill("my_ambient");
    await expect(filenameInput).toHaveValue("my_ambient");
    await filenameInput.fill("soundscape");
    await expect(filenameInput).toHaveValue("soundscape");
  });
});

test.describe("Video Export", () => {
  test("should submit video export job and complete", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("render-video").click();
    await expect(page.getByTestId("export-progress-label")).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText(/Video saved successfully|Video render completed|Render finished/).first()
    ).toBeVisible({ timeout: 20000 });
  });

  test("should toggle visualizer ON/OFF", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("export-tab").click();
    const toggle = page.getByTestId("visualizer-toggle");
    await expect(toggle).toHaveText(/off/i);
    await toggle.click();
    await expect(toggle).toHaveText(/on/i);
    await toggle.click();
    await expect(toggle).toHaveText(/off/i);
  });

  test("should toggle GPU encoding", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("export-tab").click();
    const toggle = page.getByTestId("gpu-toggle");
    await expect(toggle).toHaveText(/gpu/i);
    await toggle.click();
    await expect(toggle).toHaveText(/cpu/i);
    await toggle.click();
    await expect(toggle).toHaveText(/gpu/i);
  });

  // NEW: Video Preview opens, shows canvas, and closes (Test 9)
  test("Video Preview opens, shows canvas, and closes", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    const previewBtn = page.getByRole("button", { name: /preview/i });
    await expect(previewBtn).toBeEnabled();
    await previewBtn.click();
    const canvas = page.locator('canvas[width="480"]');
    await expect(canvas).toBeVisible({ timeout: 5000 });
    const closeBtn = page.getByRole("button", { name: /close/i });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(canvas).not.toBeVisible();
  });
});

test.describe("Job Cancellation", () => {
  test("should cancel a processing job", async ({ page }) => {
    await setupAllMocks(page, { scenario: "always-processing" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("export-wav").click();
    const cancelBtn = page.getByTestId("cancel-render");
    await expect(cancelBtn).toBeVisible({ timeout: 10000 });
    await cancelBtn.click();
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Render cancelled").first()).toBeVisible({ timeout: 5000 });
  });

  test("should cancel a queued job", async ({ page }) => {
    await setupAllMocks(page, { scenario: "always-queued" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("export-wav").click();
    const cancelBtn = page.getByTestId("cancel-render");
    await expect(cancelBtn).toBeVisible({ timeout: 10000 });
    await cancelBtn.click();
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Render cancelled").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Error Handling", () => {
  test("should handle render failure with error display", async ({ page }) => {
    await setupAllMocks(page, { scenario: "failed" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("export-wav").click();
    await expect(page.getByTestId("export-error")).toBeVisible({ timeout: 20000 });
  });

  test("should handle analysis failure gracefully", async ({ page }) => {
    await setupAllMocks(page, { analyzeStatus: 500, analyzeBody: "Analysis service unavailable" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("analyze-loop").click();
    await expect(page.getByTestId("analysis-error")).toBeVisible({ timeout: 15000 });
  });
});
