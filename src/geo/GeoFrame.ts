import * as THREE from 'three';

import { AppError } from '../app/errors';
import type { GeoFrame, GeoPlacement, GeoResult } from '../domain/types';

export const MIN_CALIBRATION_HORIZONTAL_MAGNITUDE = 0.25;
export const DEFAULT_SOURCE_RADIUS_M = 3;
export const CO_LOCATED_SOURCE_RADIUS_M = 1.5;

function hasFiniteComponents(vector: THREE.Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

/**
 * Capture a geographic frame from the camera's current world transform.
 * This is WP-2's sole intentionally impure adapter; the timestamp can be
 * supplied by orchestration for deterministic tests and event handling.
 */
export function calibrateGeoFrame(
  camera: THREE.Camera,
  calibratedAtMs: number = Date.now(),
): GeoFrame {
  const originWorld = camera.getWorldPosition(new THREE.Vector3());
  const forward = camera.getWorldDirection(new THREE.Vector3());

  if (
    !hasFiniteComponents(originWorld) ||
    !hasFiniteComponents(forward) ||
    !Number.isFinite(calibratedAtMs)
  ) {
    throw new AppError('CALIBRATION_INVALID');
  }

  forward.y = 0;
  if (forward.lengthSq() < MIN_CALIBRATION_HORIZONTAL_MAGNITUDE ** 2) {
    throw new AppError('CALIBRATION_INVALID');
  }

  const northWorld = forward.normalize();
  const upWorld = new THREE.Vector3(0, 1, 0);
  const eastWorld = northWorld.clone().cross(upWorld).normalize();

  return {
    originWorld,
    northWorld,
    eastWorld,
    upWorld,
    calibratedAtMs,
  };
}

/** Return a new unit direction without mutating the retained frame vectors. */
export function directionAtBearing(frame: GeoFrame, bearingRad: number | null): THREE.Vector3 {
  const effectiveBearing = bearingRad ?? 0;
  if (!Number.isFinite(effectiveBearing)) {
    throw new RangeError('Bearing must be finite or null.');
  }

  const direction = frame.northWorld
    .clone()
    .multiplyScalar(Math.cos(effectiveBearing))
    .add(frame.eastWorld.clone().multiplyScalar(Math.sin(effectiveBearing)));

  if (!hasFiniteComponents(direction) || direction.lengthSq() === 0) {
    throw new RangeError('Geographic frame must contain finite, non-degenerate vectors.');
  }

  return direction.normalize();
}

/**
 * Place a source in the fixed calibrated frame. Co-located records always use
 * the PRD's 1.5 m north fallback; other undefined bearings deterministically
 * fall back to calibrated north at the configured radius.
 */
export function placeAtBearing(
  frame: GeoFrame,
  geo: GeoResult,
  configuredRadiusM: number = DEFAULT_SOURCE_RADIUS_M,
): THREE.Vector3 {
  if (!Number.isFinite(configuredRadiusM) || configuredRadiusM <= 0) {
    throw new RangeError('Source radius must be finite and greater than zero.');
  }

  const effectiveRadiusM = geo.coLocated ? CO_LOCATED_SOURCE_RADIUS_M : configuredRadiusM;
  const direction = directionAtBearing(frame, geo.coLocated ? null : geo.bearingRad);
  const position = frame.originWorld.clone().addScaledVector(direction, effectiveRadiusM);
  position.y = frame.originWorld.y;
  return position;
}

export function createGeoPlacement(
  frame: GeoFrame,
  geo: GeoResult,
  configuredRadiusM: number = DEFAULT_SOURCE_RADIUS_M,
): GeoPlacement {
  return {
    geo,
    worldPosition: placeAtBearing(frame, geo, configuredRadiusM),
  };
}
