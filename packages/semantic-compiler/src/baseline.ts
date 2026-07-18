import {
  CANONICAL_PADDED_BASE64_PATTERN,
  CapabilityCandidateSchema,
  CapabilitySchema,
  HTTP_HEADER_VALUE_PATTERN,
  NormalizedOperationSchema,
  SchemaCompositionRegistry,
  canonicalStringify,
  formTextWireSchema,
  fingerprint,
  scalarTextWireSchema,
  shallowParameterTextWireSchema,
  stableId,
  WELL_FORMED_UNICODE_PATTERN,
  type Capability,
  type CapabilityCandidate,
  type JsonSchema,
  type JsonValue,
  type NormalizedOperation,
  type RiskMetadata,
} from '@hi-mcp/capability-ir';

import {
  systemCompilationClock,
  type CompilationClock,
  type CompilationProvenance,
  type CompilerIdentity,
} from './provenance.js';

export interface BaselineCompilationResult {
  readonly candidate: CapabilityCandidate;
  readonly provenance: CompilationProvenance;
}

export interface DeterministicBaselineCompilerOptions {
  readonly compiler: CompilerIdentity;
  readonly clock?: CompilationClock;
}

type MutableJsonObject = { [key: string]: JsonValue };

function asObjectSchema(value: JsonSchema): MutableJsonObject | null {
  return typeof value === 'boolean' ? null : (value as MutableJsonObject);
}

function cloneJsonSchema(schema: JsonSchema): JsonSchema {
  return structuredClone(schema);
}

function schemaEquals(left: JsonSchema, right: JsonSchema): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function combineSchemas(
  left: JsonSchema,
  right: JsonSchema,
  keyword: 'allOf' | 'anyOf' | 'oneOf',
): JsonSchema {
  if (schemaEquals(left, right)) return left;
  return { [keyword]: [cloneJsonSchema(left), cloneJsonSchema(right)] };
}

function objectProperties(schema: MutableJsonObject): MutableJsonObject {
  const current = schema['properties'];
  if (
    current !== undefined &&
    (typeof current !== 'object' || current === null || Array.isArray(current))
  ) {
    throw new TypeError('Generated input schema properties must be an object.');
  }
  if (current === undefined) {
    schema['properties'] = Object.create(null) as MutableJsonObject;
  }
  return schema['properties'] as MutableJsonObject;
}

function markRequired(schema: MutableJsonObject, name: string): void {
  const current = schema['required'];
  const values = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === 'string')
    : [];
  if (!values.includes(name)) schema['required'] = [...values, name].sort();
}

function addSchemaAtPath(
  root: MutableJsonObject,
  inputPath: readonly string[],
  schema: JsonSchema,
  required: boolean,
  mergeKeyword: 'allOf' | 'anyOf' | 'oneOf',
): void {
  let node = root;

  inputPath.forEach((segment, index) => {
    const properties = objectProperties(node);
    const isLeaf = index === inputPath.length - 1;

    if (required) markRequired(node, segment);
    if (isLeaf) {
      const existing = Object.hasOwn(properties, segment)
        ? (properties[segment] as JsonSchema)
        : undefined;
      properties[segment] =
        existing === undefined
          ? cloneJsonSchema(schema)
          : combineSchemas(existing, schema, mergeKeyword);
      return;
    }

    const existing = Object.hasOwn(properties, segment) ? properties[segment] : undefined;
    if (existing === undefined) {
      properties[segment] = {
        type: 'object',
        properties: Object.create(null) as MutableJsonObject,
      };
    }

    const child = asObjectSchema(properties[segment] as JsonSchema);
    if (child === null) {
      throw new TypeError(
        `Cannot attach nested input schema below boolean schema at ${inputPath.join('.')}.`,
      );
    }
    if (child['type'] !== undefined && child['type'] !== 'object') {
      throw new TypeError(`Input path ${inputPath.join('.')} collides with a non-object schema.`);
    }
    child['type'] = 'object';
    node = child;
  });
}

function pathPresenceSchema(inputPath: readonly string[]): JsonSchema {
  const [head, ...tail] = inputPath;
  if (head === undefined) {
    throw new TypeError('Input presence paths cannot be empty.');
  }
  return {
    type: 'object',
    required: [head],
    ...(tail.length === 0 ? {} : { properties: { [head]: pathPresenceSchema(tail) } }),
  };
}

