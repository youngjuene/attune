import type {
  GeoResult,
  MapDistanceRingModel,
  MapMarkerModel,
  MapMarkerState,
  MarkerDisabledReason,
} from '../domain/types';

export const MAP_RECT = Object.freeze({ x: 0, y: 84, width: 680, height: 660 });
export const MAP_CENTER_X_PX = 340;
export const MAP_CENTER_Y_PX = 414;
export const MAP_DRAWABLE_RADIUS_PX = 286;
export const LOG_DISTANCE_SCALE_M = 50;
export const DISTANCE_RING_RADII = [0.25, 0.5, 0.75, 1] as const;

export type DistanceScale = 'log' | 'linear';

export interface ProjectionMarkerInput {
  recordingId: string;
  geo: GeoResult;
  state: MapMarkerState;
  enabled: boolean;
  disabledReason?: MarkerDisabledReason;
}

export interface ProjectionOptions {
  distanceScale?: DistanceScale;
  configuredMaxDistanceM?: number;
}

export interface ProjectedMarkerPosition {
  xPx: number;
  yPx: number;
  radiusPx: number;
  normalizedRadius: number;
}

export interface ProjectionModel {
  effectiveDmax: number;
  markers: readonly MapMarkerModel[];
  distanceRings: readonly MapDistanceRingModel[];
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function requireNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and nonnegative.`);
  }
}

export function effectiveMaxDistanceM(
  distancesM: readonly number[],
  configuredMaxDistanceM?: number,
): number {
  if (
    configuredMaxDistanceM !== undefined &&
    (!Number.isFinite(configuredMaxDistanceM) || configuredMaxDistanceM <= 0)
  ) {
    throw new RangeError('Configured maximum distance must be finite and greater than zero.');
  }

  let maximumObservedDistanceM = 0;
  for (const distanceM of distancesM) {
    requireNonNegativeFinite(distanceM, 'Observed distance');
    maximumObservedDistanceM = Math.max(maximumObservedDistanceM, distanceM);
  }

  return Math.max(1, configuredMaxDistanceM ?? 0, maximumObservedDistanceM);
}

export function normalizedProjectionRadius(
  distanceM: number,
  effectiveDmax: number,
  distanceScale: DistanceScale = 'log',
): number {
  requireNonNegativeFinite(distanceM, 'Distance');
  if (!Number.isFinite(effectiveDmax) || effectiveDmax < 1) {
    throw new RangeError('Effective maximum distance must be finite and at least one metre.');
  }

  const normalized =
    distanceScale === 'linear'
      ? distanceM / effectiveDmax
      : Math.log1p(distanceM / LOG_DISTANCE_SCALE_M) /
        Math.log1p(effectiveDmax / LOG_DISTANCE_SCALE_M);
  return clampUnit(normalized);
}

export function projectMarkerPosition(
  distanceM: number,
  bearingRad: number | null,
  effectiveDmax: number,
  distanceScale: DistanceScale = 'log',
): ProjectedMarkerPosition {
  if (bearingRad !== null && !Number.isFinite(bearingRad)) {
    throw new RangeError('Bearing must be finite or null.');
  }

  const normalizedRadius = normalizedProjectionRadius(distanceM, effectiveDmax, distanceScale);
  const radiusPx = MAP_DRAWABLE_RADIUS_PX * normalizedRadius;
  const displayBearing = bearingRad ?? 0;

  return {
    xPx: MAP_CENTER_X_PX + radiusPx * Math.sin(displayBearing),
    yPx: MAP_CENTER_Y_PX - radiusPx * Math.cos(displayBearing),
    radiusPx,
    normalizedRadius,
  };
}

/** Apply the co-location policy before projecting a complete geodesy result. */
export function projectGeoMarkerPosition(
  geo: GeoResult,
  effectiveDmax: number,
  distanceScale: DistanceScale = 'log',
): ProjectedMarkerPosition {
  return projectMarkerPosition(
    geo.coLocated ? 0 : geo.distanceM,
    geo.bearingRad,
    effectiveDmax,
    distanceScale,
  );
}

export function inverseProjectionDistanceM(
  normalizedRadius: number,
  effectiveDmax: number,
  distanceScale: DistanceScale = 'log',
): number {
  if (!Number.isFinite(normalizedRadius) || normalizedRadius < 0 || normalizedRadius > 1) {
    throw new RangeError('Normalized radius must be finite and between zero and one.');
  }
  if (!Number.isFinite(effectiveDmax) || effectiveDmax < 1) {
    throw new RangeError('Effective maximum distance must be finite and at least one metre.');
  }

  if (distanceScale === 'linear') {
    return effectiveDmax * normalizedRadius;
  }

  return (
    LOG_DISTANCE_SCALE_M *
    ((1 + effectiveDmax / LOG_DISTANCE_SCALE_M) ** normalizedRadius - 1)
  );
}

export function formatDistanceM(distanceM: number): string {
  requireNonNegativeFinite(distanceM, 'Distance');
  if (distanceM < 1_000) return `${Math.round(distanceM)} m`;
  if (distanceM < 99_950) return `${(distanceM / 1_000).toFixed(1)} km`;
  return `${Math.round(distanceM / 1_000)} km`;
}

export function createDistanceRings(
  effectiveDmax: number,
  distanceScale: DistanceScale = 'log',
): readonly MapDistanceRingModel[] {
  return DISTANCE_RING_RADII.map((normalizedRadius) => ({
    normalizedRadius,
    distanceText: formatDistanceM(
      inverseProjectionDistanceM(normalizedRadius, effectiveDmax, distanceScale),
    ),
  }));
}

export function createProjectionModel(
  inputs: readonly ProjectionMarkerInput[],
  options: ProjectionOptions = {},
): ProjectionModel {
  const distanceScale = options.distanceScale ?? 'log';
  const effectiveDmax = effectiveMaxDistanceM(
    inputs.map((input) => input.geo.distanceM),
    options.configuredMaxDistanceM,
  );

  const markers = inputs.map((input): MapMarkerModel => {
      const position = projectGeoMarkerPosition(input.geo, effectiveDmax, distanceScale);
      const marker: MapMarkerModel = {
        recordingId: input.recordingId,
        xPx: position.xPx,
        yPx: position.yPx,
        state: input.state,
        enabled: input.enabled,
      };
      if (input.disabledReason !== undefined) {
        marker.disabledReason = input.disabledReason;
      }
      return marker;
    });

  return {
    effectiveDmax,
    markers,
    distanceRings: createDistanceRings(effectiveDmax, distanceScale),
  };
}
