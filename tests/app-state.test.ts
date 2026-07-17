import { describe, expect, test } from 'vitest';

import { canonicalDebugFrame, createInitialState, reduceAppState } from '../src/app/appState';
import type { AppReducerContext } from '../src/app/appState';
import type { AppState } from '../src/domain/types';

const config = {
  manifestUrl: 'https://example.test/content.json',
  audioLoadTimeoutMs: 20_000,
  progressUpdateHz: 4,
  maxSimultaneousSources: 1,
  buildCommit: 'test',
  debugMode: true,
} as const;

function context(overrides: Partial<AppReducerContext> = {}): AppReducerContext {
  return {
    config, locationGeneration: 1, selectionGeneration: 1, selectionGenerationsById: {},
    sessionGeneration: 1, wallClockMs: 90, ...overrides,
  };
}

describe('pure application state reducer', () => {
  test('has the exact initial state without undefined optional properties', () => {
    const state = createInitialState(config);
    expect(state).toEqual({
      phase: 'booting', recordings: [], recordingEligibility: {}, rejectedRecordCount: 0,
      unsupportedRecordCount: 0, secureContext: false, debugMode: true, xrApiAvailable: false,
      immersiveARSupported: false, browserGeolocationAvailable: false, sessionActive: false,
      controllerAvailable: false, panelVisible: true, playback: { state: 'empty', currentTimeSec: 0 },
      activeRecordingIds: [], playbackById: {},
      masterGain: 0.7, audioGestureRequired: false, buildCommit: 'test',
    });
    expect(Object.hasOwn(state, 'calibration')).toBe(false);
  });

  test('canonical debug frame owns the exact vectors', () => {
    const frame = canonicalDebugFrame(42);
    expect(frame.originWorld.toArray()).toEqual([0, 1.6, 0]);
    expect(frame.northWorld.toArray()).toEqual([0, 0, -1]);
    expect(frame.eastWorld.toArray()).toEqual([1, 0, 0]);
    expect(frame.upWorld.toArray()).toEqual([0, 1, 0]);
  });

  test('ignores stale generation completions by identity', () => {
    const state = { ...createInitialState(config), phase: 'locationPending' as const };
    expect(reduceAppState(state, {
      type: 'LOCATION_RESOLVED',
      locationGeneration: 4,
      location: { lat: 1, lon: 2, source: 'manual', timestampMs: 3 },
    }, context({ locationGeneration: 5 }))).toBe(state);
  });

  test('toggles panel visibility only in a live, non-debug ready session', () => {
    const live = {
      ...createInitialState(config),
      debugMode: false,
      sessionActive: true,
      phase: 'ready' as const,
      calibration: canonicalDebugFrame(1),
    };
    const hidden = reduceAppState(live, { type: 'TOGGLE_PANEL' }, context());
    expect(hidden.panelVisible).toBe(false);
    expect(reduceAppState(hidden, { type: 'TOGGLE_PANEL' }, context()).panelVisible).toBe(true);

    const calibrating = { ...live, phase: 'calibrating' as const };
    expect(reduceAppState(calibrating, { type: 'TOGGLE_PANEL' }, context())).toBe(calibrating);
    const debug = { ...live, debugMode: true };
    expect(reduceAppState(debug, { type: 'TOGGLE_PANEL' }, context())).toBe(debug);
  });

  test('toggles soundscape membership, evicts the oldest at cap, and re-adds focus via PLAY', () => {
    const ctx = context({ config: { ...config, maxSimultaneousSources: 3 } });
    const select = (recordingId: string) => ({ type: 'SELECT_RECORDING', recordingId } as const);
    let state: AppState = {
      ...createInitialState(config),
      phase: 'ready',
      calibration: canonicalDebugFrame(1),
      recordingEligibility: { a: 'eligible', b: 'eligible', c: 'eligible', d: 'eligible' },
    };
    state = reduceAppState(state, select('a'), ctx);
    state = reduceAppState(state, select('b'), ctx);
    state = reduceAppState(state, select('c'), ctx);
    expect(state.activeRecordingIds).toEqual(['a', 'b', 'c']);
    expect(Object.keys(state.playbackById).sort()).toEqual(['a', 'b', 'c']);

    state = reduceAppState(state, select('d'), ctx);
    expect(state.activeRecordingIds).toEqual(['b', 'c', 'd']);
    expect(state.playbackById['a']).toBeUndefined();

    state = reduceAppState(state, select('b'), ctx);
    expect(state.activeRecordingIds).toEqual(['c', 'd']);
    expect(state.selectedRecordingId).toBe('b');
    expect(state.playback).toEqual({ state: 'stopped', recordingId: 'b', currentTimeSec: 0 });
    expect(state.playbackById['b']).toBeUndefined();

    state = reduceAppState(state, { type: 'PLAY' }, ctx);
    expect(state.activeRecordingIds).toEqual(['c', 'd', 'b']);
  });

  test('validates snapshots per recording id and pauses the whole set on recalibration', () => {
    const ctx = context({
      config: { ...config, maxSimultaneousSources: 3 },
      selectionGenerationsById: { a: 1, b: 2, z: 5 },
    });
    const base = {
      ...createInitialState(config),
      phase: 'ready' as const,
      debugMode: false,
      sessionActive: true,
      calibration: canonicalDebugFrame(1),
      selectedRecordingId: 'b',
      activeRecordingIds: ['a', 'b'],
      playbackById: {
        a: { state: 'playing' as const, recordingId: 'a', currentTimeSec: 1 },
        b: { state: 'playing' as const, recordingId: 'b', currentTimeSec: 1 },
      },
    };

    const staleGeneration = reduceAppState(base, {
      type: 'PLAYBACK_SNAPSHOT', generation: 9, recordingId: 'a',
      snapshot: { state: 'paused', recordingId: 'a', currentTimeSec: 2 },
    }, ctx);
    expect(staleGeneration).toBe(base);

    const nonMember = reduceAppState(base, {
      type: 'PLAYBACK_SNAPSHOT', generation: 5, recordingId: 'z',
      snapshot: { state: 'playing', recordingId: 'z', currentTimeSec: 2 },
    }, ctx);
    expect(nonMember).toBe(base);

    const accepted = reduceAppState(base, {
      type: 'PLAYBACK_SNAPSHOT', generation: 1, recordingId: 'a',
      snapshot: { state: 'paused', recordingId: 'a', currentTimeSec: 2 },
    }, ctx);
    expect(accepted.playbackById['a']).toEqual({ state: 'paused', recordingId: 'a', currentTimeSec: 2 });
    expect(accepted.playback).toBe(base.playback); // non-focus events never touch the focus snapshot

    const recalibrated = reduceAppState(base, { type: 'RECALIBRATE' }, ctx);
    expect(recalibrated.phase).toBe('calibrating');
    expect(recalibrated.playbackById['a']?.state).toBe('paused');
    expect(recalibrated.playbackById['b']?.state).toBe('paused');
  });

  test('clamps gain to tenths and returns identical state for semantic no-ops', () => {
    const state = { ...createInitialState(config), phase: 'ready' as const, calibration: canonicalDebugFrame(1) };
    const changed = reduceAppState(state, { type: 'SET_MASTER_GAIN', value: 0.84 }, context());
    expect(changed.masterGain).toBe(0.8);
    expect(reduceAppState(changed, { type: 'SET_MASTER_GAIN', value: 0.83 }, context())).toBe(changed);
    expect(reduceAppState(changed, { type: 'SET_MASTER_GAIN', value: Number.NaN }, context())).toBe(changed);
  });
});
