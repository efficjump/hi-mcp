import { describe, expect, it } from 'vitest';

import { openApiSourceAdapter, parseOpenApi } from '../src/index.js';

describe('parseOpenApi', () => {
  it('parses JSON, YAML, byte arrays, and object inputs', () => {
    const json = parseOpenApi('{"openapi":"3.1.0","info":{"title":"JSON"},"paths":{}}');
    const yaml = parseOpenApi('openapi: 3.0.3\ninfo:\n  title: YAML\npaths: {}\n');
    const bytes = parseOpenApi(
      new TextEncoder().encode('{"openapi":"3.1.0","info":{"title":"Bytes"},"paths":{}}'),
    );
    const object = parseOpenApi({ openapi: '3.1.0', info: { title: 'Object' }, paths: {} });

    expect(json.format).toBe('json');
    expect(yaml.format).toBe('yaml');
    expect(bytes.format).toBe('json');
    expect(object.format).toBe('object');
    expect([json, yaml, bytes, object].every((result) => result.document !== null)).toBe(true);
  });

  it('returns diagnostics instead of throwing for malformed input', () => {
    const invalidJson = parseOpenApi('{ invalid json }');
    const invalidYaml = parseOpenApi('openapi: [unterminated');
    const empty = parseOpenApi('   ');

    expect(invalidJson.diagnostics.map(({ code }) => code)).toContain('OPENAPI.INVALID_JSON');
    expect(invalidYaml.diagnostics.map(({ code }) => code)).toContain('OPENAPI.INVALID_YAML');
    expect(empty.diagnostics.map(({ code }) => code)).toContain('OPENAPI.EMPTY_INPUT');
  });

  it('enforces configurable size and depth limits', () => {
    const tooLarge = parseOpenApi('{"openapi":"3.1.0"}', { maxInputBytes: 4 });
    const tooDeep = parseOpenApi({ nested: { nested: { value: true } } }, { maxObjectDepth: 1 });
    const tooManyNodes = parseOpenApi(
      { openapi: '3.1.0', values: [1, 2, 3] },
      { maxInputNodes: 3 },
    );

    expect(tooLarge.diagnostics.map(({ code }) => code)).toContain('OPENAPI.INPUT_TOO_LARGE');
    expect(tooDeep.diagnostics.map(({ code }) => code)).toContain('OPENAPI.MAX_OBJECT_DEPTH');
    expect(tooManyNodes.diagnostics.map(({ code }) => code)).toContain('OPENAPI.INPUT_NODE_LIMIT');
  });

  it('applies caller parsing budgets during source probing', async () => {
    const source = '{"openapi":"3.1.0","info":{"title":"Probe"},"paths":{}}';
    const input = { value: source, location: 'probe.json' } as const;

    expect(
      openApiSourceAdapter.probe(input, {
        maxInputBytes: new TextEncoder().encode(source).length,
      }),
    ).toMatchObject({ confidence: 1 });
    expect(openApiSourceAdapter.probe(input, { maxInputBytes: 8 })).toMatchObject({
      confidence: 0,
    });
  });

  it('rejects unsafe object keys without mutating prototypes', () => {
    const source = JSON.parse(
      '{"openapi":"3.1.0","info":{"title":"Unsafe"},"paths":{},"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const result = parseOpenApi(source);

    expect(result.diagnostics.map(({ code }) => code)).toContain('OPENAPI.UNSAFE_OBJECT_KEY');
    expect(result.document).toBeNull();
    expect(Object.hasOwn(result.document ?? {}, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects object accessors without invoking them', () => {
    let invoked = false;
    const source = Object.defineProperty(
      { openapi: '3.1.0', info: { title: 'Accessor' }, paths: {} },
      'hidden',
      {
        enumerable: true,
        get() {
          invoked = true;
          return 'secret';
        },
      },
    );

    const result = parseOpenApi(source);

    expect(invoked).toBe(false);
    expect(result.document).toBeNull();
    expect(result.diagnostics.map(({ code }) => code)).toContain('OPENAPI.UNSAFE_PROPERTY');
  });

  it('rejects Proxy inputs without running their reflection traps', () => {
    let trapCalls = 0;
    const source = new Proxy(
      { openapi: '3.1.0', info: {}, paths: {} },
      {
        getPrototypeOf(target) {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    const result = parseOpenApi(source);

    expect(result.document).toBeNull();
    expect(result.diagnostics.map(({ code }) => code)).toContain('OPENAPI.PROXY_INPUT');
    expect(trapCalls).toBe(0);
  });

  it('rejects sparse arrays before an attacker-controlled index can amplify output work', () => {
    const sparse: unknown[] = [];
    sparse[1_000_000_000] = 'value';

    const result = parseOpenApi(
      { openapi: '3.1.0', info: { title: 'Sparse' }, paths: {}, sparse },
      { maxInputNodes: 100 },
    );

    expect(result.document).toBeNull();
    expect(result.diagnostics.map(({ code }) => code)).toContain('OPENAPI.INPUT_NODE_LIMIT');
  });
});
