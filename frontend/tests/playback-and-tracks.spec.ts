/**
 * playback-and-tracks.spec.ts – Production‑ready Playwright test suite for Ambient Studio
 * Focus: Track loading, procedural generator, transport, and active playback source.
 */

import { test, expect, FIXTURE_WAV } from "./helpers/base-test";
import { setupAllMocks } from "./helpers/mocks";

// ──────────────────────────────────────────────────────────────────────────────

test.describe("Track Loading", () => {
  test("should load an audio file into track 1 and display filename + waveform", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await expect(track1.getByTestId("drop-zone")).toBeVisible();
    const fileInput = track1.getByTestId("file-input");
    await fileInput.setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toHaveText("dummy-1sec", {
      timeout: 10000,
    });
    await expect(track1.getByTestId("track-duration")).toBeVisible();
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Loaded: dummy-1sec.wav")).toBeVisible({
      timeout: 5000,
    });
  });

  test("volume slider should be visible and functional on loaded track", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    const volumeSlider = track1.getByTestId("volume-slider");
    await expect(volumeSlider).toBeVisible({ timeout: 10000 });
    await expect(track1.getByTestId("volume-value")).toHaveText("100");
  });

  test("pan slider should be visible on loaded track", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("pan-slider")).toBeVisible({
      timeout: 10000,
    });
    await expect(track1.getByTestId("pan-value")).toBeVisible();
  });

  test("mute button should dim the track", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    await expect(track1).not.toHaveClass(/opacity-50/);
    await track1.getByRole("button", { name: /mute/i }).click();
    await expect(track1).toHaveClass(/opacity-50/);
  });

  test("solo button should dim other tracks", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    const track2 = page.getByTestId("track-2");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await track2.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    await expect(track2.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    await track1.getByRole("button", { name: /solo/i }).click();
    await expect(track2).toHaveClass(/opacity-50/);
    await expect(track1).not.toHaveClass(/opacity-50/);
  });

  test("remove button should unload a track", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    await track1.hover();
    await track1.getByTestId("remove-track").click();
    await expect(track1.getByTestId("drop-zone")).toBeVisible();
  });

  // NEW: Track volume slider updates display (Test 3)
  test("changing volume slider updates the displayed value", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    const volumeSlider = track1.getByTestId("volume-slider");
    const volumeDisplay = track1.getByTestId("volume-value");
    await expect(volumeDisplay).toHaveText("100");
    await volumeSlider.fill("75");
    await expect(volumeDisplay).toHaveText("75");
    await volumeSlider.fill("120");
    await expect(volumeDisplay).toHaveText("120");
  });

  // NEW: Track pan slider changes value (Test 12)
  test("changing pan slider updates the displayed value", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    const panSlider = track1.getByTestId("pan-slider");
    const panDisplay = track1.getByTestId("pan-value");
    await expect(panDisplay).toHaveText("0");
    await panSlider.fill("50");
    await expect(panDisplay).toHaveText("+50");
    await panSlider.fill("-75");
    await expect(panDisplay).toHaveText("-75");
  });
});