function schemaAtPath(
  inputPath: readonly string[],
  leafSchema: JsonSchema,
  required: boolean,
): JsonSchema {
  const root: MutableJsonObject = {
    type: 'object',
    properties: Object.create(null) as MutableJsonObject,
  };
  addSchemaAtPath(root, inputPath, leafSchema, required, 'allOf');
  return root;
}

function parameterWireConstraint(
  parameter: NormalizedOperation['parameters'][number],
): JsonSchema | undefined {
  const essence = parameter.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (essence === 'application/json' || essence?.endsWith('+json') === true) {
    // JSON parameter content is escaped to an ASCII JSON text before entering a raw header and is
    // percent-encoded by URL-oriented locations, so the complete JSON value remains representable.
    return undefined;
  }

  const pattern =
    parameter.location === 'header' ? HTTP_HEADER_VALUE_PATTERN : WELL_FORMED_UNICODE_PATTERN;
  const scalar = scalarTextWireSchema(pattern);
  if (essence?.startsWith('text/') === true) return scalar;
  return shallowParameterTextWireSchema(pattern);
}

function inferredRequestBodySerialization(
  contentType: string,
): 'json' | 'form' | 'text' | undefined {
  const essence = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (essence === 'application/json' || essence?.endsWith('+json') === true) return 'json';
  if (essence === 'application/x-www-form-urlencoded') return 'form';
  if (essence?.startsWith('text/') === true) return 'text';
  return undefined;
}

function requestBodyWireConstraint(
  requestBody: NormalizedOperation['requestBodies'][number],
): JsonSchema | undefined {
  const serialization =
    requestBody.serialization ?? inferredRequestBodySerialization(requestBody.contentType);
  if (serialization === 'base64') {
    return { type: 'string', pattern: CANONICAL_PADDED_BASE64_PATTERN };
  }
  if (serialization === 'form') return formTextWireSchema();
  if (serialization === 'text') return scalarTextWireSchema(WELL_FORMED_UNICODE_PATTERN);
  return undefined;
}

function createInputSchema(operation: NormalizedOperation): JsonSchema {
  const schema: MutableJsonObject = {
    type: 'object',
    properties: Object.create(null) as MutableJsonObject,
    additionalProperties: false,
  };
  const composition = new SchemaCompositionRegistry();

  for (const parameter of operation.parameters) {
    const sourceSchema = composition.embed(parameter.schema);
    const wireConstraint = parameterWireConstraint(parameter);
    addSchemaAtPath(
      schema,
      parameter.inputPath,
      wireConstraint === undefined
        ? sourceSchema
        : combineSchemas(sourceSchema, wireConstraint, 'allOf'),
      parameter.required,
      'allOf',
    );
  }
  const bodyGroups = new Map<
    string,
    {
      readonly inputPath: readonly string[];
      required: boolean;
      schemas: JsonSchema[];
      selectorPath?: readonly string[];
      selectorConsistent: boolean;
    }
  >();
  const selectorGroups = new Map<
    string,
    {
      readonly inputPath: readonly string[];
      required: boolean;
      schemas: JsonSchema[];
    }
  >();
  const representationConditions: JsonSchema[] = [];
  for (const requestBody of operation.requestBodies) {
    const bodyKey = canonicalStringify(requestBody.inputPath);
    const bodyGroup = bodyGroups.get(bodyKey) ?? {
      inputPath: requestBody.inputPath,
      required: false,
      schemas: [],
      selectorConsistent: true,
    };
    bodyGroup.required ||= requestBody.required;
    const sourceSchema = composition.embed(requestBody.schema);
    const wireConstraint = requestBodyWireConstraint(requestBody);
    const inputSchema =
      wireConstraint === undefined
        ? sourceSchema
        : combineSchemas(sourceSchema, wireConstraint, 'allOf');
    bodyGroup.schemas.push(inputSchema);
    if (requestBody.contentTypeInputPath !== undefined) {
      if (bodyGroup.selectorPath === undefined) {
        bodyGroup.selectorPath = requestBody.contentTypeInputPath;
      } else if (
        canonicalStringify(bodyGroup.selectorPath) !==
        canonicalStringify(requestBody.contentTypeInputPath)
      ) {
        bodyGroup.selectorConsistent = false;
      }
    }
    bodyGroups.set(bodyKey, bodyGroup);

    if (requestBody.contentTypeInputPath !== undefined) {
      const selectorKey = canonicalStringify(requestBody.contentTypeInputPath);
      const selectorGroup = selectorGroups.get(selectorKey) ?? {
        inputPath: requestBody.contentTypeInputPath,
        required: false,
        schemas: [],
      };
      selectorGroup.required ||= requestBody.required;
      selectorGroup.schemas.push({ type: 'string', const: requestBody.contentType });
      selectorGroups.set(selectorKey, selectorGroup);
      representationConditions.push({
        if: schemaAtPath(
          requestBody.contentTypeInputPath,
          { type: 'string', const: requestBody.contentType },
          true,
        ),
        then: schemaAtPath(requestBody.inputPath, inputSchema, true),
      });
    }
  }

  for (const group of bodyGroups.values()) {
    const bodySchema = group.schemas.reduce((left, right) => combineSchemas(left, right, 'anyOf'));
    addSchemaAtPath(schema, group.inputPath, bodySchema, group.required, 'allOf');
    if (!group.required && group.selectorConsistent && group.selectorPath !== undefined) {
      const conditions = [
        {
          if: pathPresenceSchema(group.inputPath),
          then: pathPresenceSchema(group.selectorPath),
        },
        {
          if: pathPresenceSchema(group.selectorPath),
          then: pathPresenceSchema(group.inputPath),
        },
      ];
      const existing = schema['allOf'];
      schema['allOf'] = Array.isArray(existing) ? [...existing, ...conditions] : conditions;
    }
  }
  for (const group of selectorGroups.values()) {
    const selectorSchema = group.schemas.reduce((left, right) =>
      combineSchemas(left, right, 'oneOf'),
    );
    addSchemaAtPath(schema, group.inputPath, selectorSchema, group.required, 'allOf');
  }
  if (representationConditions.length > 0) {
    const existing = schema['allOf'];
    schema['allOf'] = Array.isArray(existing)
      ? [...existing, ...representationConditions]
      : representationConditions;
  }

  const definitions = composition.definitions();
  if (Object.keys(definitions).length > 0) {
    schema['$defs'] = definitions;
  }

  return schema;
}

