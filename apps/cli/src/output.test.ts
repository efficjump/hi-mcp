import type { Diagnostic } from '@hi-mcp/capability-ir';
import { describe, expect, it } from 'vitest';
import { formatDiagnostic, sortDiagnostics } from './output.js';

describe('diagnostic output', () => {
  const diagnostics: Diagnostic[] = [
    {
      code: 'SOURCE.INFO',
      severity: 'info',
      message: 'Information',
      related: [],
      recoverable: true,
    },
    {
      code: 'SOURCE.ERROR',
      severity: 'error',
      message: 'Broken operation',
      location: { sourceUri: 'fixture.yaml', pointer: '/paths/~1broken/get' },
      related: [],
      recoverable: false,
    },
  ];

  it('puts errors before informational diagnostics', () => {
    expect(sortDiagnostics(diagnostics).map(({ code }) => code)).toEqual([
      'SOURCE.ERROR',
      'SOURCE.INFO',
    ]);
  });

  it('formats source provenance without a left-side presentation marker', () => {
    expect(formatDiagnostic(diagnostics[1]!)).toBe(
      'ERROR SOURCE.ERROR fixture.yaml#/paths/~1broken/get: Broken operation',
    );
  });
});
