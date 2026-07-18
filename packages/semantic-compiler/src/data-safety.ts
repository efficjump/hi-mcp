export interface SemanticDataLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxTotalStringBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectProperties: number;
}

export const DEFAULT_SEMANTIC_DATA_LIMITS: SemanticDataLimits = Object.freeze({
  maxNodes: 20_000,
  maxDepth: 64,
  maxStringBytes: 1_048_576,
  maxTotalStringBytes: 4_194_304,
  maxArrayItems: 1_000,
  maxObjectProperties: 1_000,
});

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class SemanticDataSafetyError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticDataSafetyError';
  }
}

type Frame =
  | { readonly kind: 'value'; readonly value: unknown; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object };

function normalizedLimits(options?: Partial<SemanticDataLimits>): SemanticDataLimits {
  const limits = { ...DEFAULT_SEMANTIC_DATA_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`semanticDataLimits.${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

/** Bounds provider/model data before recursive schemas or canonical serialization process it. */
export function assertSemanticDataSafe(
  input: unknown,
  options?: Partial<SemanticDataLimits>,
): void {
  const limits = normalizedLimits(options);
  const stack: Frame[] = [{ kind: 'value', value: input, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  let totalStringBytes = 0;

  const countString = (value: string): void => {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > limits.maxStringBytes) {
      throw new SemanticDataSafetyError('Semantic data contains an oversized string.');
    }
    totalStringBytes += bytes;
    if (totalStringBytes > limits.maxTotalStringBytes) {
      throw new SemanticDataSafetyError('Semantic data exceeds the aggregate string limit.');
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      active.delete(frame.value);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new SemanticDataSafetyError('Semantic data exceeds the node limit.');
    }
    if (frame.depth > limits.maxDepth) {
      throw new SemanticDataSafetyError('Semantic data exceeds the depth limit.');
    }

    const value = frame.value;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new SemanticDataSafetyError('Semantic data contains a non-finite number.');
      }
      continue;
    }
    if (typeof value === 'string') {
      countString(value);
      continue;
    }
    if (typeof value !== 'object') {
      throw new SemanticDataSafetyError('Semantic data is not plain JSON-compatible data.');
    }
    if (active.has(value)) {
      throw new SemanticDataSafetyError('Semantic data contains a cycle.');
    }
    active.add(value);
    stack.push({ kind: 'exit', value });

    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new SemanticDataSafetyError('Semantic data array exceeds the item limit.');
      }
      const keys = Reflect.ownKeys(value);
      let indexedProperties = 0;
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string') {
          throw new SemanticDataSafetyError('Semantic data array contains symbol keys.');
        }
        const index = Number(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key ||
          descriptor === undefined ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        ) {
          throw new SemanticDataSafetyError('Semantic data array is sparse or has unsafe members.');
        }
        indexedProperties += 1;
        stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
      }
      if (indexedProperties !== value.length) {
        throw new SemanticDataSafetyError('Semantic data array contains holes.');
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SemanticDataSafetyError('Semantic data contains a non-plain object.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > limits.maxObjectProperties) {
      throw new SemanticDataSafetyError('Semantic data object exceeds the property limit.');
    }
    for (const key of keys) {
      if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) {
        throw new SemanticDataSafetyError('Semantic data contains an unsafe object key.');
      }
      countString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new SemanticDataSafetyError('Semantic data contains hidden or accessor properties.');
      }
      stack.push({ kind: 'value', value: descriptor.value, depth: frame.depth + 1 });
    }
  }
}
