import { describe, expect, test, vi } from 'vitest';

import { createLocationInitializer } from '../src/location/LocationInitializer';

describe('LocationInitializer', () => {
  test('uses the exact browser options and normalizes the accepted position', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: -0, longitude: 127.1, accuracy: -1 } as GeolocationCoordinates,
      timestamp: Number.NaN,
      toJSON: () => ({}),
    }));
    const location = createLocationInitializer(
      { getCurrentPosition } as unknown as Geolocation,
      () => 1234,
    );
    await expect(location.requestBrowserLocation()).resolves.toEqual({
      lat: 0,
      lon: 127.1,
      source: 'browser',
      timestampMs: 1234,
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });

  test.each([
    ['1e2', '0'],
    ['1,2', '0'],
    ['NaN', '0'],
    ['91', '0'],
    ['0', '181'],
  ])('strictly rejects manual coordinates %s, %s', (lat, lon) => {
    const location = createLocationInitializer(undefined, () => 5);
    expect(() => location.parseManual(lat, lon)).toThrowError(expect.objectContaining({ code: 'LOCATION_INVALID' }));
  });

  test('Unicode-trims manual decimals and normalizes negative zero', () => {
    const location = createLocationInitializer(undefined, () => 55);
    expect(location.parseManual('  -0  ', ' +126.978 ')).toEqual({
      lat: 0,
      lon: 126.978,
      source: 'manual',
      timestampMs: 55,
    });
  });

  test.each([
    [1, 'LOCATION_DENIED'],
    [2, 'LOCATION_UNAVAILABLE'],
    [3, 'LOCATION_TIMEOUT'],
    [99, 'LOCATION_UNAVAILABLE'],
  ])('maps geolocation error %i', async (code, expected) => {
    const geolocation = {
      getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => failure({
        code,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        message: 'private browser text',
      }),
    } as unknown as Geolocation;
    await expect(createLocationInitializer(geolocation, Date.now).requestBrowserLocation())
      .rejects.toMatchObject({ code: expected, message: expected });
  });
});

