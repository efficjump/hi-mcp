import { describe, expect, it } from 'vitest';

import {
  SourceAdapterRegistry,
  SourceAdapterSelectionError,
  type SourceAdapter,
} from '../src/index.js';

function adapter(id: string, confidence: number): SourceAdapter {
  return {
    id,
    probe: () => ({ confidence, reason: `${id} marker` }),
    adapt: () => ({
      adapterId: id,
      document: null,
      diagnostics: [],
      hasErrors: true,
    }),
  };
}

describe('SourceAdapterRegistry', () => {
  const input = { value: '{}', location: 'fixture.json' } as const;

  it('selects one unique highest-confidence adapter or an explicit id', async () => {
    const registry = new SourceAdapterRegistry([
      adapter('openapi', 0.9),
      adapter('http-manifest', 0.8),
    ]);
    await expect(registry.select(input)).resolves.toMatchObject({ id: 'openapi' });
    await expect(registry.select(input, 'http-manifest')).resolves.toMatchObject({
      id: 'http-manifest',
    });
  });

  it('fails closed for ambiguous or unknown adapter selection', async () => {
    const registry = new SourceAdapterRegistry([adapter('one', 0.9), adapter('two', 0.9)]);
    await expect(registry.select(input)).rejects.toBeInstanceOf(SourceAdapterSelectionError);
    await expect(registry.select(input, 'missing')).rejects.toBeInstanceOf(
      SourceAdapterSelectionError,
    );
  });

  it('uses the same caller options for automatic probing and adaptation', async () => {
    const options = { maxInputBytes: 1_024 } as const;
    let probedOptions: Readonly<Record<string, unknown>> | undefined;
    let adaptedOptions: Readonly<Record<string, unknown>> | undefined;
    const boundedAdapter: SourceAdapter = {
      id: 'bounded',
      probe: (_source, receivedOptions) => {
        probedOptions = receivedOptions;
        return {
          confidence: receivedOptions?.['maxInputBytes'] === options.maxInputBytes ? 1 : 0,
          reason: 'Recognized only when the caller parsing budget is preserved.',
        };
      },
      adapt: (_source, receivedOptions) => {
        adaptedOptions = receivedOptions;
        return {
          adapterId: 'bounded',
          document: null,
          diagnostics: [],
          hasErrors: true,
        };
      },
    };
    const registry = new SourceAdapterRegistry([boundedAdapter]);

    await expect(registry.adapt(input, 'auto', options)).resolves.toMatchObject({
      adapterId: 'bounded',
    });
    expect(probedOptions).toBe(options);
    expect(adaptedOptions).toBe(options);
  });
});
