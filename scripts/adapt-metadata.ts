import { pathToFileURL } from 'node:url';

import {
  adaptSourceMetadata,
  SOURCE_METADATA_GATE_MESSAGE,
} from '../src/data/adapter';

export { adaptSourceMetadata };

export function runAdapter(argumentsList: readonly string[]): 1 | 2 {
  const writeCount = argumentsList.filter((argument) => argument === '--write').length;
  const unknownArguments = argumentsList.filter((argument) => argument !== '--write');
  if (unknownArguments.length > 0 || writeCount > 1) {
    console.error('Usage: adapt-metadata.ts [--write]');
    return 1;
  }
  const mode = writeCount === 1 ? 'write' : 'dry-run';
  console.error(`${SOURCE_METADATA_GATE_MESSAGE} Adapter mode: ${mode}.`);
  return 2;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = runAdapter(process.argv.slice(2));
}