function createOutputSchema(operation: NormalizedOperation): JsonSchema | undefined {
  const schemas = operation.successResponses.flatMap((response) =>
    (/^2(?:\d{2}|XX)$/i.test(response.statusCode) || response.statusCode === 'default') &&
    response.schema !== undefined
      ? [response.schema]
      : [],
  );
  const unique = schemas.filter(
    (schema, index) => schemas.findIndex((candidate) => schemaEquals(candidate, schema)) === index,
  );

  if (unique.length === 0) return undefined;
  if (unique.length === 1) return cloneJsonSchema(unique[0] as JsonSchema);
  const composition = new SchemaCompositionRegistry();
  const variants = unique.map((schema) => composition.embed(schema));
  const definitions = composition.definitions();
  return {
    oneOf: variants,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  };
}

function riskFromHttpSemantics(method: NormalizedOperation['method']): RiskMetadata {
  switch (method) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
    case 'TRACE':
      return {
        level: 'read',
        sideEffect: 'none',
        idempotency: 'idempotent',
        requiresConfirmation: false,
        rationale: [`Derived conservatively from the standardized semantics of HTTP ${method}.`],
      };
    case 'DELETE':
      return {
        level: 'destructive',
        sideEffect: 'definite',
        idempotency: 'idempotent',
        requiresConfirmation: true,
        rationale: [
          'DELETE is treated as destructive until a reviewed semantic proposal confirms otherwise.',
        ],
      };
    case 'PUT':
      return {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'idempotent',
        requiresConfirmation: true,
        rationale: ['Derived conservatively from the standardized semantics of HTTP PUT.'],
      };
    case 'POST':
      return {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
        rationale: ['Derived conservatively from the standardized semantics of HTTP POST.'],
      };
    case 'PATCH':
      return {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'conditional',
        requiresConfirmation: true,
        rationale: ['PATCH idempotency depends on the patch document and upstream implementation.'],
      };
    default:
      return {
        level: 'unknown',
        sideEffect: 'unknown',
        idempotency: 'unknown',
        requiresConfirmation: true,
        rationale: [
          `HTTP extension method ${method} requires authoritative risk metadata or operator review.`,
        ],
      };
  }
}

function deriveDescription(operation: NormalizedOperation): string {
  return (
    operation.description?.trim() ||
    operation.summary?.trim() ||
    `${operation.method} ${operation.path}`
  );
}

function deriveName(operation: NormalizedOperation): string {
  const original = operation.operationId?.normalize('NFKC').trim() || operation.id;
  const normalized = original.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = normalized.length === 0 ? operation.id : normalized;
  return safe.slice(0, 128);
}

