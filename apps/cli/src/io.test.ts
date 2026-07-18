import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readSourceInput, writeJsonAtomically } from './io.js';

describe('bounded CLI I/O', () => {
  it('rejects oversized files before returning their content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'himcp-io-'));
    const location = join(directory, 'oversized.yaml');
    await writeFile(location, '0123456789', 'utf8');

    await expect(readSourceInput(location, 5)).rejects.toThrow('5-byte input limit');
  });

  it('atomically writes private release files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'himcp-io-'));
    const location = join(directory, 'release.json');

    await writeJsonAtomically(location, { release: 'fixture' });

    expect(JSON.parse(await readFile(location, 'utf8'))).toEqual({ release: 'fixture' });
    expect((await stat(location)).mode & 0o777).toBe(0o600);
    await expect(writeJsonAtomically(location, { release: 'replacement' })).rejects.toThrow(
      /Refusing to replace existing file/,
    );
    expect(JSON.parse(await readFile(location, 'utf8'))).toEqual({ release: 'fixture' });

    await writeJsonAtomically(location, { release: 'replacement' }, { overwrite: true });
    expect(JSON.parse(await readFile(location, 'utf8'))).toEqual({ release: 'replacement' });
  });
});
