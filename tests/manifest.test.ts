import { describe, expect, test, vi } from 'vitest';

import { createManifestService } from '../src/data/manifest';
import { validateManifestDocument } from '../src/data/validateManifest';

const HTTPS_MANIFEST_URL = 'https://example.test/content/recordings.json';

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'record-1',
    title: ' Recording One ',
    audioUrl: '../audio/one.wav',
    location: { lat: 37.5, lon: 127 },
    spatialFormat: 'point-source',
    ...overrides,
  };
}

function manifest(recordings: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    collection: { id: 'collection', title: ' Collection ' },
    recordings,
    ...overrides,
  };
}

describe('manifest envelope and record validation', () => {
  test('normalizes accepted data and strips unknown fields', () => {
    const input = manifest([
      record({
        description: '  ',
        credit: ' Creator ',
        gainDb: 8,
        tags: [' field ', '', 'field', 'Field'],
        location: { lon: 127, lat: 37.5, altitude: 10 },
        zeta: true,
      }),
    ], {
      collection: { title: ' Collection ', id: 'collection', unused: true, description: '  ' },
      alpha: true,
    });
    const validation = validateManifestDocument(input, HTTPS_MANIFEST_URL);

    expect(validation.envelopeErrors).toEqual([]);
    expect(validation.result?.records).toEqual([
      {
        id: 'record-1',
        title: 'Recording One',
        audioUrl: '../audio/one.wav',
        location: { lat: 37.5, lon: 127 },
        spatialFormat: 'point-source',
        tags: ['field', 'Field'],
        gainDb: 6,
        credit: 'Creator',
        resolvedAudioUrl: 'https://example.test/audio/one.wav',
      },
    ]);
    expect(validation.result?.manifest.recordings[0]).not.toHaveProperty('resolvedAudioUrl');
    expect(validation.result?.warnings.map(({ index, fieldPath, code }) => ({ index, fieldPath, code })))
      .toEqual([
        { index: undefined, fieldPath: 'alpha', code: 'UNKNOWN_FIELD_STRIPPED' },
        { index: undefined, fieldPath: 'collection.unused', code: 'UNKNOWN_FIELD_STRIPPED' },
        { index: 0, fieldPath: 'gainDb', code: 'GAIN_CLAMPED' },
        { index: 0, fieldPath: 'location.altitude', code: 'UNKNOWN_FIELD_STRIPPED' },
        { index: 0, fieldPath: 'tags.1', code: 'EMPTY_TAG_REMOVED' },
        { index: 0, fieldPath: 'tags.2', code: 'DUPLICATE_TAG_REMOVED' },
        { index: 0, fieldPath: 'zeta', code: 'UNKNOWN_FIELD_STRIPPED' },
      ]);
  });

  test('rejects invalid envelopes before evaluating records', () => {
    const validation = validateManifestDocument({
      schemaVersion: '2.0',
      collection: { id: ' bad', title: ' ' },
      map: { distanceScale: 'sqrt', maxDistanceM: 0 },
      recordings: [null],
    }, HTTPS_MANIFEST_URL);
    expect(validation.envelopeErrors).toEqual([
      { code: 'MANIFEST_INVALID', fieldPath: 'schemaVersion' },
      { code: 'MANIFEST_INVALID', fieldPath: 'collection.id' },
      { code: 'MANIFEST_INVALID', fieldPath: 'collection.title' },
      { code: 'MANIFEST_INVALID', fieldPath: 'map.distanceScale' },
      { code: 'MANIFEST_INVALID', fieldPath: 'map.maxDistanceM' },
    ]);
    expect(validation.result).toBeUndefined();
  });

  test('accumulates independent record errors in normative field order', () => {
    const validation = validateManifestDocument(manifest([
      record({
        id: 'valid-id',
        title: '',
        audioUrl: 'data:audio/wav;base64,AA==',
        location: { lat: 91, lon: Number.NaN },
        spatialFormat: 'ambisonic',
        durationSec: -1,
        recordedAt: '2025-02-29T00:00:00Z',
        mimeType: 'video/mp4',
        gainDb: Number.POSITIVE_INFINITY,
        tags: ['ok', 4],
        description: 4,
        credit: 'x'.repeat(201),
        unknown: true,
      }),
    ]), HTTPS_MANIFEST_URL);

    expect(validation.result?.rejected).toEqual([
      { index: 0, id: 'valid-id', code: 'TITLE_INVALID', fieldPath: 'title' },
      { index: 0, id: 'valid-id', code: 'AUDIO_URL_INVALID', fieldPath: 'audioUrl' },
      { index: 0, id: 'valid-id', code: 'COORDINATE_INVALID', fieldPath: 'location' },
      { index: 0, id: 'valid-id', code: 'SPATIAL_FORMAT_UNSUPPORTED', fieldPath: 'spatialFormat' },
      { index: 0, id: 'valid-id', code: 'DURATION_INVALID', fieldPath: 'durationSec' },
      { index: 0, id: 'valid-id', code: 'RECORDED_AT_INVALID', fieldPath: 'recordedAt' },
      { index: 0, id: 'valid-id', code: 'MIME_TYPE_INVALID', fieldPath: 'mimeType' },
      { index: 0, id: 'valid-id', code: 'GAIN_INVALID', fieldPath: 'gainDb' },
      { index: 0, id: 'valid-id', code: 'TAG_INVALID', fieldPath: 'tags' },
      { index: 0, id: 'valid-id', code: 'FIELD_TYPE_INVALID', fieldPath: 'description' },
      { index: 0, id: 'valid-id', code: 'FIELD_LIMIT_EXCEEDED', fieldPath: 'credit' },
    ]);
    expect(validation.result?.warnings).toEqual([]);
  });

  test('assigns duplicate ownership to the first syntactically valid raw ID', () => {
    const validation = validateManifestDocument(manifest([
      record({ id: 'same', title: '' }),
      record({ id: 'same', gainDb: 99 }),
      record({ id: 'same' }),
    ]), HTTPS_MANIFEST_URL);

    expect(validation.result?.records).toEqual([]);
    expect(validation.result?.rejected).toEqual([
      { index: 0, id: 'same', code: 'TITLE_INVALID', fieldPath: 'title' },
      { index: 1, id: 'same', code: 'ID_DUPLICATE', fieldPath: 'id' },
      { index: 2, id: 'same', code: 'ID_DUPLICATE', fieldPath: 'id' },
    ]);
    // The clamping warning belongs to a duplicate-rejected record and is discarded.
    expect(validation.result?.warnings).toEqual([]);
  });

  test('keeps a valid subset while reporting rejected records', () => {
    const validation = validateManifestDocument(manifest([
      record({ id: 'bad', location: { lat: -91, lon: 0 } }),
      record({ id: 'good', audioUrl: 'https://cdn.example/good.wav' }),
    ]), HTTPS_MANIFEST_URL);
    expect(validation.result?.records.map(({ id }) => id)).toEqual(['good']);
    expect(validation.result?.rejected).toEqual([
      { index: 0, id: 'bad', code: 'COORDINATE_INVALID', fieldPath: 'location' },
    ]);
    expect(validation.result?.warnings).toContainEqual({
      index: 1,
      id: 'good',
      code: 'EXTERNAL_AUDIO_NOT_FILE_CHECKED',
      fieldPath: 'audioUrl',
    });
  });

  test('enforces astral code-point limits and omits empty optional strings', () => {
    const accepted = validateManifestDocument(manifest([
      record({ id: 'ok', title: '😀'.repeat(120), description: '  ', credit: '\n' }),
      record({ id: 'too-long', title: '😀'.repeat(121) }),
    ]), HTTPS_MANIFEST_URL);
    expect(accepted.result?.records[0]).not.toHaveProperty('description');
    expect(accepted.result?.records[0]).not.toHaveProperty('credit');
    expect(accepted.result?.rejected).toEqual([
      { index: 1, id: 'too-long', code: 'FIELD_LIMIT_EXCEEDED', fieldPath: 'title' },
    ]);
  });

  test('produces identical normalized JSON and diagnostics for reordered keys', () => {
    const first = manifest([record({ beta: 2, alpha: 1 })], {
      collection: { id: 'collection', title: 'Collection', zeta: 1, alpha: 2 },
    });
    const second = {
      recordings: [{
        alpha: 1,
        spatialFormat: 'point-source',
        location: { lon: 127, lat: 37.5 },
        audioUrl: '../audio/one.wav',
        title: ' Recording One ',
        beta: 2,
        id: 'record-1',
      }],
      collection: { alpha: 2, title: 'Collection', zeta: 1, id: 'collection' },
      schemaVersion: '1.0',
    };
    expect(JSON.stringify(validateManifestDocument(first, HTTPS_MANIFEST_URL)))
      .toBe(JSON.stringify(validateManifestDocument(second, HTTPS_MANIFEST_URL)));
  });

  test('allows only HTTPS or same-origin loopback HTTP audio URLs', () => {
    const local = validateManifestDocument(manifest([record()]), 'http://127.0.0.2:4173/content/recordings.json');
    expect(local.result?.records).toHaveLength(1);
    const externalHttp = validateManifestDocument(
      manifest([record({ audioUrl: 'http://127.0.0.3:4173/audio/one.wav' })]),
      'http://127.0.0.2:4173/content/recordings.json',
    );
    expect(externalHttp.result?.rejected[0]?.code).toBe('AUDIO_URL_INVALID');
    const nonLocalHttp = validateManifestDocument(manifest([record()]), 'http://example.test/content/recordings.json');
    expect(nonLocalHttp.result?.rejected[0]?.code).toBe('AUDIO_URL_INVALID');
  });
});

