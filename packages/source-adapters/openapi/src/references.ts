import { types as utilTypes } from 'node:util';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fingerprint, stableId } from '@hi-mcp/capability-ir';

import { DiagnosticCollector } from './diagnostics.js';
import { encodePointerSegment } from './parse.js';
import type { ExternalReferenceResolver } from './types.js';

const DEFAULT_MAX_REF_DEPTH = 64;
const DEFAULT_MAX_OBJECT_DEPTH = 256;
const DEFAULT_MAX_RESOLVED_NODES = 100_000;
const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function configuredLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  collector: DiagnosticCollector,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  collector.add({
    code: 'OPENAPI.INVALID_SAFETY_LIMIT',
    severity: 'error',
    message: `${name} must be a positive safe integer`,
    recoverable: false,
    details: { option: name, value: String(value) },
  });
  return 0;
}

export interface ReferenceResolverOptions {
  readonly sourceUri?: string;
  readonly maxRefDepth?: number;
  readonly maxObjectDepth?: number;
  readonly maxResolvedNodes?: number;
  readonly externalRefResolver?: ExternalReferenceResolver;
}

interface ResolutionContext {
  readonly sourceUri?: string;
  readonly externalDocument: boolean;
}

interface ReferenceDescriptor {
  readonly cacheKey: string;
  readonly external: boolean;
  readonly resolvedReference: string;
  readonly targetContext: ResolutionContext;
}

interface CachedExternalReference {
  readonly resolvedReference: string;
  readonly target: unknown;
}

export class ReferenceResolver {
  readonly #maxRefDepth: number;
  readonly #maxObjectDepth: number;
  readonly #maxResolvedNodes: number;
  readonly #externalCache = new Map<string, CachedExternalReference>();
  readonly #externalValueContexts = new WeakMap<object, ResolutionContext>();
  #externalCacheSealed = false;
  #resolvedNodes = 0;
  #budgetDiagnosticEmitted = false;

  private get supportsOpenApi31ReferenceSiblings(): boolean {
    const version = this.root['openapi'];
    if (typeof version !== 'string') return false;
    const minor = /^(?:3)\.(\d+)/.exec(version)?.[1];
    return minor !== undefined && Number(minor) >= 1;
  }

  private referenceSiblingKeys(
    value: Record<string, unknown>,
    usagePointer: string,
  ): readonly string[] {
    // Path Item uses `$ref` as a fixed field rather than the standalone Reference Object. The
    // specification leaves adjacent-field resolution undefined, so preserve deterministic local
    // overrides instead of applying Reference Object sibling rules to this distinct construct.
    if (/^\/paths\/[^/]+$/.test(usagePointer)) {
      return Object.keys(value).filter((key) => key !== '$ref');
    }
    if (!this.supportsOpenApi31ReferenceSiblings) return [];
    return ['summary', 'description'].filter((key) => Object.hasOwn(value, key));
  }

