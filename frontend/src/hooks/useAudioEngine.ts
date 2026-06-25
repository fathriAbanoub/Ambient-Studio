// Web Audio API hook for live playback
import { useCallback, useEffect, useRef, useState } from "react";
import { Track, EQ_BANDS } from "@/types";
import {
  getSharedAudioContext,
  resumeSharedAudioContext,
} from "@/lib/audioContext";

interface AudioEngineState {
  isInitialized: boolean;
  isPlaying: boolean;
}

export function useAudioEngine(
  tracks: Track[],
  masterGain: number,
  eqGains: number[],
) {
  const masterGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const eqNodesRef = useRef<BiquadFilterNode[]>([]);
  const sourcesRef = useRef<Map<string, AudioBufferSourceNode[]>>(new Map());
  const trackGainsRef = useRef<Map<string, GainNode>>(new Map());
  const trackPannersRef = useRef<Map<string, StereoPannerNode>>(new Map());
  const startTimeRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);

  // ✅ ADD THIS: Track mount status to prevent post-unmount async mutations
  const mountedRef = useRef(false);

  const [state, setState] = useState<AudioEngineState>({
    isInitialized: false,
    isPlaying: false,
  });

  // Initialize audio context (shared singleton) – called once
  const initAudio = useCallback(async () => {
    const ctx = getSharedAudioContext();
    await resumeSharedAudioContext();

    // ✅ GUARD: Abort if the component unmounted during the await
    if (!mountedRef.current) return;

    if (analyserRef.current) return; // already initialized

    // Create analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    analyserRef.current = analyser;

    // Create EQ chain
    const eqNodes = EQ_BANDS.map((band, i) => {
      const filter = ctx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.freq;
      filter.gain.value = eqGains[i];
      if (band.type === "peaking") {
        filter.Q.value = 1.0;
      }
      return filter;
    });
    eqNodesRef.current = eqNodes;

    // Chain: EQ[0] -> EQ[1] -> ... -> analyser -> destination
    let lastNode: AudioNode = analyser;
    for (let i = eqNodes.length - 1; i >= 0; i--) {
      eqNodes[i].connect(lastNode);
      lastNode = eqNodes[i];
    }

    // Create master gain
    const masterGainNode = ctx.createGain();
    masterGainNode.gain.value = masterGain;
    masterGainRef.current = masterGainNode;
    masterGainNode.connect(lastNode);

    analyser.connect(ctx.destination);

    setState((s) => ({ ...s, isInitialized: true }));
  }, [eqGains, masterGain]);

  // Update master gain
  useEffect(() => {
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = masterGain;
    }
  }, [masterGain]);

  // Update EQ
  useEffect(() => {
    eqNodesRef.current.forEach((node, i) => {
      node.gain.value = eqGains[i];
    });
  }, [eqGains]);

  // Update track gain and pan (called from external UI)
  const updateTrackGain = useCallback((trackId: string, volume: number) => {
    const gainNode = trackGainsRef.current.get(trackId);
    if (gainNode) {
      gainNode.gain.value = volume / 100;
    }
  }, []);

  const updateTrackPan = useCallback((trackId: string, pan: number) => {
    const panner = trackPannersRef.current.get(trackId);
    if (panner) {
      panner.pan.value = pan / 100;
    }
  }, []);

  // ✅ FIX: Moved `stop` above `play` to prevent Temporal Dead Zone (TDZ) error.
  // `play` and `playLoopSeam` reference `stop` in their dependency arrays,
  // so `stop` must be initialized first to avoid a ReferenceError during render.
  const stop = useCallback(() => {
    isPlayingRef.current = false;

    sourcesRef.current.forEach((sources) => {
      sources.forEach((s) => {
        try {
          s.onended = null;
          s.stop();
          s.disconnect();
        } catch {}
      });
    });
    sourcesRef.current.clear();

    // Disconnect and clear track gain/panner nodes
    trackGainsRef.current.forEach((node) => node.disconnect());
    trackGainsRef.current.clear();
    trackPannersRef.current.forEach((node) => node.disconnect());
    trackPannersRef.current.clear();

    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  // Play
  const play = useCallback(async () => {
    // ✅ GUARD: Don't start playback if unmounted
    if (!mountedRef.current) return;

    // Ensure graph is initialized before playing
    if (!analyserRef.current) await initAudio();

    // ✅ GUARD: initAudio might have aborted due to unmount
    if (!mountedRef.current) return;

    const ctx = getSharedAudioContext();
    await resumeSharedAudioContext();

    // ✅ GUARD: Check again after the second await
    if (!mountedRef.current) return;

    // Stop and fully clean up any existing playback
    stop();

    startTimeRef.current = ctx.currentTime;
    isPlayingRef.current = true;

    // Check for solo tracks
    const hasSolo = tracks.some((t) => t.solo && t.loaded);

    // Start each loaded track
    tracks.forEach((track) => {
      if (!track.buffer || !track.loaded) return;
      if (track.muted || (hasSolo && !track.solo)) return;

      const sources: AudioBufferSourceNode[] = [];
      const trackGain = ctx.createGain();
      trackGain.gain.value = track.volume / 100;
      trackGainsRef.current.set(track.id, trackGain);

      const panner = ctx.createStereoPanner();
      panner.pan.value = track.pan / 100;
      trackPannersRef.current.set(track.id, panner);

      trackGain.connect(panner);
      panner.connect(masterGainRef.current!);

      // Loop the track continuously
      const scheduleNextBuffer = (startTime: number, offset: number = 0) => {
        const source = ctx.createBufferSource();
        source.buffer = track.buffer;
        source.connect(trackGain);

        const actualStart = Math.max(0, startTime);
        const remainingDuration = track.buffer!.duration - offset;

        source.start(actualStart, offset, remainingDuration);
        sources.push(source);

        // Schedule next loop
        const nextStartTime = actualStart + remainingDuration;
        source.onended = () => {
          if (isPlayingRef.current) {
            scheduleNextBuffer(nextStartTime, 0);
          }
        };
      };

      // Start with random offset for phase diversity
      const randomOffset = Math.random() * track.buffer.duration;
      scheduleNextBuffer(0, randomOffset);

      sourcesRef.current.set(track.id, sources);
    });

    setState((s) => ({ ...s, isPlaying: true }));
  }, [tracks, initAudio, stop]);

  // Play Loop Seam Preview
  const playLoopSeam = useCallback(
    async (loopStartMs: number, loopEndMs: number, crossfadeMs: number) => {
      // ✅ GUARD: Don't start playback if unmounted
      if (!mountedRef.current) return;

      // Ensure graph is initialized
      if (!analyserRef.current) await initAudio();

      // ✅ GUARD: initAudio might have aborted due to unmount
      if (!mountedRef.current) return;

      const ctx = getSharedAudioContext();
      await resumeSharedAudioContext();

      // ✅ GUARD: Check again after the second await
      if (!mountedRef.current) return;

      // Stop any existing playback
      stop();

      const loopStart = loopStartMs / 1000;
      const loopEnd = loopEndMs / 1000;
      const crossfade = crossfadeMs / 1000;

      startTimeRef.current = ctx.currentTime;
      isPlayingRef.current = true;

      const hasSolo = tracks.some((t) => t.solo && t.loaded);

      tracks.forEach((track) => {
        if (!track.buffer || !track.loaded) return;
        if (track.muted || (hasSolo && !track.solo)) return;

        const trackGain = ctx.createGain();
        trackGain.gain.value = track.volume / 100;
        trackGainsRef.current.set(track.id, trackGain);

        const panner = ctx.createStereoPanner();
        panner.pan.value = track.pan / 100;
        trackPannersRef.current.set(track.id, panner);

        trackGain.connect(panner);
        panner.connect(masterGainRef.current!);

        // Tail (ending at loopEnd)
        const tailSource = ctx.createBufferSource();
        tailSource.buffer = track.buffer;
        const tailGain = ctx.createGain();
        tailSource.connect(tailGain);
        tailGain.connect(trackGain);

        // Head (starting at loopStart)
        const headSource = ctx.createBufferSource();
        headSource.buffer = track.buffer;
        const headGain = ctx.createGain();
        headSource.connect(headGain);
        headGain.connect(trackGain);

        const now = ctx.currentTime;
        const preRoll = 2.0;
        const tailStartOffset = Math.max(0, loopEnd - crossfade - preRoll);
        const tailDuration = crossfade + preRoll;

        tailSource.start(now, tailStartOffset, tailDuration);

        const postRoll = 2.0;
        const headStartOffset = loopStart;
        const headDuration = crossfade + postRoll;

        // Tail fades out
        tailGain.gain.setValueAtTime(1.0, now + preRoll);
        tailGain.gain.linearRampToValueAtTime(0.0, now + preRoll + crossfade);

        // Head fades in
        headGain.gain.setValueAtTime(0.0, now + preRoll);
        headSource.start(now + preRoll, headStartOffset, headDuration);
        headGain.gain.linearRampToValueAtTime(1.0, now + preRoll + crossfade);

        const sources = sourcesRef.current.get(track.id) || [];
        sources.push(tailSource, headSource);
        sourcesRef.current.set(track.id, sources);
      });

      setState((s) => ({ ...s, isPlaying: true }));
    },
    [tracks, initAudio, stop],
  );

  // Get analyser data for VU meter
  const getAnalyserData = useCallback(() => {
    if (!analyserRef.current) return new Uint8Array(128);

    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    return data;
  }, []);

  // Cleanup on unmount – stop sources and disconnect, but do NOT close the shared context
  useEffect(() => {
    mountedRef.current = true; // Mark as mounted

    return () => {
      mountedRef.current = false; // Mark as unmounted IMMEDIATELY

      isPlayingRef.current = false;
      sourcesRef.current.forEach((sources) => {
        sources.forEach((s) => {
          try {
            s.onended = null;
            s.stop();
            s.disconnect();
          } catch {}
        });
      });
      sourcesRef.current.clear();
      trackGainsRef.current.forEach((node) => node.disconnect());
      trackGainsRef.current.clear();
      trackPannersRef.current.forEach((node) => node.disconnect());
      trackPannersRef.current.clear();
      eqNodesRef.current.forEach((node) => {
        try {
          node.disconnect();
        } catch {}
      });
      eqNodesRef.current = [];
      if (masterGainRef.current) {
        try {
          masterGainRef.current.disconnect();
        } catch {}
        masterGainRef.current = null;
      }
      if (analyserRef.current) {
        try {
          analyserRef.current.disconnect();
        } catch {}
        analyserRef.current = null;
      }
      // Do not close the AudioContext – it's shared
    };
  }, []);

  return {
    ...state,
    initAudio,
    play,
    playLoopSeam,
    stop,
    updateTrackGain,
    updateTrackPan,
    getAnalyserData,
  };
}
