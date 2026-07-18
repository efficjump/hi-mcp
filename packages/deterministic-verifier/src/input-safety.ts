import type { VerificationInputLimits } from './types.js';

export const DEFAULT_VERIFICATION_INPUT_LIMITS: VerificationInputLimits = Object.freeze({
  maxNodes: 100_000,
  maxDepth: 128,
  maxStringBytes: 4 * 1024 * 1024,
  maxTotalStringBytes: 16 * 1024 * 1024,
  maxArrayItems: 50_000,
  maxObjectProperties: 10_000,
});

export interface VerificationInputFailure {
  readonly kind: 'limit' | 'unsafe';
  readonly message: string;
}

type InspectionFrame =
  | { readonly kind: 'value'; readonly value: unknown; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object };

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function normalizedLimits(
  options: Partial<VerificationInputLimits> | undefined,
): VerificationInputLimits {
  const limits = { ...DEFAULT_VERIFICATION_INPUT_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`inputLimits.${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function limited(message: string): VerificationInputFailure {
  return { kind: 'limit', message };
}

function unsafe(message: string): VerificationInputFailure {
  return { kind: 'unsafe', message };
}

/**
 * Performs bounded, iterative plain-JSON inspection before recursive Zod schemas are invoked.
 * Returns null only when the complete object graph is safe to parse recursively.
 */
export function inspectVerificationInput(
  input: unknown,
  options?: Partial<VerificationInputLimits>,
): VerificationInputFailure | null {
  const limits = normalizedLimits(options);
  const stack: InspectionFrame[] = [{ kind: 'value', value: input, depth: 0 }];
  const activeObjects = new WeakSet<object>();
  let nodes = 0;
  let totalStringBytes = 0;

  const countString = (value: string): VerificationInputFailure | null => {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > limits.maxStringBytes) {
      return limited('Input contains a string that exceeds the per-string byte limit.');
    }
    if (bytes > limits.maxTotalStringBytes - totalStringBytes) {
      return limited('Input exceeds the aggregate string byte limit.');
    }
    totalStringBytes += bytes;
    return null;
  };

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === 'exit') {
        activeObjects.delete(frame.value);
        continue;
      }

      nodes += 1;
      if (nodes > limits.maxNodes) return limited('Input exceeds the node limit.');
      if (frame.depth > limits.maxDepth) return limited('Input exceeds the depth limit.');

      const value = frame.value;
      if (value === null || typeof value === 'boolean') continue;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return unsafe('Input contains a non-finite number.');
        continue;
      }
      if (typeof value === 'string') {
        const failure = countString(value);
        if (failure !== null) return failure;
        continue;
      }
      if (typeof value !== 'object') {
        return unsafe(`Input contains unsupported ${typeof value} values.`);
      }
      if (activeObjects.has(value)) return unsafe('Input contains a circular reference.');

      activeObjects.add(value);
      stack.push({ kind: 'exit', value });

      if (Array.isArray(value)) {
        if (value.length > limits.maxArrayItems)
          return limited('Input array exceeds the item limit.');
        if (value.length > limits.maxNodes - nodes) return limited('Input exceeds the node limit.');
        const keys = Reflect.ownKeys(value);
        let indexedProperties = 0;
        for (const key of keys) {
          if (key === 'length') continue;
          if (typeof key !== 'string') return unsafe('Input arrays contain symbol keys.');
          const index = Number(key);
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          ) {
            return unsafe('Input arrays contain non-index properties.');
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
            return unsafe('Input arrays contain hidden or accessor properties.');
          }
          indexedProperties += 1;
          stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
        }
        if (indexedProperties !== value.length) return unsafe('Input arrays contain holes.');
        continue;
      }

      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        return unsafe('Input contains a non-plain object.');
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length > limits.maxObjectProperties) {
        return limited('Input object exceeds the property limit.');
      }
      if (keys.length > limits.maxNodes - nodes) return limited('Input exceeds the node limit.');
      for (const key of keys) {
        if (typeof key !== 'string') return unsafe('Input objects contain symbol keys.');
        if (UNSAFE_KEYS.has(key)) return unsafe('Input contains an unsafe object key.');
        const keyFailure = countString(key);
        if (keyFailure !== null) return keyFailure;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return unsafe('Input objects contain hidden or accessor properties.');
        }
        stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
      }
    }
  } catch {
    return unsafe('Input could not be safely inspected as a plain JSON value.');
  }

  return null;
}
