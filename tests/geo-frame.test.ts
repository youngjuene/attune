import * as THREE from 'three';
import { describe, expect, test } from 'vitest';

import type { GeoFrame, GeoResult } from '../src/domain/types';
import {
  calibrateGeoFrame,
  createGeoPlacement,
  directionAtBearing,
  placeAtBearing,
} from '../src/geo/GeoFrame';

const directionalGeo = (degrees: number): GeoResult => ({
  distanceM: 100,
  bearingRad: THREE.MathUtils.degToRad(degrees),
  bearingDeg: degrees,
  cardinal: null,
  coLocated: false,
});

const canonicalFrame = (): GeoFrame => ({
  originWorld: new THREE.Vector3(10, 1.6, 20),
  northWorld: new THREE.Vector3(0, 0, -1),
  eastWorld: new THREE.Vector3(1, 0, 0),
  upWorld: new THREE.Vector3(0, 1, 0),
  calibratedAtMs: 123,
});

function expectVector(vector: THREE.Vector3, expected: readonly [number, number, number]): void {
  expect(vector.x).toBeCloseTo(expected[0], 10);
  expect(vector.y).toBeCloseTo(expected[1], 10);
  expect(vector.z).toBeCloseTo(expected[2], 10);
}

describe('WP-2 geographic frame', () => {
  test('captures cloned camera world position, north, east, up, and timestamp', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(2, 1.7, 4);
    camera.updateMatrixWorld(true);

    const frame = calibrateGeoFrame(camera, 456);
    expectVector(frame.originWorld, [2, 1.7, 4]);
    expectVector(frame.northWorld, [0, 0, -1]);
    expectVector(frame.eastWorld, [1, 0, 0]);
    expectVector(frame.upWorld, [0, 1, 0]);
    expect(frame.calibratedAtMs).toBe(456);

    camera.position.set(99, 99, 99);
    camera.updateMatrixWorld(true);
    expectVector(frame.originWorld, [2, 1.7, 4]);
  });

  test('rejects calibration whose horizontal camera-forward magnitude is below 0.25', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.rotation.x = Math.PI / 2;
    camera.updateMatrixWorld(true);

    expect(() => calibrateGeoFrame(camera, 1)).toThrowError(
      expect.objectContaining({ code: 'CALIBRATION_INVALID' }),
    );
  });

  test.each([
    [0, [10, 1.6, 17]],
    [90, [13, 1.6, 20]],
    [180, [10, 1.6, 23]],
    [270, [7, 1.6, 20]],
  ] as const)('places bearing %s in its canonical fixed world direction', (bearing, expected) => {
    expectVector(placeAtBearing(canonicalFrame(), directionalGeo(bearing), 3), expected);
  });

  test('normalizes arbitrary calibrated directions and never mutates the frame', () => {
    const frame: GeoFrame = {
      originWorld: new THREE.Vector3(3, 2, -4),
      northWorld: new THREE.Vector3(2, 0, -2),
      eastWorld: new THREE.Vector3(2, 0, 2),
      upWorld: new THREE.Vector3(0, 1, 0),
      calibratedAtMs: 5,
    };
    const before = {
      origin: frame.originWorld.clone(),
      north: frame.northWorld.clone(),
      east: frame.eastWorld.clone(),
    };

    expect(directionAtBearing(frame, Math.PI / 3).length()).toBeCloseTo(1, 12);
    const first = placeAtBearing(frame, directionalGeo(45), 4);
    first.set(0, 0, 0);
    const second = placeAtBearing(frame, directionalGeo(45), 4);
    expect(second.lengthSq()).toBeGreaterThan(0);
    expect(frame.originWorld.equals(before.origin)).toBe(true);
    expect(frame.northWorld.equals(before.north)).toBe(true);
    expect(frame.eastWorld.equals(before.east)).toBe(true);
  });

  test('uses calibrated north and 1.5 m for co-location and null bearings', () => {
    const frame = canonicalFrame();
    const coLocated: GeoResult = {
      distanceM: 0,
      bearingRad: Math.PI / 2,
      bearingDeg: 90,
      cardinal: 'E',
      coLocated: true,
    };
    const placement = createGeoPlacement(frame, coLocated, 8);
    expect(placement.geo).toBe(coLocated);
    expectVector(placement.worldPosition, [10, 1.6, 18.5]);

    const undefinedBearing: GeoResult = {
      ...coLocated,
      distanceM: 20_000_000,
      bearingRad: null,
      bearingDeg: null,
      cardinal: null,
      coLocated: false,
    };
    expectVector(placeAtBearing(frame, undefinedBearing, 8), [10, 1.6, 12]);
  });
});
