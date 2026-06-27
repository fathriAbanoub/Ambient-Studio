/**
 * base-test.ts – Custom Playwright test fixture for Ambient Studio
 *
 * Provides:
 *   - test, expect – re-exported from @playwright/test
 *   - FIXTURE_WAV – path to the test audio fixture
 *   - beforeEach hook that mocks Web Audio decodeAudioData
 *   - A pre‑flight file check to prevent cryptic “ZIP 0‑byte file” errors
 *
 * This ensures a single source of truth for test setup across all spec files.
 */

import { test as base, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

// ──────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ──────────────────────────────────────────────────────────────────────────────

// NOTE: If your project uses ESM ("type": "module"), __dirname is not defined.
// Replace the line below with:
//   import { fileURLToPath } from 'url';
//   const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_WAV = path.join(
  __dirname,
  "..",
  "fixtures",
  "dummy-1sec.wav",
);

// ✅ SAFETY CHECK: Prevent cryptic Playwright ZIP errors if the file is 0 bytes
// Playwright cannot ZIP a 0‑byte file to send to the browser.
if (!fs.existsSync(FIXTURE_WAV) || fs.statSync(FIXTURE_WAV).size === 0) {
  throw new Error(
    `\n\n❌ CRITICAL: Fixture file is missing or 0 bytes: ${FIXTURE_WAV}\n` +
      `Playwright cannot ZIP a 0‑byte file to send to the browser.\n` +
      `Run this command to fix it:\n` +
      `head -c 44144 /dev/urandom > ${FIXTURE_WAV}\n\n`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Custom test fixture
// ──────────────────────────────────────────────────────────────────────────────

// Extend the base test with shared setup (add custom fixtures here later)
export const test = base.extend({});

// ✅ Mock the Web Audio API decoding so tests don't fail
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

export { expect };
