import { createHash } from 'node:crypto';

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalizationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

function normalize(
  value: unknown,
  location: string,
  ancestors: WeakSet<object>,
): CanonicalValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(`${location} contains a non-finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new CanonicalizationError(`${location} contains unsupported value type ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalizationError(`${location} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const normalized = normalize(item, `${location}[${index}]`, ancestors);
        if (normalized === undefined) {
          throw new CanonicalizationError(`${location}[${index}] is undefined`);
        }
        return normalized;
      });
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(`${location} must contain only plain objects`);
    }

    const result: Record<string, CanonicalValue> = Object.create(null) as Record<
      string,
      CanonicalValue
    >;
    for (const key of Object.keys(value).sort()) {
      const normalized = normalize(
        (value as Record<string, unknown>)[key],
        `${location}.${key}`,
        ancestors,
      );
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Produces a JSON-compatible value with recursively sorted object keys. */
export function canonicalize(value: unknown): CanonicalValue {
  const normalized = normalize(value, '$', new WeakSet<object>());
  if (normalized === undefined) {
    throw new CanonicalizationError('The root value cannot be undefined');
  }
  return normalized;
}

/** Serializes data deterministically for hashing, manifests, and cache keys. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Returns a content fingerprint with an explicit hash-algorithm prefix. */
export function fingerprint(value: unknown): string {
  const digest = createHash('sha256').update(canonicalStringify(value)).digest('hex');
  return `sha256:${digest}`;
}

function normalizeStableIdPart(part: string): string {
  return part.normalize('NFKC').trim();
}

/**
 * Generates an identifier stable across processes and input object key order.
 * The human-readable namespace is validated so IDs remain safe in paths and logs.
 */
export function stableId(namespace: string, ...parts: readonly unknown[]): string {
  const normalizedNamespace = normalizeStableIdPart(namespace).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalizedNamespace)) {
    throw new TypeError(`Invalid stable ID namespace: ${namespace}`);
  }

  const digest = createHash('sha256').update(canonicalStringify(parts)).digest('hex').slice(0, 24);
  return `${normalizedNamespace}_${digest}`;
}
