import {
  fingerprint,
  type Capability,
  type NormalizedApiDocument,
  type Release,
} from '@hi-mcp/capability-ir';

import { createBaselineRelease } from './release.js';
import { CLI_PACKAGE_NAME, CLI_VERSION } from './version.js';

export type ContractChangeArea =
  | 'tool-metadata'
  | 'schema-annotations'
  | 'input-schema'
  | 'output-schema'
  | 'authentication'
  | 'risk'
  | 'destination'
  | 'request-binding'
  | 'response-contract';

export type ContractChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export type ContractChangeImpact =
  'security-review' | 'breaking' | 'additive' | 'metadata-review' | 'none';

export interface ContractOperationView {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly origins: readonly string[];
  readonly authRequired: boolean;
  readonly authSchemes: readonly string[];
  readonly risk: Readonly<{
    level: string;
    sideEffect: string;
    idempotency: string;
    requiresConfirmation: boolean;
  }>;
}

export interface ContractOperationChange {
  readonly operationId: string;
  readonly kind: ContractChangeKind;
  readonly impact: ContractChangeImpact;
  readonly areas: readonly ContractChangeArea[];
  readonly before?: ContractOperationView;
  readonly after?: ContractOperationView;
}

export interface ContractDiff {
  readonly schemaVersion: '1.0';
  readonly baseline: Readonly<{
    releaseId: string;
    releaseFingerprint: string;
    capabilityCount: number;
  }>;
  readonly current: Readonly<{
    documentFingerprint: string;
    operationCount: number;
  }>;
  readonly summary: Readonly<{
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    securityReview: number;
    breaking: number;
    metadataReview: number;
  }>;
  readonly operations: readonly ContractOperationChange[];
  readonly fingerprint: string;
}

const AREA_ORDER: readonly ContractChangeArea[] = [
  'destination',
  'authentication',
  'risk',
  'request-binding',
  'response-contract',
  'input-schema',
  'output-schema',
  'schema-annotations',
  'tool-metadata',
];

const SCHEMA_ANNOTATIONS = new Set([
  '$comment',
  'title',
  'description',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
]);
const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_SINGLE_KEYWORDS = new Set([
  'not',
  'if',
  'then',
  'else',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'unevaluatedItems',
  'contentSchema',
  'additionalItems',
]);

const IMPACT_ORDER: Readonly<Record<ContractChangeImpact, number>> = {
  'security-review': 0,
  breaking: 1,
  additive: 2,
  'metadata-review': 3,
  none: 4,
};

function same(left: unknown, right: unknown): boolean {
  return fingerprint({ value: left ?? null }) === fingerprint({ value: right ?? null });
}

/** Retains validation behavior while removing standard JSON Schema annotation keywords. */
function schemaAssertions(schema: unknown): unknown {
  if (typeof schema === 'boolean' || schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(schemaAssertions);
  const source = schema as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (SCHEMA_ANNOTATIONS.has(key)) continue;
    if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = Object.fromEntries(
        Object.entries(value as Readonly<Record<string, unknown>>).map(([name, child]) => [
          name,
          schemaAssertions(child),
        ]),
      );
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      result[key] = value.map(schemaAssertions);
      continue;
    }
    if (SCHEMA_SINGLE_KEYWORDS.has(key)) {
      result[key] = schemaAssertions(value);
      continue;
    }
    if (key === 'items') {
      result[key] = Array.isArray(value) ? value.map(schemaAssertions) : schemaAssertions(value);
      continue;
    }
    if (
      key === 'dependencies' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = Object.fromEntries(
        Object.entries(value as Readonly<Record<string, unknown>>).map(([name, child]) => [
          name,
          Array.isArray(child) ? child : schemaAssertions(child),
        ]),
      );
      continue;
    }
    result[key] = value;
  }
  return result;
}

function reviewedOrigin(server: Capability['execution']['servers'][number]): string {
  const target = server.resolvedUrl ?? server.template;
  try {
    return new URL(target).origin;
  } catch {
    return target;
  }
}

