import { AppError } from '../app/errors';
import type { CreateManifestService, ManifestLoadResult } from '../domain/types';
import { validateManifestDocument } from './validateManifest';

async function loadManifest(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<ManifestLoadResult> {
  let response: Response;
  try {
    response = signal === undefined
      ? await fetchImpl(url)
      : await fetchImpl(url, { signal });
  } catch (cause) {
    throw new AppError('MANIFEST_LOAD_FAILED', { cause });
  }
  if (!response.ok) {
    throw new AppError('MANIFEST_LOAD_FAILED');
  }

  let input: unknown;
  try {
    input = await response.json() as unknown;
  } catch (cause) {
    throw new AppError(cause instanceof SyntaxError ? 'MANIFEST_INVALID' : 'MANIFEST_LOAD_FAILED', { cause });
  }

  const validation = validateManifestDocument(input, response.url || url);
  if (validation.envelopeErrors.length > 0 || validation.result === undefined) {
    throw new AppError('MANIFEST_INVALID');
  }
  if (validation.result.records.length === 0) {
    throw new AppError('NO_VALID_RECORDINGS');
  }
  return validation.result;
}

/** Create the single runtime manifest service around an injected fetch implementation. */
export const createManifestService: CreateManifestService = (fetchImpl) => ({
  load: (url, signal) => loadManifest(fetchImpl, url, signal),
});
