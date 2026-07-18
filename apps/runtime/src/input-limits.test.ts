import { describe, expect, it } from 'vitest';

import { inspectJsonValue } from './input-limits.js';

describe('inspectJsonValue', () => {
  it('accepts bounded JSON-compatible values', () => {
    expect(
      inspectJsonValue(
        { itemId: 'item_1', filters: ['active', null] },
        { maxDepth: 3, maxNodes: 8, maxStringBytes: 64 },
      ),
    ).toMatchObject({ valid: true });
  });

  it('rejects deeply nested input iteratively', () => {
    const result = inspectJsonValue(
      { one: { two: { three: true } } },
      { maxDepth: 2, maxNodes: 10, maxStringBytes: 64 },
    );

    expect(result).toMatchObject({ valid: false, limitExceeded: true });
  });

  it('rejects cyclic and accessor-bearing objects', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'do-not-invoke',
    });

    expect(inspectJsonValue(cyclic)).toMatchObject({ valid: false, limitExceeded: false });
    expect(inspectJsonValue(accessor)).toMatchObject({ valid: false, limitExceeded: false });
  });

  it('rejects unsafe object keys', () => {
    const value = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as unknown;

    expect(inspectJsonValue(value)).toMatchObject({ valid: false, limitExceeded: false });
  });
});
