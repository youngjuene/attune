import { AppError } from './app/errors';
import type { AppConfig, LatLon } from './domain/types';

const NUMERIC_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const BUILD_COMMIT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

let resolvedConfig: Readonly<AppConfig> | undefined;

function configurationError(cause?: unknown): AppError {
  return new AppError('CONFIGURATION_CONFLICT', cause === undefined ? undefined : { cause });
}

function parseNumber(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const valueText = raw.trim();
  if (!NUMERIC_PATTERN.test(valueText)) {
    throw configurationError();
  }

  const value = Number(valueText);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw configurationError();
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') {
    return true;
  }
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

function resolveManifestUrl(raw: string | undefined, baseUri: string, locationRef: Location): string {
  let url: URL;
  try {
    url = raw === undefined || raw.trim() === ''
      ? new URL('content/recordings.json', baseUri)
      : new URL(raw.trim(), baseUri);
  } catch (cause) {
    throw configurationError(cause);
  }

  if (url.protocol === 'https:') {
    return url.href;
  }
  if (
    url.protocol === 'http:'
    && url.origin === locationRef.origin
    && isLoopbackHostname(locationRef.hostname)
  ) {
    return url.href;
  }
  throw configurationError();
}

function resolveBuildCommit(raw: string | undefined): string {
  const buildCommit = raw?.trim() || 'dev';
  if (!BUILD_COMMIT_PATTERN.test(buildCommit)) {
    throw configurationError();
  }
  return buildCommit;
}

function resolveDefaultLocation(latRaw: string | undefined, lonRaw: string | undefined): LatLon | undefined {
  const latText = latRaw?.trim() ?? '';
  const lonText = lonRaw?.trim() ?? '';
  if (latText === '' && lonText === '') {
    return undefined;
  }
  if (latText === '' || lonText === '') {
    // A half-specified default coordinate is a misconfiguration: require both or neither.
    throw configurationError();
  }
  return {
    lat: parseNumber(latText, 0, -90, 90, false),
    lon: parseNumber(lonText, 0, -180, 180, false),
  };
}

export function getAppConfig(): Readonly<AppConfig> {
  if (resolvedConfig !== undefined) {
    return resolvedConfig;
  }

  const sourceRadiusText = import.meta.env.VITE_SOURCE_RADIUS_M;
  const sourceRadiusMOverride = sourceRadiusText === undefined || sourceRadiusText.trim() === ''
    ? undefined
    : parseNumber(sourceRadiusText, 3, 1.5, 8, false);

  const defaultLocation = resolveDefaultLocation(
    import.meta.env.VITE_DEFAULT_LAT,
    import.meta.env.VITE_DEFAULT_LON,
  );

  const config: AppConfig = {
    manifestUrl: resolveManifestUrl(import.meta.env.VITE_MANIFEST_URL, document.baseURI, window.location),
    audioLoadTimeoutMs: parseNumber(
      import.meta.env.VITE_AUDIO_LOAD_TIMEOUT_MS,
      20_000,
      1_000,
      120_000,
      true,
    ),
    progressUpdateHz: parseNumber(import.meta.env.VITE_PROGRESS_UPDATE_HZ, 4, 1, 10, true),
    maxSimultaneousSources: parseNumber(import.meta.env.VITE_MAX_SIMULTANEOUS_SOURCES, 1, 1, 8, true),
    buildCommit: resolveBuildCommit(import.meta.env.VITE_BUILD_COMMIT),
    debugMode: new URLSearchParams(window.location.search).get('debug') === '1',
    ...(defaultLocation === undefined ? {} : { defaultLocation }),
    ...(sourceRadiusMOverride === undefined ? {} : { sourceRadiusMOverride }),
  };

  resolvedConfig = Object.freeze(config);
  return resolvedConfig;
}
