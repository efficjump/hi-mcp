import { describe, expect, it } from 'vitest';

import { parseAllowedHostRule } from './host-rule.js';

describe('parseAllowedHostRule', () => {
  it.each([
    ['api.example.com', { hostname: 'api.example.com' }],
    ['api.example.com:443', { hostname: 'api.example.com', ports: [443] }],
    ['api.example.com:8443', { hostname: 'api.example.com', ports: [8443] }],
    ['[2001:db8::1]:8443', { hostname: '2001:db8::1', ports: [8443] }],
  ] as const)('parses exact authority %s', (input, expected) => {
    expect(parseAllowedHostRule(input)).toEqual(expected);
  });

  it.each([
    'https://api.example.com',
    '*.example.com',
    'user@api.example.com',
    'api.example.com/path',
    ' api.example.com',
  ])('rejects non-exact authority %s', (input) => {
    expect(() => parseAllowedHostRule(input)).toThrow(TypeError);
  });
});
