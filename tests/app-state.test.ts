import { describe, expect, test } from 'vitest';

import { canonicalDebugFrame, createInitialState, reduceAppState } from '../src/app/appState';
import type { AppReducerContext } from '../src/app/appState';

const config = {
  manifestUrl: 'https://example.test/content.json',
  audioLoadTimeoutMs: 20_000,
  progressUpdateHz: 4,
  buildCommit: 'test',
  debugMode: true,
} as const;

function context(overrides: Partial<AppReducerContext> = {}): AppReducerContext {
  return { config, locationGeneration: 1, selectionGeneration: 1, sessionGeneration: 1, wallClockMs: 90, ...overrides };
}

describe('pure application state reducer', () => {
  test('has the exact initial state without undefined optional properties', () => {
    const state = createInitialState(config);
    expect(state).toEqual({
      phase: 'booting', recordings: [], recordingEligibility: {}, rejectedRecordCount: 0,
      unsupportedRecordCount: 0, secureContext: false, debugMode: true, xrApiAvailable: false,
      immersiveARSupported: false, browserGeolocationAvailable: false, sessionActive: false,
      controllerAvailable: false, playback: { state: 'empty', currentTimeSec: 0 }, masterGain: 0.7,
      audioGestureRequired: false, buildCommit: 'test',
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

  test('clamps gain to tenths and returns identical state for semantic no-ops', () => {
    const state = { ...createInitialState(config), phase: 'ready' as const, calibration: canonicalDebugFrame(1) };
    const changed = reduceAppState(state, { type: 'SET_MASTER_GAIN', value: 0.84 }, context());
    expect(changed.masterGain).toBe(0.8);
    expect(reduceAppState(changed, { type: 'SET_MASTER_GAIN', value: 0.83 }, context())).toBe(changed);
    expect(reduceAppState(changed, { type: 'SET_MASTER_GAIN', value: Number.NaN }, context())).toBe(changed);
  });
});
