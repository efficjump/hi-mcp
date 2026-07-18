import { describe, expect, it } from 'vitest';

import { parseSourceDocument } from '../src/index.js';

describe('parseSourceDocument', () => {
  it('parses bounded JSON and YAML with caller-selected diagnostic namespaces', () => {
    expect(parseSourceDocument('{"kind":"json"}').document).toEqual({ kind: 'json' });
    expect(parseSourceDocument('kind: yaml\n').document).toEqual({ kind: 'yaml' });
    expect(
      parseSourceDocument('{', { diagnosticNamespace: 'HTTP_MANIFEST' }).diagnostics[0]?.code,
    ).toBe('HTTP_MANIFEST.INVALID_JSON');
  });

  it('rejects proxies and sparse arrays without invoking reflection traps', () => {
    let trapCalls = 0;
    const proxy = new Proxy(
      { kind: 'proxy' },
      {
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const proxyResult = parseSourceDocument(proxy);
    const sparse: unknown[] = [];
    sparse[1_000_000] = true;
    const sparseResult = parseSourceDocument({ sparse }, { maxInputNodes: 100 });

    expect(proxyResult.document).toBeNull();
    expect(proxyResult.diagnostics.map(({ code }) => code)).toContain('SOURCE.PROXY_INPUT');
    expect(trapCalls).toBe(0);
    expect(sparseResult.document).toBeNull();
    expect(sparseResult.diagnostics.map(({ code }) => code)).toContain('SOURCE.INPUT_NODE_LIMIT');
  });
});