test.describe("Procedural Generator", () => {
  test("should start and stop the generator, showing scene name", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const playBtn = page.getByTestId("generator-play-stop");
    await expect(playBtn).toBeVisible();
    await playBtn.click();
    await expect(playBtn).toHaveText(/stop/i, { timeout: 10000 });
    await expect(page.getByTestId("current-scene")).toBeVisible({
      timeout: 10000,
    });
    await page.getByTestId("console-tab").click();
    await expect(page.getByText("Procedural generator started")).toBeVisible({
      timeout: 5000,
    });
    await playBtn.click();
    await expect(playBtn).toHaveText(/play/i, { timeout: 5000 });
    await expect(page.getByTestId("current-scene")).not.toBeVisible();
  });

  test("should dim the generator when a manual track has solo active", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    await track1.getByRole("button", { name: /solo/i }).click();
    const procTrack = page.getByTestId("procedural-track");
    await expect(procTrack).toHaveClass(/opacity-50/, { timeout: 5000 });
  });

  // NEW: Generator export WAV with progress (Test 5) – unused variable removed
  test("clicking EXPORT WAV shows progress updates and completes", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const OriginalOfflineCtx = window.OfflineAudioContext;
      window.OfflineAudioContext = class extends OriginalOfflineCtx {
        constructor(
          numberOfChannels: number,
          length: number,
          sampleRate: number,
        ) {
          super(numberOfChannels, length, sampleRate);
        }
        startRendering() {
          // ✅ FIX: Add <AudioBuffer> generic to resolve TypeScript error
          return new Promise<AudioBuffer>((resolve) => {
            setTimeout(() => {
              resolve({
                length: this.length,
                duration: this.length / this.sampleRate,
                sampleRate: this.sampleRate,
                numberOfChannels: 2,
                getChannelData: () => new Float32Array(this.length),
              } as unknown as AudioBuffer);
            }, 500);
          });
        }
      } as any;
      HTMLAnchorElement.prototype.click = () => {};
    });

    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const exportDurationInput = page.getByTestId("generator-export-duration");
    await exportDurationInput.fill("1");
    const exportBtn = page.getByTestId("generator-export-wav");
    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toHaveText(/EXPORT WAV/);
    await exportBtn.click();
    await expect(exportBtn).toHaveText(/\d+%/, { timeout: 5000 });
    await expect(exportBtn).toHaveText(/EXPORT WAV/, { timeout: 5000 });
  });

  // NEW: Generator complexity slider changes value (Test 13)
  test("changing complexity slider updates the displayed percentage", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const complexitySlider = page.getByTestId("generator-complexity");
    const complexityDisplay = page.getByTestId("generator-complexity-value");
    await expect(complexityDisplay).toHaveText("35%");
    await complexitySlider.fill("75");
    await expect(complexityDisplay).toHaveText("75%");
    await complexitySlider.fill("20");
    await expect(complexityDisplay).toHaveText("20%");
  });

  test("changing space slider updates the displayed percentage", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const spaceSlider = page.getByTestId("generator-space");
    const spaceDisplay = page.getByTestId("generator-space-value");
    await expect(spaceDisplay).toHaveText("40%");
    await spaceSlider.fill("80");
    await expect(spaceDisplay).toHaveText("80%");
    await spaceSlider.fill("10");
    await expect(spaceDisplay).toHaveText("10%");
  });
});

test.describe("Active Playback Source", () => {
  test("manual play button sets source to 'manual' and shows glow", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    // ✅ FIX: Wait for backend health check to resolve before interacting.
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", {
      timeout: 10000,
    });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    const playBtn = page.getByTestId("transport-play-stop");
    await playBtn.click();
    await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING", {
      timeout: 5000,
    });
    await expect(playBtn).toHaveClass(
      /shadow-\[0_0_12px_var\(--glow-cyan\)\]/,
      { timeout: 5000 },
    );
  });

  test("generator play sets source to 'generator' and shows glow", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    // ✅ FIX: Wait for backend health check to resolve before interacting.
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", {
      timeout: 10000,
    });
    const genBtn = page.getByTestId("generator-play-stop");
    await genBtn.click();
    await expect(genBtn).toHaveText(/stop/i, { timeout: 10000 });
    await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING");
    const procTrack = page.getByTestId("procedural-track");
    await expect(procTrack).toHaveClass(/shadow-\[/, { timeout: 5000 });
  });

  test("switching from generator to manual should update glow", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    // ✅ FIX: Wait for backend health check to resolve before interacting.
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", {
      timeout: 10000,
    });
    const genBtn = page.getByTestId("generator-play-stop");
    await genBtn.click();
    await expect(genBtn).toHaveText(/stop/i, { timeout: 10000 });
    await genBtn.click();
    await expect(genBtn).toHaveText(/play/i, { timeout: 5000 });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    const transportBtn = page.getByTestId("transport-play-stop");
    await transportBtn.click();
    await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING", {
      timeout: 5000,
    });
    await expect(transportBtn).toHaveClass(
      /shadow-\[0_0_12px_var\(--glow-cyan\)\]/,
      { timeout: 5000 },
    );
    const procTrack = page.getByTestId("procedural-track");
    await expect(procTrack).not.toHaveClass(/shadow-\[0_0_12px/);
  });
});

