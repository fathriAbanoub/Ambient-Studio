/**
 * test/chordWalk.ts — shared reconstruction of the kernel chord walk for the
 * daemon audio tools. Mirrors buildTimeline's kernel initialisation exactly,
 * including the sample-lane draw when a sample bank is configured. This module
 * runs no main() and may be imported by any tool.
 */
import {
  getMusicalEvents,
  createInitialState,
  advanceRngPastNoiseBuffer,
  initializeBell,
  initializeSampleLane,
  isHarmonicCycleBoundary,
  type EngineParams,
  type ChordQuality,
} from "../../kernel/musicalLogic";

export interface ChordWalkRow {
  rootPc: number;
  quality: ChordQuality;
  boundary: boolean;
}

export function chordPerBeat(
  params: EngineParams,
  beatCount: number,
): ChordWalkRow[] {
  let state = createInitialState(params);
  state = advanceRngPastNoiseBuffer(state);
  state = initializeBell(state);
  state = initializeSampleLane(state, params);

  const rows: ChordWalkRow[] = [];
  for (let i = 0; i < beatCount; i++) {
    const boundary = isHarmonicCycleBoundary(state.beat);
    const { nextState } = getMusicalEvents(state.beat, { ...state }, params);
    rows.push({
      rootPc: nextState.chordRootPc,
      quality: nextState.chordQuality,
      boundary,
    });
    state = nextState;
  }
  return rows;
}
