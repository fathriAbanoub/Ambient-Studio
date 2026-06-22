/**
 * base-test.ts – Custom Playwright test fixture for Ambient Studio
 *
 * Provides:
 *   - test, expect – re-exported from @playwright/test
 *   - FIXTURE_WAV – path to the test audio fixture
 *   - beforeEach hook that mocks Web Audio decodeAudioData
 *
 * This ensures a single source of truth for test setup across all spec files.
 */

import { test as base, expect, Page } from "@playwright/test";
import path from "path";

// ──────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ──────────────────────────────────────────────────────────────────────────────

// NOTE: If your project uses ESM ("type": "module"), __dirname is not defined.
// Replace the line below with:
//   import { fileURLToPath } from 'url';
//   const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_WAV = path.join(__dirname, "..", "fixtures", "dummy-1sec.wav");

// ──────────────────────────────────────────────────────────────────────────────
// Custom test fixture
// ──────────────────────────────────────────────────────────────────────────────

// Extend the base test with shared setup
export const test = base.extend({});

// ✅ FIX: Mock the Web Audio API decoding so tests don't fail
// if the dummy-1sec.wav file is empty, corrupted, or missing.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    AudioContext.prototype.decodeAudioData = async function () {
      // Return a fake AudioBuffer that satisfies the component's requirements
      return {
        duration: 1.0,
        length: 44100,
        numberOfChannels: 1,
        sampleRate: 44100,
        getChannelData: () => new Float32Array(44100),
      } as unknown as AudioBuffer;
    };
  });
});

// Re-export expect so spec files can import from here
export { expect };
