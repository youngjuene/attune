import { createHash } from 'node:crypto';
import {
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANONICAL_TONE_SHA256 = 'e4df7c1075940a8d01285505c96e080a5adae2c819ae7f16a0e9338e6a228110';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SYNTHETIC_ORIGIN = 'https://attune.invalid';

interface ValidationIssue {
  code: string;
  index?: number;
  fieldPath?: string;
  recordingId?: string;
}

interface AudioEvidence {
  path: string;
  recordingId: string;
  sha256: string;
  sizeBytes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizedPath(value: string): string {
  return value.split(sep).join('/');
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortObjectKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

function serializeStable(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function parseArguments(argumentsList: readonly string[]): string {
  let manifestPath: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument !== '--manifest' || manifestPath !== undefined) {
      throw new Error('Usage: validate-content.ts --manifest <manifest-path>');
    }
    manifestPath = argumentsList[index + 1];
    index += 1;
  }
  if (manifestPath === undefined) {
    throw new Error('Usage: validate-content.ts --manifest <manifest-path>');
  }
  return manifestPath;
}

function resolveLocalAudioPath(audioUrl: string, manifestPath: string, publicRoot: string): {
  absolutePath?: string;
  external: boolean;
} {
  const relativeManifestPath = normalizedPath(relative(publicRoot, manifestPath));
  if (relativeManifestPath.startsWith('../') || isAbsolute(relativeManifestPath)) {
    throw new Error('Manifest must be inside the public directory.');
  }

  const baseUrl = new URL(`/${relativeManifestPath}`, SYNTHETIC_ORIGIN);
  const resolvedUrl = new URL(audioUrl, baseUrl);
  if (resolvedUrl.protocol !== 'https:') {
    throw new Error('Unsupported audio URL scheme.');
  }
  if (resolvedUrl.origin !== SYNTHETIC_ORIGIN) {
    return { external: true };
  }

  const pathSegments = resolvedUrl.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
  if (
    pathSegments.some((segment) =>
      segment === '.'
      || segment === '..'
      || segment.includes('\0')
      || segment.includes('/')
      || segment.includes('\\'))
  ) {
    throw new Error('Unsafe audio path.');
  }

  const absolutePath = resolve(publicRoot, ...pathSegments);
  const relativePath = relative(publicRoot, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Audio path escapes the public directory.');
  }
  return { absolutePath, external: false };
}

function validateEnvelope(value: unknown, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    issues.push({ code: 'MANIFEST_INVALID' });
    return undefined;
  }
  if (value.schemaVersion !== '1.0') {
    issues.push({ code: 'MANIFEST_INVALID', fieldPath: 'schemaVersion' });
  }
  if (!isPlainObject(value.collection)) {
    issues.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection' });
  } else {
    if (typeof value.collection.id !== 'string' || !ID_PATTERN.test(value.collection.id)) {
      issues.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.id' });
    }
    const title = typeof value.collection.title === 'string' ? value.collection.title.trim() : '';
    if (title.length === 0 || codePointLength(title) > 120) {
      issues.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.title' });
    }
  }
  if (value.map !== undefined && !isPlainObject(value.map)) {
    issues.push({ code: 'MANIFEST_INVALID', fieldPath: 'map' });
  }
  if (!Array.isArray(value.recordings)) {
    issues.push({ code: 'MANIFEST_INVALID', fieldPath: 'recordings' });
  }
  return value;
}

function validateRecord(
  value: unknown,
  index: number,
  manifestPath: string,
  publicRoot: string,
  issues: ValidationIssue[],
  warnings: ValidationIssue[],
  audioFiles: AudioEvidence[],
): string | undefined {
  if (!isPlainObject(value)) {
    issues.push({ code: 'RECORD_NOT_OBJECT', index });
    return undefined;
  }

  const id = typeof value.id === 'string' && ID_PATTERN.test(value.id) ? value.id : undefined;
  if (id === undefined) {
    issues.push({ code: 'ID_INVALID', fieldPath: 'id', index });
  }
  const issueBase = id === undefined ? { index } : { index, recordingId: id };
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (title.length === 0 || codePointLength(title) > 120) {
    issues.push({ ...issueBase, code: 'TITLE_INVALID', fieldPath: 'title' });
  }
  const location = value.location;
  if (
    !isPlainObject(location)
    || typeof location.lat !== 'number'
    || !Number.isFinite(location.lat)
    || location.lat < -90
    || location.lat > 90
    || typeof location.lon !== 'number'
    || !Number.isFinite(location.lon)
    || location.lon < -180
    || location.lon > 180
  ) {
    issues.push({ ...issueBase, code: 'COORDINATE_INVALID', fieldPath: 'location' });
  }
  if (value.spatialFormat !== 'point-source') {
    issues.push({ ...issueBase, code: 'SPATIAL_FORMAT_UNSUPPORTED', fieldPath: 'spatialFormat' });
  }

  const audioUrl = typeof value.audioUrl === 'string' ? value.audioUrl.trim() : '';
  if (audioUrl.length === 0 || codePointLength(audioUrl) > 2_048) {
    issues.push({ ...issueBase, code: 'AUDIO_URL_INVALID', fieldPath: 'audioUrl' });
  } else if (id !== undefined) {
    try {
      const resolution = resolveLocalAudioPath(audioUrl, manifestPath, publicRoot);
      if (resolution.external) {
        warnings.push({ ...issueBase, code: 'EXTERNAL_AUDIO_NOT_FILE_CHECKED', fieldPath: 'audioUrl' });
      } else if (resolution.absolutePath !== undefined) {
        const fileStat = statSync(resolution.absolutePath);
        if (!fileStat.isFile()) {
          throw new Error('Audio path is not a regular file.');
        }
        const bytes = readFileSync(resolution.absolutePath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const relativeAudioPath = normalizedPath(relative(publicRoot, resolution.absolutePath));
        audioFiles.push({ path: relativeAudioPath, recordingId: id, sha256, sizeBytes: bytes.byteLength });
        if (relativeAudioPath === 'audio/test-tone.wav' && sha256 !== CANONICAL_TONE_SHA256) {
          issues.push({ ...issueBase, code: 'AUDIO_FIXTURE_HASH_MISMATCH', fieldPath: 'audioUrl' });
        }
      }
    } catch {
      issues.push({ ...issueBase, code: 'AUDIO_FILE_INVALID', fieldPath: 'audioUrl' });
    }
  }
  return id;
}

let exitCode = 0;
try {
  const suppliedManifestPath = parseArguments(process.argv.slice(2));
  const manifestPath = resolve(suppliedManifestPath);
  const publicRoot = resolve('public');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const audioFiles: AudioEvidence[] = [];
  const envelope = validateEnvelope(parsed, issues);
  const ids = new Map<string, number>();

  if (envelope !== undefined && Array.isArray(envelope.recordings)) {
    envelope.recordings.forEach((record, index) => {
      const id = validateRecord(record, index, manifestPath, publicRoot, issues, warnings, audioFiles);
      if (id !== undefined) {
        const ownerIndex = ids.get(id);
        if (ownerIndex === undefined) {
          ids.set(id, index);
        } else {
          issues.push({ code: 'ID_DUPLICATE', fieldPath: 'id', index, recordingId: id });
        }
      }
    });
  }

  const summary = {
    audioFiles,
    errors: issues,
    manifest: normalizedPath(relative(process.cwd(), manifestPath)),
    recordCount: envelope !== undefined && Array.isArray(envelope.recordings) ? envelope.recordings.length : 0,
    status: issues.length === 0 ? 'ok' : 'error',
    warnings,
  };
  const outputPath = resolve('artifacts/content-validation.json');
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serializeStable(summary), 'utf8');
  renameSync(temporaryPath, outputPath);

  if (issues.length > 0) {
    console.error(`Content validation failed with ${issues.length} error(s).`);
    exitCode = 1;
  } else {
    console.log(`Validated ${summary.recordCount} recording(s); evidence: ${normalizedPath(relative(process.cwd(), outputPath))}`);
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : 'Content validation failed.');
  exitCode = 1;
}
process.exitCode = exitCode;
