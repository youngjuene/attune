import { describe, expect, test } from 'vitest';

import {
  DISTANCE_GAIN_FLOOR,
  DISTANCE_GAIN_NEAR_M,
  distanceGain,
  ensembleTrim,
} from '../src/audio/mixGain';

describe('distanceGain', () => {
  test('is 1 within the near field, for co-located records, and for non-finite input', () => {
    expect(distanceGain(0, 5_000)).toBe(1);
    expect(distanceGain(DISTANCE_GAIN_NEAR_M, 5_000)).toBe(1);
    expect(distanceGain(250_000, 5_000, true)).toBe(1);
    expect(distanceGain(Number.NaN, 5_000)).toBe(1);
  });

  test('floors at and beyond the collection maximum', () => {
    expect(distanceGain(5_000, 5_000)).toBe(DISTANCE_GAIN_FLOOR);
    expect(distanceGain(250_000, 5_000)).toBe(DISTANCE_GAIN_FLOOR);
    // A maximum below the near field clamps to the near field: anything
    // beyond 100 m floors immediately.
    expect(distanceGain(150, 50)).toBe(DISTANCE_GAIN_FLOOR);
    expect(distanceGain(150, Number.NaN)).toBe(DISTANCE_GAIN_FLOOR);
  });

  test('interpolates linearly in log distance and stays monotone', () => {
    const logMidpoint = Math.sqrt(DISTANCE_GAIN_NEAR_M * 10_000);
    expect(distanceGain(logMidpoint, 10_000)).toBeCloseTo((1 + DISTANCE_GAIN_FLOOR) / 2, 6);
    expect(distanceGain(500, 10_000)).toBeGreaterThan(distanceGain(2_000, 10_000));
    expect(distanceGain(2_000, 10_000)).toBeGreaterThan(DISTANCE_GAIN_FLOOR);
  });
});

describe('ensembleTrim', () => {
  test('applies equal-power attenuation only beyond one source', () => {
    expect(ensembleTrim(0)).toBe(1);
    expect(ensembleTrim(1)).toBe(1);
    expect(ensembleTrim(2)).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(ensembleTrim(4)).toBe(0.5);
  });
});
