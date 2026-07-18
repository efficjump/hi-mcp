import type { JsonSchema, JsonValue } from './schemas.js';
import { canonicalStringify, stableId } from './fingerprint.js';

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
  );
}

function cloneValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
    );
  }
  return value;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function localReferenceFragment(reference: string, rootId: string | undefined): string | null {
  if (reference.startsWith('#')) {
    return reference.slice(1);
  }
  if (rootId !== undefined && reference === rootId) {
    return '';
  }
  if (rootId !== undefined && reference.startsWith(`${rootId}#`)) {
    return reference.slice(rootId.length + 1);
  }
  return null;
}

function collectAnchors(
  value: JsonValue,
  anchors: Map<string, string>,
  definitionKey: string,
  isRoot = true,
  insideNestedResource = false,
): void {
  if (Array.isArray(value)) {
    value.forEach((child) =>
      collectAnchors(child, anchors, definitionKey, false, insideNestedResource),
    );
    return;
  }
  if (!isObject(value)) {
    return;
  }
  const nested = insideNestedResource || (!isRoot && typeof value['$id'] === 'string');
  if (!nested) {
    for (const keyword of ['$anchor', '$dynamicAnchor'] as const) {
      const anchor = value[keyword];
      if (typeof anchor === 'string' && /^[A-Za-z_][-A-Za-z0-9._]*$/.test(anchor)) {
        anchors.set(anchor, `${definitionKey}_${anchor}`);
      }
    }
  }
  for (const child of Object.values(value)) {
    collectAnchors(child, anchors, definitionKey, false, nested);
  }
}

/** True when embedding this schema below another root would change local-reference semantics. */
export function schemaNeedsResourceBoundary(schema: JsonSchema): boolean {
  if (typeof schema === 'boolean') {
    return false;
  }
  const visit = (value: JsonValue): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!isObject(value)) {
      return false;
    }
    if (
      typeof value['$id'] === 'string' ||
      typeof value['$anchor'] === 'string' ||
      typeof value['$dynamicAnchor'] === 'string' ||
      isObject(value['$defs'])
    ) {
      return true;
    }
    for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef'] as const) {
      const reference = value[keyword];
      if (typeof reference === 'string' && reference.startsWith('#')) {
        return true;
      }
    }
    return Object.values(value).some(visit);
  };
  return visit(schema);
}

/** Deterministic key used when a standalone schema is hoisted into a host schema's `$defs`. */
export function embeddedSchemaDefinitionKey(schema: JsonSchema): string {
  return stableId('embedded', schema);
}

/** Creates the local reference used by a host schema to address an embedded definition. */
export function embeddedSchemaReference(definitionKey: string): JsonSchema {
  if (definitionKey.length === 0) {
    throw new TypeError('Embedded schema definition key cannot be empty');
  }
  return { $ref: `#/$defs/${escapePointerSegment(definitionKey)}` };
}

/**
 * Moves a standalone schema under a host `$defs` key. Root-local JSON Pointers and anchors are
 * rebased to that key, while nested resources with their own `$id` retain their original scope.
 */
export function rebaseSchemaResource(schema: JsonSchema, definitionKey: string): JsonSchema {
  if (typeof schema === 'boolean') {
    return schema;
  }
  if (definitionKey.length === 0) {
    throw new TypeError('Embedded schema definition key cannot be empty');
  }
  const rootId = typeof schema['$id'] === 'string' ? schema['$id'] : undefined;
  const anchors = new Map<string, string>();
  collectAnchors(schema, anchors, definitionKey);
  const boundaryPointer = `#/$defs/${escapePointerSegment(definitionKey)}`;

  const visit = (value: JsonValue, isRoot: boolean, insideNestedResource: boolean): JsonValue => {
    if (Array.isArray(value)) {
      return value.map((child) => visit(child, false, insideNestedResource));
    }
    if (!isObject(value)) {
      return value;
    }

    const declaresNestedResource =
      !isRoot && typeof value['$id'] === 'string' && value['$id'].length > 0;
    const nested = insideNestedResource || declaresNestedResource;
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isRoot && key === '$id') {
        continue;
      }
      if (!nested && (key === '$anchor' || key === '$dynamicAnchor') && typeof child === 'string') {
        output[key] = anchors.get(child) ?? child;
        continue;
      }
      if (
        !nested &&
        (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') &&
        typeof child === 'string'
      ) {
        const fragment = localReferenceFragment(child, rootId);
        if (fragment !== null) {
          if (fragment === '') {
            output[key] = boundaryPointer;
          } else if (fragment.startsWith('/')) {
            output[key] = `${boundaryPointer}${fragment}`;
          } else {
            output[key] = `#${anchors.get(fragment) ?? fragment}`;
          }
          continue;
        }
      }
      output[key] = visit(child, false, nested);
    }
    return output;
  };

  return visit(schema, true, false) as JsonSchema;
}

/** Collision-safe registry for composing standalone schemas into one host JSON Schema. */
export class SchemaCompositionRegistry {
  readonly #definitions: Record<string, JsonSchema> = {};

  public embed(schema: JsonSchema): JsonSchema {
    if (!schemaNeedsResourceBoundary(schema)) {
      return cloneValue(schema) as JsonSchema;
    }

    const baseKey = embeddedSchemaDefinitionKey(schema);
    let key = baseKey;
    let collisionIndex = 1;
    while (true) {
      const rebased = rebaseSchemaResource(schema, key);
      const existing = this.#definitions[key];
      if (existing === undefined) {
        this.#definitions[key] = rebased;
        return embeddedSchemaReference(key);
      }
      if (canonicalStringify(existing) === canonicalStringify(rebased)) {
        return embeddedSchemaReference(key);
      }
      key = `${baseKey}_${collisionIndex}`;
      collisionIndex += 1;
    }
  }

  public definitions(): Readonly<Record<string, JsonSchema>> {
    return Object.fromEntries(
      Object.entries(this.#definitions).map(([key, schema]) => [
        key,
        cloneValue(schema) as JsonSchema,
      ]),
    );
  }
}
