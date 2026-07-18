import safeRegex from 'safe-regex2';

import type {
  ExecutionComplexityLimits,
  JsonSchemaComplexityLimits,
  JsonValueComplexityLimits,
} from './types.js';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const DEFAULT_VALUE_COMPLEXITY_LIMITS: JsonValueComplexityLimits = Object.freeze({
  maxNodes: 50_000,
  maxDepth: 64,
  maxStringBytes: 1_048_576,
  maxTotalStringBytes: 4_194_304,
  maxArrayItems: 1_000,
  maxObjectProperties: 1_000,
});

export const DEFAULT_SCHEMA_COMPLEXITY_LIMITS: JsonSchemaComplexityLimits = Object.freeze({
  maxNodes: 20_000,
  maxDepth: 128,
  maxPatternLength: 512,
  maxRegexRepetitions: 25,
});

export class ComplexityLimitError extends TypeError {
  readonly kind: 'value' | 'schema';

  constructor(kind: 'value' | 'schema', message: string) {
    super(message);
    this.name = 'ComplexityLimitError';
    this.kind = kind;
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function normalizeComplexityLimits(limits: ExecutionComplexityLimits | undefined): {
  readonly values: JsonValueComplexityLimits;
  readonly schemas: JsonSchemaComplexityLimits;
} {
  const values = { ...DEFAULT_VALUE_COMPLEXITY_LIMITS, ...limits?.values };
  const schemas = { ...DEFAULT_SCHEMA_COMPLEXITY_LIMITS, ...limits?.schemas };

  for (const [key, value] of Object.entries(values)) {
    positiveSafeInteger(value, `complexity.values.${key}`);
  }
  for (const [key, value] of Object.entries(schemas)) {
    positiveSafeInteger(value, `complexity.schemas.${key}`);
  }
  return { values, schemas };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assertJsonValueComplexity(value: unknown, limits: JsonValueComplexityLimits): void {
  let nodes = 0;
  let totalStringBytes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new ComplexityLimitError('value', 'JSON value exceeds the node limit.');
    }
    if (depth > limits.maxDepth) {
      throw new ComplexityLimitError('value', 'JSON value exceeds the depth limit.');
    }
    if (typeof current === 'string') {
      const bytes = byteLength(current);
      if (bytes > limits.maxStringBytes) {
        throw new ComplexityLimitError('value', 'JSON string exceeds the per-string byte limit.');
      }
      totalStringBytes += bytes;
      if (totalStringBytes > limits.maxTotalStringBytes) {
        throw new ComplexityLimitError('value', 'JSON value exceeds the total string byte limit.');
      }
      return;
    }
    if (
      current === null ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      return;
    }
    if (typeof current !== 'object') {
      throw new ComplexityLimitError('value', 'Value is not JSON-compatible.');
    }
    if (ancestors.has(current)) {
      throw new ComplexityLimitError('value', 'JSON value contains a circular reference.');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > limits.maxArrayItems) {
          throw new ComplexityLimitError('value', 'JSON array exceeds the item limit.');
        }
        for (const item of current) visit(item, depth + 1);
        return;
      }

      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ComplexityLimitError('value', 'JSON value contains a non-plain object.');
      }
      const keys = Object.keys(current);
      if (keys.length > limits.maxObjectProperties) {
        throw new ComplexityLimitError('value', 'JSON object exceeds the property limit.');
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new ComplexityLimitError('value', 'JSON value contains symbol properties.');
      }
      for (const key of keys) {
        if (UNSAFE_KEYS.has(key)) {
          throw new ComplexityLimitError('value', 'JSON value contains an unsafe object key.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
          throw new ComplexityLimitError('value', 'JSON value contains an accessor property.');
        }
        totalStringBytes += byteLength(key);
        if (totalStringBytes > limits.maxTotalStringBytes) {
          throw new ComplexityLimitError(
            'value',
            'JSON value exceeds the total string byte limit.',
          );
        }
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, 0);
}

function assertSafePattern(pattern: string, limits: JsonSchemaComplexityLimits): void {
  if (pattern.length > limits.maxPatternLength) {
    throw new ComplexityLimitError('schema', 'JSON Schema regex exceeds the length limit.');
  }
  if (!safeRegex(pattern, { limit: limits.maxRegexRepetitions })) {
    throw new ComplexityLimitError(
      'schema',
      'JSON Schema contains a potentially unsafe regular expression.',
    );
  }
}

export function assertJsonSchemaComplexity(
  schema: unknown,
  limits: JsonSchemaComplexityLimits,
): void {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, depth: number, parentKey?: string): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new ComplexityLimitError('schema', 'JSON Schema exceeds the node limit.');
    }
    if (depth > limits.maxDepth) {
      throw new ComplexityLimitError('schema', 'JSON Schema exceeds the depth limit.');
    }
    if (parentKey === 'pattern' && typeof current === 'string') {
      assertSafePattern(current, limits);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (ancestors.has(current)) {
      throw new ComplexityLimitError('schema', 'JSON Schema contains an object cycle.');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1, parentKey);
        return;
      }
      const entries = Object.entries(current);
      for (const [key, child] of entries) {
        if (parentKey === 'patternProperties') assertSafePattern(key, limits);
        visit(child, depth + 1, key);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(schema, 0);
}
