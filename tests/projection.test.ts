import { describe, expect, test } from 'vitest';

import type { GeoResult } from '../src/domain/types';
import {
  MAP_CENTER_X_PX,
  MAP_CENTER_Y_PX,
  MAP_DRAWABLE_RADIUS_PX,
  createDistanceRings,
  createProjectionModel,
  effectiveMaxDistanceM,
  formatDistanceM,
  inverseProjectionDistanceM,
  normalizedProjectionRadius,
  projectGeoMarkerPosition,
  projectMarkerPosition,
  type ProjectionMarkerInput,
} from '../src/geo/projection';

const geo = (distanceM: number, bearingDeg: number | null, coLocated = false): GeoResult => ({
  distanceM,
  bearingRad: bearingDeg === null ? null : (bearingDeg * Math.PI) / 180,
  bearingDeg,
  cardinal: null,
  coLocated,
});

describe('WP-2 radial projection', () => {
  test('uses configured maximum as a lower bound and always includes observed distances', () => {
    expect(effectiveMaxDistanceM([], undefined)).toBe(1);
    expect(effectiveMaxDistanceM([0, 100], 500)).toBe(500);
    expect(effectiveMaxDistanceM([0, 750], 500)).toBe(750);
  });

  test('projects canonical bearings north-up at the exact drawable radius', () => {
    const positions = [0, 90, 180, 270].map((bearing) =>
      projectMarkerPosition(100, (bearing * Math.PI) / 180, 100, 'linear'),
    );
    expect(positions[0]).toMatchObject({ xPx: MAP_CENTER_X_PX, yPx: MAP_CENTER_Y_PX - MAP_DRAWABLE_RADIUS_PX });
    expect(positions[1]?.xPx).toBeCloseTo(MAP_CENTER_X_PX + MAP_DRAWABLE_RADIUS_PX, 10);
    expect(positions[1]?.yPx).toBeCloseTo(MAP_CENTER_Y_PX, 10);
    expect(positions[2]?.xPx).toBeCloseTo(MAP_CENTER_X_PX, 10);
    expect(positions[2]?.yPx).toBeCloseTo(MAP_CENTER_Y_PX + MAP_DRAWABLE_RADIUS_PX, 10);
    expect(positions[3]?.xPx).toBeCloseTo(MAP_CENTER_X_PX - MAP_DRAWABLE_RADIUS_PX, 10);
    expect(positions[3]?.yPx).toBeCloseTo(MAP_CENTER_Y_PX, 10);
  });

  test('keeps co-located markers finite at center and uses north for undefined bearings', () => {
    expect(projectGeoMarkerPosition(geo(4.9, null, true), 5)).toMatchObject({
      xPx: MAP_CENTER_X_PX,
      yPx: MAP_CENTER_Y_PX,
      radiusPx: 0,
      normalizedRadius: 0,
    });
    const undefinedBearing = projectMarkerPosition(50, null, 100, 'linear');
    expect(undefinedBearing.xPx).toBeCloseTo(MAP_CENTER_X_PX, 12);
    expect(undefinedBearing.yPx).toBeLessThan(MAP_CENTER_Y_PX);
  });

  test('implements linear and logarithmic projection and clamps beyond the bound', () => {
    expect(normalizedProjectionRadius(250, 1_000, 'linear')).toBe(0.25);
    expect(normalizedProjectionRadius(1_500, 1_000, 'linear')).toBe(1);

    const distances = [0, 10, 50, 100, 1_000];
    const radii = distances.map((distance) => normalizedProjectionRadius(distance, 1_000, 'log'));
    expect(radii[0]).toBe(0);
    expect(radii.at(-1)).toBe(1);
    for (let index = 1; index < radii.length; index += 1) {
      expect(radii[index]).toBeGreaterThan(radii[index - 1] ?? Number.NEGATIVE_INFINITY);
    }
  });

  test.each(['linear', 'log'] as const)('inverts every %s distance ring', (scale) => {
    const max = 12_345;
    for (const normalized of [0.25, 0.5, 0.75, 1] as const) {
      const distance = inverseProjectionDistanceM(normalized, max, scale);
      expect(normalizedProjectionRadius(distance, max, scale)).toBeCloseTo(normalized, 12);
    }
    expect(createDistanceRings(max, scale).map((ring) => ring.normalizedRadius)).toEqual([
      0.25,
      0.5,
      0.75,
      1,
    ]);
  });

  test('formats ring distances with the deterministic Appendix F thresholds', () => {
    expect(formatDistanceM(999)).toBe('999 m');
    expect(formatDistanceM(1_000)).toBe('1.0 km');
    expect(formatDistanceM(99_949)).toBe('99.9 km');
    expect(formatDistanceM(99_950)).toBe('100 km');
  });

  test('preserves normalized manifest order without mutating inputs', () => {
    const inputs: ProjectionMarkerInput[] = [
      { recordingId: 'ä', geo: geo(100, 180), state: 'default', enabled: true },
      {
        recordingId: 'B',
        geo: geo(50, 90),
        state: 'disabled',
        enabled: false,
        disabledReason: 'unsupported-audio',
      },
      { recordingId: 'a', geo: geo(0, null, true), state: 'selected', enabled: true },
    ];
    const originalOrder = inputs.map((input) => input.recordingId);
    const model = createProjectionModel(inputs, {
      configuredMaxDistanceM: 75,
      distanceScale: 'linear',
    });

    expect(model.effectiveDmax).toBe(100);
    expect(model.markers.map((marker) => marker.recordingId)).toEqual(originalOrder);
    expect(model.markers[1]).toMatchObject({
      enabled: false,
      disabledReason: 'unsupported-audio',
    });
    expect(model.markers[2]).toMatchObject({
      xPx: MAP_CENTER_X_PX,
      yPx: MAP_CENTER_Y_PX,
    });
    expect(inputs.map((input) => input.recordingId)).toEqual(originalOrder);
  });

  test('rejects non-finite or negative projection inputs', () => {
    expect(() => effectiveMaxDistanceM([Number.NaN])).toThrow(RangeError);
    expect(() => normalizedProjectionRadius(-1, 10)).toThrow(RangeError);
    expect(() => projectMarkerPosition(1, Number.POSITIVE_INFINITY, 10)).toThrow(RangeError);
  });
});
