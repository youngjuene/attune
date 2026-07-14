const argumentsSet = new Set(process.argv.slice(2));
const unknownArguments = [...argumentsSet].filter((argument) => argument !== '--write');
const writeRequested = argumentsSet.has('--write');

if (unknownArguments.length > 0) {
  console.error(`Unknown argument(s): ${unknownArguments.join(', ')}`);
}

console.error(
  `G-01 is open: representative source metadata and an approved field mapping are required before ${
    writeRequested ? 'writing' : 'dry-running'
  } the content adapter.`,
);
process.exitCode = 2;
