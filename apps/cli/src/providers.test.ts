import { describe, expect, it, vi } from 'vitest';
import { loadSemanticProviders } from './providers.js';

describe('loadSemanticProviders', () => {
  it('loads explicitly configured provider factories', async () => {
    const provider = {
      id: 'fixture-provider',
      listModels: vi.fn(async () => []),
      generateStructured: vi.fn(async () => ({ output: {} })),
    };
    const importer = vi.fn(async () => ({
      createSemanticProvider: async (settings: Readonly<Record<string, unknown>>) => {
        expect(settings).toEqual({ profile: 'reasoning' });
        return provider;
      },
    }));

    const result = await loadSemanticProviders(
      [
        {
          module: '@example/provider',
          export: 'createSemanticProvider',
          enabled: true,
          allowLocal: false,
          settings: { profile: 'reasoning' },
        },
      ],
      { importer },
    );

    expect(result).toEqual({ providers: [provider], failures: [] });
    expect(importer).toHaveBeenCalledWith('@example/provider');
  });

  it('reports invalid providers without preventing other providers from loading', async () => {
    const result = await loadSemanticProviders(
      [
        {
          module: '@example/broken',
          export: 'createSemanticProvider',
          enabled: true,
          allowLocal: false,
          settings: {},
        },
      ],
      { importer: async () => ({}) },
    );

    expect(result.providers).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      module: '@example/broken',
      message: expect.stringContaining('does not export'),
    });
  });

  it('rejects URL-scheme and unpinned local provider modules before import', async () => {
    const importer = vi.fn(async () => ({}));
    const result = await loadSemanticProviders(
      [
        {
          module: 'data:text/javascript,export default {}',
          export: 'createSemanticProvider',
          enabled: true,
          allowLocal: false,
          settings: {},
        },
        {
          module: './provider.js',
          export: 'createSemanticProvider',
          enabled: true,
          allowLocal: true,
          settings: {},
        },
      ],
      { importer, configLocation: '/workspace/.himcp.yaml' },
    );

    expect(result.providers).toEqual([]);
    expect(result.failures.map(({ message }) => message)).toEqual([
      expect.stringContaining('URL schemes'),
      expect.stringContaining('sha256 integrity'),
    ]);
    expect(importer).not.toHaveBeenCalled();
  });
});