function capabilityView(capability: Capability): ContractOperationView {
  return {
    id: capability.id,
    name: capability.name,
    ...(capability.title === undefined ? {} : { title: capability.title }),
    description: capability.description,
    method: capability.execution.method,
    path: capability.execution.pathTemplate,
    origins: [...new Set(capability.execution.servers.map(reviewedOrigin))].sort(),
    authRequired: capability.auth.required,
    authSchemes: Object.keys(capability.auth.schemes).sort(),
    risk: {
      level: capability.risk.level,
      sideEffect: capability.risk.sideEffect,
      idempotency: capability.risk.idempotency,
      requiresConfirmation: capability.risk.requiresConfirmation,
    },
  };
}

function authenticationContract(capability: Capability): unknown {
  return {
    required: capability.auth.required,
    alternatives: capability.auth.alternatives,
    schemes: Object.fromEntries(
      Object.entries(capability.auth.schemes).map(([id, scheme]) => {
        const { description: _description, provenancePointer: _pointer, ...contract } = scheme;
        return [id, contract];
      }),
    ),
  };
}

function destinationContract(capability: Capability): unknown {
  return capability.execution.servers.map(({ template, resolvedUrl, variables }) => ({
    template,
    ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
    variables,
  }));
}

function requestBindingContract(capability: Capability): unknown {
  return {
    method: capability.execution.method,
    pathTemplate: capability.execution.pathTemplate,
    parameterBindings: capability.execution.parameterBindings.map(
      ({ description: _description, provenancePointer: _pointer, schema, ...binding }) => ({
        ...binding,
        schema: schemaAssertions(schema),
      }),
    ),
    requestBodies: capability.execution.requestBodies.map(
      ({ description: _description, provenancePointer: _pointer, schema, ...binding }) => ({
        ...binding,
        schema: schemaAssertions(schema),
      }),
    ),
  };
}

function responseContract(capability: Capability): unknown {
  return capability.execution.successResponses.map(
    ({ description: _description, provenancePointer: _pointer, schema, ...response }) => ({
      ...response,
      ...(schema === undefined ? {} : { schema: schemaAssertions(schema) }),
    }),
  );
}

function riskContract(capability: Capability): unknown {
  return {
    level: capability.risk.level,
    sideEffect: capability.risk.sideEffect,
    idempotency: capability.risk.idempotency,
    requiresConfirmation: capability.risk.requiresConfirmation,
  };
}

function changedAreas(before: Capability, after: Capability): readonly ContractChangeArea[] {
  const changed = new Set<ContractChangeArea>();
  if (
    !same(
      {
        name: before.name,
        title: before.title ?? null,
        description: before.description,
        intent: before.intent,
      },
      {
        name: after.name,
        title: after.title ?? null,
        description: after.description,
        intent: after.intent,
      },
    )
  ) {
    changed.add('tool-metadata');
  }
  if (!same(before.inputSchema, after.inputSchema)) {
    changed.add(
      same(schemaAssertions(before.inputSchema), schemaAssertions(after.inputSchema))
        ? 'schema-annotations'
        : 'input-schema',
    );
  }
  if (!same(before.outputSchema ?? null, after.outputSchema ?? null)) {
    changed.add(
      same(
        schemaAssertions(before.outputSchema ?? null),
        schemaAssertions(after.outputSchema ?? null),
      )
        ? 'schema-annotations'
        : 'output-schema',
    );
  }
  if (!same(authenticationContract(before), authenticationContract(after))) {
    changed.add('authentication');
  }
  if (!same(riskContract(before), riskContract(after))) changed.add('risk');
  if (!same(destinationContract(before), destinationContract(after))) changed.add('destination');
  if (!same(requestBindingContract(before), requestBindingContract(after))) {
    changed.add('request-binding');
  }
  if (!same(responseContract(before), responseContract(after))) {
    changed.add('response-contract');
  }
  return AREA_ORDER.filter((area) => changed.has(area));
}

