import { describe, expect, it } from "vitest";
import { getDecodedSampleBuffer } from "./sampleBank";

describe("sample bank helpers", () => {
  it("skips an undecoded sample", () => {
    expect(getDecodedSampleBuffer(new Map(), "anything")).toBeUndefined();
  });
});