  public constructor(
    private readonly root: Readonly<Record<string, unknown>>,
    private readonly collector: DiagnosticCollector,
    private readonly options: ReferenceResolverOptions,
  ) {
    this.#maxRefDepth = configuredLimit(
      options.maxRefDepth,
      DEFAULT_MAX_REF_DEPTH,
      'maxRefDepth',
      collector,
    );
    this.#maxObjectDepth = configuredLimit(
      options.maxObjectDepth,
      DEFAULT_MAX_OBJECT_DEPTH,
      'maxObjectDepth',
      collector,
    );
    this.#maxResolvedNodes = configuredLimit(
      options.maxResolvedNodes,
      DEFAULT_MAX_RESOLVED_NODES,
      'maxResolvedNodes',
      collector,
    );
  }

  public audit(): void {
    const auditedReferenceTargets = new Set<string>();
    const walk = (
      value: unknown,
      pointer: string,
      stack: readonly string[],
      ancestors: WeakSet<object>,
      context: ResolutionContext,
      schemaContext: boolean,
    ): void => {
      if (!this.consumeNode(pointer)) {
        return;
      }
      if (Array.isArray(value)) {
        if (ancestors.has(value)) {
          this.circularExternalValue(pointer);
          return;
        }
        if (!this.canVisitNodes(value.length, pointer)) {
          return;
        }
        ancestors.add(value);
        value.forEach((item, index) =>
          walk(item, `${pointer}/${index}`, stack, ancestors, context, schemaContext),
        );
        ancestors.delete(value);
        return;
      }
      if (!isRecord(value)) {
        return;
      }
      if (ancestors.has(value)) {
        this.circularExternalValue(pointer);
        return;
      }

      const reference = value['$ref'];
      if (reference !== undefined) {
        const siblingKeys = [
          ...(schemaContext && this.supportsOpenApi31ReferenceSiblings
            ? Object.keys(value).filter((key) => key !== '$ref')
            : this.referenceSiblingKeys(value, pointer)),
        ].sort();
        if (!this.canVisitNodes(siblingKeys.length, pointer)) {
          return;
        }
        ancestors.add(value);
        for (const key of siblingKeys) {
          walk(
            value[key],
            `${pointer}/${encodePointerSegment(key)}`,
            stack,
            ancestors,
            context,
            schemaContext,
          );
        }
        ancestors.delete(value);

        if (typeof reference !== 'string' || reference.length === 0) {
          this.resolveShallowInContext({ $ref: reference }, pointer, stack, context);
          return;
        }
        const descriptor = this.describeReference(reference, context);
        if (stack.includes(descriptor.cacheKey)) {
          this.resolveShallowInContext({ $ref: reference }, pointer, stack, context);
          return;
        }
        const auditKey = `${schemaContext ? 'schema' : 'reference'}:${descriptor.cacheKey}`;
        if (auditedReferenceTargets.has(auditKey)) {
          return;
        }
        auditedReferenceTargets.add(auditKey);
        const target = this.resolveShallowInContext({ $ref: reference }, pointer, stack, context);
        if (target !== undefined) {
          walk(
            target,
            pointer,
            [...stack, descriptor.cacheKey],
            new WeakSet<object>(),
            this.contextFor(target) ?? descriptor.targetContext,
            schemaContext,
          );
        }
        return;
      }

      ancestors.add(value);
      const keys = Object.keys(value).sort();
      if (!this.canVisitNodes(keys.length, pointer)) {
        ancestors.delete(value);
        return;
      }
      for (const key of keys) {
        const childSchemaContext = schemaContext || key === 'schema' || key === 'schemas';
        walk(
          value[key],
          `${pointer}/${encodePointerSegment(key)}`,
          stack,
          ancestors,
          context,
          childSchemaContext,
        );
      }
      ancestors.delete(value);
    };

    walk(this.root, '', [], new WeakSet<object>(), this.rootContext(), false);
    this.#externalCacheSealed = true;
  }

  /** Fingerprints the sanitized external dependency graph in reference-name order. */
  public externalReferencesFingerprint(): string | undefined {
    if (this.#externalCache.size === 0) {
      return undefined;
    }
    const references = [...this.#externalCache.entries()]
      .map(([cacheKey, entry]) => ({
        cacheKey,
        reference: entry.resolvedReference,
        target: entry.target,
      }))
      .sort((left, right) =>
        left.cacheKey < right.cacheKey ? -1 : left.cacheKey > right.cacheKey ? 1 : 0,
      );
    return fingerprint(references);
  }

  /** Resolves only a Reference Object at this level and leaves nested values untouched. */
  public resolveShallow(
    value: unknown,
    usagePointer: string,
    stack: readonly string[] = [],
  ): unknown {
    return this.resolveShallowInContext(
      value,
      usagePointer,
      stack,
      this.contextFor(value) ?? this.rootContext(),
    );
  }

  private resolveShallowInContext(
    value: unknown,
    usagePointer: string,
    stack: readonly string[],
    context: ResolutionContext,
  ): unknown {
    if (!this.consumeNode(usagePointer)) {
      return undefined;
    }
    if (!isRecord(value) || value['$ref'] === undefined) {
      return value;
    }
    const reference = value['$ref'];
    if (typeof reference !== 'string' || reference.length === 0) {
      this.collector.add({
        code: 'OPENAPI.INVALID_REF',
        severity: 'error',
        message: '$ref must be a non-empty string',
        pointer: `${usagePointer}/$ref`,
      });
      return undefined;
    }
    return this.resolveReference(reference, value, usagePointer, stack, false, context);
  }

  /**
   * Dereferences a schema and rebases recursive component references into local `$defs`, making
   * the resulting schema self-contained instead of leaving pointers into the OpenAPI document.
   */
  public resolveSchema(value: unknown, usagePointer: string): unknown {
    const components = this.root['components'];
    const schemas =
      isRecord(components) && isRecord(components['schemas']) ? components['schemas'] : undefined;
    if (!isRecord(value)) {
      return value;
    }

    const existingDefinitions = isRecord(value['$defs']) ? value['$defs'] : {};
    const definitions: Record<string, unknown> = {};
    const componentDefinitionKeys = new Map<string, string>();
    const referenceDefinitionKeys = new Map<string, string>();
    const populatingDefinitions = new Set<string>();
    const populatedDefinitions = new Set<string>();

    const componentReference = (
      reference: string,
    ): { readonly name: string; readonly suffix: readonly string[] } | null => {
      if (!reference.startsWith('#/')) {
        return null;
      }
      let fragment: string;
      try {
        fragment = decodeURIComponent(reference.slice(2));
      } catch {
        return null;
      }
      const segments = fragment.split('/').map(decodePointerSegment);
      if (segments[0] !== 'components' || segments[1] !== 'schemas' || segments[2] === undefined) {
        return null;
      }
      return { name: segments[2], suffix: segments.slice(3) };
    };

    const reserveDefinitionKey = (base: string): string => {
      let candidate = base;
      let collisionIndex = 1;
      while (
        Object.hasOwn(existingDefinitions, candidate) ||
        Object.hasOwn(definitions, candidate)
      ) {
        candidate = `${base}:${collisionIndex}`;
        collisionIndex += 1;
      }
      definitions[candidate] = true;
      return candidate;
    };

    const componentDefinitionKey = (name: string): string => {
      const existing = componentDefinitionKeys.get(name);
      if (existing !== undefined) {
        return existing;
      }
      const key = reserveDefinitionKey(`openapi:${name}`);
      componentDefinitionKeys.set(name, key);
      return key;
    };

    const referenceDefinitionKey = (cacheKey: string): string => {
      const existing = referenceDefinitionKeys.get(cacheKey);
      if (existing !== undefined) {
        return existing;
      }
      const key = reserveDefinitionKey(stableId('external', cacheKey));
      referenceDefinitionKeys.set(cacheKey, key);
      return key;
    };

    const rewrite = (node: unknown, context: ResolutionContext): unknown => {
      if (!this.consumeNode(usagePointer)) {
        return Object.create(null) as Record<string, unknown>;
      }
      if (Array.isArray(node)) {
        if (!this.canVisitNodes(node.length, usagePointer)) {
          return Object.create(null) as Record<string, unknown>;
        }
        return node.map((item) => rewrite(item, context));
      }
      if (!isRecord(node)) {
        return node;
      }

      const reference = node['$ref'];
      const preserveSchemaSiblings =
        reference === undefined || this.supportsOpenApi31ReferenceSiblings;
      if (preserveSchemaSiblings) {
        for (const keyword of ['$dynamicRef', '$recursiveRef'] as const) {
          const dynamicReference = node[keyword];
          if (
            dynamicReference !== undefined &&
            (typeof dynamicReference !== 'string' || dynamicReference.length === 0)
          ) {
            this.collector.add({
              code: 'OPENAPI.INVALID_DYNAMIC_REF',
              severity: 'error',
              message: `${keyword} must be a non-empty string`,
              pointer: `${usagePointer}/${keyword}`,
            });
            return false;
          }
          if (typeof dynamicReference === 'string' && !dynamicReference.startsWith('#')) {
            this.collector.add({
              code: 'OPENAPI.EXTERNAL_DYNAMIC_REF_UNSUPPORTED',
              severity: 'error',
              message: `${keyword} cannot target an external resource during deterministic schema bundling`,
              pointer: `${usagePointer}/${keyword}`,
              recoverable: false,
              details: { reference: dynamicReference },
            });
            return false;
          }
        }
      }

      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = Object.keys(node)
        .filter((key) => key === '$ref' || preserveSchemaSiblings)
        .sort();
      if (!this.canVisitNodes(keys.length, usagePointer)) {
        return output;
      }
      for (const key of keys) {
        if (key !== '$ref') {
          output[key] = rewrite(node[key], context);
        }
      }
      if (reference !== undefined && (typeof reference !== 'string' || reference.length === 0)) {
        this.collector.add({
          code: 'OPENAPI.INVALID_REF',
          severity: 'error',
          message: '$ref must be a non-empty string',
          pointer: `${usagePointer}/$ref`,
        });
        return false;
      }
      if (typeof reference !== 'string') {
        return output;
      }

      const component = context.externalDocument ? null : componentReference(reference);
      if (component !== null && schemas !== undefined && Object.hasOwn(schemas, component.name)) {
        const key = componentDefinitionKey(component.name);
        if (!populatedDefinitions.has(key) && !populatingDefinitions.has(key)) {
          populatingDefinitions.add(key);
          definitions[key] = rewrite(schemas[component.name], this.rootContext());
          populatingDefinitions.delete(key);
          populatedDefinitions.add(key);
        }
        const suffix = component.suffix.map(encodePointerSegment).join('/');
        output['$ref'] =
          `#/$defs/${encodePointerSegment(key)}${suffix.length === 0 ? '' : `/${suffix}`}`;
        return output;
      }

      const descriptor = this.describeReference(reference, context);
      const key = referenceDefinitionKey(descriptor.cacheKey);
      output['$ref'] = `#/$defs/${encodePointerSegment(key)}`;
      if (!populatedDefinitions.has(key) && !populatingDefinitions.has(key)) {
        populatingDefinitions.add(key);
        const target = this.resolveShallowInContext({ $ref: reference }, usagePointer, [], context);
        definitions[key] =
          target === undefined
            ? false
            : rewrite(target, this.contextFor(target) ?? descriptor.targetContext);
        populatingDefinitions.delete(key);
        populatedDefinitions.add(key);
      }
      return output;
    };

    const bundled = rewrite(value, this.contextFor(value) ?? this.rootContext());
    if (!isRecord(bundled) || Object.keys(definitions).length === 0) {
      return bundled;
    }
    const bundledDefinitions = isRecord(bundled['$defs']) ? bundled['$defs'] : {};
    return {
      ...bundled,
      ...(typeof bundled['$id'] === 'string'
        ? {}
        : { $id: `urn:hi-mcp:${stableId('schema', usagePointer, value)}` }),
      $defs: {
        ...bundledDefinitions,
        ...definitions,
      },
    };
  }

  public resolveNode(
    value: unknown,
    usagePointer: string,
    stack: readonly string[] = [],
    ancestors: WeakSet<object> = new WeakSet<object>(),
  ): unknown {
    return this.resolveNodeInContext(
      value,
      usagePointer,
      stack,
      ancestors,
      this.contextFor(value) ?? this.rootContext(),
    );
  }

  private resolveNodeInContext(
    value: unknown,
    usagePointer: string,
    stack: readonly string[],
    ancestors: WeakSet<object>,
    context: ResolutionContext,
  ): unknown {
    if (!this.consumeNode(usagePointer)) {
      return undefined;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        this.circularExternalValue(usagePointer);
        return undefined;
      }
      if (!this.canVisitNodes(value.length, usagePointer)) {
        return undefined;
      }
      ancestors.add(value);
      try {
        return value.map(
          (item, index) =>
            this.resolveNodeInContext(
              item,
              `${usagePointer}/${index}`,
              stack,
              ancestors,
              context,
            ) ?? null,
        );
      } finally {
        ancestors.delete(value);
      }
    }
    if (!isRecord(value)) {
      return value;
    }

    const reference = value['$ref'];
    if (reference !== undefined) {
      if (typeof reference !== 'string' || reference.length === 0) {
        this.collector.add({
          code: 'OPENAPI.INVALID_REF',
          severity: 'error',
          message: '$ref must be a non-empty string',
          pointer: `${usagePointer}/$ref`,
        });
        return undefined;
      }
      return this.resolveReference(reference, value, usagePointer, stack, true, context);
    }

    if (ancestors.has(value)) {
      this.circularExternalValue(usagePointer);
      return undefined;
    }

    ancestors.add(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    try {
      const keys = Object.keys(value).sort();
      if (!this.canVisitNodes(keys.length, usagePointer)) {
        return output;
      }
      for (const key of keys) {
        const resolved = this.resolveNodeInContext(
          value[key],
          `${usagePointer}/${encodePointerSegment(key)}`,
          stack,
          ancestors,
          context,
        );
        if (resolved !== undefined) {
          output[key] = resolved;
        }
      }
    } finally {
      ancestors.delete(value);
    }
    return output;
  }

  private resolveReference(
    reference: string,
    referenceObject: Record<string, unknown>,
    usagePointer: string,
    stack: readonly string[],
    deep: boolean,
    context: ResolutionContext,
  ): unknown {
    if (stack.length >= this.#maxRefDepth) {
      this.collector.add({
        code: 'OPENAPI.REF_DEPTH_EXCEEDED',
        severity: 'error',
        message: `Reference depth exceeds the configured limit of ${this.#maxRefDepth}`,
        pointer: usagePointer,
      });
      return undefined;
    }
    const descriptor = this.describeReference(reference, context);
    if (stack.includes(descriptor.cacheKey)) {
      const schemaCycle =
        usagePointer.includes('/schemas/') ||
        usagePointer.endsWith('/schema') ||
        usagePointer.includes('/schema/');
      this.collector.add({
        code: 'OPENAPI.REF_CYCLE',
        severity: schemaCycle ? 'info' : 'error',
        message: `Reference cycle detected for '${reference}'`,
        pointer: usagePointer,
        details: { chain: [...stack, descriptor.cacheKey] },
      });
      return { $ref: reference };
    }

    let target: unknown;
    if (!descriptor.external) {
      target = this.resolveInternalPointer(reference, usagePointer);
    } else if (this.options.externalRefResolver === undefined) {
      this.collector.add({
        code: 'OPENAPI.EXTERNAL_REF_REJECTED',
        severity: 'error',
        message: `External reference '${reference}' is rejected by default`,
        pointer: usagePointer,
      });
      return undefined;
    } else {
      if (this.#externalCache.has(descriptor.cacheKey)) {
        target = this.#externalCache.get(descriptor.cacheKey)?.target;
      } else {
        if (this.#externalCacheSealed) {
          this.collector.add({
            code: 'OPENAPI.EXTERNAL_REF_DISCOVERED_AFTER_AUDIT',
            severity: 'error',
            message: `External reference '${reference}' was not captured by the dependency audit`,
            pointer: usagePointer,
            recoverable: false,
          });
          return undefined;
        }
        let rawTarget: unknown;
        try {
          rawTarget = this.options.externalRefResolver(reference, {
            ...(context.sourceUri === undefined ? {} : { sourceUri: context.sourceUri }),
            resolvedReference: descriptor.resolvedReference,
            usagePointer,
          });
        } catch (error) {
          this.collector.add({
            code: 'OPENAPI.EXTERNAL_REF_RESOLUTION_FAILED',
            severity: 'error',
            message:
              error instanceof Error
                ? `External reference '${reference}' failed: ${error.message}`
                : `External reference '${reference}' failed`,
            pointer: usagePointer,
          });
          return undefined;
        }
        if (rawTarget !== undefined) {
          target = this.sanitizeExternalValue(rawTarget, usagePointer, 0, new WeakSet<object>());
          if (target === undefined) {
            return undefined;
          }
          this.associateExternalContext(target, descriptor.targetContext);
          this.#externalCache.set(descriptor.cacheKey, {
            resolvedReference: descriptor.resolvedReference,
            target,
          });
        }
      }
      if (target === undefined) {
        this.collector.add({
          code: 'OPENAPI.EXTERNAL_REF_NOT_FOUND',
          severity: 'error',
          message: `External resolver returned no value for '${reference}'`,
          pointer: usagePointer,
        });
        return undefined;
      }
    }
    if (target === undefined) {
      return undefined;
    }

    const targetContext = this.contextFor(target) ?? descriptor.targetContext;
    const resolved = deep
      ? this.resolveNodeInContext(
          target,
          usagePointer,
          [...stack, descriptor.cacheKey],
          new WeakSet<object>(),
          targetContext,
        )
      : this.resolveShallowInContext(
          target,
          usagePointer,
          [...stack, descriptor.cacheKey],
          targetContext,
        );
    const siblingKeys = this.referenceSiblingKeys(referenceObject, usagePointer);
    if (siblingKeys.length === 0) {
      return resolved;
    }
    if (!isRecord(resolved)) {
      this.collector.add({
        code: 'OPENAPI.INVALID_REF_SIBLINGS',
        severity: 'warning',
        message: 'Reference siblings cannot be merged into a non-object target',
        pointer: usagePointer,
      });
      return resolved;
    }

    const rawSiblings = Object.fromEntries(siblingKeys.map((key) => [key, referenceObject[key]]));
    const siblings = deep
      ? this.resolveNodeInContext(rawSiblings, usagePointer, stack, new WeakSet<object>(), context)
      : rawSiblings;
    if (!isRecord(siblings)) {
      return resolved;
    }
    const merged = { ...resolved, ...siblings };
    this.#externalValueContexts.set(merged, targetContext);
    return merged;
  }

  private rootContext(): ResolutionContext {
    return {
      ...(this.options.sourceUri === undefined ? {} : { sourceUri: this.options.sourceUri }),
      externalDocument: false,
    };
  }

  private contextFor(value: unknown): ResolutionContext | undefined {
    return value !== null && typeof value === 'object'
      ? this.#externalValueContexts.get(value)
      : undefined;
  }

  private associateExternalContext(value: unknown, context: ResolutionContext): void {
    if (value === null || typeof value !== 'object') {
      return;
    }
    const pending: object[] = [value];
    const visited = new WeakSet<object>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);
      this.#externalValueContexts.set(current, context);
      for (const child of Array.isArray(current)
        ? current
        : Object.values(current as Record<string, unknown>)) {
        if (child !== null && typeof child === 'object') {
          pending.push(child);
        }
      }
    }
  }

  private describeReference(reference: string, context: ResolutionContext): ReferenceDescriptor {
    if (reference.startsWith('#') && !context.externalDocument) {
      return {
        cacheKey: `root:${reference}`,
        external: false,
        resolvedReference: reference,
        targetContext: context,
      };
    }

    let resolvedReference: string | undefined;
    let filesystemBase = false;
    try {
      let baseUri = context.sourceUri;
      if (baseUri !== undefined && isAbsolute(baseUri)) {
        baseUri = pathToFileURL(baseUri).href;
        filesystemBase = true;
      }
      resolvedReference =
        baseUri === undefined
          ? isAbsolute(reference)
            ? pathToFileURL(reference).href
            : new URL(reference).href
          : new URL(reference, baseUri).href;
    } catch {
      // Custom resolver schemes and non-URI source identifiers remain safely scoped by context.
    }
    const scopedReference =
      resolvedReference ??
      (context.sourceUri === undefined ? reference : `${context.sourceUri}\u0000${reference}`);
    let targetSourceUri = context.sourceUri;
    if (resolvedReference !== undefined) {
      try {
        const target = new URL(resolvedReference);
        target.hash = '';
        targetSourceUri =
          filesystemBase && target.protocol === 'file:' ? fileURLToPath(target) : target.href;
      } catch {
        // The resolved value came from URL, so this is defensive only.
      }
    }
    return {
      cacheKey: `external:${scopedReference}`,
      external: true,
      resolvedReference: resolvedReference ?? reference,
      targetContext: {
        ...(targetSourceUri === undefined ? {} : { sourceUri: targetSourceUri }),
        externalDocument: true,
      },
    };
  }

  private resolveInternalPointer(reference: string, usagePointer: string): unknown {
    let fragment: string;
    try {
      fragment = decodeURIComponent(reference.slice(1));
    } catch {
      this.invalidPointer(reference, usagePointer, 'contains invalid percent encoding');
      return undefined;
    }
    if (fragment === '') {
      return this.root;
    }
    if (!fragment.startsWith('/')) {
      this.invalidPointer(reference, usagePointer, 'must use JSON Pointer syntax');
      return undefined;
    }

    const encodedSegments = fragment.slice(1).split('/');
    for (const encodedSegment of encodedSegments) {
      if (/~(?:[^01]|$)/.test(encodedSegment)) {
        this.invalidPointer(reference, usagePointer, "contains invalid '~' escaping");
        return undefined;
      }
    }

    let current: unknown = this.root;
    for (const encodedSegment of encodedSegments) {
      if (!this.consumeNode(usagePointer)) {
        return undefined;
      }
      const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
      if (UNSAFE_POINTER_SEGMENTS.has(segment)) {
        this.invalidPointer(reference, usagePointer, `contains unsafe segment '${segment}'`);
        return undefined;
      }
      if (Array.isArray(current)) {
        if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
          this.invalidPointer(
            reference,
            usagePointer,
            `does not address an array index at '${segment}'`,
          );
          return undefined;
        }
        const index = Number(segment);
        if (index >= current.length || !Object.hasOwn(current, index)) {
          this.collector.add({
            code: 'OPENAPI.REF_NOT_FOUND',
            severity: 'error',
            message: `Reference target '${reference}' does not exist`,
            pointer: usagePointer,
          });
          return undefined;
        }
        current = current[index];
      } else if (isRecord(current) && Object.hasOwn(current, segment)) {
        current = current[segment];
      } else {
        this.collector.add({
          code: 'OPENAPI.REF_NOT_FOUND',
          severity: 'error',
          message: `Reference target '${reference}' does not exist`,
          pointer: usagePointer,
        });
        return undefined;
      }
    }
    return current;
  }

  private invalidPointer(reference: string, usagePointer: string, reason: string): void {
    this.collector.add({
      code: 'OPENAPI.INVALID_REF_POINTER',
      severity: 'error',
      message: `Reference '${reference}' ${reason}`,
      pointer: usagePointer,
    });
  }

  private sanitizeExternalValue(
    value: unknown,
    usagePointer: string,
    depth: number,
    ancestors: WeakSet<object>,
  ): unknown {
    if (!this.consumeNode(usagePointer)) {
      return undefined;
    }
    if (depth > this.#maxObjectDepth) {
      this.collector.add({
        code: 'OPENAPI.EXTERNAL_VALUE_DEPTH_EXCEEDED',
        severity: 'error',
        message: `External reference value exceeds the configured object depth of ${this.#maxObjectDepth}`,
        pointer: usagePointer,
        recoverable: false,
      });
      return undefined;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        return value;
      }
      this.invalidExternalValue('External reference contains a non-finite number', usagePointer);
      return undefined;
    }
    if (typeof value !== 'object') {
      this.invalidExternalValue(
        `External reference contains unsupported value type '${typeof value}'`,
        usagePointer,
      );
      return undefined;
    }
    if (utilTypes.isProxy(value)) {
      this.invalidExternalValue(
        'External reference contains a Proxy, which is executable rather than plain data',
        usagePointer,
      );
      return undefined;
    }
    if (ancestors.has(value)) {
      this.circularExternalValue(usagePointer);
      return undefined;
    }

    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value) as object | null;
    } catch {
      this.invalidExternalValue(
        'External reference object cannot be safely inspected',
        usagePointer,
      );
      return undefined;
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        this.invalidExternalValue('External reference contains a non-plain array', usagePointer);
        return undefined;
      }
      ancestors.add(value);
      try {
        if (Object.getOwnPropertySymbols(value).length > 0) {
          this.invalidExternalValue('External reference array contains symbol keys', usagePointer);
          return undefined;
        }
        const unexpectedKey = Object.keys(value).find(
          (key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length,
        );
        if (unexpectedKey !== undefined) {
          this.invalidExternalValue(
            `External reference array contains unsupported property '${unexpectedKey}'`,
            usagePointer,
          );
          return undefined;
        }
        if (!this.canVisitNodes(value.length, usagePointer)) {
          return undefined;
        }
        return Array.from({ length: value.length }, (_unused, index) => {
          const childPointer = `${usagePointer}/${index}`;
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            return null;
          }
          if (descriptor.get !== undefined || descriptor.set !== undefined) {
            this.invalidExternalValue(
              `External reference array index '${index}' must be a data property`,
              childPointer,
            );
            return null;
          }
          return (
            this.sanitizeExternalValue(descriptor.value, childPointer, depth + 1, ancestors) ?? null
          );
        });
      } catch {
        this.invalidExternalValue(
          'External reference array cannot be safely inspected',
          usagePointer,
        );
        return undefined;
      } finally {
        ancestors.delete(value);
      }
    }
    if (prototype !== Object.prototype && prototype !== null) {
      this.invalidExternalValue('External reference contains a non-plain object', usagePointer);
      return undefined;
    }

    let keys: string[];
    try {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        this.invalidExternalValue('External reference object contains symbol keys', usagePointer);
        return undefined;
      }
      keys = Object.keys(value).sort();
    } catch {
      this.invalidExternalValue(
        'External reference object cannot be safely inspected',
        usagePointer,
      );
      return undefined;
    }

    if (!this.canVisitNodes(keys.length, usagePointer)) {
      return undefined;
    }

    ancestors.add(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    try {
      for (const key of keys) {
        const childPointer = `${usagePointer}/${encodePointerSegment(key)}`;
        if (UNSAFE_POINTER_SEGMENTS.has(key)) {
          this.collector.add({
            code: 'OPENAPI.EXTERNAL_UNSAFE_OBJECT_KEY',
            severity: 'error',
            message: `External reference contains unsafe object key '${key}'`,
            pointer: childPointer,
            recoverable: false,
          });
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          this.invalidExternalValue(
            `External reference property '${key}' must be a data property`,
            childPointer,
          );
          continue;
        }
        const child = this.sanitizeExternalValue(
          descriptor.value,
          childPointer,
          depth + 1,
          ancestors,
        );
        if (child !== undefined) {
          output[key] = child;
        }
      }
    } catch {
      this.invalidExternalValue(
        'External reference object cannot be safely inspected',
        usagePointer,
      );
      return undefined;
    } finally {
      ancestors.delete(value);
    }
    return output;
  }

  private invalidExternalValue(message: string, usagePointer: string): void {
    this.collector.add({
      code: 'OPENAPI.INVALID_EXTERNAL_VALUE',
      severity: 'error',
      message,
      pointer: usagePointer,
      recoverable: false,
    });
  }

  private circularExternalValue(usagePointer: string): void {
    this.collector.add({
      code: 'OPENAPI.CIRCULAR_EXTERNAL_VALUE',
      severity: 'error',
      message: 'External reference resolver returned a circular object graph',
      pointer: usagePointer,
      recoverable: false,
    });
  }

  private consumeNode(usagePointer: string): boolean {
    if (this.#resolvedNodes >= this.#maxResolvedNodes) {
      this.reportBudgetExceeded(usagePointer);
      return false;
    }
    this.#resolvedNodes += 1;
    return true;
  }

  private canVisitNodes(count: number, usagePointer: string): boolean {
    if (count <= this.#maxResolvedNodes - this.#resolvedNodes) {
      return true;
    }
    this.reportBudgetExceeded(usagePointer);
    return false;
  }

  private reportBudgetExceeded(usagePointer: string): void {
    if (this.#budgetDiagnosticEmitted) {
      return;
    }
    this.#budgetDiagnosticEmitted = true;
    this.collector.add({
      code: 'OPENAPI.RESOLUTION_BUDGET_EXCEEDED',
      severity: 'error',
      message: `Reference processing exceeded the configured budget of ${this.#maxResolvedNodes} nodes`,
      pointer: usagePointer,
      recoverable: false,
      details: {
        maxResolvedNodes: this.#maxResolvedNodes,
        visitedNodes: this.#resolvedNodes,
      },
    });
  }
}
