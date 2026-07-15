import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { runAdapter, adaptSourceMetadata } from '../scripts/adapt-metadata';
import {
  resolvePublicAudioPath,
  runContentValidation,
} from '../scripts/validate-content';
import { SOURCE_METADATA_GATE_MESSAGE } from '../src/data/adapter';

function createWorkspace(audioUrl = '../audio/sample.wav'): {
  root: string;
  manifestPath: string;
  outputPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'attune-content-'));
  const publicRoot = join(root, 'public');
  mkdirSync(join(publicRoot, 'content'), { recursive: true });
  mkdirSync(join(publicRoot, 'audio'), { recursive: true });
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(publicRoot, 'audio', 'sample.wav'), new Uint8Array([1, 2, 3]));
  const manifestPath = join(publicRoot, 'content', 'recordings.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: '1.0',
    collection: { id: 'test', title: 'Test' },
    recordings: [{
      id: 'one',
      title: 'One',
      audioUrl,
      location: { lat: 0, lon: 0 },
      spatialFormat: 'point-source',
    }],
  }, null, 2)}\n`);
  return { root, manifestPath, outputPath: join(root, 'artifacts', 'content-validation.json') };
}

describe('build-time content validation', () => {
  test('checks local files and emits byte-stable machine evidence', () => {
    const fixture = createWorkspace();
    const options = {
      cwd: fixture.root,
      publicRoot: join(fixture.root, 'public'),
      outputPath: fixture.outputPath,
    };
    const first = runContentValidation(['--manifest', 'public/content/recordings.json'], options);
    const second = runContentValidation(['--manifest', 'public/content/recordings.json'], options);

    expect(first.exitCode).toBe(0);
    expect(first.serialized).toBe(second.serialized);
    expect(readFileSync(fixture.outputPath, 'utf8')).toBe(first.serialized);
    expect(first.serialized.endsWith('\n')).toBe(true);
    expect(first.summary.audioFiles).toEqual([{
      path: 'audio/sample.wav',
      recordingId: 'one',
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      sizeBytes: 3,
    }]);
  });

  test('exits nonzero for a missing local file and rejected record', () => {
    const fixture = createWorkspace('../audio/missing.wav');
    const missing = runContentValidation(['--manifest', 'public/content/recordings.json'], {
      cwd: fixture.root,
      publicRoot: join(fixture.root, 'public'),
      outputPath: fixture.outputPath,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.summary.errors).toContainEqual({
      code: 'AUDIO_FILE_INVALID', fieldPath: 'audioUrl', id: 'one', index: 0,
    });

    writeFileSync(fixture.manifestPath, JSON.stringify({
      schemaVersion: '1.0',
      collection: { id: 'test', title: 'Test' },
      recordings: [
        { id: 'duplicate', title: '', audioUrl: '../audio/sample.wav', location: { lat: 0, lon: 0 }, spatialFormat: 'point-source' },
        { id: 'duplicate', title: 'Two', audioUrl: '../audio/sample.wav', location: { lat: 0, lon: 0 }, spatialFormat: 'point-source' },
      ],
    }));
    const rejected = runContentValidation(['--manifest', 'public/content/recordings.json'], {
      cwd: fixture.root,
      publicRoot: join(fixture.root, 'public'),
      outputPath: fixture.outputPath,
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.summary.rejectedRecordCount).toBe(2);
  });

  test('enforces manifest and decoded audio path containment', () => {
    const fixture = createWorkspace();
    expect(() => runContentValidation(['--manifest', fixture.manifestPath], {
      cwd: fixture.root,
      publicRoot: join(fixture.root, 'public', 'audio'),
      outputPath: fixture.outputPath,
    })).toThrow('Manifest must be inside the public directory.');
    expect(() => resolvePublicAudioPath(
      'https://attune.invalid/audio/%2Fsecret.wav',
      join(fixture.root, 'public'),
    )).toThrow('Unsafe audio path.');
    expect(resolvePublicAudioPath(
      'https://cdn.example/audio.wav',
      join(fixture.root, 'public'),
    )).toBeUndefined();
  });
});

describe('content adapter gate', () => {
  test('exports a concrete deterministic adapter while G-01 remains open', () => {
    expect(() => adaptSourceMetadata({ any: 'shape' })).toThrow(SOURCE_METADATA_GATE_MESSAGE);
    expect(() => adaptSourceMetadata({ differently: 'ordered' })).toThrow(SOURCE_METADATA_GATE_MESSAGE);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runAdapter([])).toBe(2);
    expect(runAdapter(['--write'])).toBe(2);
    expect(runAdapter(['--unknown'])).toBe(1);
    expect(error.mock.calls.map(([message]) => message)).toEqual([
      `${SOURCE_METADATA_GATE_MESSAGE} Adapter mode: dry-run.`,
      `${SOURCE_METADATA_GATE_MESSAGE} Adapter mode: write.`,
      'Usage: adapt-metadata.ts [--write]',
    ]);
    error.mockRestore();
  });
});
