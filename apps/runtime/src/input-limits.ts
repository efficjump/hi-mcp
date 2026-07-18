import type { JsonValue } from '@hi-mcp/capability-ir';

export interface ToolInputLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
}

export const DEFAULT_TOOL_INPUT_LIMITS: ToolInputLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 50_000,
  maxStringBytes: 1024 * 1024,
});

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type JsonValueInspectionResult =
  | { readonly valid: true; readonly value: JsonValue }
  | {
      readonly valid: false;
      readonly limitExceeded: boolean;
      readonly message: string;
    };

type InspectionFrame =
  | { readonly kind: 'value'; readonly value: unknown; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object };

function resolveLimits(options: Partial<ToolInputLimits> | undefined): ToolInputLimits {
  const limits = { ...DEFAULT_TOOL_INPUT_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
  }
  return limits;
}

function invalid(message: string): JsonValueInspectionResult {
  return { valid: false, limitExceeded: false, message };
}

function exceeded(message: string): JsonValueInspectionResult {
  return { valid: false, limitExceeded: true, message };
}

/** Iteratively validates JSON compatibility and complexity without recursive parser stack growth. */
export function inspectJsonValue(
  input: unknown,
  options?: Partial<ToolInputLimits>,
): JsonValueInspectionResult {
  const limits = resolveLimits(options);
  const stack: InspectionFrame[] = [{ kind: 'value', value: input, depth: 0 }];
  const activeObjects = new WeakSet<object>();
  let nodes = 0;
  let stringBytes = 0;

  const countString = (value: string): boolean => {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > limits.maxStringBytes - stringBytes) return false;
    stringBytes += bytes;
    return true;
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      activeObjects.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > limits.maxNodes) {
      return exceeded(`Tool arguments exceed the ${limits.maxNodes}-node limit.`);
    }
    if (frame.depth > limits.maxDepth) {
      return exceeded(`Tool arguments exceed the depth limit of ${limits.maxDepth}.`);
    }

    const value = frame.value;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid('Tool arguments contain a non-finite number.');
      continue;
    }
    if (typeof value === 'string') {
      if (!countString(value)) {
        return exceeded(
          `Tool argument strings exceed the ${limits.maxStringBytes}-byte aggregate limit.`,
        );
      }
      continue;
    }
    if (typeof value !== 'object') {
      return invalid(`Tool arguments contain unsupported ${typeof value} values.`);
    }
    if (activeObjects.has(value)) return invalid('Tool arguments contain a circular reference.');

    activeObjects.add(value);
    stack.push({ kind: 'exit', value });

    if (Array.isArray(value)) {
      if (value.length > limits.maxNodes - nodes) {
        return exceeded(`Tool arguments exceed the ${limits.maxNodes}-node limit.`);
      }
      const ownKeys = Reflect.ownKeys(value);
      let indexedProperties = 0;
      for (const key of ownKeys) {
        if (key === 'length') continue;
        if (typeof key !== 'string') return invalid('Tool argument arrays contain symbol keys.');
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          return invalid('Tool argument arrays contain non-index properties.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return invalid('Tool argument arrays contain hidden or accessor properties.');
        }
        indexedProperties += 1;
        stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
      }
      if (indexedProperties !== value.length) return invalid('Tool argument arrays contain holes.');
      continue;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return invalid('Tool argument objects must have a plain-object prototype.');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > limits.maxNodes - nodes) {
      return exceeded(`Tool arguments exceed the ${limits.maxNodes}-node limit.`);
    }
    for (const key of ownKeys) {
      if (typeof key !== 'string') return invalid('Tool argument objects contain symbol keys.');
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        return invalid('Tool argument objects contain an unsafe property name.');
      }
      if (!countString(key)) {
        return exceeded(
          `Tool argument strings exceed the ${limits.maxStringBytes}-byte aggregate limit.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return invalid('Tool argument objects contain hidden or accessor properties.');
      }
      stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
    }
  }

  return { valid: true, value: input as JsonValue };
}
