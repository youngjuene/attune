import type { GeoResult, LatLon } from '../domain/types';

export const EARTH_RADIUS_M = 6_371_008.8;
export const CO_LOCATED_DISTANCE_M = 5;
export const BEARING_VECTOR_EPSILON = 1e-12;

const FULL_CIRCLE_RAD = 2 * Math.PI;

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Normalize a longitude delta to the closed geographic interval [-pi, pi]. */
export function normalizeDeltaLonRad(delta: number): number {
  if (!Number.isFinite(delta)) {
    throw new RangeError('Longitude delta must be finite.');
  }

  return ((delta + Math.PI) % FULL_CIRCLE_RAD + FULL_CIRCLE_RAD) % FULL_CIRCLE_RAD - Math.PI;
}

export function validateLatLon(coordinate: LatLon): void {
  if (!Number.isFinite(coordinate.lat) || coordinate.lat < -90 || coordinate.lat > 90) {
    throw new RangeError('Latitude must be finite and between -90 and 90 degrees.');
  }
  if (!Number.isFinite(coordinate.lon) || coordinate.lon < -180 || coordinate.lon > 180) {
    throw new RangeError('Longitude must be finite and between -180 and 180 degrees.');
  }
}

export function cardinalLabel(bearingDeg: number): string {
  if (!Number.isFinite(bearingDeg)) {
    throw new RangeError('Bearing must be finite.');
  }

  const normalized = ((bearingDeg % 360) + 360) % 360;
  if (normalized < 22.5 || normalized >= 337.5) return 'N';
  if (normalized < 67.5) return 'NE';
  if (normalized < 112.5) return 'E';
  if (normalized < 157.5) return 'SE';
  if (normalized < 202.5) return 'S';
  if (normalized < 247.5) return 'SW';
  if (normalized < 292.5) return 'W';
  return 'NW';
}

/**
 * Calculate the Haversine distance and initial great-circle bearing from origin
 * to target. The returned bearing is clockwise from true north.
 */
export function geoBetween(origin: LatLon, target: LatLon): GeoResult {
  validateLatLon(origin);
  validateLatLon(target);

  const phi1 = degToRad(origin.lat);
  const phi2 = degToRad(target.lat);
  const deltaPhi = phi2 - phi1;
  const deltaLambda = normalizeDeltaLonRad(degToRad(target.lon - origin.lon));

  const sinHalfPhi = Math.sin(deltaPhi / 2);
  const sinHalfLambda = Math.sin(deltaLambda / 2);
  const a =
    sinHalfPhi * sinHalfPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda;
  const aClamped = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(aClamped), Math.sqrt(1 - aClamped));
  const distanceM = EARTH_RADIUS_M * c;

  if (distanceM < CO_LOCATED_DISTANCE_M) {
    return {
      distanceM,
      bearingRad: null,
      bearingDeg: null,
      cardinal: null,
      coLocated: true,
    };
  }

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  if (Math.hypot(x, y) < BEARING_VECTOR_EPSILON) {
    return {
      distanceM,
      bearingRad: null,
      bearingDeg: null,
      cardinal: null,
      coLocated: false,
    };
  }

  const bearingRad = (Math.atan2(y, x) + FULL_CIRCLE_RAD) % FULL_CIRCLE_RAD;
  const bearingDeg = radToDeg(bearingRad);

  return {
    distanceM,
    bearingRad,
    bearingDeg,
    cardinal: cardinalLabel(bearingDeg),
    coLocated: false,
  };
}
