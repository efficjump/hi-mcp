import { describe, expect, it } from 'vitest';

import { SemanticDataSafetyError, assertSemanticDataSafe } from './data-safety.js';

describe('semantic provider data safety', () => {
  it('accepts bounded plain JSON data', () => {
    expect(() => assertSemanticDataSafe({ models: [{ id: 'dynamic-model' }] })).not.toThrow();
  });

  it('rejects excessive depth before recursive schema parsing', () => {
    expect(() =>
      assertSemanticDataSafe({ first: { second: { third: true } } }, { maxDepth: 2 }),
    ).toThrow(SemanticDataSafetyError);
  });

  it('rejects cycles and accessor properties', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => assertSemanticDataSafe(circular)).toThrow(SemanticDataSafetyError);

    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'not-evaluated',
    });
    expect(() => assertSemanticDataSafe(accessor)).toThrow(SemanticDataSafetyError);
  });
});
