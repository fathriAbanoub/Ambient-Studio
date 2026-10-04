// Client-side audio renderer using OfflineAudioContext
// Renders a mix of audio tracks with volume, pan, and EQ

import { Track, EQ_BANDS } from "@/types";

export async function renderAudioMix(
  durationSeconds: number,
  tracks: Track[],
  masterGainValue: number,
  eqGains: number[],
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const sampleRate = 44100;
  const totalSamples = Math.ceil(sampleRate * durationSeconds);
  
  // Create offline context with stereo output
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
  
  // Create EQ chain
  const eqNodes: BiquadFilterNode[] = EQ_BANDS.map((band, i) => {
    const filter = offlineCtx.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.freq;
    filter.gain.value = eqGains[i];
    if (band.type === "peaking") {
      filter.Q.value = 1.0;
    }
    return filter;
  });
  
  // Chain EQ nodes
  let lastNode: AudioNode = offlineCtx.destination;
  for (let i = eqNodes.length - 1; i >= 0; i--) {
    eqNodes[i].connect(lastNode);
    lastNode = eqNodes[i];
  }
  
  // Create master gain
  const masterGain = offlineCtx.createGain();
  masterGain.gain.value = masterGainValue;
  masterGain.connect(lastNode);
  
  // Check for solo tracks
  const hasSolo = tracks.some(t => t.solo && t.loaded);
  
  // Process each track
  tracks.forEach((track, index) => {
    if (!track.buffer || !track.loaded) return;
    
    // Skip muted tracks or non-solo tracks when solo is active
    if (track.muted || (hasSolo && !track.solo)) return;
    
    const gain = track.volume / 100;
    const pan = track.pan / 100;
    
    // Calculate how many loops we need
    const loopCount = Math.ceil(durationSeconds / track.buffer.duration);
    
    for (let loop = 0; loop < loopCount; loop++) {
      const source = offlineCtx.createBufferSource();
      source.buffer = track.buffer;
      
      // Random start offset for phase diversity
      const randomOffset = Math.random() * track.buffer.duration;
      const startTime = loop * track.buffer.duration - randomOffset;
      
      // Track gain
      const trackGain = offlineCtx.createGain();
      trackGain.gain.value = gain;
      
      // Stereo panner
      const panner = offlineCtx.createStereoPanner();
      panner.pan.value = pan;
      
      source.connect(trackGain);
      trackGain.connect(panner);
      panner.connect(masterGain);
      
      source.start(Math.max(0, startTime));
    }
    
    // Report progress
    if (onProgress) {
      onProgress(Math.round(((index + 1) / tracks.length) * 30));
    }
  });
  
  // Render audio
  const renderedBuffer = await offlineCtx.startRendering();
  
  if (onProgress) {
    onProgress(50);
  }
  
  // Convert to WAV
  const wavBlob = audioBufferToWav(renderedBuffer);
  
  if (onProgress) {
    onProgress(100);
  }
  
  return wavBlob;
}

// Convert AudioBuffer to WAV Blob
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  
  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;
  
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);
  
  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);
  
  // Interleave channels and write samples
  const channelData: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) {
    channelData.push(buffer.getChannelData(i));
  }
  
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }
  
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Utility to decode audio file to AudioBuffer
export async function decodeAudioFile(
  audioContext: AudioContext | OfflineAudioContext,
  file: File
): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  return await audioContext.decodeAudioData(arrayBuffer);
}
