import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeSampleBank,
  decodeNewSampleBankEntries,
  getDecodedSampleBuffer,
} from "./sampleBank";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sample bank helpers", () => {
  it("skips an undecoded sample", () => {
    expect(getDecodedSampleBuffer(new Map(), "anything")).toBeUndefined();
  });

  it("decodes only the first playable entry for a duplicate ID", async () => {
    const buffer = {} as AudioBuffer;
    const decodeAudioData = vi.fn().mockResolvedValue(buffer);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
    });
    vi.stubGlobal("fetch", fetchMock);

    const buffers = await decodeSampleBank(
      { decodeAudioData } as unknown as BaseAudioContext,
      [
        { id: "same", url: "/first.wav" },
        { id: "same", url: "/second.wav" },
      ],
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/first.wav",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(buffers.get("same")).toBe(buffer);
  });

  it("aborts and skips a stalled sample fetch after 15 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const pending = decodeSampleBank(
      { decodeAudioData: vi.fn() } as unknown as BaseAudioContext,
      [{ id: "stalled", url: "/stalled.wav" }],
    );
    await vi.advanceTimersByTimeAsync(15000);

    await expect(pending).resolves.toEqual(new Map());
    expect(warn).toHaveBeenCalledOnce();
  });

  it("decodeNewSampleBankEntries only fetches ids missing from the map", async () => {
    const existingBuffer = { label: "existing" } as unknown as AudioBuffer;
    const newBuffer = { label: "new" } as unknown as AudioBuffer;
    const into = new Map<string, AudioBuffer>([["keep", existingBuffer]]);
    const decodeAudioData = vi
      .fn()
      .mockResolvedValueOnce(newBuffer);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
    });
    vi.stubGlobal("fetch", fetchMock);

    await decodeNewSampleBankEntries(
      { decodeAudioData } as unknown as BaseAudioContext,
      [
        { id: "keep", url: "/keep.wav" },
        { id: "fresh", url: "/fresh.wav" },
      ],
      into,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/fresh.wav",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(into.get("keep")).toBe(existingBuffer);
    expect(into.get("fresh")).toBe(newBuffer);
  });
});