test.describe("Transport", () => {
  test("master volume slider should be visible and show 100%", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const slider = page.getByTestId("master-volume");
    await expect(slider).toBeVisible();
    await expect(page.getByTestId("master-volume-value")).toHaveText("100%");
  });

  test("timer should display 00:00:00 initially", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByTestId("timer")).toHaveText("00:00:00");
  });

  // NEW: play → stop cycle resets UI state (Test 1)
  test("play → stop cycle should reset UI state", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    // This test already had the guard – keep it.
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", {
      timeout: 10000,
    });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    const playBtn = page.getByTestId("transport-play-stop");
    const status = page.getByTestId("status-indicator");
    await expect(status).toHaveText("IDLE");
    await playBtn.click();
    await expect(status).toHaveText("PLAYING", { timeout: 5000 });
    await playBtn.click();
    await expect(status).toHaveText("IDLE", { timeout: 5000 });
  });

  // NEW: master volume slider updates percentage (Test 4)
  test("master volume slider updates the displayed percentage", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const masterSlider = page.getByTestId("master-volume");
    const masterDisplay = page.getByTestId("master-volume-value");
    await expect(masterDisplay).toHaveText("100%");
    await masterSlider.fill("50");
    await expect(masterDisplay).toHaveText("50%");
    await masterSlider.fill("150");
    await expect(masterDisplay).toHaveText("150%");
  });

  // NEW: Force Stop button appears when playing and stops playback (Test 6)
  test("Force Stop button appears when playing and stops playback", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    // ✅ FIX: Wait for backend health check to resolve before interacting.
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", {
      timeout: 10000,
    });
    const track1 = page.getByTestId("track-1");
    await track1.getByTestId("file-input").setInputFiles(FIXTURE_WAV);
    await expect(track1.getByTestId("track-name")).toBeVisible({
      timeout: 10000,
    });
    const playBtn = page.getByTestId("transport-play-stop");
    await playBtn.click();
    await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING", {
      timeout: 5000,
    });
    const forceStop = page.locator("button.border-\\[var\\(--warning\\)\\]");
    await expect(forceStop).toBeVisible();
    await forceStop.click();
    await expect(page.getByTestId("status-indicator")).toHaveText("IDLE", {
      timeout: 5000,
    });
    await expect(forceStop).not.toBeVisible();
  });
});

