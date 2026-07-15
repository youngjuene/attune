// Shared pure validation used by both runtime loading and build-time content checks.
import type {
  ContentRejectionCode,
  ContentWarning,
  ContentWarningCode,
  ManifestLoadResult,
  NormalizedManifest,
  NormalizedRecording,
  RejectedRecord,
} from '../domain/types';

export interface EnvelopeDiagnostic {
  code: 'MANIFEST_INVALID';
  fieldPath?: string;
}

export interface ManifestDocumentValidation {
  envelopeErrors: readonly EnvelopeDiagnostic[];
  result?: ManifestLoadResult;
  sourceRecordCount: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RECORDED_AT_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

const RECORD_FIELDS = [
  'id',
  'title',
  'audioUrl',
  'location',
  'spatialFormat',
  'durationSec',
  'recordedAt',
  'mimeType',
  'gainDb',
  'tags',
  'description',
  'credit',
] as const;
const LOCATION_FIELDS = ['lat', 'lon'] as const;
const ENVELOPE_FIELDS = ['schemaVersion', 'collection', 'map', 'recordings'] as const;
const COLLECTION_FIELDS = ['id', 'title', 'description', 'defaultSpatialRadiusM'] as const;
const MAP_FIELDS = ['distanceScale', 'maxDistanceM'] as const;

const REJECTION_CODE_ORDER: readonly ContentRejectionCode[] = [
  'RECORD_NOT_OBJECT',
  'ID_INVALID',
  'ID_DUPLICATE',
  'TITLE_INVALID',
  'AUDIO_URL_INVALID',
  'COORDINATE_INVALID',
  'SPATIAL_FORMAT_UNSUPPORTED',
  'DURATION_INVALID',
  'RECORDED_AT_INVALID',
  'MIME_TYPE_INVALID',
  'GAIN_INVALID',
  'TAG_INVALID',
  'FIELD_TYPE_INVALID',
  'FIELD_LIMIT_EXCEEDED',
];
const WARNING_CODE_ORDER: readonly ContentWarningCode[] = [
  'UNKNOWN_FIELD_STRIPPED',
  'GAIN_CLAMPED',
  'EMPTY_TAG_REMOVED',
  'DUPLICATE_TAG_REMOVED',
  'EXTERNAL_AUDIO_NOT_FILE_CHECKED',
];

const FIELD_RANK: Readonly<Record<string, number>> = {
  '': 0,
  id: 1,
  'id:duplicate': 2,
  title: 3,
  audioUrl: 4,
  location: 5,
  spatialFormat: 6,
  durationSec: 7,
  recordedAt: 8,
  mimeType: 9,
  gainDb: 10,
  tags: 11,
  description: 12,
  credit: 13,
};

interface RecordCandidate {
  id?: string;
  normalized?: NormalizedRecording;
  rejections: RejectedRecord[];
  warnings: ContentWarning[];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSyntacticallyValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unknownKeys(object: Record<string, unknown>, known: readonly string[]): string[] {
  const knownSet = new Set(known);
  return Object.keys(object).filter((key) => !knownSet.has(key)).sort(compareCodeUnits);
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function resolveAllowedAudioUrl(audioUrl: string, manifestResponseUrl: string): URL | undefined {
  try {
    const base = new URL(manifestResponseUrl);
    const resolved = new URL(audioUrl, base);
    if (resolved.protocol === 'https:') return resolved;
    if (
      resolved.protocol === 'http:'
      && resolved.origin === base.origin
      && base.protocol === 'http:'
      && isLocalDevelopmentHostname(base.hostname)
    ) {
      return resolved;
    }
  } catch {
    // The caller maps all URL construction failures to AUDIO_URL_INVALID.
  }
  return undefined;
}

function isValidRecordedAt(value: string): boolean {
  const match = RECORDED_AT_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function rejection(
  index: number,
  id: string | undefined,
  code: ContentRejectionCode,
  fieldPath?: string,
): RejectedRecord {
  return {
    index,
    ...(id === undefined ? {} : { id }),
    code,
    ...(fieldPath === undefined ? {} : { fieldPath }),
  };
}

function warning(
  index: number,
  id: string,
  code: ContentWarningCode,
  fieldPath: string,
): ContentWarning {
  return { index, id, code, fieldPath };
}

/** Validate and normalize one record before duplicate-ID ownership is applied. */
export function validateRecordingRecord(
  value: unknown,
  index: number,
  manifestResponseUrl: string,
): RecordCandidate {
  if (!isPlainObject(value)) {
    return { rejections: [rejection(index, undefined, 'RECORD_NOT_OBJECT')], warnings: [] };
  }

  const rejections: RejectedRecord[] = [];
  const warnings: ContentWarning[] = [];
  const id = isSyntacticallyValidId(value.id) ? value.id : undefined;
  if (id === undefined) rejections.push(rejection(index, undefined, 'ID_INVALID', 'id'));

  let title: string | undefined;
  if (typeof value.title !== 'string' || (title = value.title.trim()).length === 0) {
    rejections.push(rejection(index, id, 'TITLE_INVALID', 'title'));
  } else if (codePointLength(title) > 120) {
    rejections.push(rejection(index, id, 'FIELD_LIMIT_EXCEEDED', 'title'));
  }

  let audioUrl: string | undefined;
  let resolvedAudioUrl: string | undefined;
  if (typeof value.audioUrl !== 'string' || (audioUrl = value.audioUrl.trim()).length === 0) {
    rejections.push(rejection(index, id, 'AUDIO_URL_INVALID', 'audioUrl'));
  } else if (codePointLength(audioUrl) > 2_048) {
    rejections.push(rejection(index, id, 'FIELD_LIMIT_EXCEEDED', 'audioUrl'));
  } else {
    const resolved = resolveAllowedAudioUrl(audioUrl, manifestResponseUrl);
    if (resolved === undefined) {
      rejections.push(rejection(index, id, 'AUDIO_URL_INVALID', 'audioUrl'));
    } else {
      resolvedAudioUrl = resolved.href;
      const base = new URL(manifestResponseUrl);
      if (resolved.origin !== base.origin && id !== undefined) {
        warnings.push(warning(index, id, 'EXTERNAL_AUDIO_NOT_FILE_CHECKED', 'audioUrl'));
      }
    }
  }

  const location = value.location;
  let normalizedLocation: { lat: number; lon: number } | undefined;
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
    rejections.push(rejection(index, id, 'COORDINATE_INVALID', 'location'));
  } else {
    normalizedLocation = { lat: location.lat, lon: location.lon };
    if (id !== undefined) {
      for (const key of unknownKeys(location, LOCATION_FIELDS)) {
        warnings.push(warning(index, id, 'UNKNOWN_FIELD_STRIPPED', `location.${key}`));
      }
    }
  }

  if (value.spatialFormat !== 'point-source') {
    rejections.push(rejection(index, id, 'SPATIAL_FORMAT_UNSUPPORTED', 'spatialFormat'));
  }

  let durationSec: number | undefined;
  if (value.durationSec !== undefined) {
    if (typeof value.durationSec !== 'number' || !Number.isFinite(value.durationSec) || value.durationSec < 0) {
      rejections.push(rejection(index, id, 'DURATION_INVALID', 'durationSec'));
    } else {
      durationSec = value.durationSec;
    }
  }

  let recordedAt: string | undefined;
  if (value.recordedAt !== undefined) {
    if (typeof value.recordedAt !== 'string' || !isValidRecordedAt(value.recordedAt)) {
      rejections.push(rejection(index, id, 'RECORDED_AT_INVALID', 'recordedAt'));
    } else {
      recordedAt = value.recordedAt;
    }
  }

  let mimeType: string | undefined;
  if (value.mimeType !== undefined) {
    if (
      typeof value.mimeType !== 'string'
      || (mimeType = value.mimeType.trim()).length === 0
      || CONTROL_CHARACTER_PATTERN.test(mimeType)
      || !/^audio\//i.test(mimeType)
    ) {
      rejections.push(rejection(index, id, 'MIME_TYPE_INVALID', 'mimeType'));
    } else if (codePointLength(mimeType) > 100) {
      rejections.push(rejection(index, id, 'FIELD_LIMIT_EXCEEDED', 'mimeType'));
    }
  }

  let gainDb = 0;
  if (value.gainDb !== undefined) {
    if (typeof value.gainDb !== 'number' || !Number.isFinite(value.gainDb)) {
      rejections.push(rejection(index, id, 'GAIN_INVALID', 'gainDb'));
    } else {
      gainDb = Math.min(6, Math.max(-24, value.gainDb));
      if (gainDb !== value.gainDb && id !== undefined) {
        warnings.push(warning(index, id, 'GAIN_CLAMPED', 'gainDb'));
      }
    }
  }

  const tags: string[] = [];
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')) {
      rejections.push(rejection(index, id, 'TAG_INVALID', 'tags'));
    } else if (
      value.tags.length > 20
      || value.tags.some((tag) => codePointLength(tag.trim()) > 40)
    ) {
      rejections.push(rejection(index, id, 'FIELD_LIMIT_EXCEEDED', 'tags'));
    } else {
      const seen = new Set<string>();
      value.tags.forEach((tag, tagIndex) => {
        const trimmed = tag.trim();
        if (trimmed.length === 0) {
          if (id !== undefined) warnings.push(warning(index, id, 'EMPTY_TAG_REMOVED', `tags.${tagIndex}`));
        } else if (seen.has(trimmed)) {
          if (id !== undefined) warnings.push(warning(index, id, 'DUPLICATE_TAG_REMOVED', `tags.${tagIndex}`));
        } else {
          seen.add(trimmed);
          tags.push(trimmed);
        }
      });
    }
  }

