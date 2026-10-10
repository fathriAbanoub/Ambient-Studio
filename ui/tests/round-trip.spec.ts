// round-trip.spec.ts — proves the newly exposed controls reach the LIVE
// engine, not just the DOM: set values through real inputs, press PLAY, then
// assert the running LiveEngine instance carries those exact parameters.
import { expect, test } from "@playwright/test";

test("new parameter controls round-trip into the running engine", async ({ page }) => {
  await page.goto("/");

  // open the advanced panel
  await page.getByTestId("generator-expand").click();

  // root frequency
  const rootHz = page.getByTestId("generator-root-hz");
  await expect(rootHz).toHaveValue("220");
  await rootHz.fill("196");

  // harmonic loop toggle
  await page.getByTestId("generator-harmonic-loop-toggle").click(); // on → off

  // drone layer with detune + sweep
  await page.getByTestId("generator-drone-add").click();
  await page.getByTestId("generator-drone-detune-0").fill("-7");
  await page.getByTestId("generator-drone-sweep-0").fill("3.5");
  await page.getByTestId("generator-drone-hz-0").fill("110");

  // sample upload (fixture WAV) + gain/pan edits
  await page
    .getByTestId("generator-sample-upload")
    .setInputFiles("tests/fixtures/dummy-1sec.wav");
  await expect(page.getByTestId("generator-sample-gain-0")).toBeVisible();
  await page.getByTestId("generator-sample-gain-0").fill("1.25");
  await page.getByTestId("generator-sample-pan-0").fill("-40");

  // start the live engine
  await page.getByTestId("generator-play-stop").click();
  await expect(page.getByTestId("status-indicator")).toHaveText("PLAYING", {
    timeout: 15_000,
  });

  // the engine instance the hook started must carry every control value
  const params = await page.evaluate(() => {
    const engine = (window as {
      __ambientEngine?: { params: Record<string, unknown> };
    }).__ambientEngine;
    if (!engine) throw new Error("no engine started");
    return JSON.parse(JSON.stringify(engine.params));
  });

  expect(params.rootHz).toBe(196);
  expect(params.enableHarmonicLoop).toBe(false);
  expect(params.bpm).toBe(72); // untouched control keeps its default
  const layers = params.drone as { layers: Record<string, unknown>[] };
  expect(layers.layers[0]).toMatchObject({ hz: 110, detuneCents: -7, sweepSec: 3.5 });
  const bank = params.sampleBank as Record<string, unknown>[];
  expect(bank[0]).toMatchObject({ gain: 1.25, pan: -0.4 });
});
