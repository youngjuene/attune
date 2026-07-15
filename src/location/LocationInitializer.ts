import { AppError } from '../app/errors';
import type { CreateLocationInitializer, InitializedLocation } from '../domain/types';

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function parseCoordinate(text: string, minimum: number, maximum: number): number {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new AppError('LOCATION_INVALID');
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AppError('LOCATION_INVALID');
  }
  return normalizeZero(value);
}

function geolocationError(error: GeolocationPositionError): AppError {
  if (error.code === error.PERMISSION_DENIED) return new AppError('LOCATION_DENIED');
  if (error.code === error.TIMEOUT) return new AppError('LOCATION_TIMEOUT');
  return new AppError('LOCATION_UNAVAILABLE');
}

/** Wrap browser geolocation and strict WGS 84 manual parsing. */
export const createLocationInitializer: CreateLocationInitializer = (geolocation, wallClockMs) => ({
  requestBrowserLocation(): Promise<InitializedLocation> {
    if (geolocation === undefined) {
      return Promise.reject(new AppError('LOCATION_UNAVAILABLE'));
    }
    return new Promise<InitializedLocation>((resolve, reject) => {
      geolocation.getCurrentPosition(
        (position) => {
          const lat = normalizeZero(position.coords.latitude);
          const lon = normalizeZero(position.coords.longitude);
          if (
            !Number.isFinite(lat) || lat < -90 || lat > 90
            || !Number.isFinite(lon) || lon < -180 || lon > 180
          ) {
            reject(new AppError('LOCATION_INVALID'));
            return;
          }
          const timestampMs = Number.isFinite(position.timestamp) && position.timestamp >= 0
            ? position.timestamp
            : wallClockMs();
          const accuracyM = position.coords.accuracy;
          resolve({
            lat,
            lon,
            source: 'browser',
            timestampMs,
            ...(Number.isFinite(accuracyM) && accuracyM >= 0 ? { accuracyM } : {}),
          });
        },
        (error) => reject(geolocationError(error)),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });
  },

  parseManual(latText: string, lonText: string): InitializedLocation {
    return {
      lat: parseCoordinate(latText, -90, 90),
      lon: parseCoordinate(lonText, -180, 180),
      source: 'manual',
      timestampMs: wallClockMs(),
    };
  },
});