  let description: string | undefined;
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') {
      rejections.push(rejection(index, id, 'FIELD_TYPE_INVALID', 'description'));
    } else {
      const trimmed = value.description.trim();
      if (codePointLength(trimmed) > 1_000) {
        rejections.push(rejection(index, id, 'FIELD_LIMIT_EXCEEDED', 'description'));
      } else if (trimmed.length > 0) {
        description = trimmed;
      }
    }
  }

  let credit: string | undefined;
  if (value.credit !== undefined) {
    if (typeof value.credit !== 'string') {
      rejections.push(rejection(index, id, 'FIELD_TYPE_INVALID', 'credit'));
    } else {
      const trimmed = value.credit.trim();
      if (codePointLength(trimmed) > 200) {
        rejections.push(rejection(index, id, 'FIELD_LIMIT_EXCEEDED', 'credit'));
      } else if (trimmed.length > 0) {
        credit = trimmed;
      }
    }
  }

  if (id !== undefined) {
    for (const key of unknownKeys(value, RECORD_FIELDS)) {
      warnings.push(warning(index, id, 'UNKNOWN_FIELD_STRIPPED', key));
    }
  }

  const normalized = rejections.length === 0 && id !== undefined && title !== undefined
    && audioUrl !== undefined && resolvedAudioUrl !== undefined && normalizedLocation !== undefined
    ? {
        id,
        title,
        audioUrl,
        ...(mimeType === undefined ? {} : { mimeType }),
        location: normalizedLocation,
        spatialFormat: 'point-source' as const,
        ...(durationSec === undefined ? {} : { durationSec }),
        ...(recordedAt === undefined ? {} : { recordedAt }),
        ...(description === undefined ? {} : { description }),
        tags,
        gainDb,
        ...(credit === undefined ? {} : { credit }),
        resolvedAudioUrl,
      }
    : undefined;
  return { ...(id === undefined ? {} : { id }), ...(normalized === undefined ? {} : { normalized }), rejections, warnings };
}