function collisionSafeName(
  preferredName: string,
  operation: NormalizedOperation,
  usedNames: ReadonlySet<string>,
): string {
  if (!usedNames.has(preferredName)) {
    return preferredName;
  }

  const stableSuffix = `_${stableId('tool', operation.id).slice('tool_'.length)}`;
  const stem = preferredName.slice(0, 128 - stableSuffix.length);
  const stableCandidate = `${stem}${stableSuffix}`;
  if (!usedNames.has(stableCandidate)) {
    return stableCandidate;
  }

  for (let collisionIndex = 2; ; collisionIndex += 1) {
    const retrySuffix = `_${stableId('tool', operation.id, collisionIndex).slice('tool_'.length)}`;
    const candidate = `${preferredName.slice(0, 128 - retrySuffix.length)}${retrySuffix}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }
}

function withoutFingerprint(capability: Capability): Omit<Capability, 'fingerprint'> {
  const { fingerprint: _fingerprint, ...content } = capability;
  return content;
}

function buildCapability(operation: NormalizedOperation): Capability {
  const outputSchema = createOutputSchema(operation);
  const draft = {
    schemaVersion: '1.0' as const,
    id: operation.id,
    name: deriveName(operation),
    ...(operation.summary?.trim() ? { title: operation.summary.trim() } : {}),
    description: deriveDescription(operation),
    intent: {
      useWhen: [deriveDescription(operation)],
      avoidWhen: [],
      examples: [],
      tags: [...operation.tags],
    },
    inputSchema: createInputSchema(operation),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    auth: structuredClone(operation.auth),
    risk:
      operation.risk === undefined
        ? riskFromHttpSemantics(operation.method)
        : structuredClone(operation.risk),
    execution: {
      kind: 'http' as const,
      method: operation.method,
      pathTemplate: operation.path,
      servers: structuredClone(operation.servers),
      parameterBindings: structuredClone(operation.parameters),
      requestBodies: structuredClone(operation.requestBodies),
      successResponses: structuredClone(operation.successResponses),
    },
    provenance: structuredClone(operation.provenance),
  };

  return CapabilitySchema.parse({ ...draft, fingerprint: fingerprint(draft) });
}

export class DeterministicBaselineCompiler {
  readonly #compiler: CompilerIdentity;
  readonly #clock: CompilationClock;

  constructor(options: DeterministicBaselineCompilerOptions) {
    this.#compiler = options.compiler;
    this.#clock = options.clock ?? systemCompilationClock;
  }

  compile(operation: NormalizedOperation): BaselineCompilationResult {
    const normalizedOperation = NormalizedOperationSchema.parse(operation);
    const capability = buildCapability(normalizedOperation);
    const candidate = CapabilityCandidateSchema.parse({
      sourceOperationId: normalizedOperation.id,
      stage: 'baseline',
      capability,
      rationale: ['Deterministically compiled from the normalized source operation.'],
      diagnostics: [],
    });

    return {
      candidate,
      provenance: {
        compiler: this.#compiler,
        mode: 'deterministic-baseline',
        baseCapabilityFingerprint: capability.fingerprint,
        resultCapabilityFingerprint: capability.fingerprint,
        compiledAt: this.#clock().toISOString(),
        attempts: [],
      },
    };
  }

  compileAll(operations: readonly NormalizedOperation[]): readonly BaselineCompilationResult[] {
    const usedNames = new Set<string>();
    return [...operations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((operation) => {
        const result = this.compile(operation);
        const preferredName = result.candidate.capability.name;
        const name = collisionSafeName(preferredName, operation, usedNames);
        usedNames.add(name);
        if (name === preferredName) {
          return result;
        }

        const capability = refingerprintCapability({
          ...result.candidate.capability,
          name,
        });
        return {
          candidate: CapabilityCandidateSchema.parse({
            ...result.candidate,
            capability,
          }),
          provenance: {
            ...result.provenance,
            baseCapabilityFingerprint: capability.fingerprint,
            resultCapabilityFingerprint: capability.fingerprint,
          },
        };
      });
  }
}

export function compileDeterministicBaseline(
  operation: NormalizedOperation,
  options: DeterministicBaselineCompilerOptions,
): BaselineCompilationResult {
  return new DeterministicBaselineCompiler(options).compile(operation);
}

/** Recomputes the semantic content fingerprint after safe, contract-preserving changes. */
export function refingerprintCapability(capability: Capability): Capability {
  const content = withoutFingerprint(capability);
  return CapabilitySchema.parse({ ...content, fingerprint: fingerprint(content) });
}
