import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:3002",
    launchOptions: {
      args: [
        // The round-trip spec starts the live engine in headless Chromium;
        // without this the AudioContext stays suspended and start() bails.
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3002",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
