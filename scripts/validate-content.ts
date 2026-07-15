import { createHash } from 'node:crypto';
import {
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ContentWarning, RejectedRecord } from '../src/domain/types';
import {
  isPlainObject,
  isSyntacticallyValidId,
  validateManifestDocument,
  type EnvelopeDiagnostic,
} from '../src/data/validateManifest';

const CANONICAL_TONE_SHA256 = 'e4df7c1075940a8d01285505c96e080a5adae2c819ae7f16a0e9338e6a228110';
const SYNTHETIC_ORIGIN = 'https://attune.invalid';

interface FileDiagnostic {
  code: 'AUDIO_FILE_INVALID' | 'AUDIO_FIXTURE_HASH_MISMATCH';
  fieldPath: 'audioUrl';
  id: string;
  index: number;
}

interface EmptySetDiagnostic {
  code: 'NO_VALID_RECORDINGS';
  fieldPath: 'recordings';
}

interface AudioEvidence {
  path: string;
  recordingId: string;
  sha256: string;
  sizeBytes: number;
}

export interface ContentValidationSummary {
  audioFiles: readonly AudioEvidence[];
  errors: readonly (EnvelopeDiagnostic | RejectedRecord | FileDiagnostic | EmptySetDiagnostic)[];
  manifest: string;
  normalizedManifest?: unknown;
  recordCount: number;
  rejectedRecordCount: number;
  status: 'ok' | 'error';
  validRecordCount: number;
  warnings: readonly ContentWarning[];
}

function normalizedPath(value: string): string {
  return value.split(sep).join('/');
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortObjectKeys(value[key]);
  return sorted;
}

export function serializeStable(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function parseArguments(argumentsList: readonly string[]): string {
  if (argumentsList.length !== 2 || argumentsList[0] !== '--manifest' || argumentsList[1] === undefined) {
    throw new Error('Usage: validate-content.ts --manifest <manifest-path>');
  }
  return argumentsList[1];
}

function pathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function syntheticManifestUrl(manifestPath: string, publicRoot: string): string {
  if (!pathInside(publicRoot, manifestPath)) throw new Error('Manifest must be inside the public directory.');
  const relativePath = normalizedPath(relative(publicRoot, manifestPath));
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  return new URL(`/${encodedPath}`, SYNTHETIC_ORIGIN).href;
}

/** Map a same-origin synthetic public URL back to a contained local path. */
export function resolvePublicAudioPath(resolvedAudioUrl: string, publicRoot: string): string | undefined {
  const url = new URL(resolvedAudioUrl);
  if (url.origin !== SYNTHETIC_ORIGIN) return undefined;
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (decoded === '.' || decoded === '..' || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error('Unsafe audio path.');
    }
    return decoded;
  });
  const absolutePath = resolve(publicRoot, ...segments);
  if (!pathInside(publicRoot, absolutePath)) throw new Error('Audio path escapes the public directory.');
  return absolutePath;
}

function inspectAudioFiles(
  records: NonNullable<ReturnType<typeof validateManifestDocument>['result']>['records'],
  publicRoot: string,
  sourceIndexById: ReadonlyMap<string, number>,
): { audioFiles: AudioEvidence[]; errors: FileDiagnostic[] } {
  const audioFiles: AudioEvidence[] = [];
  const errors: FileDiagnostic[] = [];
  records.forEach((record) => {
    const index = sourceIndexById.get(record.id) ?? 0;
    try {
      const absolutePath = resolvePublicAudioPath(record.resolvedAudioUrl, publicRoot);
      if (absolutePath === undefined) return;
      const fileStat = statSync(absolutePath);
      if (!fileStat.isFile()) throw new Error('Not a regular file.');
      const bytes = readFileSync(absolutePath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = normalizedPath(relative(publicRoot, absolutePath));
      audioFiles.push({ path, recordingId: record.id, sha256, sizeBytes: bytes.byteLength });
      if (path === 'audio/test-tone.wav' && sha256 !== CANONICAL_TONE_SHA256) {
        errors.push({ code: 'AUDIO_FIXTURE_HASH_MISMATCH', fieldPath: 'audioUrl', id: record.id, index });
      }
    } catch {
      errors.push({ code: 'AUDIO_FILE_INVALID', fieldPath: 'audioUrl', id: record.id, index });
    }
  });
  return { audioFiles, errors };
}

/** Validate one committed manifest and atomically emit its stable evidence artifact. */
export function runContentValidation(
  argumentsList: readonly string[],
  options: { cwd?: string; publicRoot?: string; outputPath?: string } = {},
): { exitCode: 0 | 1; summary: ContentValidationSummary; serialized: string } {
  const cwd = resolve(options.cwd ?? process.cwd());
  const publicRoot = resolve(options.publicRoot ?? resolve(cwd, 'public'));
  const manifestPath = resolve(cwd, parseArguments(argumentsList));
  const outputPath = resolve(options.outputPath ?? resolve(cwd, 'artifacts/content-validation.json'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    parsed = undefined;
  }
  const validation = validateManifestDocument(parsed, syntheticManifestUrl(manifestPath, publicRoot));
  const result = validation.result;
  const sourceIndexById = new Map<string, number>();
  if (isPlainObject(parsed) && Array.isArray(parsed.recordings)) {
    parsed.recordings.forEach((record, index) => {
      if (isPlainObject(record) && isSyntacticallyValidId(record.id) && !sourceIndexById.has(record.id)) {
        sourceIndexById.set(record.id, index);
      }
    });
  }
  const fileInspection = result === undefined
    ? { audioFiles: [], errors: [] }
    : inspectAudioFiles(result.records, publicRoot, sourceIndexById);
  const errors: Array<EnvelopeDiagnostic | RejectedRecord | FileDiagnostic | EmptySetDiagnostic> = [
    ...validation.envelopeErrors,
    ...(result?.rejected ?? []),
    ...fileInspection.errors,
  ];
  if (result !== undefined && result.records.length === 0) {
    errors.push({ code: 'NO_VALID_RECORDINGS', fieldPath: 'recordings' });
  }
  const summary: ContentValidationSummary = {
    audioFiles: fileInspection.audioFiles,
    errors,
    manifest: normalizedPath(relative(cwd, manifestPath)),
    ...(result === undefined ? {} : { normalizedManifest: result.manifest }),
    recordCount: validation.sourceRecordCount,
    rejectedRecordCount: result?.rejected.length ?? 0,
    status: errors.length === 0 ? 'ok' : 'error',
    validRecordCount: result?.records.length ?? 0,
    warnings: result?.warnings ?? [],
  };
  const serialized = serializeStable(summary);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serialized, 'utf8');
  renameSync(temporaryPath, outputPath);
  return { exitCode: errors.length === 0 ? 0 : 1, summary, serialized };
}

function main(): void {
  try {
    const outcome = runContentValidation(process.argv.slice(2));
    const evidencePath = normalizedPath(relative(process.cwd(), resolve('artifacts/content-validation.json')));
    if (outcome.exitCode === 0) {
      console.log(`Validated ${outcome.summary.validRecordCount} recording(s); evidence: ${evidencePath}`);
    } else {
      console.error(`Content validation failed with ${outcome.summary.errors.length} error(s); evidence: ${evidencePath}`);
      for (const issue of outcome.summary.errors) {
        const location = 'index' in issue ? ` record ${issue.index}` : '';
        const field = issue.fieldPath === undefined ? '' : ` at ${issue.fieldPath}`;
        console.error(`- ${issue.code}${location}${field}`);
      }
    }
    process.exitCode = outcome.exitCode;
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'Content validation failed.');
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
