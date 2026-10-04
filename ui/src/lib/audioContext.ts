// lib/audioContext.ts
let sharedContext: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (typeof window === "undefined") {
    throw new Error("AudioContext is only available in the browser.");
  }

  if (!sharedContext) {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio API is not supported in this browser.");
    }
    sharedContext = new AudioContextClass();
  }
  return sharedContext;
}

export async function resumeSharedAudioContext(): Promise<void> {
  const ctx = getSharedAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}
