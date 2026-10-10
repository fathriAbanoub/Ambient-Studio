"use strict";
(() => {
  // ../work/ambient-studio/Ambient-Studio-main/frontend/src/lib/ambient-engine/musicalLogic.ts
  var SCALE_INTERVALS = {
    majorPent: [0, 2, 4, 7, 9],
    minorPent: [0, 3, 5, 7, 10],
    ionian: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10]
  };
  var MAX_DRONE_LAYERS = 8;
  var DRONE_FADE_SEC = 1;
  var BEATS_PER_BAR = 4;
  var BAR_LENGTH = 8;
  var BASS_HITS = 3;
  var CADENCE_INTERVAL = 16;
  var PHRASE_LENGTH = 32;
  var DRUM_GHOST_PROBABILITY = 0.25;
  var DRUM_SNARE_AMP = 0.45;
  var DRUM_KICK_AMP = 0.6;
  var DRUM_HAT_AMP = 0.25;
  var DRUM_HAT_CLOSED_PROB = 0.85;
  var SAMPLE_TRIGGER_PROBABILITY = 0.35;
  var SAMPLE_MIN_GAP_BEATS = 8;
  var SAMPLE_JITTER_BEATS = 9;
  var SAMPLE_DEFAULT_GAIN = 0.25;
  var NOISE_BUFFER_SAMPLES = 22050;
  var ROOT_LOOP_HZ = [220, 185, 147, 165];
  var SCENE_PACKS = {
    default: [
      {
        name: "Calm",
        scale: "majorPent",
        bpm: 72,
        mix: 0.4,
        complexity: 0.3,
        density: 0.8,
        timbre: "sine"
      },
      {
        name: "Nocturne",
        scale: "minorPent",
        bpm: 62,
        mix: 0.55,
        complexity: 0.45,
        density: 0.65,
        timbre: "triangle"
      },
      {
        name: "Ether",
        scale: "majorPent",
        bpm: 68,
        mix: 0.65,
        complexity: 0.55,
        density: 0.55,
        timbre: "fm"
      }
    ]
  };
  var SCENES = SCENE_PACKS.default;
  function getScenePackScenes(params) {
    return SCENE_PACKS[params?.scenePack ?? "default"] ?? SCENE_PACKS.default;
  }
  function mulberry32Next(state) {
    let t = state.rngState += 1831565813;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  function computeSceneProgress(barCount, sceneStartBeat, sceneDurationBars) {
    const sceneStartBar = Math.floor(sceneStartBeat / BEATS_PER_BAR);
    return Math.min((barCount - sceneStartBar) / sceneDurationBars, 1);
  }
  function currentScale(scale) {
    return SCALE_INTERVALS[scale];
  }
  function noteHz(degree, octaveShift, rootHz, scale) {
    const intervals = currentScale(scale);
    const semi = intervals[(degree % intervals.length + intervals.length) % intervals.length] + 12 * octaveShift;
    return rootHz * Math.pow(2, semi / 12);
  }
  function wrapDegree(degree, scaleLength) {
    return (degree % scaleLength + scaleLength) % scaleLength;
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function droneEvents(params, beat, beatSec) {
    const layers = params.drone?.layers ?? [];
    return layers.slice(0, MAX_DRONE_LAYERS).flatMap((layer, index) => {
      if (!Number.isFinite(layer.hz) || layer.hz <= 0 || !Number.isFinite(layer.amp) || layer.amp <= 0) {
        return [];
      }
      const detuneCents = layer.detuneCents;
      const sweepSec = layer.sweepSec;
      return [
        {
          type: "drone",
          hz: layer.hz,
          amp: clamp(layer.amp, 0, 1),
          durationSec: beatSec,
          pan: Number.isFinite(layer.pan) ? clamp(layer.pan, -1, 1) : 0,
          timbre: layer.timbre,
          droneLayerIndex: index,
          detuneCents: detuneCents !== void 0 && Number.isFinite(detuneCents) ? detuneCents : void 0,
          sweepSec: sweepSec !== void 0 && Number.isFinite(sweepSec) && sweepSec > 0 ? sweepSec : void 0,
          beatIndex: beat,
          subBeatIndex: 0
        }
      ];
    });
  }
  function playableSampleEntries(sampleBank) {
    const ids = /* @__PURE__ */ new Set();
    return (sampleBank ?? []).filter((entry) => {
      if (typeof entry?.id !== "string" || entry.id.length === 0 || typeof entry.url !== "string" || entry.url.length === 0 || entry.gain !== void 0 && (!Number.isFinite(entry.gain) || entry.gain <= 0) || ids.has(entry.id)) {
        return false;
      }
      ids.add(entry.id);
      return true;
    });
  }
  function maybeSampleEvent(state, params, beat, rng) {
    const samples = playableSampleEntries(params.sampleBank);
    if (samples.length === 0 || state.beat < state.nextSampleBeat) return [];
    const events = [];
    if (rng() < SAMPLE_TRIGGER_PROBABILITY) {
      const sample = samples[Math.floor(rng() * samples.length)];
      events.push({
        type: "sample",
        sampleId: sample.id,
        amp: clamp(sample.gain ?? SAMPLE_DEFAULT_GAIN, 0, 1),
        durationSec: 0,
        pan: sample.pan !== void 0 && Number.isFinite(sample.pan) ? clamp(sample.pan, -1, 1) : 0,
        beatIndex: beat,
        subBeatIndex: 0
      });
    }
    state.nextSampleBeat = state.beat + SAMPLE_MIN_GAP_BEATS + Math.floor(rng() * SAMPLE_JITTER_BEATS);
    return events;
  }
  function euclideanRhythm(step, pulses, steps) {
    return step * pulses % steps < pulses;
  }
  function markovStep(lastInterval, complexity, rng) {
    const intervals = [-2, -1, 0, 1, 2];
    const baseWeights = [
      [0.1, 0.25, 0.4, 0.2, 0.05],
      [0.05, 0.25, 0.45, 0.2, 0.05],
      [0.1, 0.2, 0.4, 0.2, 0.1],
      [0.05, 0.2, 0.45, 0.25, 0.05],
      [0.05, 0.2, 0.4, 0.25, 0.1]
    ];
    const lastIdx = intervals.indexOf(lastInterval);
    const row = lastIdx >= 0 ? baseWeights[lastIdx] : baseWeights[2];
    const uniform = 0.2;
    const weights = row.map((w) => w * (1 - complexity) + uniform * complexity);
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = rng() * sum;
    let idx = 0;
    for (; idx < weights.length - 1 && (r -= weights[idx]) > 0; idx++) ;
    return intervals[idx];
  }
  function updateSceneEngine(state, params) {
    if (params.enableScenes === false) return { params, state: {} };
    const barCount = Math.floor(state.beat / BEATS_PER_BAR);
    const sceneDurationBars = params.sceneDurationBars ?? 32;
    const scenes = getScenePackScenes(params);
    let newSceneIndex = state.currentSceneIndex % scenes.length;
    let newSceneStartBeat = state.sceneStartBeat;
    const sceneStartBar = Math.floor(state.sceneStartBeat / BEATS_PER_BAR);
    if (barCount - sceneStartBar >= sceneDurationBars) {
      newSceneIndex = (newSceneIndex + 1) % scenes.length;
      newSceneStartBeat = state.beat;
    }
    const currentScene = scenes[newSceneIndex];
    const nextScene = scenes[(newSceneIndex + 1) % scenes.length];
    const progress = computeSceneProgress(
      barCount,
      newSceneStartBeat,
      sceneDurationBars
    );
    const t = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const newParams = { ...params };
    newParams.bpm = currentScene.bpm + (nextScene.bpm - currentScene.bpm) * t;
    newParams.mix = currentScene.mix + (nextScene.mix - currentScene.mix) * t;
    newParams.complexity = currentScene.complexity + (nextScene.complexity - currentScene.complexity) * t;
    const newDensity = currentScene.density + (nextScene.density - currentScene.density) * t;
    newParams.scale = progress < 0.5 ? currentScene.scale : nextScene.scale;
    const newTimbre = progress < 0.5 ? currentScene.timbre : nextScene.timbre;
    return {
      params: newParams,
      state: {
        currentSceneIndex: newSceneIndex,
        sceneStartBeat: newSceneStartBeat,
        currentDensity: newDensity,
        currentTimbre: newTimbre
      }
    };
  }
  function updateHarmonicLoop(state, params) {
    if (params.enableHarmonicLoop === false) {
      return {
        targetRootHz: params.rootHz,
        currentRootHz: params.rootHz
      };
    }
    const barCount = Math.floor(state.beat / BEATS_PER_BAR);
    if (state.beat > 0 && barCount % 8 === 0 && state.beat % BEATS_PER_BAR === 0) {
      const newLoopIndex = (state.harmonicLoopIndex + 1) % ROOT_LOOP_HZ.length;
      const newTarget = ROOT_LOOP_HZ[newLoopIndex];
      if (newTarget !== state.targetRootHz) {
        return {
          harmonicLoopIndex: newLoopIndex,
          targetRootHz: newTarget
          // currentRootHz intentionally NOT updated here — synthesis shell slews to it
        };
      }
    }
    return {};
  }
  function getMusicalEvents(beat, state, params) {
    const s = { ...state };
    const events = [];
    const rng = () => mulberry32Next(s);
    const sceneResult = updateSceneEngine(s, params);
    const effectiveParams = sceneResult.params;
    Object.assign(s, sceneResult.state);
    const harmonicUpdates = updateHarmonicLoop(s, effectiveParams);
    Object.assign(s, harmonicUpdates);
    s.panDriftPhase += 0.01;
    const beatSec = 60 / effectiveParams.bpm;
    const currentRootHz = s.currentRootHz;
    const currentScaleName = effectiveParams.scale;
    const scaleLength = currentScale(currentScaleName).length;
    const currentTimbre = s.currentTimbre;
    const currentDensity = s.currentDensity;
    const drumLevel = effectiveParams.drumLevel ?? 0.5;
    const drumStyle = effectiveParams.drumStyle ?? "euclideanTrap";
    if (effectiveParams.enableBeats === false) {
      events.push(...maybeSampleEvent(s, effectiveParams, beat, rng));
      if (!s.droneLayersStarted) {
        events.push(...droneEvents(effectiveParams, beat, beatSec));
        s.droneLayersStarted = true;
      }
      s.sixteenthCount += 4;
      s.beat++;
      return { events, nextState: s };
    }
    s.droneLayersStarted = false;
    events.push(...droneEvents(effectiveParams, beat, beatSec));
    for (let i = 0; i < 4; i++) {
      const sixteenthStep = s.sixteenthCount + i;
      const shouldKick = drumStyle === "fourFloor" ? i === 0 : euclideanRhythm(sixteenthStep % 16, 5, 16);
      if (drumLevel > 0 && shouldKick) {
        events.push({
          type: "kick",
          amp: DRUM_KICK_AMP * drumLevel,
          durationSec: 0.3,
          pan: 0,
          beatIndex: beat,
          subBeatIndex: i
          // FIX C1
        });
      }
      if (drumLevel > 0) {
        const beatStep = sixteenthStep % 16;
        if (beatStep === 4 || beatStep === 12) {
          events.push({
            type: "snare",
            amp: DRUM_SNARE_AMP * drumLevel,
            durationSec: 0.12,
            pan: 0,
            beatIndex: beat,
            subBeatIndex: i,
            // FIX C1
            isGhost: false
          });
        } else if (euclideanRhythm(sixteenthStep % 16, 2, 16) && rng() < DRUM_GHOST_PROBABILITY) {
          events.push({
            type: "snare",
            amp: DRUM_SNARE_AMP * 0.3 * drumLevel,
            durationSec: 0.06,
            pan: 0,
            beatIndex: beat,
            subBeatIndex: i,
            // FIX C1
            isGhost: true
          });
        }
      }
      if (drumLevel > 0 && euclideanRhythm(sixteenthStep % 16, 9, 16)) {
        const isClosed = rng() < DRUM_HAT_CLOSED_PROB;
        events.push({
          type: "hihat",
          amp: (isClosed ? DRUM_HAT_AMP : DRUM_HAT_AMP * 0.7) * drumLevel,
          durationSec: isClosed ? 0.03 : 0.08,
          pan: 0,
          beatIndex: beat,
          subBeatIndex: i,
          // FIX C1
          isClosed
        });
      }
    }
    s.sixteenthCount += 4;
    const sectionOffsets = [0, -3, -1, 2];
    const barIndex = Math.floor(s.beat / BEATS_PER_BAR);
    const sectionOffset = sectionOffsets[barIndex % sectionOffsets.length];
    const isCadence = s.beat % CADENCE_INTERVAL === CADENCE_INTERVAL - 1;
    if (isCadence) {
      s.degree = rng() < 0.6 ? 0 : 2;
      s.lastInterval = 0;
    } else {
      const interval = markovStep(
        s.lastInterval,
        effectiveParams.complexity,
        rng
      );
      s.lastInterval = interval;
      s.degree = wrapDegree(s.degree + interval, scaleLength);
    }
    if (rng() < currentDensity) {
      const isPhraseEnd = s.beat % PHRASE_LENGTH === PHRASE_LENGTH - 1;
      const octaveShift = isPhraseEnd && rng() < 0.3 ? 2 : 1;
      const fMel = noteHz(s.degree, octaveShift, currentRootHz, currentScaleName);
      events.push({
        type: "melody",
        hz: fMel,
        amp: 0.22,
        durationSec: beatSec * 0.85,
        pan: 0,
        timbre: currentTimbre,
        beatIndex: beat,
        subBeatIndex: 0
      });
    }
    const padDegree = wrapDegree(s.degree + 2 + sectionOffset, scaleLength);
    const fPad = noteHz(padDegree, 2, currentRootHz, currentScaleName);
    events.push({
      type: "pad",
      hz: fPad * 0.995,
      amp: 0.12,
      durationSec: beatSec * 1,
      pan: -1,
      // signals "left pad" → use padPanL node and ADSR_PAD_L
      timbre: currentTimbre,
      beatIndex: beat,
      subBeatIndex: 0
    });
    events.push({
      type: "pad",
      hz: fPad * 1.005,
      amp: 0.12,
      durationSec: beatSec * 1,
      pan: 1,
      // signals "right pad" → use padPanR node and ADSR_PAD_R
      timbre: currentTimbre,
      beatIndex: beat,
      subBeatIndex: 0
    });
    const beatInBar = s.beat % BAR_LENGTH;
    if (euclideanRhythm(beatInBar, BASS_HITS, BAR_LENGTH)) {
      const bassDegree = wrapDegree(s.degree + sectionOffset, scaleLength);
      const fBass = noteHz(bassDegree, -1, currentRootHz, currentScaleName) / 2;
      events.push({
        type: "bass",
        hz: fBass,
        amp: 0.18,
        durationSec: beatSec * 0.7,
        pan: 0,
        timbre: "sine",
        beatIndex: beat,
        subBeatIndex: 0
      });
    }
    if (s.beat >= s.nextBellBeat) {
      const bellOctave = 2 + Math.floor(rng() * 2);
      const bellDegree = Math.floor(rng() * scaleLength);
      const fBell = noteHz(
        bellDegree,
        bellOctave,
        currentRootHz,
        currentScaleName
      );
      events.push({
        type: "bell",
        hz: fBell,
        amp: 0.15,
        durationSec: beatSec * 0.3,
        pan: 0,
        // A3: bell routing is by type === "bell" in both shells; pan is unused for bells (bellPan node receives its own drift automation)
        timbre: currentTimbre,
        beatIndex: beat,
        subBeatIndex: 0
      });
      s.nextBellBeat = s.beat + Math.floor(rng() * 9) + 8;
    }
    events.push(...maybeSampleEvent(s, effectiveParams, beat, rng));
    s.beat++;
    return { events, nextState: s };
  }
  function createInitialState(params) {
    const seed = params.seed ?? Math.floor(Math.random() * 1e6);
    const scenes = getScenePackScenes(params);
    return {
      beat: 0,
      degree: 0,
      lastInterval: 0,
      currentSceneIndex: 0,
      sceneStartBeat: 0,
      harmonicLoopIndex: 0,
      currentRootHz: params.rootHz,
      targetRootHz: params.rootHz,
      rngState: seed,
      panDriftPhase: 0,
      sixteenthCount: 0,
      nextBellBeat: 0,
      nextSampleBeat: 0,
      currentDensity: scenes[0].density,
      currentTimbre: scenes[0].timbre,
      // ✅ ADD (beatless drone latch): start with the latch cleared so the
      // first beatless beat emits drone events. LiveEngine.start() and the
      // renderAmbient startState clone both reset this to false as well.
      droneLayersStarted: false
    };
  }
  function initializeBell(state) {
    const s = { ...state };
    s.nextBellBeat = Math.floor(mulberry32Next(s) * 8) + 8;
    return s;
  }
  function initializeSampleLane(state, params) {
    const s = { ...state };
    if (playableSampleEntries(params.sampleBank).length === 0) return s;
    s.nextSampleBeat = Math.floor(mulberry32Next(s) * 8) + 8;
    return s;
  }
  function getEffectiveSceneParams(state, params) {
    if (params.enableScenes === false) {
      return {
        bpm: params.bpm,
        mix: params.mix,
        scale: params.scale,
        complexity: params.complexity
      };
    }
    const sceneDurationBars = params.sceneDurationBars ?? 32;
    const scenes = getScenePackScenes(params);
    const barCount = Math.floor(state.beat / BEATS_PER_BAR);
    let sceneIndex = state.currentSceneIndex % scenes.length;
    let sceneStartBar = Math.floor(state.sceneStartBeat / BEATS_PER_BAR);
    if (barCount - sceneStartBar >= sceneDurationBars) {
      sceneIndex = (sceneIndex + 1) % scenes.length;
      sceneStartBar = barCount;
    }
    const currentScene = scenes[sceneIndex];
    const nextScene = scenes[(sceneIndex + 1) % scenes.length];
    const progress = computeSceneProgress(
      barCount,
      sceneStartBar * BEATS_PER_BAR,
      sceneDurationBars
    );
    const t = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    return {
      bpm: currentScene.bpm + (nextScene.bpm - currentScene.bpm) * t,
      mix: currentScene.mix + (nextScene.mix - currentScene.mix) * t,
      scale: progress < 0.5 ? currentScene.scale : nextScene.scale,
      complexity: currentScene.complexity + (nextScene.complexity - currentScene.complexity) * t
    };
  }

  // ../work/ambient-studio/Ambient-Studio-main/frontend/src/lib/ambient-engine/sampleBank.ts
  var SAMPLE_FETCH_TIMEOUT_MS = 15e3;
  async function decodeSampleBank(ctx, sampleBank) {
    const buffers = /* @__PURE__ */ new Map();
    const entries = playableSampleEntries(sampleBank);
    if (!entries.length) return buffers;
    await Promise.all(
      entries.map(async (entry) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          SAMPLE_FETCH_TIMEOUT_MS
        );
        try {
          const response = await fetch(entry.url, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.arrayBuffer();
          const buffer = await ctx.decodeAudioData(data.slice(0));
          buffers.set(entry.id, buffer);
        } catch (error) {
          console.warn(`[ambient-engine] sample decode failed: ${entry.id}`, error);
        } finally {
          clearTimeout(timeoutId);
        }
      })
    );
    return buffers;
  }
  function getDecodedSampleBuffer(buffers, sampleId) {
    if (!sampleId) return void 0;
    return buffers.get(sampleId);
  }
  function scheduleSamplePlayback(ctx, buffer, amp, pan, t0, destination, fadeSec) {
    const source = ctx.createBufferSource();
    const g = ctx.createGain();
    const panNode = ctx.createStereoPanner();
    const clampedFade = Math.min(fadeSec, buffer.duration / 2);
    source.buffer = buffer;
    panNode.pan.setValueAtTime(pan, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + clampedFade);
    g.gain.setValueAtTime(
      amp,
      Math.max(t0 + clampedFade, t0 + buffer.duration - clampedFade)
    );
    g.gain.linearRampToValueAtTime(1e-4, t0 + buffer.duration);
    source.connect(g);
    g.connect(panNode);
    panNode.connect(destination);
    source.start(t0);
    source.stop(t0 + buffer.duration + 0.05);
    return source;
  }

  // ../work/ambient-studio/Ambient-Studio-main/frontend/src/lib/ambient-engine/scheduling.ts
  var MAX_SWING = 0.6;
  var SIDECHAIN_MAX_DUCK_DB = 5;
  var SIDECHAIN_ATTACK_SEC = 0.01;
  var SIDECHAIN_RELEASE_SEC = 0.18;
  var TONAL_BUS_GAIN = 0.3;
  var PAN_DRIFT_TIME_CONSTANT_SEC = 0.1;
  var ADSR_MELODY = { a: 0.02, d: 0.2, s: 0.55, r: 0.25 };
  var ADSR_PAD_L = { a: 0.5, d: 0.8, s: 0.7, r: 0.8 };
  var ADSR_PAD_R = { a: 0.6, d: 0.8, s: 0.7, r: 0.9 };
  var ADSR_BASS = { a: 5e-3, d: 0.15, s: 0.25, r: 0.2 };
  var ADSR_BELL = { a: 0.01, d: 0.1, s: 0.2, r: 0.15 };
  function resolveToneEnvelope(type, pan) {
    switch (type) {
      case "melody":
        return { env: ADSR_MELODY, vibratoAmount: 1.5 };
      case "pad":
        return { env: pan < 0 ? ADSR_PAD_L : ADSR_PAD_R };
      case "bass":
        return { env: ADSR_BASS };
      case "bell":
        return { env: ADSR_BELL };
      default:
        return { env: ADSR_PAD_L };
    }
  }
  function clamp2(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function getSwingOffsetSec(subBeatIndex, sixteenthSec, swing) {
    if (subBeatIndex % 2 === 0) return 0;
    const amount = Number.isFinite(swing) ? clamp2(swing ?? 0, 0, MAX_SWING) : 0;
    return amount * sixteenthSec;
  }
  function getSubBeatEventTime(beatTime, subBeatIndex, sixteenthSec, swing) {
    return beatTime + subBeatIndex * sixteenthSec + getSwingOffsetSec(subBeatIndex, sixteenthSec, swing);
  }
  function getSidechainDuckShape(kickTime, sidechainAmount) {
    const amount = Number.isFinite(sidechainAmount) ? clamp2(sidechainAmount ?? 0, 0, 1) : 0;
    if (amount <= 0) return null;
    return {
      duckGainMultiplier: Math.pow(10, -SIDECHAIN_MAX_DUCK_DB * amount / 20),
      attackTime: kickTime + SIDECHAIN_ATTACK_SEC,
      releaseTime: kickTime + SIDECHAIN_RELEASE_SEC
    };
  }
  function cancelAndHold(param, t, fallbackValue) {
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(fallbackValue ?? param.value, t);
    }
  }
  function evaluateExponentialApproach(fromValue, toValue, startTime, timeConstant, now) {
    if (timeConstant <= 0) return toValue;
    const t = Math.max(0, now - startTime);
    return toValue + (fromValue - toValue) * Math.exp(-t / timeConstant);
  }
  function evaluateDroneEnvelope(curve, now) {
    const {
      fromValue,
      toValue,
      startTime,
      timeConstant,
      sustainTime,
      sustainValue,
      releaseEndTime,
      releaseTarget
    } = curve;
    if (sustainTime === null) {
      if (now >= releaseEndTime) return releaseTarget;
      const span = releaseEndTime - startTime;
      if (span <= 0) return releaseTarget;
      const progress2 = Math.max(0, (now - startTime) / span);
      return fromValue + (releaseTarget - fromValue) * progress2;
    }
    if (now < sustainTime) {
      return evaluateExponentialApproach(
        fromValue,
        toValue,
        startTime,
        timeConstant,
        now
      );
    }
    if (now >= releaseEndTime) {
      return releaseTarget;
    }
    const releaseSpan = releaseEndTime - sustainTime;
    if (releaseSpan <= 0) return releaseTarget;
    const progress = (now - sustainTime) / releaseSpan;
    return sustainValue + (releaseTarget - sustainValue) * progress;
  }
  (function testSchedulingHelpers() {
    if (false) return;
    const assert = (condition, message) => {
      if (!condition) throw new Error(`[ambient-engine] ${message}`);
    };
    const approx = (a, b) => Math.abs(a - b) < 1e-12;
    assert(
      getSubBeatEventTime(10, 1, 0.125, 0) === 10.125,
      "swing=0 changed odd sub-beat timing"
    );
    assert(
      getSubBeatEventTime(10, 1, 0.125, 0.5) === 10.1875,
      "swing failed to offset odd sub-beat timing"
    );
    assert(
      getSubBeatEventTime(10, 2, 0.125, 0.5) === 10.25,
      "swing offset an even sub-beat"
    );
    const duck = getSidechainDuckShape(2, 1);
    assert(duck !== null, "sidechain amount 1 produced no duck shape");
    assert(
      approx(duck.duckGainMultiplier, Math.pow(10, -SIDECHAIN_MAX_DUCK_DB / 20)),
      "sidechain duck depth check failed"
    );
    assert(
      approx(duck.attackTime, 2.01),
      "sidechain attack timing check failed"
    );
    assert(
      approx(duck.releaseTime, 2.18),
      "sidechain release timing check failed"
    );
    assert(
      getSidechainDuckShape(2, 0) === null,
      "sidechain amount 0 should leave output unchanged"
    );
    assert(
      evaluateExponentialApproach(0, 1, 0, 1, 0) === 0,
      "exp approach at start"
    );
    const mid = evaluateExponentialApproach(0, 1, 0, 1, 1);
    assert(mid > 0 && mid < 1, "exp approach mid");
    assert(
      Math.abs(evaluateExponentialApproach(0, 1, 0, 1, 100) - 1) < 1e-6,
      "exp approach asymptote"
    );
    assert(
      evaluateExponentialApproach(0, 1, 0, 0, 5) === 1,
      "exp approach zero tc guard"
    );
    const sustainCurve = {
      fromValue: 0.1,
      toValue: 0.5,
      startTime: 0,
      timeConstant: 1 / 3,
      sustainTime: 2,
      sustainValue: 0.5,
      releaseEndTime: 3,
      releaseTarget: 1e-4
    };
    const beforeSustain = evaluateDroneEnvelope(sustainCurve, 1);
    const expectedExp = 0.5 + (0.1 - 0.5) * Math.exp(-1 / (1 / 3));
    assert(
      Math.abs(beforeSustain - expectedExp) < 1e-9,
      "drone envelope before sustain should match exponential approach"
    );
    const atSustain = evaluateDroneEnvelope(sustainCurve, 2);
    assert(
      Math.abs(atSustain - 0.5) < 1e-9,
      "drone envelope at sustain should equal sustain value"
    );
    const midRelease = evaluateDroneEnvelope(sustainCurve, 2.5);
    assert(
      midRelease > 1e-4 && midRelease < 0.5,
      "drone envelope mid-release should be between sustain and release target"
    );
    assert(
      Math.abs(midRelease - 0.25005) < 1e-9,
      "drone envelope mid-release should be the linear midpoint"
    );
    const atStop = evaluateDroneEnvelope(sustainCurve, 3);
    assert(
      Math.abs(atStop - 1e-4) < 1e-12,
      "drone envelope at stop should equal release target"
    );
    const afterStop = evaluateDroneEnvelope(sustainCurve, 4);
    assert(
      Math.abs(afterStop - 1e-4) < 1e-12,
      "drone envelope after stop should equal release target"
    );
    const nullSustainCurve = {
      fromValue: 0.1,
      toValue: 0.5,
      startTime: 0,
      timeConstant: 1 / 3,
      sustainTime: null,
      sustainValue: 0.5,
      releaseEndTime: 3,
      releaseTarget: 1e-4
    };
    const nullSustain = evaluateDroneEnvelope(nullSustainCurve, 2.5);
    const expectedLinear = 0.1 + (1e-4 - 0.1) * (2.5 / 3);
    assert(
      Math.abs(nullSustain - expectedLinear) < 1e-9,
      "drone envelope with null sustain should follow the replacing linear ramp"
    );
    const nullSustainAtEnd = evaluateDroneEnvelope(nullSustainCurve, 3);
    assert(
      Math.abs(nullSustainAtEnd - 1e-4) < 1e-12,
      "drone envelope with null sustain should reach release target at stopTime"
    );
    const seamCurve = {
      fromValue: 0.1,
      toValue: 0.5,
      startTime: 0,
      timeConstant: 1 / 3,
      sustainTime: 1,
      // 3 time constants after startTime — the worst case.
      sustainValue: evaluateExponentialApproach(0.1, 0.5, 0, 1 / 3, 1),
      releaseEndTime: 2,
      releaseTarget: 1e-4
    };
    assert(
      approx(evaluateDroneEnvelope(seamCurve, 1), seamCurve.sustainValue),
      "drone envelope at the sustain seam should equal the approach value"
    );
    const seamProbeOffsetSec = 1e-9;
    const seamEpsilon = 1e-8;
    assert(
      Math.abs(
        evaluateDroneEnvelope(seamCurve, 1 + seamProbeOffsetSec) - seamCurve.sustainValue
      ) < seamEpsilon,
      "drone envelope just after the sustain seam should not step"
    );
  })();

  // ../work/ambient-studio/Ambient-Studio-main/frontend/src/lib/ambient-engine/renderAmbient.ts
  var FM_MOD_RATIO = 1.5;
  var FM_INDEX = 1.8;
  var SAMPLE_FADE_SEC = 0.01;
  var DRONE_PAN_TIME_CONSTANT_SEC = 0.25;
  var DRONE_FILTER_CUTOFF_HZ = 3600;
  var DRONE_PARAMETER_TIME_CONSTANT_SEC = 0.5;
  var DRONE_FADE_TARGET_DIVISOR = 3;
  var DRONE_FILTER_LFO_DEPTH_HZ = 800;
  var DRONE_TAIL_SEC = 0.05;
  var DRONE_RELEASE_SILENCE_GAIN = 1e-4;
  async function renderAmbient(params, durationSeconds, startState, onProgress) {
    const effectiveParams = { ...params };
    const SAMPLE_RATE = 44100;
    const effectiveBpm = effectiveParams.bpm || 72;
    const PRE_ROLL_SECONDS = 4 * (60 / effectiveBpm) * 4;
    const totalSecondsEstimate = (PRE_ROLL_SECONDS + durationSeconds) * 1.1;
    const totalSamples = Math.ceil(SAMPLE_RATE * totalSecondsEstimate);
    onProgress?.({ phase: "preparing", percent: 5 });
    const offlineCtx = new OfflineAudioContext(2, totalSamples, SAMPLE_RATE);
    const sampleBuffers = await decodeSampleBank(
      offlineCtx,
      effectiveParams.sampleBank
    );
    const gain = offlineCtx.createGain();
    const delay = offlineCtx.createDelay(2);
    const fb = offlineCtx.createGain();
    const filter = offlineCtx.createBiquadFilter();
    const out = offlineCtx.createGain();
    gain.gain.value = TONAL_BUS_GAIN;
    delay.delayTime.value = 0.3 + 0.4 * (effectiveParams.mix || 0.4);
    fb.gain.value = 0.2 + 0.5 * (effectiveParams.mix || 0.4);
    filter.type = "lowpass";
    filter.frequency.value = 5e3 + (effectiveParams.mix || 0.4) * 4e3;
    filter.Q.value = 1;
    gain.connect(filter);
    filter.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(out);
    filter.connect(out);
    out.connect(offlineCtx.destination);
    const drumBus = offlineCtx.createGain();
    const drumCompressor = offlineCtx.createDynamicsCompressor();
    drumCompressor.threshold.value = -20;
    drumCompressor.ratio.value = 3;
    drumCompressor.attack.value = 3e-3;
    drumCompressor.release.value = 0.25;
    drumBus.connect(drumCompressor);
    drumCompressor.connect(out);
    const padPanL = offlineCtx.createStereoPanner();
    const padPanR = offlineCtx.createStereoPanner();
    const bellPan = offlineCtx.createStereoPanner();
    padPanL.pan.value = 0;
    padPanR.pan.value = 0;
    bellPan.pan.value = 0;
    padPanL.connect(gain);
    padPanR.connect(gain);
    bellPan.connect(gain);
    const dronePans = [];
    const droneGains = [];
    const droneFilters = [];
    const droneOscs = [];
    const droneModOscs = [];
    const droneCurves = [];
    const scheduledDroneLayers = /* @__PURE__ */ new Set();
    for (let i = 0; i < MAX_DRONE_LAYERS; i++) {
      const pan = offlineCtx.createStereoPanner();
      const g = offlineCtx.createGain();
      const droneFilter = offlineCtx.createBiquadFilter();
      pan.pan.value = 0;
      g.gain.value = 0;
      droneFilter.type = "lowpass";
      droneFilter.frequency.value = 3600;
      droneFilter.Q.value = 0.7;
      droneFilter.connect(g);
      g.connect(pan);
      pan.connect(gain);
      dronePans.push(pan);
      droneGains.push(g);
      droneFilters.push(droneFilter);
      droneOscs.push(null);
      droneModOscs.push(null);
      droneCurves.push(null);
    }
    onProgress?.({ phase: "scheduling", percent: 10 });
    let state;
    let noiseBuffer;
    if (startState) {
      state = { ...startState, droneLayersStarted: false };
      noiseBuffer = createNoiseBufferFromSnapshot(
        offlineCtx,
        createInitialState(effectiveParams).rngState
      );
    } else {
      state = createInitialState(effectiveParams);
      noiseBuffer = createNoiseBufferFromState(offlineCtx, state);
      state = initializeBell(state);
      state = initializeSampleLane(state, effectiveParams);
    }
    let slewStartHz = null;
    let slewEndHz = null;
    let slewStartTime = null;
    let slewEndTime = null;
    const SLEW_DURATION = 0.6;
    if (startState && state.currentRootHz !== state.targetRootHz) {
      slewStartHz = state.currentRootHz;
      slewEndHz = state.targetRootHz;
      slewStartTime = 0;
      slewEndTime = SLEW_DURATION;
    }
    let currentTime = 0;
    const targetEndTime = PRE_ROLL_SECONDS + durationSeconds;
    const minBpm = Math.min(
      effectiveBpm,
      ...getScenePackScenes(effectiveParams).map((s) => s.bpm)
    );
    const maxBeats = Math.ceil(totalSecondsEstimate * (minBpm / 60)) + 100;
    let beatIndex = 0;
    const sidechainTracker = {
      attackStartT: 0,
      attackStartV: TONAL_BUS_GAIN,
      attackEndT: 0,
      attackEndV: TONAL_BUS_GAIN,
      releaseEndT: 0,
      releaseEndV: TONAL_BUS_GAIN
    };
    const droneGraph = {
      pans: dronePans,
      gains: droneGains,
      filters: droneFilters,
      oscs: droneOscs,
      modOscs: droneModOscs,
      curves: droneCurves,
      scheduledLayers: scheduledDroneLayers
    };
    const synthGraph = {
      mainGain: gain,
      drumBus,
      noiseBuffer,
      sampleBuffers,
      padPanL,
      padPanR,
      bellPan,
      droneGraph,
      droneStopTime: targetEndTime
    };
    while (currentTime < targetEndTime && beatIndex < maxBeats) {
      const slewedRootHz = getSlewedHz(
        currentTime,
        state.currentRootHz,
        slewStartHz,
        slewEndHz,
        slewStartTime,
        slewEndTime,
        SLEW_DURATION
      );
      state = { ...state, currentRootHz: slewedRootHz };
      const prevTargetRootHz = state.targetRootHz;
      const preBeatParams = getEffectiveSceneParams(state, effectiveParams);
      const beatSec = 60 / preBeatParams.bpm;
      effectiveParams.bpm = preBeatParams.bpm;
      const sceneMix = preBeatParams.mix;
      const sixteenthSec = beatSec / 4;
      const { events, nextState } = getMusicalEvents(
        state.beat,
        { ...state },
        effectiveParams
      );
      state = nextState;
      if (state.targetRootHz !== prevTargetRootHz) {
        slewStartHz = slewedRootHz;
        slewEndHz = state.targetRootHz;
        slewStartTime = currentTime;
        slewEndTime = currentTime + SLEW_DURATION;
      }
      const panValue = Math.sin(state.panDriftPhase) * 0.1;
      padPanL.pan.setTargetAtTime(
        -panValue,
        currentTime,
        PAN_DRIFT_TIME_CONSTANT_SEC
      );
      padPanR.pan.setTargetAtTime(
        panValue,
        currentTime,
        PAN_DRIFT_TIME_CONSTANT_SEC
      );
      bellPan.pan.setTargetAtTime(
        Math.sin(state.panDriftPhase * 1.3) * 0.15,
        currentTime,
        PAN_DRIFT_TIME_CONSTANT_SEC
      );
      delay.delayTime.setTargetAtTime(0.3 + 0.4 * sceneMix, currentTime, 0.1);
      fb.gain.setTargetAtTime(0.2 + 0.5 * sceneMix, currentTime, 0.1);
      filter.frequency.setValueAtTime(5e3 + sceneMix * 4e3, currentTime);
      for (const event of events) {
        const eventTime = getSubBeatEventTime(
          currentTime,
          event.subBeatIndex,
          sixteenthSec,
          effectiveParams.swing
        );
        scheduleEvent(
          offlineCtx,
          event,
          eventTime,
          synthGraph,
          // ✅ ADD (sidechain): pass the sidechain amount so kick events can
          // duck the tonal bus. scheduleEvent forwards it to scheduleSidechain.
          effectiveParams.sidechainAmount,
          sidechainTracker
        );
      }
      currentTime += beatSec;
      beatIndex++;
      if (beatIndex % 64 === 0 && onProgress) {
        const pct = 10 + Math.floor(currentTime / targetEndTime * 35);
        onProgress({ phase: "scheduling", percent: Math.min(44, pct) });
      }
    }
    onProgress?.({ phase: "rendering", percent: 45 });
    const renderedBuffer = await offlineCtx.startRendering();
    onProgress?.({ phase: "encoding", percent: 85 });
    const preRollSamples = Math.ceil(PRE_ROLL_SECONDS * SAMPLE_RATE);
    const outputLength = Math.min(
      Math.ceil(durationSeconds * SAMPLE_RATE),
      renderedBuffer.length - preRollSamples
    );
    const outputBuffer = new AudioBuffer({
      numberOfChannels: 2,
      length: Math.max(1, outputLength),
      sampleRate: SAMPLE_RATE
    });
    for (let ch = 0; ch < 2; ch++) {
      const src = renderedBuffer.getChannelData(ch);
      const dst = outputBuffer.getChannelData(ch);
      for (let i = 0; i < outputLength; i++) dst[i] = src[i + preRollSamples];
    }
    onProgress?.({ phase: "encoding", percent: 100 });
    return outputBuffer;
  }
  function getSlewedHz(now, currentHz, startHz, endHz, startTime, endTime, duration) {
    if (startHz === null || endHz === null || startTime === null || endTime === null) {
      return currentHz;
    }
    if (now >= endTime) return endHz;
    const progress = (now - startTime) / duration;
    return startHz + (endHz - startHz) * progress;
  }
  function createNoiseBufferFromState(ctx, state) {
    const buffer = ctx.createBuffer(1, NOISE_BUFFER_SAMPLES, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < NOISE_BUFFER_SAMPLES; i++) {
      data[i] = mulberry32Next(state) * 2 - 1;
    }
    return buffer;
  }
  function createNoiseBufferFromSnapshot(ctx, seedSnapshot) {
    const buffer = ctx.createBuffer(1, NOISE_BUFFER_SAMPLES, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const localState = { rngState: seedSnapshot };
    for (let i = 0; i < NOISE_BUFFER_SAMPLES; i++) {
      data[i] = mulberry32Next(localState) * 2 - 1;
    }
    return buffer;
  }
  function scheduleEvent(ctx, event, t0, graph, sidechainAmount, sidechainTracker) {
    const {
      mainGain,
      drumBus,
      noiseBuffer,
      sampleBuffers,
      padPanL,
      padPanR,
      bellPan,
      droneGraph,
      droneStopTime
    } = graph;
    switch (event.type) {
      case "kick":
        scheduleKick(ctx, t0, event.amp, drumBus);
        scheduleSidechain(mainGain, t0, sidechainAmount, sidechainTracker);
        break;
      case "snare":
        scheduleSnare(
          ctx,
          t0,
          event.amp,
          event.isGhost ?? false,
          drumBus,
          noiseBuffer
        );
        break;
      case "hihat":
        scheduleHat(
          ctx,
          t0,
          event.amp,
          event.isClosed ?? true,
          drumBus,
          noiseBuffer
        );
        break;
      case "drone":
        scheduleDrone(ctx, event, t0, droneStopTime, droneGraph);
        break;
      case "sample":
        scheduleSample(ctx, event, t0, mainGain, sampleBuffers);
        break;
      case "melody":
      case "pad":
      case "bass":
      case "bell":
        scheduleTonal(ctx, event, t0, mainGain, padPanL, padPanR, bellPan);
        break;
    }
  }
  function scheduleSample(ctx, event, t0, mainGain, sampleBuffers) {
    const buffer = getDecodedSampleBuffer(sampleBuffers, event.sampleId);
    if (!buffer || event.amp <= 0) return;
    scheduleSamplePlayback(
      ctx,
      buffer,
      event.amp,
      event.pan,
      t0,
      mainGain,
      SAMPLE_FADE_SEC
    );
  }
  function evaluateSidechain(tracker, t0) {
    if (t0 < tracker.attackEndT) {
      const span = tracker.attackEndT - tracker.attackStartT;
      if (span <= 0) return tracker.attackEndV;
      const progress = (t0 - tracker.attackStartT) / span;
      return tracker.attackStartV + (tracker.attackEndV - tracker.attackStartV) * progress;
    }
    if (t0 < tracker.releaseEndT) {
      const span = tracker.releaseEndT - tracker.attackEndT;
      if (span <= 0) return tracker.releaseEndV;
      const progress = (t0 - tracker.attackEndT) / span;
      return tracker.attackEndV + (tracker.releaseEndV - tracker.attackEndV) * progress;
    }
    return tracker.releaseEndV;
  }
  function scheduleSidechain(mainGain, t0, sidechainAmount, tracker) {
    const shape = getSidechainDuckShape(t0, sidechainAmount);
    if (!shape) return;
    const param = mainGain.gain;
    const duckValue = TONAL_BUS_GAIN * shape.duckGainMultiplier;
    const anchorValue = evaluateSidechain(tracker, t0);
    cancelAndHold(param, t0, anchorValue);
    param.linearRampToValueAtTime(duckValue, shape.attackTime);
    param.linearRampToValueAtTime(TONAL_BUS_GAIN, shape.releaseTime);
    tracker.attackStartT = t0;
    tracker.attackStartV = anchorValue;
    tracker.attackEndT = shape.attackTime;
    tracker.attackEndV = duckValue;
    tracker.releaseEndT = shape.releaseTime;
    tracker.releaseEndV = TONAL_BUS_GAIN;
  }
  function scheduleDrone(ctx, event, t0, stopTime, droneGraph) {
    if (event.hz === void 0) return;
    const layerIndex = event.droneLayerIndex ?? 0;
    if (layerIndex < 0 || layerIndex >= MAX_DRONE_LAYERS) return;
    const pan = droneGraph.pans[layerIndex];
    const gain = droneGraph.gains[layerIndex];
    const filter = droneGraph.filters[layerIndex];
    const gainParam = gain.gain;
    const curve = droneGraph.curves[layerIndex];
    let fallbackValue = 0;
    if (curve) {
      fallbackValue = evaluateDroneEnvelope(curve, t0);
    }
    cancelAndHold(gainParam, t0, fallbackValue);
    pan.pan.setTargetAtTime(event.pan, t0, DRONE_PAN_TIME_CONSTANT_SEC);
    filter.frequency.setTargetAtTime(
      DRONE_FILTER_CUTOFF_HZ,
      t0,
      DRONE_PARAMETER_TIME_CONSTANT_SEC
    );
    if (!droneGraph.scheduledLayers.has(layerIndex)) {
      const [osc, modOsc] = createOscillator(
        ctx,
        event.hz,
        event.timbre ?? "sine"
      );
      osc.detune.setValueAtTime(event.detuneCents ?? 0, t0);
      osc.connect(filter);
      if (event.sweepSec) {
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 1 / event.sweepSec;
        lfoGain.gain.value = DRONE_FILTER_LFO_DEPTH_HZ;
        lfo.connect(lfoGain).connect(filter.frequency);
        lfo.start(t0);
        lfo.stop(stopTime + DRONE_TAIL_SEC);
      }
      if (modOsc) {
        modOsc.start(t0);
        modOsc.stop(stopTime + DRONE_TAIL_SEC);
        droneGraph.modOscs[layerIndex] = modOsc;
      }
      osc.start(t0);
      osc.stop(stopTime + DRONE_TAIL_SEC);
      droneGraph.oscs[layerIndex] = osc;
      droneGraph.scheduledLayers.add(layerIndex);
    } else {
      const osc = droneGraph.oscs[layerIndex];
      if (osc) {
        osc.frequency.setTargetAtTime(
          event.hz,
          t0,
          DRONE_PARAMETER_TIME_CONSTANT_SEC
        );
        osc.detune.setTargetAtTime(
          event.detuneCents ?? 0,
          t0,
          DRONE_PARAMETER_TIME_CONSTANT_SEC
        );
      }
      const modOsc = droneGraph.modOscs[layerIndex];
      if (modOsc) {
        modOsc.frequency.setTargetAtTime(
          event.hz * FM_MOD_RATIO,
          t0,
          DRONE_PARAMETER_TIME_CONSTANT_SEC
        );
      }
    }
    const timeConstant = DRONE_FADE_SEC / DRONE_FADE_TARGET_DIVISOR;
    gainParam.setTargetAtTime(event.amp, t0, timeConstant);
    const sustainTime = Math.max(t0 + DRONE_FADE_SEC, stopTime - DRONE_FADE_SEC);
    const actualSustainValue = evaluateExponentialApproach(
      fallbackValue,
      event.amp,
      t0,
      timeConstant,
      sustainTime
    );
    if (sustainTime < stopTime) {
      gainParam.setValueAtTime(actualSustainValue, sustainTime);
    }
    gainParam.linearRampToValueAtTime(DRONE_RELEASE_SILENCE_GAIN, stopTime);
    droneGraph.curves[layerIndex] = {
      fromValue: fallbackValue,
      toValue: event.amp,
      startTime: t0,
      timeConstant,
      sustainTime: sustainTime < stopTime ? sustainTime : null,
      sustainValue: actualSustainValue,
      releaseEndTime: stopTime,
      releaseTarget: DRONE_RELEASE_SILENCE_GAIN
    };
  }
  function scheduleTonal(ctx, event, t0, mainGain, padPanL, padPanR, bellPan) {
    const { hz, amp, durationSec, pan, timbre, type } = event;
    if (hz === void 0) return;
    const { env, vibratoAmount } = resolveToneEnvelope(type, pan);
    const [osc, modOsc] = createOscillator(ctx, hz, timbre ?? "sine");
    const g = ctx.createGain();
    let filterNode = null;
    if (timbre === "softsq") {
      filterNode = ctx.createBiquadFilter();
      filterNode.type = "lowpass";
      filterNode.frequency.value = 3200;
      filterNode.Q.value = 0.7;
    }
    if (vibratoAmount) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 4.5;
      lfoGain.gain.value = vibratoAmount;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + durationSec + env.r + 0.05);
    }
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + env.a);
    g.gain.linearRampToValueAtTime(amp * env.s, t0 + env.a + env.d);
    g.gain.setValueAtTime(amp * env.s, t0 + Math.max(env.a + env.d, durationSec));
    g.gain.linearRampToValueAtTime(
      1e-4,
      t0 + Math.max(env.a + env.d, durationSec) + env.r
    );
    if (filterNode) {
      osc.connect(filterNode);
      filterNode.connect(g);
    } else {
      osc.connect(g);
    }
    let destination;
    if (type === "pad" && pan < 0) destination = padPanL;
    else if (type === "pad" && pan > 0) destination = padPanR;
    else if (type === "bell") destination = bellPan;
    else destination = mainGain;
    g.connect(destination);
    const stopTime = t0 + Math.max(env.a + env.d, durationSec) + env.r + 0.05;
    if (modOsc) {
      modOsc.start(t0);
      modOsc.stop(stopTime);
    }
    osc.start(t0);
    osc.stop(stopTime);
  }
  function createOscillator(ctx, freq, timbre) {
    const osc = ctx.createOscillator();
    let modOsc = null;
    switch (timbre) {
      case "sine":
        osc.type = "sine";
        break;
      case "triangle":
        osc.type = "triangle";
        break;
      case "softsq":
        osc.type = "square";
        break;
      case "fm": {
        osc.type = "sine";
        modOsc = ctx.createOscillator();
        const modGain = ctx.createGain();
        modOsc.frequency.value = freq * FM_MOD_RATIO;
        modGain.gain.value = freq * FM_INDEX;
        modOsc.connect(modGain).connect(osc.frequency);
        break;
      }
    }
    osc.frequency.value = freq;
    return [osc, modOsc];
  }
  function scheduleKick(ctx, t0, amp, drumBus) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.05);
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(1e-3, t0 + 0.3);
    osc.connect(g);
    g.connect(drumBus);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  }
  function scheduleSnare(ctx, t0, amp, isGhost, drumBus, nb) {
    const noise = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    noise.buffer = nb;
    filter.type = "bandpass";
    filter.frequency.value = 2e3;
    filter.Q.value = 1.5;
    const dur = isGhost ? 0.06 : 0.12;
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(1e-3, t0 + dur);
    noise.connect(filter);
    filter.connect(g);
    g.connect(drumBus);
    noise.start(t0);
    noise.stop(t0 + dur);
  }
  function scheduleHat(ctx, t0, amp, closed, drumBus, nb) {
    const noise = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    noise.buffer = nb;
    filter.type = "highpass";
    filter.frequency.value = 7e3;
    filter.Q.value = 1;
    const dur = closed ? 0.03 : 0.08;
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(1e-3, t0 + dur);
    noise.connect(filter);
    filter.connect(g);
    g.connect(drumBus);
    noise.start(t0);
    noise.stop(t0 + dur);
  }
  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const ab = new ArrayBuffer(44 + dataLength);
    const view = new DataView(ab);
    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    ws(8, "WAVE");
    ws(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    ws(36, "data");
    view.setUint32(40, dataLength, true);
    const channels = Array.from(
      { length: numChannels },
      (_, i) => buffer.getChannelData(i)
    );
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
        offset += 2;
      }
    }
    return new Blob([ab], { type: "audio/wav" });
  }

  // scripts/browser_ref_harness.ts
  async function renderRecipe(paramsJson, durationSec) {
    const params = JSON.parse(paramsJson);
    const buf = await renderAmbient(params, durationSec, void 0);
    const blob = audioBufferToWav(buf);
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let bin = "";
    const CH = 32768;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CH));
    }
    return { wav_b64: btoa(bin), frames: buf.length, sampleRate: buf.sampleRate };
  }
  function freqResponse(type, f0, q, freqsJson) {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    const biq = ctx.createBiquadFilter();
    biq.type = type;
    biq.frequency.value = f0;
    biq.Q.value = q;
    const freqs = Float32Array.from(JSON.parse(freqsJson));
    const mag = new Float32Array(freqs.length);
    const ph = new Float32Array(freqs.length);
    biq.getFrequencyResponse(freqs, mag, ph);
    return { mag: Array.from(mag), phase: Array.from(ph) };
  }
  window.__ref = { renderRecipe, freqResponse };
})();
