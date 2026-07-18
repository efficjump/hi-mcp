import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  InvalidReleaseJsonError,
  ReleaseFileTooLargeError,
  readReleaseFile,
} from './release-file.js';

const temporaryDirectories: string[] = [];

async function temporaryFile(content: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hi-mcp-runtime-'));
  temporaryDirectories.push(directory);
  const location = join(directory, 'release.json');
  await writeFile(location, content);
  return location;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('readReleaseFile', () => {
  it('reads and parses a JSON release within the configured byte limit', async () => {
    const location = await temporaryFile('{"schemaVersion":"1.0"}');

    await expect(readReleaseFile(location, { maxBytes: 128 })).resolves.toEqual({
      schemaVersion: '1.0',
    });
  });

  it('rejects an oversized file before allocating its declared size', async () => {
    const location = await temporaryFile(Buffer.alloc(33, 0x20));

    await expect(readReleaseFile(location, { maxBytes: 32 })).rejects.toBeInstanceOf(
      ReleaseFileTooLargeError,
    );
  });

  it('returns a sanitized parse error for malformed JSON', async () => {
    const location = await temporaryFile('{"secret":"not closed"');

    await expect(readReleaseFile(location)).rejects.toBeInstanceOf(InvalidReleaseJsonError);
  });
});