function rejectionRank(value: RejectedRecord): number {
  if (value.code === 'ID_DUPLICATE') return FIELD_RANK['id:duplicate'] ?? 2;
  return FIELD_RANK[value.fieldPath ?? ''] ?? Number.MAX_SAFE_INTEGER;
}

function sortRejections(values: RejectedRecord[]): RejectedRecord[] {
  const codeRank = new Map(REJECTION_CODE_ORDER.map((code, index) => [code, index]));
  return values.sort((left, right) =>
    left.index - right.index
    || rejectionRank(left) - rejectionRank(right)
    || compareCodeUnits(left.fieldPath ?? '', right.fieldPath ?? '')
    || (codeRank.get(left.code) ?? 999) - (codeRank.get(right.code) ?? 999));
}

function sortWarnings(values: ContentWarning[]): ContentWarning[] {
  const codeRank = new Map(WARNING_CODE_ORDER.map((code, index) => [code, index]));
  return values.sort((left, right) =>
    (left.index ?? -1) - (right.index ?? -1)
    || compareCodeUnits(left.fieldPath, right.fieldPath)
    || (codeRank.get(left.code) ?? 999) - (codeRank.get(right.code) ?? 999));
}

function envelopeWarning(code: ContentWarningCode, fieldPath: string): ContentWarning {
  return { code, fieldPath };
}

