import { describe, expect, it } from 'vitest';

import { CanonicalizationError, canonicalStringify, fingerprint, stableId } from '../src/index.js';

describe('canonical fingerprints', () => {
  it('ignores object key order while preserving array order', () => {
    const first = { z: [2, 1], nested: { b: true, a: 'value' } };
    const second = { nested: { a: 'value', b: true }, z: [2, 1] };

    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
    expect(fingerprint(first)).toBe(fingerprint(second));
    expect(fingerprint({ z: [1, 2], nested: second.nested })).not.toBe(fingerprint(first));
  });

  it('omits undefined object fields but rejects undefined array entries', () => {
    expect(canonicalStringify({ present: true, ignored: undefined })).toBe('{"present":true}');
    expect(() => canonicalStringify([undefined])).toThrow(CanonicalizationError);
  });

  it('rejects non-JSON and circular inputs', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => fingerprint(circular)).toThrow('circular reference');
    expect(() => fingerprint(Number.POSITIVE_INFINITY)).toThrow('non-finite');
    expect(() => fingerprint(new Date())).toThrow('plain objects');
  });

  it('builds stable namespace-scoped IDs', () => {
    expect(stableId('operation', 'GET', '/pets')).toBe(stableId('operation', 'GET', '/pets'));
    expect(stableId('operation', 'GET', '/pets')).not.toBe(stableId('operation', 'POST', '/pets'));
    expect(() => stableId('../unsafe', 'value')).toThrow('Invalid stable ID namespace');
  });
});
