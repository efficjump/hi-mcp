import {
  CANONICAL_PADDED_BASE64_PATTERN,
  canonicalStringify,
  isCanonicalPaddedBase64,
  rebaseSchemaResource,
  type JsonSchema,
  type JsonValue,
} from '@hi-mcp/capability-ir';
import type { ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import safeRegex from 'safe-regex2';

import type { CapabilityVerificationOptions, SchemaVerificationLimits } from './types.js';

type JsonObject = { [key: string]: JsonValue };

export interface SchemaCompilationFailure {
  readonly diagnosticCode: 'SCHEMA.INVALID' | 'SCHEMA.COMPLEXITY_LIMIT' | 'SCHEMA.UNSAFE_PATTERN';
  readonly message: string;
  readonly errors: readonly ErrorObject[];
}

export interface LocatedInputSchema {
  readonly schema: JsonSchema;
  readonly required: boolean;
}

export type JsonValueType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

const ALL_JSON_VALUE_TYPES: ReadonlySet<JsonValueType> = new Set([
  'null',
  'boolean',
  'number',
  'string',
  'array',
  'object',
]);

const ANNOTATION_KEYWORDS = new Set(['title', 'description', 'examples']);
const UNSAFE_POINTER_TOKENS = new Set(['__proto__', 'prototype', 'constructor']);

export const DEFAULT_SCHEMA_VERIFICATION_LIMITS: SchemaVerificationLimits = Object.freeze({
  maxNodes: 20_000,
  maxDepth: 128,
  maxPatternLength: 512,
  maxRegexRepetitions: 25,
});

function normalizedSchemaLimits(
  options: CapabilityVerificationOptions['schemaLimits'],
): SchemaVerificationLimits {
  const limits = { ...DEFAULT_SCHEMA_VERIFICATION_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`schemaLimits.${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function schemaSafetyFailure(
  schema: JsonSchema,
  configuredLimits: CapabilityVerificationOptions['schemaLimits'],
): SchemaCompilationFailure | null {
  const limits = normalizedSchemaLimits(configuredLimits);
  const stack: Array<{ readonly value: JsonValue; readonly depth: number; readonly key?: string }> =
    [{ value: schema, depth: 0 }];
  let nodes = 0;
  const isSafePattern = (pattern: string): boolean => {
    try {
      return safeRegex(pattern, { limit: limits.maxRegexRepetitions });
    } catch {
      return false;
    }
  };

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes || current.depth > limits.maxDepth) {
      return {
        diagnosticCode: 'SCHEMA.COMPLEXITY_LIMIT',
        message: 'JSON Schema exceeds the configured node or depth limit.',
        errors: [],
      };
    }
    if (current.key === 'pattern' && typeof current.value === 'string') {
      if (current.value.length > limits.maxPatternLength) {
        return {
          diagnosticCode: 'SCHEMA.UNSAFE_PATTERN',
          message: 'JSON Schema regex exceeds the configured length limit.',
          errors: [],
        };
      }
      if (current.value !== CANONICAL_PADDED_BASE64_PATTERN && !isSafePattern(current.value)) {
        return {
          diagnosticCode: 'SCHEMA.UNSAFE_PATTERN',
          message: 'JSON Schema contains a potentially unsafe regular expression.',
          errors: [],
        };
      }
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({
          value: child,
          depth: current.depth + 1,
          ...(current.key === undefined ? {} : { key: current.key }),
        });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (current.key === 'patternProperties') {
        if (key.length > limits.maxPatternLength || !isSafePattern(key)) {
          return {
            diagnosticCode: 'SCHEMA.UNSAFE_PATTERN',
            message: 'JSON Schema contains a potentially unsafe patternProperties expression.',
            errors: [],
          };
        }
      }
      stack.push({ value: child, depth: current.depth + 1, key });
    }
  }
  return null;
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function decodePointerToken(token: string): string | null {
  if (/~(?:[^01]|$)/.test(token)) return null;
  const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
  return UNSAFE_POINTER_TOKENS.has(decoded) ? null : decoded;
}

function resolveLocalReference(root: JsonSchema, reference: string): JsonSchema | null {
  if (!reference.startsWith('#/')) return null;
  let current: JsonValue = root;

  for (const encodedToken of reference.slice(2).split('/')) {
    const token = decodePointerToken(encodedToken);
    if (token === null) return null;
    const object = asObject(current);
    if (object === null || !Object.hasOwn(object, token)) return null;
    current = object[token] as JsonValue;
  }

  return typeof current === 'boolean' || asObject(current) !== null
    ? (current as JsonSchema)
    : null;
}

function jsonValueType(value: JsonValue): JsonValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function intersectTypes(
  left: ReadonlySet<JsonValueType>,
  right: ReadonlySet<JsonValueType>,
): Set<JsonValueType> {
  return new Set([...left].filter((type) => right.has(type)));
}

function declaredTypeSet(value: JsonValue | undefined): ReadonlySet<JsonValueType> | null {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (values === null) return null;
  const types = new Set<JsonValueType>();
  for (const candidate of values) {
    if (candidate === 'integer' || candidate === 'number') types.add('number');
    else if (
      candidate === 'null' ||
      candidate === 'boolean' ||
      candidate === 'string' ||
      candidate === 'array' ||
      candidate === 'object'
    ) {
      types.add(candidate);
    }
  }
  return types;
}

/**
 * Conservatively derives every JSON value shape that a schema may accept. Unknown constructs retain
 * all shapes, so callers can use subset checks to prove a wire serializer is total for the schema.
 */
export function possibleJsonValueTypes(
  schema: JsonSchema,
  root: JsonSchema = schema,
  visitedReferences: ReadonlySet<string> = new Set(),
): ReadonlySet<JsonValueType> {
  if (schema === false) return new Set();
  if (schema === true) return new Set(ALL_JSON_VALUE_TYPES);

  let possible = new Set(ALL_JSON_VALUE_TYPES);
  const declared = declaredTypeSet(schema['type']);
  if (declared !== null) possible = intersectTypes(possible, declared);

  if (Object.hasOwn(schema, 'const')) {
    possible = intersectTypes(possible, new Set([jsonValueType(schema['const'] as JsonValue)]));
  }
  if (Array.isArray(schema['enum'])) {
    const enumTypes = new Set(schema['enum'].map((value) => jsonValueType(value)));
    possible = intersectTypes(possible, enumTypes);
  }

  const reference = typeof schema['$ref'] === 'string' ? schema['$ref'] : undefined;
  if (reference !== undefined && !visitedReferences.has(reference)) {
    const resolved = resolveLocalReference(root, reference);
    if (resolved !== null) {
      possible = intersectTypes(
        possible,
        possibleJsonValueTypes(resolved, root, new Set([...visitedReferences, reference])),
      );
    }
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (typeof branch === 'boolean' || asObject(branch) !== null) {
        possible = intersectTypes(
          possible,
          possibleJsonValueTypes(branch as JsonSchema, root, visitedReferences),
        );
      }
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const union = new Set<JsonValueType>();
    for (const branch of branches) {
      if (typeof branch !== 'boolean' && asObject(branch) === null) continue;
      for (const type of possibleJsonValueTypes(branch as JsonSchema, root, visitedReferences)) {
        union.add(type);
      }
    }
    possible = intersectTypes(possible, union);
  }

  return possible;
}

type WireValueDomain =
  'scalar' | 'parameter' | 'object-with-scalar-values' | 'form-object' | 'form-entry';

const SCALAR_JSON_VALUE_TYPES: ReadonlySet<JsonValueType> = new Set([
  'null',
  'boolean',
  'number',
  'string',
]);

function valueFitsWireDomain(value: JsonValue, domain: WireValueDomain): boolean {
  const type = jsonValueType(value);
  if (domain === 'scalar') return SCALAR_JSON_VALUE_TYPES.has(type);
  if (domain === 'form-entry') {
    return (
      SCALAR_JSON_VALUE_TYPES.has(type) ||
      (Array.isArray(value) && value.every((item) => valueFitsWireDomain(item, 'scalar')))
    );
  }
  if (domain === 'form-object') {
    return (
      type === 'object' &&
      Object.values(value as { [key: string]: JsonValue }).every((item) =>
        valueFitsWireDomain(item, 'form-entry'),
      )
    );
  }
  if (domain === 'object-with-scalar-values') {
    return (
      type === 'object' &&
      Object.values(value as { [key: string]: JsonValue }).every((item) =>
        valueFitsWireDomain(item, 'scalar'),
      )
    );
  }
  return (
    SCALAR_JSON_VALUE_TYPES.has(type) ||
    (Array.isArray(value) && value.every((item) => valueFitsWireDomain(item, 'scalar'))) ||
    (type === 'object' &&
      Object.values(value as { [key: string]: JsonValue }).every((item) =>
        valueFitsWireDomain(item, 'scalar'),
      ))
  );
}

function schemaValue(value: JsonValue | undefined): JsonSchema | null {
  return typeof value === 'boolean' || asObject(value) !== null ? (value as JsonSchema) : null;
}

function schemaList(value: JsonValue | undefined): readonly JsonSchema[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const schema = schemaValue(candidate);
        return schema === null ? [] : [schema];
      })
    : [];
}

function directArrayElementsFitDomain(
  schema: JsonObject,
  root: JsonSchema,
  elementDomain: WireValueDomain,
  visitedReferences: ReadonlySet<string>,
): boolean {
  if (typeof schema['maxItems'] === 'number' && schema['maxItems'] <= 0) return true;

  const prefixItems = schemaList(schema['prefixItems']);
  if (
    prefixItems.some((item) => !schemaFitsWireDomain(item, root, elementDomain, visitedReferences))
  ) {
    return false;
  }

  const items = schemaValue(schema['items']);
  if (items === false) return true;
  if (items !== null) {
    return schemaFitsWireDomain(items, root, elementDomain, visitedReferences);
  }
  return (
    prefixItems.length > 0 &&
    typeof schema['maxItems'] === 'number' &&
    schema['maxItems'] <= prefixItems.length
  );
}

function objectMapFitsDomain(
  value: JsonValue | undefined,
  root: JsonSchema,
  valueDomain: WireValueDomain,
  visitedReferences: ReadonlySet<string>,
): boolean {
  if (value === undefined) return true;
  const object = asObject(value);
  if (object === null) return false;
  return Object.values(object).every((candidate) => {
    const schema = schemaValue(candidate);
    return schema !== null && schemaFitsWireDomain(schema, root, valueDomain, visitedReferences);
  });
}

function directObjectValuesFitDomain(
  schema: JsonObject,
  root: JsonSchema,
  valueDomain: WireValueDomain,
  visitedReferences: ReadonlySet<string>,
): boolean {
  if (typeof schema['maxProperties'] === 'number' && schema['maxProperties'] <= 0) return true;
  if (!objectMapFitsDomain(schema['properties'], root, valueDomain, visitedReferences))
    return false;
  if (!objectMapFitsDomain(schema['patternProperties'], root, valueDomain, visitedReferences)) {
    return false;
  }

  const additional = schemaValue(schema['additionalProperties']);
  return (
    additional === false ||
    (additional !== null && schemaFitsWireDomain(additional, root, valueDomain, visitedReferences))
  );
}

function schemaFitsWireDomain(
  schema: JsonSchema,
  root: JsonSchema,
  domain: WireValueDomain,
  visitedReferences: ReadonlySet<string>,
): boolean {
  if (schema === false) return true;
  if (schema === true) return false;

  if (Object.hasOwn(schema, 'const')) {
    return valueFitsWireDomain(schema['const'] as JsonValue, domain);
  }
  if (Array.isArray(schema['enum'])) {
    return schema['enum'].every((value) => valueFitsWireDomain(value, domain));
  }

  const possibleTypes = possibleJsonValueTypes(schema, root, visitedReferences);
  if (possibleTypes.size === 0) return true;
  const directProof = [...possibleTypes].every((type) => {
    if (SCALAR_JSON_VALUE_TYPES.has(type)) {
      return domain === 'scalar' || domain === 'parameter' || domain === 'form-entry';
    }
    if (type === 'array') {
      return (
        (domain === 'parameter' || domain === 'form-entry') &&
        directArrayElementsFitDomain(schema, root, 'scalar', visitedReferences)
      );
    }
    if (type === 'object') {
      const childDomain =
        domain === 'parameter' || domain === 'object-with-scalar-values'
          ? 'scalar'
          : domain === 'form-object'
            ? 'form-entry'
            : null;
      return (
        childDomain !== null &&
        directObjectValuesFitDomain(schema, root, childDomain, visitedReferences)
      );
    }
    return false;
  });
  if (directProof) return true;

  const reference = typeof schema['$ref'] === 'string' ? schema['$ref'] : undefined;
  if (reference !== undefined && !visitedReferences.has(reference)) {
    const resolved = resolveLocalReference(root, reference);
    if (
      resolved !== null &&
      schemaFitsWireDomain(resolved, root, domain, new Set([...visitedReferences, reference]))
    ) {
      return true;
    }
  }

  const allOf = schemaList(schema['allOf']);
  if (allOf.some((branch) => schemaFitsWireDomain(branch, root, domain, visitedReferences))) {
    return true;
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schemaList(schema[keyword]);
    if (
      branches.length > 0 &&
      branches.every((branch) => schemaFitsWireDomain(branch, root, domain, visitedReferences))
    ) {
      return true;
    }
  }
  return false;
}

/** Proves that every value admitted by the schema can be serialized by scalar wire bindings. */
export function schemaAcceptsOnlyScalars(schema: JsonSchema): boolean {
  return schemaFitsWireDomain(schema, schema, 'scalar', new Set());
}

/** Proves scalar, scalar-array, or shallow object shapes used by style-based parameters. */
export function schemaAcceptsOnlyParameterValues(schema: JsonSchema): boolean {
  return schemaFitsWireDomain(schema, schema, 'parameter', new Set());
}

/** Proves a deepObject-compatible object whose property values are all scalar. */
export function schemaAcceptsOnlyScalarPropertyObject(schema: JsonSchema): boolean {
  return schemaFitsWireDomain(schema, schema, 'object-with-scalar-values', new Set());
}

/** Proves an object whose values are scalar or arrays containing only scalar values. */
export function schemaAcceptsOnlyFormObject(schema: JsonSchema): boolean {
  return schemaFitsWireDomain(schema, schema, 'form-object', new Set());
}

function schemaAcceptsOnlyCanonicalBase64Internal(
  schema: JsonSchema,
  root: JsonSchema,
  visitedReferences: ReadonlySet<string>,
): boolean {
  if (schema === false) return true;
  if (schema === true) return false;
  if (Object.hasOwn(schema, 'const')) {
    return typeof schema['const'] === 'string' && isCanonicalPaddedBase64(schema['const']);
  }
  if (Array.isArray(schema['enum'])) {
    return schema['enum'].every(
      (value) => typeof value === 'string' && isCanonicalPaddedBase64(value),
    );
  }
  const possibleTypes = possibleJsonValueTypes(schema, root, visitedReferences);
  if (possibleTypes.size === 0) return true;
  if (
    possibleTypes.size === 1 &&
    possibleTypes.has('string') &&
    schema['pattern'] === CANONICAL_PADDED_BASE64_PATTERN
  ) {
    return true;
  }

  const reference = typeof schema['$ref'] === 'string' ? schema['$ref'] : undefined;
  if (reference !== undefined && !visitedReferences.has(reference)) {
    const resolved = resolveLocalReference(root, reference);
    if (
      resolved !== null &&
      schemaAcceptsOnlyCanonicalBase64Internal(
        resolved,
        root,
        new Set([...visitedReferences, reference]),
      )
    ) {
      return true;
    }
  }
  if (
    schemaList(schema['allOf']).some((branch) =>
      schemaAcceptsOnlyCanonicalBase64Internal(branch, root, visitedReferences),
    )
  ) {
    return true;
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schemaList(schema[keyword]);
    if (
      branches.length > 0 &&
      branches.every((branch) =>
        schemaAcceptsOnlyCanonicalBase64Internal(branch, root, visitedReferences),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Proves canonical padded base64 values from finite or shared-pattern schema constraints. */
export function schemaAcceptsOnlyCanonicalBase64(schema: JsonSchema): boolean {
  return schemaAcceptsOnlyCanonicalBase64Internal(schema, schema, new Set());
}

function branchSchemas(schema: JsonObject): readonly JsonSchema[] {
  return ['allOf', 'anyOf', 'oneOf'].flatMap((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches)
      ? branches.filter(
          (branch): branch is JsonSchema =>
            typeof branch === 'boolean' || asObject(branch) !== null,
        )
      : [];
  });
}

function findProperty(
  root: JsonSchema,
  schema: JsonSchema,
  name: string,
  visitedReferences: ReadonlySet<string>,
): readonly { schema: JsonSchema; required: boolean }[] {
  if (typeof schema === 'boolean') return [];

  const reference = typeof schema['$ref'] === 'string' ? schema['$ref'] : undefined;
  if (reference !== undefined && !visitedReferences.has(reference)) {
    const resolved = resolveLocalReference(root, reference);
    if (resolved !== null) {
      return findProperty(root, resolved, name, new Set([...visitedReferences, reference]));
    }
  }

  const properties = asObject(schema['properties']);
  const direct = properties?.[name];
  const requiredEntries = Array.isArray(schema['required'])
    ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const matches: Array<{ schema: JsonSchema; required: boolean }> = [];
  if (direct !== undefined && (typeof direct === 'boolean' || asObject(direct) !== null)) {
    matches.push({ schema: direct as JsonSchema, required: requiredEntries.includes(name) });
  }

  for (const branch of branchSchemas(schema)) {
    matches.push(...findProperty(root, branch, name, visitedReferences));
  }
  return matches;
}

export function locateInputSchema(
  root: JsonSchema,
  inputPath: readonly string[],
): LocatedInputSchema | null {
  let candidates: readonly { schema: JsonSchema; required: boolean }[] = [
    { schema: root, required: true },
  ];
  let pathRequired = true;

  for (const segment of inputPath) {
    const next = candidates.flatMap((candidate) =>
      findProperty(root, candidate.schema, segment, new Set()).map((match) => ({
        schema: match.schema,
        required: candidate.required && match.required,
      })),
    );
    if (next.length === 0) return null;
    pathRequired = next.every((candidate) => candidate.required);
    candidates = next;
  }

  const first = candidates[0];
  if (!first) return null;
  const unique = candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) => canonicalStringify(other.schema) === canonicalStringify(candidate.schema),
      ) === index,
  );

  return {
    schema:
      unique.length === 1
        ? (unique[0] as { schema: JsonSchema }).schema
        : { anyOf: unique.map((candidate) => candidate.schema) },
    required: pathRequired,
  };
}

function stripAnnotations(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  const object = asObject(value);
  if (object === null) return value;

  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !ANNOTATION_KEYWORDS.has(key))
      .map(([key, child]) => [key, stripAnnotations(child)]),
  );
}

export function schemasMatchIgnoringAnnotations(left: JsonSchema, right: JsonSchema): boolean {
  return canonicalStringify(stripAnnotations(left)) === canonicalStringify(stripAnnotations(right));
}

/**
 * Conservatively proves that every value admitted by `schema` is intersected with one exact shared
 * wire constraint. An `allOf` needs one proving branch, while every `anyOf`/`oneOf` branch must
 * prove the constraint so an unsafe union arm cannot hide beside a safe one.
 */
export function schemaProvesWireConstraint(
  schema: JsonSchema,
  expected: JsonSchema,
  root: JsonSchema = schema,
  visitedReferences: ReadonlySet<string> = new Set(),
): boolean {
  if (schema === false) return true;
  if (schema === true) return expected === true;
  if (schemasMatchIgnoringAnnotations(schema, expected)) return true;

  const reference = typeof schema['$ref'] === 'string' ? schema['$ref'] : undefined;
  if (reference !== undefined && !visitedReferences.has(reference)) {
    const resolved = resolveLocalReference(root, reference);
    if (
      resolved !== null &&
      schemaProvesWireConstraint(
        resolved,
        expected,
        root,
        new Set([...visitedReferences, reference]),
      )
    ) {
      return true;
    }
  }

  const allOf = schemaList(schema['allOf']);
  if (
    allOf.some((branch) => schemaProvesWireConstraint(branch, expected, root, visitedReferences))
  ) {
    return true;
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schemaList(schema[keyword]);
    if (
      branches.length > 0 &&
      branches.every((branch) =>
        schemaProvesWireConstraint(branch, expected, root, visitedReferences),
      )
    ) {
      return true;
    }
  }
  return false;
}

function schemaVariants(schema: JsonSchema): readonly JsonSchema[] {
  if (typeof schema === 'boolean') return [];
  return ['oneOf', 'anyOf'].flatMap((keyword) => {
    const value = schema[keyword];
    return Array.isArray(value)
      ? value.filter(
          (candidate): candidate is JsonSchema =>
            typeof candidate === 'boolean' || asObject(candidate) !== null,
        )
      : [];
  });
}

function composedSchemas(schema: JsonSchema): readonly JsonSchema[] {
  if (typeof schema === 'boolean') return [];
  return ['allOf', 'oneOf', 'anyOf'].flatMap((keyword) => {
    const value = schema[keyword];
    return Array.isArray(value)
      ? value.filter(
          (candidate): candidate is JsonSchema =>
            typeof candidate === 'boolean' || asObject(candidate) !== null,
        )
      : [];
  });
}

/** True when the schemas match directly or the expected schema is an explicit union member. */
function embeddedSchemaMatches(
  root: JsonSchema,
  container: JsonSchema,
  expected: JsonSchema,
): boolean {
  if (typeof container === 'boolean') return false;
  const reference = typeof container['$ref'] === 'string' ? container['$ref'] : undefined;
  if (reference === undefined || !reference.startsWith('#/')) return false;
  const segments = reference.slice(2).split('/').map(decodePointerToken);
  if (segments.length !== 2 || segments[0] !== '$defs') return false;
  const definitionKey = segments[1];
  if (definitionKey === undefined || definitionKey === null) return false;
  const actual = resolveLocalReference(root, reference);
  return (
    actual !== null &&
    schemasMatchIgnoringAnnotations(actual, rebaseSchemaResource(expected, definitionKey))
  );
}

export function schemaContainsVariant(
  container: JsonSchema,
  expected: JsonSchema,
  root: JsonSchema = container,
): boolean {
  return (
    schemasMatchIgnoringAnnotations(container, expected) ||
    embeddedSchemaMatches(root, container, expected) ||
    composedSchemas(container).some((variant) => schemaContainsVariant(variant, expected, root))
  );
}

/** Compares an explicit oneOf/anyOf output union with the schemas grounded in success responses. */
export function schemaRepresentsVariants(
  schema: JsonSchema,
  expectedVariants: readonly JsonSchema[],
  root: JsonSchema = schema,
): boolean {
  const uniqueExpectedVariants = expectedVariants.filter(
    (variant, index) =>
      expectedVariants.findIndex((candidate) =>
        schemasMatchIgnoringAnnotations(candidate, variant),
      ) === index,
  );
  if (uniqueExpectedVariants.length === 1) {
    return schemaContainsVariant(schema, uniqueExpectedVariants[0] as JsonSchema, root);
  }
  const actual = schemaVariants(schema);
  if (actual.length === 0) return false;

  const uniqueActual = new Set(
    actual.map((variant) => canonicalStringify(stripAnnotations(variant))),
  );
  const uniqueExpected = new Set(
    uniqueExpectedVariants.map((variant) => canonicalStringify(stripAnnotations(variant))),
  );
  if (
    uniqueActual.size === uniqueExpected.size &&
    [...uniqueActual].every((variant) => uniqueExpected.has(variant))
  ) {
    return true;
  }
  return (
    actual.length === uniqueExpectedVariants.length &&
    uniqueExpectedVariants.every((expected) =>
      actual.some((candidate) => schemaContainsVariant(candidate, expected, root)),
    ) &&
    actual.every((candidate) =>
      uniqueExpectedVariants.some((expected) => schemaContainsVariant(candidate, expected, root)),
    )
  );
}

export function validateJsonSchema(
  schema: JsonSchema,
  options: CapabilityVerificationOptions['ajv'],
  schemaLimits?: CapabilityVerificationOptions['schemaLimits'],
): SchemaCompilationFailure | null {
  const safetyFailure = schemaSafetyFailure(schema, schemaLimits);
  if (safetyFailure !== null) return safetyFailure;

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    ...options,
  });

  try {
    const valid = ajv.validateSchema(schema);
    if (!valid) {
      return {
        diagnosticCode: 'SCHEMA.INVALID',
        message: 'The value is not a valid JSON Schema.',
        errors: [...(ajv.errors ?? [])],
      };
    }
    ajv.compile(schema);
    return null;
  } catch (error) {
    return {
      diagnosticCode: 'SCHEMA.INVALID',
      message: error instanceof Error ? error.message : String(error),
      errors: [...(ajv.errors ?? [])],
    };
  }
}
