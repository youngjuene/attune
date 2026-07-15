import { describe, expect, test } from 'vitest';

import {
  EARTH_RADIUS_M,
  cardinalLabel,
  degToRad,
  geoBetween,
  normalizeDeltaLonRad,
} from '../src/geo/geodesy';

const origin = { lat: 37.5665, lon: 126.978 };
const cardinalTargets = [
  { label: 'N', bearing: 0, target: { lat: 37.567399320364, lon: 126.978 } },
  { label: 'E', bearing: 90, target: { lat: 37.566499994571, lon: 126.979134579723 } },
  { label: 'S', bearing: 180, target: { lat: 37.565600679636, lon: 126.978 } },
  { label: 'W', bearing: 270, target: { lat: 37.566499994571, lon: 126.976865420277 } },
] as const;

describe('WP-2 geodesy', () => {
  test.each(cardinalTargets)('calculates the canonical $label fixture', ({ bearing, label, target }) => {
    const result = geoBetween(origin, target);
    expect(result.distanceM).toBeCloseTo(100, 0);
    expect(result.bearingDeg).toBeCloseTo(bearing, 1);
    expect(result.cardinal).toBe(label);
    expect(result.coLocated).toBe(false);
  });

  test('uses the short dateline-crossing longitude delta', () => {
    expect(normalizeDeltaLonRad(degToRad(-359.8))).toBeCloseTo(degToRad(0.2), 12);
    const eastward = geoBetween({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 });
    expect(eastward.distanceM).toBeCloseTo(EARTH_RADIUS_M * degToRad(0.2), 6);
    expect(eastward.bearingDeg).toBeCloseTo(90, 10);
  });

  test('marks distances below five metres as co-located with no bearing', () => {
    const same = geoBetween(origin, origin);
    expect(same).toEqual({
      distanceM: 0,
      bearingRad: null,
      bearingDeg: null,
      cardinal: null,
      coLocated: true,
    });

    const nearby = geoBetween(origin, { lat: origin.lat + 0.00001, lon: origin.lon });
    expect(nearby.distanceM).toBeGreaterThan(0);
    expect(nearby.distanceM).toBeLessThan(5);
    expect(nearby.bearingRad).toBeNull();
    expect(nearby.coLocated).toBe(true);
  });

  test('surfaces an antipodal indeterminate bearing as null, never NaN', () => {
    const antipodal = geoBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(antipodal.distanceM).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 6);
    expect(antipodal).toMatchObject({
      bearingRad: null,
      bearingDeg: null,
      cardinal: null,
      coLocated: false,
    });

    const almostAntipodal = geoBetween({ lat: 0, lon: 0 }, { lat: 0.000001, lon: 179.999999 });
    expect(Number.isFinite(almostAntipodal.distanceM)).toBe(true);
    expect(almostAntipodal.bearingDeg === null || Number.isFinite(almostAntipodal.bearingDeg)).toBe(true);
  });

  test('keeps high-latitude calculations finite', () => {
    const result = geoBetween({ lat: 89.9, lon: -45 }, { lat: 89.9, lon: 45 });
    expect(Number.isFinite(result.distanceM)).toBe(true);
    expect(result.distanceM).toBeGreaterThan(0);
    expect(Number.isFinite(result.bearingDeg)).toBe(true);
  });

  test('uses exact eight-point cardinal boundaries without locale behavior', () => {
    expect([
      cardinalLabel(337.5),
      cardinalLabel(0),
      cardinalLabel(22.499999),
      cardinalLabel(22.5),
      cardinalLabel(67.5),
      cardinalLabel(112.5),
      cardinalLabel(157.5),
      cardinalLabel(202.5),
      cardinalLabel(247.5),
      cardinalLabel(292.5),
      cardinalLabel(-90),
    ]).toEqual(['N', 'N', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'W']);
  });

  test.each([
    [{ lat: Number.NaN, lon: 0 }, origin],
    [{ lat: 91, lon: 0 }, origin],
    [{ lat: 0, lon: 181 }, origin],
    [origin, { lat: Number.POSITIVE_INFINITY, lon: 0 }],
  ])('rejects an invalid coordinate pair', (from, to) => {
    expect(() => geoBetween(from, to)).toThrow(RangeError);
  });
});
