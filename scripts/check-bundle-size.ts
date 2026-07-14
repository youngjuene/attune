import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

function collectJavaScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(absolutePath);
    }
  }
  return files;
}

const [distArgument, ceilingArgument] = process.argv.slice(2);
if (distArgument === undefined || ceilingArgument === undefined) {
  console.error('Usage: check-bundle-size.ts <dist-directory> <gzip-byte-ceiling>');
  process.exitCode = 2;
} else {
  const distDirectory = resolve(distArgument);
  const assetsDirectory = join(distDirectory, 'assets');
  const ceiling = Number(ceilingArgument);
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0 || !statSync(assetsDirectory).isDirectory()) {
    console.error('Bundle directory or byte ceiling is invalid.');
    process.exitCode = 2;
  } else {
    const files = collectJavaScriptFiles(assetsDirectory)
      .map((absolutePath) => ({
        absolutePath,
        relativePath: relative(distDirectory, absolutePath).split(sep).join('/'),
      }))
      .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);

    let total = 0;
    for (const file of files) {
      const gzipBytes = gzipSync(readFileSync(file.absolutePath), { level: 9 }).byteLength;
      total += gzipBytes;
      console.log(`${file.relativePath}: ${gzipBytes} gzip bytes`);
    }
    console.log(`total: ${total} gzip bytes (ceiling: ${ceiling})`);

    if (total > ceiling) {
      console.error(`Bundle exceeds the gzip ceiling by ${total - ceiling} bytes.`);
      process.exitCode = 1;
    }
  }
}
