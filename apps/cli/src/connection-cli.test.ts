import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseConnectionProfile } from './connection-profile.js';
import { createProgram } from './program.js';
import { exampleReleaseForConnectionTest } from './test-fixtures/connection-release.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixtureFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'hi-mcp-connection-'));
  temporaryDirectories.push(directory);
  const releasePath = join(directory, 'api.release.json');
  const profilePath = join(directory, 'api.connection.json');
  const descriptorPath = join(directory, 'mcp.json');
  await writeFile(releasePath, `${JSON.stringify(exampleReleaseForConnectionTest())}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { releasePath, profilePath, descriptorPath };
}

describe('connection CLI', () => {
  it('creates a reviewed profile and exports a shell-free MCP descriptor', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { releasePath, profilePath, descriptorPath } = await fixtureFiles();

    await createProgram().parseAsync([
      'node',
      'himcp',
      'connection',
      'create',
      releasePath,
      '--name',
      'Fixture API',
      '--approve-origin',
      'https://api.example.com',
      '--credential-env',
      'ApiKey=FIXTURE_API_KEY',
      '--output',
      profilePath,
    ]);
    const profile = parseConnectionProfile(JSON.parse(await readFile(profilePath, 'utf8')));
    expect(profile.release.path).toBe('./api.release.json');
    expect(profile.policy.approvedOrigins).toEqual(['https://api.example.com']);
    expect(
      profile.credentialBindings.find(({ scheme }) => scheme === 'ApiKey')?.environmentVariable,
    ).toBe('FIXTURE_API_KEY');
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);

    await createProgram().parseAsync([
      'node',
      'himcp',
      'connection',
      'export',
      profilePath,
      '--output',
      descriptorPath,
    ]);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(descriptor.mcpServers[profile.id]).toEqual({
      command: process.execPath,
      args: [expect.stringMatching(/bin\.js$/), 'serve-profile', profilePath],
    });
    expect(JSON.stringify(descriptor)).not.toContain('FIXTURE_API_KEY');
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);

    const releaseBefore = await readFile(releasePath, 'utf8');
    await expect(
      createProgram().parseAsync([
        'node',
        'himcp',
        'connection',
        'export',
        profilePath,
        '--output',
        releasePath,
        '--force',
      ]),
    ).rejects.toThrow(/cannot overwrite its connection profile or referenced release/);
    expect(await readFile(releasePath, 'utf8')).toBe(releaseBefore);
  });

  it('requires explicit approval of every release origin', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { releasePath, profilePath } = await fixtureFiles();

    await expect(
      createProgram().parseAsync([
        'node',
        'himcp',
        'connection',
        'create',
        releasePath,
        '--name',
        'Fixture API',
        '--output',
        profilePath,
      ]),
    ).rejects.toThrow(/Explicitly approve every release origin/);
  });
});
