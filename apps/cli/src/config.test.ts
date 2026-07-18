import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('returns safe defaults when no explicit config is provided', async () => {
    await expect(loadConfig()).resolves.toMatchObject({
      config: {
        semantic: { required: false, providers: [] },
        compile: { strict: true },
      },
    });
  });

  it('loads provider modules from YAML without embedding credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'himcp-config-'));
    const location = join(directory, 'config.yaml');
    await writeFile(
      location,
      [
        'semantic:',
        '  required: true',
        '  providers:',
        '    - module: "@example/himcp-provider"',
        '      settings:',
        '        modelProfile: "schema-reasoning"',
      ].join('\n'),
    );

    await expect(loadConfig(location)).resolves.toMatchObject({
      config: {
        semantic: {
          required: true,
          providers: [
            {
              module: '@example/himcp-provider',
              export: 'createSemanticProvider',
              enabled: true,
              settings: { modelProfile: 'schema-reasoning' },
            },
          ],
        },
      },
      location,
    });
  });
});
