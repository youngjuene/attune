import type { AdaptSourceMetadata } from '../domain/types';

export const SOURCE_METADATA_GATE_MESSAGE =
  'G-01 is open: representative source metadata and an approved field mapping are required.';

/**
 * The concrete adapter boundary. It remains an explicit deterministic gate until
 * the content owner supplies and approves a representative source mapping.
 */
export const adaptSourceMetadata: AdaptSourceMetadata = (_input) => {
  throw new Error(SOURCE_METADATA_GATE_MESSAGE);
};
