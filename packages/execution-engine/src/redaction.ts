import type { JsonValue, RedactionPolicy } from './types.js';

export const DEFAULT_REDACTION_REPLACEMENT = '[REDACTED]';

export const DEFAULT_SENSITIVE_KEYS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'access-token',
  'refresh-token',
  'client-secret',
  'password',
  'passwd',
  'secret',
  'token',
]);
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replaceAll(/[-_]/g, '');
}

function sensitiveKeySet(policy?: RedactionPolicy): ReadonlySet<string> {
  return new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(policy?.sensitiveKeys ?? [])].map((key) => normalizeKey(key)),
  );
}

function cloneAndRedact(
  value: JsonValue,
  keys: ReadonlySet<string>,
  replacement: string,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => cloneAndRedact(item, keys, replacement));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        keys.has(normalizeKey(key)) ? replacement : cloneAndRedact(item, keys, replacement),
      ]),
    );
  }

  return value;
}

function setAtPath(root: JsonValue, path: readonly string[], replacement: string): void {
  if (path.length === 0 || root === null || typeof root !== 'object') {
    return;
  }

  let current: JsonValue = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (
      segment === undefined ||
      UNSAFE_PATH_SEGMENTS.has(segment) ||
      current === null ||
      typeof current !== 'object'
    ) {
      return;
    }

    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
        return;
      }
      const next: JsonValue | undefined = current[arrayIndex];
      if (next === undefined) {
        return;
      }
      current = next;
    } else {
      if (!Object.hasOwn(current, segment)) return;
      const next: JsonValue | undefined = current[segment];
      if (next === undefined) {
        return;
      }
      current = next;
    }
  }

  const leaf = path.at(-1);
  if (
    leaf === undefined ||
    UNSAFE_PATH_SEGMENTS.has(leaf) ||
    current === null ||
    typeof current !== 'object'
  ) {
    return;
  }

  if (Array.isArray(current)) {
    const arrayIndex = Number(leaf);
    if (Number.isInteger(arrayIndex) && arrayIndex >= 0 && arrayIndex < current.length) {
      current[arrayIndex] = replacement;
    }
    return;
  }

  if (Object.hasOwn(current, leaf)) {
    current[leaf] = replacement;
  }
}

/** Redacts recursively named sensitive fields for telemetry and audit payloads. */
export function redactSensitiveValue(value: JsonValue, policy?: RedactionPolicy): JsonValue {
  const replacement = policy?.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
  return cloneAndRedact(value, sensitiveKeySet(policy), replacement);
}

/**
 * Output redaction is opt-in by explicit paths so an implicit redaction cannot
 * make structuredContent violate its declared output schema.
 */
export function redactOutputPaths(value: JsonValue, policy?: RedactionPolicy): JsonValue {
  const cloned = structuredClone(value);
  const replacement = policy?.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
  for (const path of policy?.outputPaths ?? []) {
    setAtPath(cloned, path, replacement);
  }
  return cloned;
}

export function isSensitiveHeader(name: string, policy?: RedactionPolicy): boolean {
  return sensitiveKeySet(policy).has(normalizeKey(name));
}