test.describe("Advanced Generator Parameters", () => {
  test("should expand advanced panel and show controls", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    await expect(page.getByTestId("generator-seed")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("generator-scenes-toggle")).toBeVisible();
    await expect(page.getByTestId("generator-tempo")).toBeVisible();
    await expect(page.getByTestId("generator-complexity")).toBeVisible();
    await expect(page.getByTestId("generator-space")).toBeVisible();
    await expect(page.getByTestId("generator-scene-duration")).toBeVisible();
    await expect(page.getByTestId("generator-scale")).toBeVisible();
    await expect(page.getByTestId("generator-beatless-toggle")).toBeVisible();
    await expect(page.getByTestId("generator-drum-style")).toBeVisible();
    await expect(page.getByTestId("generator-swing")).toBeVisible();
    await expect(page.getByTestId("generator-sidechain")).toBeVisible();
    await expect(page.getByTestId("generator-drone-add")).toBeVisible();
    await expect(page.getByTestId("generator-sample-upload-btn")).toBeVisible();
  });

  test("should change seed value", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const seedInput = page.getByTestId("generator-seed");
    await seedInput.fill("12345");
    await expect(seedInput).toHaveValue("12345");
  });

  test("should change tempo slider", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const tempoSlider = page.getByTestId("generator-tempo");
    await expect(tempoSlider).toBeVisible();
    await expect(tempoSlider).toHaveValue("72");
    await tempoSlider.focus();
    await tempoSlider.press("ArrowRight");
    await tempoSlider.press("ArrowRight");
    await tempoSlider.press("ArrowRight");
    await expect(tempoSlider).not.toHaveValue("72");
  });

  test("should toggle scenes switch", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const scenesSwitch = page.getByTestId("generator-scenes-toggle");
    await expect(scenesSwitch).toBeVisible();
    await expect(scenesSwitch).toHaveAttribute("aria-checked", "true");
    await scenesSwitch.click();
    await expect(scenesSwitch).toHaveAttribute("aria-checked", "false");
  });

  test("should change scene duration dropdown", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const sceneSelect = page.getByTestId("generator-scene-duration");
    await expect(sceneSelect).toBeVisible();
    await expect(sceneSelect).toHaveValue("32");
    await sceneSelect.selectOption("64");
    await expect(sceneSelect).toHaveValue("64");
  });

  test("EXPORT WAV button in advanced panel should be visible", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    await expect(page.getByTestId("generator-export-wav")).toBeVisible({
      timeout: 5000,
    });
  });

  test("should change scale selection", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const scaleSelect = page.getByTestId("generator-scale");
    await expect(scaleSelect).toBeVisible();
    await expect(scaleSelect).toHaveValue("majorPent");
    await scaleSelect.selectOption("dorian");
    await expect(scaleSelect).toHaveValue("dorian");
  });

  test("should toggle beatless mode and dim drum controls", async ({
    page,
  }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const beatless = page.getByTestId("generator-beatless-toggle");
    await expect(beatless).toHaveAttribute("aria-checked", "false");
    await beatless.click();
    await expect(beatless).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("generator-drum-style")).toBeDisabled();
    await expect(page.getByTestId("generator-swing")).toBeDisabled();
    await expect(page.getByTestId("generator-sidechain")).toBeDisabled();
  });

  test("should adjust swing and sidechain sliders", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const swing = page.getByTestId("generator-swing");
    const sidechain = page.getByTestId("generator-sidechain");
    await expect(swing).toHaveValue("0");
    await expect(sidechain).toHaveValue("0");
    await swing.focus();
    await swing.press("ArrowRight");
    await swing.press("ArrowRight");
    await expect(swing).not.toHaveValue("0");
    await sidechain.focus();
    for (let i = 0; i < 10; i++) await sidechain.press("ArrowRight");
    await expect(sidechain).not.toHaveValue("0");
    await expect(page.getByTestId("generator-sidechain-value")).not.toHaveText(
      "0%",
    );
  });

  test("should switch drum style", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    const drumStyle = page.getByTestId("generator-drum-style");
    await expect(drumStyle).toHaveValue("euclideanTrap");
    await drumStyle.selectOption("fourFloor");
    await expect(drumStyle).toHaveValue("fourFloor");
  });

  test("should add and remove a drone layer", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    await page.getByTestId("generator-drone-add").click();
    await expect(page.getByTestId("generator-drone-layer-0")).toBeVisible();
    await expect(page.getByTestId("generator-drone-hz-0")).toHaveValue("55");
    await page.getByTestId("generator-drone-timbre-0").selectOption("triangle");
    await expect(page.getByTestId("generator-drone-timbre-0")).toHaveValue(
      "triangle",
    );
    await page.getByTestId("generator-drone-remove-0").click();
    await expect(page.getByTestId("generator-drone-layer-0")).not.toBeVisible();
  });

  test("should upload a sample bank entry", async ({ page }) => {
    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();
    await page
      .getByTestId("generator-sample-upload")
      .setInputFiles(FIXTURE_WAV);
    await expect(page.getByTestId("generator-sample-bank-list")).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.getByTestId("generator-sample-bank-list").getByText(/dummy-1sec/),
    ).toBeVisible();
  });

  test("mid-playback drone removal silences layers and sample add decodes", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      type Probe = {
        oscillatorStops: number;
        decodeCalls: number;
      };
      const probe: Probe = { oscillatorStops: 0, decodeCalls: 0 };
      (
        window as unknown as { __ambientAudioProbe: Probe }
      ).__ambientAudioProbe = probe;

      const origOscStop = OscillatorNode.prototype.stop;
      OscillatorNode.prototype.stop = function (
        this: OscillatorNode,
        ...args: Parameters<typeof origOscStop>
      ) {
        probe.oscillatorStops += 1;
        return origOscStop.apply(this, args);
      };

      const origDecode = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = async function (
        this: AudioContext,
        ...args: Parameters<typeof origDecode>
      ) {
        probe.decodeCalls += 1;
        return origDecode.apply(this, args);
      };
    });

    await setupAllMocks(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("generator-expand").click();

    // Distinct hz values so A2 stable-id identity is also covered.
    await page.getByTestId("generator-drone-add").click();
    await page.getByTestId("generator-drone-add").click();
    await page.getByTestId("generator-drone-add").click();
    await page.getByTestId("generator-drone-hz-0").fill("110");
    await page.getByTestId("generator-drone-hz-1").fill("220");
    await page.getByTestId("generator-drone-hz-2").fill("330");

    await page.getByTestId("generator-beatless-toggle").click();
    await page.getByTestId("generator-play-stop").click();
    await expect(page.getByTestId("generator-play-stop")).toHaveText(/stop/i, {
      timeout: 10000,
    });

    // ✅ FIX: Wait for the engine to be fully running (status indicator) instead of a fixed delay.
    await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING", {
      timeout: 5000,
    });

    const stopsBeforeRemove = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ambientAudioProbe: { oscillatorStops: number };
          }
        ).__ambientAudioProbe.oscillatorStops,
    );

    await page.getByTestId("generator-drone-remove-1").click();
    await expect(page.getByTestId("generator-drone-hz-0")).toHaveValue("110");
    await expect(page.getByTestId("generator-drone-hz-1")).toHaveValue("330");
    await expect(page.getByTestId("generator-drone-layer-2")).not.toBeVisible();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __ambientAudioProbe: { oscillatorStops: number };
                }
              ).__ambientAudioProbe.oscillatorStops,
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(stopsBeforeRemove);

    const decodeBeforeUpload = await page.evaluate(
      () =>
        (window as unknown as { __ambientAudioProbe: { decodeCalls: number } })
          .__ambientAudioProbe.decodeCalls,
    );
    await page
      .getByTestId("generator-sample-upload")
      .setInputFiles(FIXTURE_WAV);
    await expect(page.getByTestId("generator-sample-bank-list")).toBeVisible({
      timeout: 5000,
    });
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __ambientAudioProbe: { decodeCalls: number };
                }
              ).__ambientAudioProbe.decodeCalls,
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(decodeBeforeUpload);

    await expect(page.getByTestId("generator-play-stop")).toHaveText(/stop/i);
  });
});
