import {
  CANONICAL_PADDED_BASE64_PATTERN,
  WELL_FORMED_UNICODE_PATTERN,
  scalarTextWireSchema,
  type JsonSchema,
} from '@hi-mcp/capability-ir';
import { describe, expect, it } from 'vitest';

import {
  locateInputSchema,
  possibleJsonValueTypes,
  schemaAcceptsOnlyCanonicalBase64,
  schemaAcceptsOnlyFormObject,
  schemaAcceptsOnlyParameterValues,
  schemaAcceptsOnlyScalarPropertyObject,
  schemaAcceptsOnlyScalars,
  schemaContainsVariant,
  schemaProvesWireConstraint,
  schemaRepresentsVariants,
} from './json-schema.js';

describe('local JSON Schema references', () => {
  it('resolves safe own-property pointer tokens', () => {
    const schema: JsonSchema = {
      $defs: {
        identifier: {
          type: 'object',
          properties: { itemId: { type: 'string' } },
          required: ['itemId'],
        },
      },
      $ref: '#/$defs/identifier',
    };

    expect(locateInputSchema(schema, ['itemId'])).toMatchObject({
      schema: { type: 'string' },
      required: true,
    });
  });

  it.each(['#/__proto__/polluted', '#/constructor/prototype', '#/$defs/~2invalid'])(
    'rejects unsafe or malformed pointer %s',
    (reference) => {
      const schema = { $ref: reference } satisfies JsonSchema;

      expect(locateInputSchema(schema, ['polluted'])).toBeNull();
    },
  );
});

describe('output schema variants', () => {
  const stringSchema = { type: 'string' } satisfies JsonSchema;
  const numberSchema = { type: 'number' } satisfies JsonSchema;

  it('requires every distinct source response variant', () => {
    expect(schemaRepresentsVariants(stringSchema, [stringSchema, numberSchema])).toBe(false);
    expect(
      schemaRepresentsVariants({ oneOf: [stringSchema, numberSchema] }, [
        stringSchema,
        numberSchema,
      ]),
    ).toBe(true);
  });

  it('collapses duplicate source response schemas', () => {
    expect(schemaRepresentsVariants(stringSchema, [stringSchema, stringSchema])).toBe(true);
  });

  it('finds a binding schema inside allOf without changing output union semantics', () => {
    expect(
      schemaContainsVariant(
        { allOf: [{ type: 'string' }, { anyOf: [stringSchema, numberSchema] }] },
        numberSchema,
      ),
    ).toBe(true);
    expect(
      schemaRepresentsVariants({ allOf: [stringSchema, numberSchema] }, [
        stringSchema,
        numberSchema,
      ]),
    ).toBe(false);
  });
});

describe('wire serialization schema proofs', () => {
  it('requires every union arm to retain a shared wire constraint', () => {
    const constraint = scalarTextWireSchema(WELL_FORMED_UNICODE_PATTERN);
    const safe = { allOf: [{ type: 'string' }, constraint] } satisfies JsonSchema;

    expect(schemaProvesWireConstraint(safe, constraint)).toBe(true);
    expect(schemaProvesWireConstraint({ anyOf: [safe, { type: 'string' }] }, constraint)).toBe(
      false,
    );
    expect(schemaProvesWireConstraint({ anyOf: [safe, safe] }, constraint)).toBe(true);
  });

  it('derives conservative possible JSON value types through composition and local refs', () => {
    expect([...possibleJsonValueTypes({})].sort()).toEqual([
      'array',
      'boolean',
      'null',
      'number',
      'object',
      'string',
    ]);
    expect([...possibleJsonValueTypes({ allOf: [{}, { type: 'object' }] })]).toEqual(['object']);
    expect(
      [...possibleJsonValueTypes({ oneOf: [{ type: 'string' }, { const: 1 }] })].sort(),
    ).toEqual(['number', 'string']);
    expect([
      ...possibleJsonValueTypes({
        $defs: { value: { type: 'boolean' } },
        $ref: '#/$defs/value',
      }),
    ]).toEqual(['boolean']);
  });

  it('rejects unconstrained and nested parameter shapes while accepting executable shallow ones', () => {
    expect(schemaAcceptsOnlyScalars({})).toBe(false);
    expect(schemaAcceptsOnlyScalars({ enum: ['active', 1, null] })).toBe(true);
    expect(
      schemaAcceptsOnlyParameterValues({
        type: 'object',
        properties: { state: { type: 'string' } },
        additionalProperties: false,
      }),
    ).toBe(true);
    expect(
      schemaAcceptsOnlyParameterValues({
        type: 'object',
        properties: { nested: { type: 'object' } },
        additionalProperties: false,
      }),
    ).toBe(false);
    expect(
      schemaAcceptsOnlyScalarPropertyObject({
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      }),
    ).toBe(false);
  });

  it('proves only the shallow object shape implemented by form serialization', () => {
    expect(
      schemaAcceptsOnlyFormObject({
        type: 'object',
        properties: {
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      }),
    ).toBe(true);
    expect(
      schemaAcceptsOnlyFormObject({
        type: 'object',
        properties: {
          nested: { type: 'object', additionalProperties: { type: 'string' } },
          rows: { type: 'array', items: { type: 'object' } },
        },
        additionalProperties: false,
      }),
    ).toBe(false);
    expect(schemaAcceptsOnlyFormObject({ type: 'object' })).toBe(false);
  });

  it('accepts canonical finite base64 constraints and rejects unconstrained strings', () => {
    expect(schemaAcceptsOnlyCanonicalBase64({ enum: ['aGVsbG8=', 'd29ybGQ='] })).toBe(true);
    expect(
      schemaAcceptsOnlyCanonicalBase64({
        allOf: [{ type: 'string' }, { type: 'string', pattern: CANONICAL_PADDED_BASE64_PATTERN }],
      }),
    ).toBe(true);
    expect(schemaAcceptsOnlyCanonicalBase64({ type: 'string' })).toBe(false);
    expect(schemaAcceptsOnlyCanonicalBase64({ enum: ['d29ybGQ'] })).toBe(false);
    expect(schemaAcceptsOnlyCanonicalBase64({ enum: ['not base64'] })).toBe(false);
  });
});