function impactFor(
  kind: ContractChangeKind,
  areas: readonly ContractChangeArea[],
): ContractChangeImpact {
  if (kind === 'added') return 'additive';
  if (kind === 'removed') return 'breaking';
  if (kind === 'unchanged') return 'none';
  if (areas.some((area) => ['destination', 'authentication', 'risk'].includes(area))) {
    return 'security-review';
  }
  if (
    areas.some((area) =>
      ['input-schema', 'output-schema', 'request-binding', 'response-contract'].includes(area),
    )
  ) {
    return 'breaking';
  }
  return 'metadata-review';
}

function capabilityMap(release: Release, label: string): ReadonlyMap<string, Capability> {
  const result = new Map<string, Capability>();
  for (const capability of release.capabilities) {
    if (result.has(capability.id)) {
      throw new TypeError(`${label} contains duplicate capability ID ${capability.id}.`);
    }
    result.set(capability.id, capability);
  }
  return result;
}

export function compareReleaseContracts(
  baseline: Release,
  current: Release,
  currentDocumentFingerprint = current.sources[0]?.fingerprint ?? current.fingerprint,
  currentOperationCount = current.capabilities.length,
): ContractDiff {
  const beforeById = capabilityMap(baseline, 'Baseline release');
  const afterById = capabilityMap(current, 'Current release');
  const operationIds = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const operations = operationIds.map((operationId): ContractOperationChange => {
    const before = beforeById.get(operationId);
    const after = afterById.get(operationId);
    if (before === undefined && after !== undefined) {
      return {
        operationId,
        kind: 'added',
        impact: 'additive',
        areas: [],
        after: capabilityView(after),
      };
    }
    if (before !== undefined && after === undefined) {
      return {
        operationId,
        kind: 'removed',
        impact: 'breaking',
        areas: [],
        before: capabilityView(before),
      };
    }
    if (before === undefined || after === undefined) {
      throw new TypeError(`Could not compare capability ${operationId}.`);
    }
    const areas = changedAreas(before, after);
    const kind: ContractChangeKind = areas.length === 0 ? 'unchanged' : 'changed';
    if (kind === 'unchanged') {
      return {
        operationId,
        kind,
        impact: 'none',
        areas,
      };
    }
    return {
      operationId,
      kind,
      impact: impactFor(kind, areas),
      areas,
      before: capabilityView(before),
      after: capabilityView(after),
    };
  });
  operations.sort(
    (left, right) =>
      IMPACT_ORDER[left.impact] - IMPACT_ORDER[right.impact] ||
      left.operationId.localeCompare(right.operationId),
  );

  const summary = {
    added: operations.filter(({ kind }) => kind === 'added').length,
    removed: operations.filter(({ kind }) => kind === 'removed').length,
    changed: operations.filter(({ kind }) => kind === 'changed').length,
    unchanged: operations.filter(({ kind }) => kind === 'unchanged').length,
    securityReview: operations.filter(({ impact }) => impact === 'security-review').length,
    breaking: operations.filter(({ impact }) => impact === 'breaking').length,
    metadataReview: operations.filter(({ impact }) => impact === 'metadata-review').length,
  };
  const material = {
    schemaVersion: '1.0' as const,
    baseline: {
      releaseId: baseline.id,
      releaseFingerprint: baseline.fingerprint,
      capabilityCount: baseline.capabilities.length,
    },
    current: {
      documentFingerprint: currentDocumentFingerprint,
      operationCount: currentOperationCount,
    },
    summary,
    operations,
  };
  return { ...material, fingerprint: fingerprint(material) };
}

/** Compares a verified release with a fresh deterministic baseline for the current source. */
export function compareReleaseToDocument(
  baseline: Release,
  document: NormalizedApiDocument,
): ContractDiff {
  const current = createBaselineRelease(document, [], {
    compilerName: CLI_PACKAGE_NAME,
    compilerVersion: CLI_VERSION,
    sequence: baseline.sequence,
    now: () => new Date('1970-01-01T00:00:00.000Z'),
  }).release;
  return compareReleaseContracts(
    baseline,
    current,
    document.documentFingerprint,
    document.operations.length,
  );
}
