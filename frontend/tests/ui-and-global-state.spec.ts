/**
 * ui-and-global-state.spec.ts – Production‑ready Playwright test suite for Ambient Studio
 * Focus: EQ panel, presets, log console, and header status.
 */

import { test, expect, FIXTURE_WAV } from "./helpers/base-test";
import { setupAllMocks, API_BASE } from "./helpers/mocks";
import { Route } from "@playwright/test";

// ──────────────────────────────────────────────────────────────────────────────

test.describe("EQ Panel", () => {
  test("should display 7 EQ band sliders", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const sliders = page.getByTestId("eq-slider");
    await expect(sliders).toHaveCount(7);
  });

  test("should display correct band labels", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const labels = ["Sub", "Bass", "Low-Mid", "Mid", "Upper-Mid", "Presence", "Air"];
    for (const label of labels) {
      await expect(page.getByTestId(`eq-label-${label}`)).toBeVisible();
    }
  });

  test("reset button should reset all bands to 0", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("eq-reset").click();
    const sliders = page.getByTestId("eq-slider");
    const count = await sliders.count();
    for (let i = 0; i < count; i++) {
      await expect(sliders.nth(i)).toHaveAttribute("aria-valuenow", "0");
    }
  });

  // NEW: EQ slider changes aria-valuenow (Test 2)
  test("adjusting an EQ slider updates its aria-valuenow", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const slider = page.getByTestId("eq-slider").first();
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await slider.focus();
    await slider.press("ArrowUp");
    await slider.press("ArrowUp");
    await expect(slider).toHaveAttribute("aria-valuenow", "2");
    await slider.press("ArrowDown");
    await expect(slider).toHaveAttribute("aria-valuenow", "1");
  });
});

test.describe("Presets", () => {
  test("should apply a preset and update track volumes", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("preset-forest").click();
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Applied preset: Forest")).toBeVisible({ timeout: 5000 });
  });

  test("all preset buttons should be visible in header", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByTestId("preset-forest")).toBeVisible();
    await expect(page.getByTestId("preset-ocean")).toBeVisible();
    await expect(page.getByTestId("preset-space")).toBeVisible();
    await expect(page.getByTestId("preset-café")).toBeVisible();
  });

  // NEW: Ocean, Space, Café presets apply (Test 11)
  const presetNames = ["ocean", "space", "café"];
  for (const name of presetNames) {
    test(`should apply ${name} preset and log it`, async ({ page }) => {
      await setupAllMocks(page);
      await page.goto("/", { waitUntil: "networkidle" });
      const track1 = page.getByTestId("track-1");
      await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
      await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
      await page.getByTestId(`preset-${name}`).click();
      await page.getByTestId("console-tab").click();
      const expected = name === "café" ? "Café" : name.charAt(0).toUpperCase() + name.slice(1);
      await expect(page.getByText(`Applied preset: ${expected}`)).toBeVisible({ timeout: 5000 });
    });
  }
});

test.describe("Log Console", () => {
  test("should display log entries when a track is loaded", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Loaded: dummy-1sec.wav")).toBeVisible({ timeout: 5000 });
  });

  test("clear button should remove all log entries", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Loaded: dummy-1sec.wav")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("clear-logs").click();
    await expect(page.getByTestId("console-empty-state")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Header Status", () => {
  test("should show PLAYING when backend is online and audio is playing", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("transport-play-stop").click();
    await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING", { timeout: 5000 });
  });

  test("should show OFFLINE when backend is unreachable", async ({ page }) => {
    await setupAllMocks(page);
    await page.unroute(`${API_BASE}/health`);
    await page.route(`${API_BASE}/health`, (route: Route) =>
      route.abort("connectionrefused"),
    );
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByTestId("status-indicator")).toHaveText("OFFLINE", { timeout: 15000 });
  });

  test("should show IDLE when backend is online but nothing is playing", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", { timeout: 10000 });
  });

  // NEW: Header shows EXPORTING during render (Test 10)
  test("should show EXPORTING when a render job is in progress", async ({ page }) => {
    await setupAllMocks(page, { scenario: "always-processing" });
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("export-tab").click();
    await page.getByTestId("export-wav").click();
    await expect(page.getByTestId("status-indicator")).toHaveText("EXPORTING", { timeout: 10000 });
  });
});
