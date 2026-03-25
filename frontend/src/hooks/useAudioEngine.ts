// Web Audio API hook for live playback
import { useCallback, useEffect, useRef, useState } from "react";
import { Track, EQ_BANDS } from "@/types";

interface AudioEngineState {
  isInitialized: boolean;
  isPlaying: boolean;
  currentTime: number;
  analyserData: Uint8Array;
}

export function useAudioEngine(tracks: Track[], masterGain: number, eqGains: number[]) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const eqNodesRef = useRef<BiquadFilterNode[]>([]);
  const sourcesRef = useRef<Map<string, AudioBufferSourceNode[]>>(new Map());
  const trackGainsRef = useRef<Map<string, GainNode>>(new Map());
  const trackPannersRef = useRef<Map<string, StereoPannerNode>>(new Map());
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);
  
  const [state, setState] = useState<AudioEngineState>({
    isInitialized: false,
    isPlaying: false,
    currentTime: 0,
    analyserData: new Uint8Array(128),
  });

  // Initialize audio context
  const initAudio = useCallback(async () => {
    if (audioContextRef.current) return;
    
    const ctx = new AudioContext();
    audioContextRef.current = ctx;
    
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
    
    setState(s => ({ ...s, isInitialized: true }));
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

  // Update track gain and pan
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

  // Play
  const play = useCallback(async () => {
    if (!audioContextRef.current) {
      await initAudio();
    }
    
    const ctx = audioContextRef.current!;
    
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    
    // Stop any existing playback
    sourcesRef.current.forEach(sources => {
      sources.forEach(s => {
        try { s.stop(); } catch {}
      });
    });
    sourcesRef.current.clear();
    
    startTimeRef.current = ctx.currentTime;
    
    // Check for solo tracks
    const hasSolo = tracks.some(t => t.solo && t.loaded);
    
    // Start each loaded track
    tracks.forEach(track => {
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
          if (state.isPlaying && audioContextRef.current) {
            scheduleNextBuffer(nextStartTime, 0);
          }
        };
      };
      
      // Start with random offset for phase diversity
      const randomOffset = Math.random() * track.buffer.duration;
      scheduleNextBuffer(0, randomOffset);
      
      sourcesRef.current.set(track.id, sources);
    });
    
    setState(s => ({ ...s, isPlaying: true, currentTime: 0 }));
    
    // Start time update loop
    const updateTime = () => {
      if (audioContextRef.current && state.isPlaying) {
        const elapsed = audioContextRef.current.currentTime - startTimeRef.current;
        setState(s => ({ ...s, currentTime: elapsed }));
      }
      animationFrameRef.current = requestAnimationFrame(updateTime);
    };
    updateTime();
    
  }, [tracks, initAudio, state.isPlaying]);

  // Stop
  const stop = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    sourcesRef.current.forEach(sources => {
      sources.forEach(s => {
        try { s.stop(); } catch {}
      });
    });
    sourcesRef.current.clear();
    
    setState(s => ({ ...s, isPlaying: false, currentTime: 0 }));
  }, []);

  // Get analyser data for VU meter
  const getAnalyserData = useCallback(() => {
    if (!analyserRef.current) return new Uint8Array(128);
    
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    return data;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      sourcesRef.current.forEach(sources => {
        sources.forEach(s => {
          try { s.stop(); } catch {}
        });
      });
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  return {
    ...state,
    initAudio,
    play,
    stop,
    updateTrackGain,
    updateTrackPan,
    getAnalyserData,
  };
}
