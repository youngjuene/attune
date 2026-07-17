import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
  vi.resetModules();
});

describe('canonical configuration', () => {
  test('uses fixed defaults and the exact first debug query value', async () => {
    window.history.replaceState({}, '', '/?debug=1&debug=0');
    // Vite loads .env.local in every mode (including test); blank-stub the
    // developer-local knobs so this canonical-defaults test stays hermetic.
    vi.stubEnv('VITE_MAX_SIMULTANEOUS_SOURCES', '');
    vi.stubEnv('VITE_DEFAULT_LAT', '');
    vi.stubEnv('VITE_DEFAULT_LON', '');
    const { getAppConfig } = await import('../src/config');
    expect(getAppConfig()).toMatchObject({
      manifestUrl: 'http://localhost:3000/content/recordings.json',
      audioLoadTimeoutMs: 20_000,
      progressUpdateHz: 4,
      maxSimultaneousSources: 1,
      buildCommit: 'dev',
      debugMode: true,
    });
    expect(getAppConfig()).toBe(getAppConfig());
  });

  test('rejects exponent notation and non-loopback HTTP manifests', async () => {
    vi.stubEnv('VITE_AUDIO_LOAD_TIMEOUT_MS', '1e4');
    const first = await import('../src/config');
    expect(() => first.getAppConfig()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }));
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_MANIFEST_URL', 'http://example.com/content.json');
    const second = await import('../src/config');
    expect(() => second.getAppConfig()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }));
  });
});

describe('default location', () => {
  test('exposes a coordinate when both VITE_DEFAULT_LAT and VITE_DEFAULT_LON are set', async () => {
    vi.stubEnv('VITE_DEFAULT_LAT', '37.5665');
    vi.stubEnv('VITE_DEFAULT_LON', '126.978');
    const { getAppConfig } = await import('../src/config');
    expect(getAppConfig().defaultLocation).toEqual({ lat: 37.5665, lon: 126.978 });
  });

  test('omits the coordinate when neither is set', async () => {
    vi.stubEnv('VITE_DEFAULT_LAT', '');
    vi.stubEnv('VITE_DEFAULT_LON', '');
    const { getAppConfig } = await import('../src/config');
    expect(getAppConfig().defaultLocation).toBeUndefined();
  });

  test('rejects a half-specified default coordinate (both required, or neither)', async () => {
    vi.stubEnv('VITE_DEFAULT_LAT', '37.5665');
    vi.stubEnv('VITE_DEFAULT_LON', '');
    const { getAppConfig } = await import('../src/config');
    expect(() => getAppConfig()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }));
  });

  test('rejects an out-of-range default coordinate', async () => {
    vi.stubEnv('VITE_DEFAULT_LAT', '95');
    vi.stubEnv('VITE_DEFAULT_LON', '126.978');
    const { getAppConfig } = await import('../src/config');
    expect(() => getAppConfig()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }));
  });
});

describe('simultaneous sources cap', () => {
  test('accepts an integer cap within 1-8', async () => {
    vi.stubEnv('VITE_MAX_SIMULTANEOUS_SOURCES', '4');
    const { getAppConfig } = await import('../src/config');
    expect(getAppConfig().maxSimultaneousSources).toBe(4);
  });

  test('rejects zero, fractional, and out-of-range caps', async () => {
    for (const raw of ['0', '2.5', '9']) {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv('VITE_MAX_SIMULTANEOUS_SOURCES', raw);
      const { getAppConfig } = await import('../src/config');
      expect(() => getAppConfig()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CONFLICT' }));
    }
  });
});