function validateEnvelope(value: unknown): {
  errors: EnvelopeDiagnostic[];
  warnings: ContentWarning[];
  normalized?: Omit<NormalizedManifest, 'recordings'>;
  recordings?: unknown[];
} {
  if (!isPlainObject(value)) return { errors: [{ code: 'MANIFEST_INVALID' }], warnings: [] };
  const errors: EnvelopeDiagnostic[] = [];
  const warnings: ContentWarning[] = [];
  if (value.schemaVersion !== '1.0') errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'schemaVersion' });

  let collection: NormalizedManifest['collection'] | undefined;
  if (!isPlainObject(value.collection)) {
    errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection' });
  } else {
    const candidate = value.collection;
    const idValid = isSyntacticallyValidId(candidate.id);
    if (!idValid) errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.id' });
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : undefined;
    if (title === undefined || title.length === 0 || codePointLength(title) > 120) {
      errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.title' });
    }
    let description: string | undefined;
    if (candidate.description !== undefined) {
      if (typeof candidate.description !== 'string') {
        errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.description' });
      } else {
        const trimmed = candidate.description.trim();
        if (codePointLength(trimmed) > 1_000) {
          errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.description' });
        } else if (trimmed.length > 0) description = trimmed;
      }
    }
    let defaultSpatialRadiusM: number | undefined;
    if (candidate.defaultSpatialRadiusM !== undefined) {
      if (
        typeof candidate.defaultSpatialRadiusM !== 'number'
        || !Number.isFinite(candidate.defaultSpatialRadiusM)
        || candidate.defaultSpatialRadiusM < 1.5
        || candidate.defaultSpatialRadiusM > 8
      ) {
        errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'collection.defaultSpatialRadiusM' });
      } else defaultSpatialRadiusM = candidate.defaultSpatialRadiusM;
    }
    for (const key of unknownKeys(candidate, COLLECTION_FIELDS)) {
      warnings.push(envelopeWarning('UNKNOWN_FIELD_STRIPPED', `collection.${key}`));
    }
    if (idValid && title !== undefined && title.length > 0 && codePointLength(title) <= 120) {
      collection = {
        id: candidate.id as string,
        title,
        ...(description === undefined ? {} : { description }),
        ...(defaultSpatialRadiusM === undefined ? {} : { defaultSpatialRadiusM }),
      };
    }
  }

  let map: NormalizedManifest['map'];
  if (value.map !== undefined) {
    if (!isPlainObject(value.map)) {
      errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'map' });
    } else {
      const candidate = value.map;
      let distanceScale: 'log' | 'linear' | undefined;
      if (candidate.distanceScale !== undefined) {
        if (candidate.distanceScale !== 'log' && candidate.distanceScale !== 'linear') {
          errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'map.distanceScale' });
        } else distanceScale = candidate.distanceScale;
      }
      let maxDistanceM: number | undefined;
      if (candidate.maxDistanceM !== undefined) {
        if (typeof candidate.maxDistanceM !== 'number' || !Number.isFinite(candidate.maxDistanceM) || candidate.maxDistanceM <= 0) {
          errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'map.maxDistanceM' });
        } else maxDistanceM = candidate.maxDistanceM;
      }
      for (const key of unknownKeys(candidate, MAP_FIELDS)) {
        warnings.push(envelopeWarning('UNKNOWN_FIELD_STRIPPED', `map.${key}`));
      }
      map = {
        ...(distanceScale === undefined ? {} : { distanceScale }),
        ...(maxDistanceM === undefined ? {} : { maxDistanceM }),
      };
    }
  }

  const recordings = Array.isArray(value.recordings) ? value.recordings : undefined;
  if (recordings === undefined) errors.push({ code: 'MANIFEST_INVALID', fieldPath: 'recordings' });
  for (const key of unknownKeys(value, ENVELOPE_FIELDS)) {
    warnings.push(envelopeWarning('UNKNOWN_FIELD_STRIPPED', key));
  }
  const normalized = collection === undefined ? undefined : {
    schemaVersion: '1.0' as const,
    collection,
    ...(map === undefined ? {} : { map }),
  };
  return { errors, warnings, ...(normalized === undefined ? {} : { normalized }), ...(recordings === undefined ? {} : { recordings }) };
}

/** Validate a parsed manifest without I/O. Envelope failures prevent record evaluation. */
export function validateManifestDocument(input: unknown, manifestResponseUrl: string): ManifestDocumentValidation {
  const envelope = validateEnvelope(input);
  const sourceRecordCount = envelope.recordings?.length ?? 0;
  if (envelope.errors.length > 0 || envelope.normalized === undefined || envelope.recordings === undefined) {
    return { envelopeErrors: envelope.errors, sourceRecordCount };
  }

  const candidates = envelope.recordings.map((record, index) =>
    validateRecordingRecord(record, index, manifestResponseUrl));
  const duplicateOwners = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.id === undefined) continue;
    const owner = duplicateOwners.get(candidate.id);
    if (owner === undefined) duplicateOwners.set(candidate.id, index);
    else candidate.rejections.push(rejection(index, candidate.id, 'ID_DUPLICATE', 'id'));
  }

  const records: NormalizedRecording[] = [];
  const rejected: RejectedRecord[] = [];
  const warnings = [...envelope.warnings];
  candidates.forEach((candidate) => {
    if (candidate.rejections.length > 0 || candidate.normalized === undefined) {
      rejected.push(...candidate.rejections);
    } else {
      records.push(candidate.normalized);
      warnings.push(...candidate.warnings);
    }
  });
  sortRejections(rejected);
  sortWarnings(warnings);

  const manifestRecords = records.map(({ resolvedAudioUrl: _resolvedAudioUrl, ...record }) => record);
  const manifest: NormalizedManifest = {
    ...envelope.normalized,
    recordings: manifestRecords,
  };
  return {
    envelopeErrors: [],
    sourceRecordCount,
    result: { manifest, records, rejected, warnings },
  };
}

// Public package name matching the declared `validateManifest.ts` module.
export const validateManifest = validateManifestDocument;
