import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';
import { compileSource } from './pipeline.js';
import { createProgram } from './program.js';

const fixtureLocation = new URL('../../../examples/customer-support/openapi.yaml', import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('diff CLI', () => {
  it('writes a machine-readable diff and enforces the breaking-change threshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hi-mcp-diff-'));
    temporaryDirectories.push(directory);
    const source = await readFile(fixtureLocation, 'utf8');
    const defaults = (await loadConfig()).config;
    const config = { ...defaults, compile: { ...defaults.compile, strict: false } };
    const compiled = await compileSource({
      source,
      location: fixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
    });
    const releasePath = join(directory, 'baseline.release.json');
    const sourcePath = join(directory, 'current.openapi.yaml');
    await writeFile(releasePath, `${JSON.stringify(compiled.release)}\n`, { mode: 0o600 });
    await writeFile(sourcePath, source.replace('minLength: 1', 'minLength: 2'), { mode: 0o600 });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync([
      'node',
      'himcp',
      'diff',
      releasePath,
      sourcePath,
      '--source-type',
      'openapi',
      '--fail-on',
      'breaking',
      '--json',
    ]);

    const report = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
      summary: { breaking: number };
      operations: Array<{ areas: string[] }>;
    };
    expect(report.summary.breaking).toBe(1);
    expect(report.operations).toContainEqual(
      expect.objectContaining({ areas: expect.arrayContaining(['input-schema']) }),
    );
    expect(process.exitCode).toBe(1);
  });
});