describe('runtime manifest service', () => {
  test('loads valid records and maps envelope, empty-set, HTTP, and fetch failures', async () => {
    const fetchValid = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      url: HTTPS_MANIFEST_URL,
      json: async () => manifest([record()]),
    } as unknown as Response);
    await expect(createManifestService(fetchValid).load(HTTPS_MANIFEST_URL)).resolves.toMatchObject({
      records: [{ id: 'record-1' }],
    });

    const fetchEnvelope = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      url: HTTPS_MANIFEST_URL,
      json: async () => ({ schemaVersion: '2.0' }),
    } as unknown as Response);
    await expect(createManifestService(fetchEnvelope).load(HTTPS_MANIFEST_URL))
      .rejects.toMatchObject({ code: 'MANIFEST_INVALID' });

    const fetchEmpty = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      url: HTTPS_MANIFEST_URL,
      json: async () => manifest([record({ title: '' })]),
    } as Response);
    await expect(createManifestService(fetchEmpty).load(HTTPS_MANIFEST_URL))
      .rejects.toMatchObject({ code: 'NO_VALID_RECORDINGS' });

    const fetchHttp = vi.fn<typeof fetch>().mockResolvedValue({ ok: false } as Response);
    await expect(createManifestService(fetchHttp).load(HTTPS_MANIFEST_URL))
      .rejects.toMatchObject({ code: 'MANIFEST_LOAD_FAILED' });

    const fetchParse = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      url: HTTPS_MANIFEST_URL,
      json: async () => { throw new SyntaxError('invalid JSON'); },
    } as unknown as Response);
    await expect(createManifestService(fetchParse).load(HTTPS_MANIFEST_URL))
      .rejects.toMatchObject({ code: 'MANIFEST_INVALID' });

    const fetchBodyFailure = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      url: HTTPS_MANIFEST_URL,
      json: async () => { throw new DOMException('aborted', 'AbortError'); },
    } as unknown as Response);
    await expect(createManifestService(fetchBodyFailure).load(HTTPS_MANIFEST_URL))
      .rejects.toMatchObject({ code: 'MANIFEST_LOAD_FAILED' });

    const fetchRejected = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(createManifestService(fetchRejected).load(HTTPS_MANIFEST_URL, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MANIFEST_LOAD_FAILED' });
  });
});
