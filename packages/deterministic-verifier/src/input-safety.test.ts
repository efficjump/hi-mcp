import { describe, expect, it } from 'vitest';

import { inspectVerificationInput } from './input-safety.js';

function deeplyNested(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}

describe('inspectVerificationInput', () => {
  it('rejects deeply nested input without recursive traversal', () => {
    expect(inspectVerificationInput(deeplyNested(512))).toMatchObject({ kind: 'limit' });
  });

  it('rejects cycles, accessors, and unsafe keys', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'must-not-run',
    });
    const unsafe = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as unknown;

    expect(inspectVerificationInput(cyclic)).toMatchObject({ kind: 'unsafe' });
    expect(inspectVerificationInput(accessor)).toMatchObject({ kind: 'unsafe' });
    expect(inspectVerificationInput(unsafe)).toMatchObject({ kind: 'unsafe' });
  });
});
