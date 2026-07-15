import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
  vi.resetModules();
});

describe('canonical configuration', () => {
  test('uses fixed defaults and the exact first debug query value', async () => {
    window.history.replaceState({}, '', '/?debug=1&debug=0');
    const { getAppConfig } = await import('../src/config');
    expect(getAppConfig()).toMatchObject({
      manifestUrl: 'http://localhost:3000/content/recordings.json',
      audioLoadTimeoutMs: 20_000,
      progressUpdateHz: 4,
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

