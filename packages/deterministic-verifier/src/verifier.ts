import {
  CapabilitySchema,
  DiagnosticSchema,
  HTTP_HEADER_VALUE_PATTERN,
  NormalizedOperationSchema,
  WELL_FORMED_UNICODE_PATTERN,
  canonicalStringify,
  formTextWireSchema,
  fingerprint,
  isHttpFieldName,
  isTransportControlledCredentialHeader,
  isWellFormedUnicode,
  scalarTextWireSchema,
  shallowParameterTextWireSchema,
  validateHttpOperationPath,
  type Capability,
  type Diagnostic,
  type JsonSchema,
  type NormalizedOperation,
  type SecuritySchemeMetadata,
  type ServerTarget,
} from '@hi-mcp/capability-ir';

import {
  locateInputSchema,
  schemaAcceptsOnlyCanonicalBase64,
  schemaAcceptsOnlyFormObject,
  schemaAcceptsOnlyParameterValues,
  schemaAcceptsOnlyScalarPropertyObject,
  schemaAcceptsOnlyScalars,
  schemaContainsVariant,
  schemaProvesWireConstraint,
  schemaRepresentsVariants,
  validateJsonSchema,
} from './json-schema.js';
import {
  isForbiddenToolInputHeader,
  isValidHeaderName,
  normalizeHeaderName,
} from './header-policy.js';
import { inspectVerificationInput } from './input-safety.js';
import type { CapabilityVerificationOptions, CapabilityVerificationResult } from './types.js';

interface DiagnosticInput {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly pointer?: string;
  readonly recoverable?: boolean;
  readonly details?: Record<string, string | number | boolean | null>;
}

const HTTP_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTTP_MUTATION_METHODS = new Set(['PUT', 'POST', 'DELETE', 'PATCH']);
const FETCH_FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const TEMPLATE_VARIABLE = /\{([^{}]+)\}/g;
const PARAMETER_STYLES = {
  path: new Set(['simple', 'label', 'matrix']),
  query: new Set(['form', 'spaceDelimited', 'pipeDelimited', 'deepObject']),
  header: new Set(['simple']),
  cookie: new Set(['form']),
} as const;
const DEFAULT_PARAMETER_STYLE = {
  path: 'simple',
  query: 'form',
  header: 'simple',
  cookie: 'form',
} as const;

function escapePointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointer(...segments: readonly (string | number)[]): string {
  return `/${segments.map((segment) => escapePointerToken(String(segment))).join('/')}`;
}

function diagnostic(input: DiagnosticInput): Diagnostic {
  return DiagnosticSchema.parse({
    code: input.code,
    severity: input.severity,
    message: input.message,
    ...(input.pointer === undefined ? {} : { location: { pointer: input.pointer } }),
    related: [],
    recoverable: input.recoverable ?? true,
    ...(input.details === undefined ? {} : { details: input.details }),
  });
}

function compareContract(
  diagnostics: Diagnostic[],
  code: string,
  label: string,
  pointerValue: string,
  actual: unknown,
  expected: unknown,
): void {
  const equal =
    actual === undefined || expected === undefined
      ? actual === expected
      : canonicalStringify(actual) === canonicalStringify(expected);
  if (!equal) {
    diagnostics.push(
      diagnostic({
        code,
        severity: 'error',
        message: `${label} differs from the authoritative source contract.`,
        pointer: pointerValue,
        recoverable: false,
      }),
    );
  }
}

function resolvedServerUrl(server: ServerTarget): string | null {
  if (server.resolvedUrl !== undefined) {
    return isWellFormedUnicode(server.resolvedUrl) ? server.resolvedUrl : null;
  }
  if (!isWellFormedUnicode(server.template)) return null;

  const variables = server.variables ?? {};
  let complete = true;
  const substituted = server.template.replace(TEMPLATE_VARIABLE, (_match, name: string) => {
    const variable = variables[name];
    if (!isWellFormedUnicode(name) || !variable || !isWellFormedUnicode(variable.default)) {
      complete = false;
      return '';
    }
    try {
      return encodeURIComponent(variable.default);
    } catch {
      complete = false;
      return '';
    }
  });
  return complete ? substituted : null;
}

function validateServers(capability: Capability, diagnostics: Diagnostic[]): void {
  capability.execution.servers.forEach((server, index) => {
    const basePointer = pointer('execution', 'servers', index);
    const variables = server.variables ?? {};
    if (
      !isWellFormedUnicode(server.template) ||
      (server.resolvedUrl !== undefined && !isWellFormedUnicode(server.resolvedUrl))
    ) {
      diagnostics.push(
        diagnostic({
          code: 'SERVER.INVALID_UNICODE',
          severity: 'error',
          message: 'Server URLs cannot contain unpaired Unicode surrogates.',
          pointer: basePointer,
          recoverable: false,
        }),
      );
    }
    const declaredVariables = new Set(Object.keys(variables));
    const referencedVariables = new Set(
      [...server.template.matchAll(TEMPLATE_VARIABLE)]
        .map((match) => match[1])
        .filter(Boolean) as string[],
    );

    for (const variable of referencedVariables) {
      if (!declaredVariables.has(variable)) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.UNDECLARED_VARIABLE',
            severity: 'error',
            message: `Server template variable ${variable} has no declaration.`,
            pointer: `${basePointer}/template`,
          }),
        );
      }
    }
    for (const variable of declaredVariables) {
      const metadata = variables[variable];
      if (
        !isWellFormedUnicode(variable) ||
        (metadata !== undefined &&
          (!isWellFormedUnicode(metadata.default) ||
            metadata.enum?.some((value) => !isWellFormedUnicode(value)) === true))
      ) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.INVALID_VARIABLE_UNICODE',
            severity: 'error',
            message: 'Server variable names and values cannot contain unpaired Unicode surrogates.',
            pointer: `${basePointer}/variables/${escapePointerToken(variable)}`,
            recoverable: false,
          }),
        );
      }
      if (!referencedVariables.has(variable)) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.UNUSED_VARIABLE',
            severity: 'warning',
            message: `Server variable ${variable} is not used by the template.`,
            pointer: `${basePointer}/variables/${escapePointerToken(variable)}`,
          }),
        );
      }
      if (metadata?.enum !== undefined && !metadata.enum.includes(metadata.default)) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.INVALID_VARIABLE_DEFAULT',
            severity: 'error',
            message: `Default value for server variable ${variable} is outside its enum.`,
            pointer: `${basePointer}/variables/${escapePointerToken(variable)}/default`,
          }),
        );
      }
    }

    const resolved = resolvedServerUrl(server);
    if (resolved === null) {
      diagnostics.push(
        diagnostic({
          code: 'SERVER.UNRESOLVED_URL',
          severity: 'error',
          message: 'Server URL cannot be resolved from the declared template variables.',
          pointer: basePointer,
        }),
      );
      return;
    }

    try {
      const url = new URL(resolved);
      if (server.resolvedUrl !== undefined && url.toString() !== server.resolvedUrl) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.NON_CANONICAL_RESOLVED_URL',
            severity: 'error',
            message:
              'Executable resolvedUrl must use the canonical WHATWG URL serialization recorded by its source adapter.',
            pointer: `${basePointer}/resolvedUrl`,
            recoverable: false,
          }),
        );
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.UNSUPPORTED_PROTOCOL',
            severity: 'error',
            message: `Unsupported upstream protocol: ${url.protocol}`,
            pointer: basePointer,
          }),
        );
      }
      if (url.username || url.password) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.EMBEDDED_CREDENTIAL',
            severity: 'error',
            message: 'Credentials must not be embedded in an upstream server URL.',
            pointer: basePointer,
            recoverable: false,
          }),
        );
      }
      if (url.hash) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.URL_FRAGMENT',
            severity: 'error',
            message: 'An upstream server URL cannot contain a fragment.',
            pointer: basePointer,
          }),
        );
      }
      if (url.search) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.URL_QUERY',
            severity: 'error',
            message: 'An upstream server base URL cannot contain query parameters.',
            pointer: basePointer,
          }),
        );
      }
      if (!url.hostname) {
        diagnostics.push(
          diagnostic({
            code: 'SERVER.MISSING_HOST',
            severity: 'error',
            message: 'An upstream server URL must contain a host.',
            pointer: basePointer,
          }),
        );
      }
    } catch {
      diagnostics.push(
        diagnostic({
          code: 'SERVER.INVALID_URL',
          severity: 'error',
          message: `Resolved server target is not an absolute URL: ${resolved}`,
          pointer: basePointer,
        }),
      );
    }
  });
}

function validatePathContract(capability: Capability, diagnostics: Diagnostic[]): void {
  const pathIssue = validateHttpOperationPath(capability.execution.pathTemplate);
  if (pathIssue !== null) {
    diagnostics.push(
      diagnostic({
        code: 'PATH.UNSAFE_TEMPLATE',
        severity: 'error',
        message: pathIssue.message,
        pointer: '/execution/pathTemplate',
        recoverable: false,
        details: {
          reason: pathIssue.code,
          ...(pathIssue.segmentIndex === undefined ? {} : { segmentIndex: pathIssue.segmentIndex }),
        },
      }),
    );
  }
  const placeholders = [...capability.execution.pathTemplate.matchAll(TEMPLATE_VARIABLE)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
  const uniquePlaceholders = new Set(placeholders);
  if (capability.execution.pathTemplate.replace(TEMPLATE_VARIABLE, '').match(/[{}]/)) {
    diagnostics.push(
      diagnostic({
        code: 'PATH.MALFORMED_TEMPLATE',
        severity: 'error',
        message: 'Path template contains an unmatched or nested brace.',
        pointer: '/execution/pathTemplate',
      }),
    );
  }
  if (uniquePlaceholders.size !== placeholders.length) {
    diagnostics.push(
      diagnostic({
        code: 'PATH.DUPLICATE_PLACEHOLDER',
        severity: 'error',
        message: 'A path template placeholder may occur only once.',
        pointer: '/execution/pathTemplate',
      }),
    );
  }

  const pathBindings = capability.execution.parameterBindings.filter(
    (binding) => binding.location === 'path',
  );
  for (const placeholder of uniquePlaceholders) {
    const matches = pathBindings.filter((binding) => binding.name === placeholder);
    if (matches.length === 0) {
      diagnostics.push(
        diagnostic({
          code: 'PATH.UNBOUND_PLACEHOLDER',
          severity: 'error',
          message: `Path placeholder ${placeholder} has no input binding.`,
          pointer: '/execution/pathTemplate',
        }),
      );
    } else if (matches.length > 1) {
      diagnostics.push(
        diagnostic({
          code: 'PATH.DUPLICATE_BINDING',
          severity: 'error',
          message: `Path placeholder ${placeholder} has multiple bindings.`,
          pointer: '/execution/parameterBindings',
        }),
      );
    }
  }
  pathBindings.forEach((binding, index) => {
    if (!uniquePlaceholders.has(binding.name)) {
      diagnostics.push(
        diagnostic({
          code: 'PATH.UNUSED_BINDING',
          severity: 'error',
          message: `Path binding ${binding.name} has no matching template placeholder.`,
          pointer: pointer('execution', 'parameterBindings', index, 'name'),
        }),
      );
    }
  });
}

function validateOneBinding(
  capability: Capability,
  binding: {
    readonly inputPath: readonly string[];
    readonly required: boolean;
    readonly schema: JsonSchema;
  },
  bindingPointer: string,
  diagnostics: Diagnostic[],
): void {
  const located = locateInputSchema(capability.inputSchema, binding.inputPath);
  if (located === null) {
    diagnostics.push(
      diagnostic({
        code: 'BINDING.INPUT_PATH_MISSING',
        severity: 'error',
        message: `Execution binding input path does not exist: ${binding.inputPath.join('.')}`,
        pointer: `${bindingPointer}/inputPath`,
      }),
    );
    return;
  }
  if (binding.required && !located.required) {
    diagnostics.push(
      diagnostic({
        code: 'BINDING.REQUIRED_PATH_OPTIONAL',
        severity: 'error',
        message: `Required execution binding points to an optional input: ${binding.inputPath.join('.')}`,
        pointer: `${bindingPointer}/required`,
      }),
    );
  }
  if (!schemaContainsVariant(located.schema, binding.schema, capability.inputSchema)) {
    diagnostics.push(
      diagnostic({
        code: 'BINDING.SCHEMA_MISMATCH',
        severity: 'warning',
        message: `Binding schema differs from inputSchema at ${binding.inputPath.join('.')}.`,
        pointer: `${bindingPointer}/schema`,
      }),
    );
  }
}

function inferredBodySerialization(contentType: string): 'json' | 'form' | 'text' | undefined {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'application/json' || normalized?.endsWith('+json') === true) return 'json';
  if (normalized === 'application/x-www-form-urlencoded') return 'form';
  if (normalized?.startsWith('text/') === true) return 'text';
  return undefined;
}

function mediaTypeEssence(contentType: string): string {
  return contentType.split(';', 1)[0]!.trim().toLowerCase();
}

function parameterTextWireConstraint(
  binding: Capability['execution']['parameterBindings'][number],
): JsonSchema | undefined {
  const essence =
    binding.contentType === undefined ? undefined : mediaTypeEssence(binding.contentType);
  if (essence === 'application/json' || essence?.endsWith('+json') === true) return undefined;
  const pattern =
    binding.location === 'header' ? HTTP_HEADER_VALUE_PATTERN : WELL_FORMED_UNICODE_PATTERN;
  if (essence?.startsWith('text/') === true) return scalarTextWireSchema(pattern);
  return shallowParameterTextWireSchema(pattern);
}

function requiredPathSchema(inputPath: readonly string[], leafSchema: JsonSchema): JsonSchema {
  const [head, ...tail] = inputPath;
  if (head === undefined) return false;
  return {
    type: 'object',
    properties: {
      [head]: tail.length === 0 ? leafSchema : requiredPathSchema(tail, leafSchema),
    },
    required: [head],
  };
}

function asJsonSchema(value: unknown): JsonSchema | null {
  return typeof value === 'boolean' ||
    (value !== null && typeof value === 'object' && !Array.isArray(value))
    ? (value as JsonSchema)
    : null;
}

function requestBodyInputSchema(
  capability: Capability,
  binding: Capability['execution']['requestBodies'][number],
): JsonSchema {
  const direct = locateInputSchema(capability.inputSchema, binding.inputPath)?.schema;
  if (binding.contentTypeInputPath === undefined || typeof capability.inputSchema === 'boolean') {
    return direct ?? binding.schema;
  }

  const expectedCondition = requiredPathSchema(binding.contentTypeInputPath, {
    type: 'string',
    const: binding.contentType,
  });
  const allOf = capability.inputSchema['allOf'];
  if (!Array.isArray(allOf)) return direct ?? binding.schema;
  for (const candidate of allOf) {
    const branch = asJsonSchema(candidate);
    if (branch === null || typeof branch === 'boolean') continue;
    const condition = asJsonSchema(branch['if']);
    const consequence = asJsonSchema(branch['then']);
    if (
      condition === null ||
      consequence === null ||
      canonicalStringify(condition) !== canonicalStringify(expectedCondition)
    ) {
      continue;
    }
    const selected = locateInputSchema(consequence, binding.inputPath);
    if (selected !== null) return selected.schema;
  }
  return direct ?? binding.schema;
}

type ResponseMediaContract =
  | { readonly kind: 'untyped' }
  | { readonly kind: 'any' }
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'suffix'; readonly type: string; readonly suffix: string }
  | { readonly kind: 'concrete'; readonly type: string; readonly subtype: string };

interface MediaOverlapIndex {
  untyped?: number;
  firstTyped?: number;
  any?: number;
  firstTypeRange?: number;
  firstWildcardSuffix?: number;
  readonly firstByType: Map<string, number>;
  readonly typeRanges: Map<string, number>;
  readonly suffixes: Map<string, number>;
  readonly suffixesBySuffix: Map<string, number>;
  readonly concrete: Map<string, number>;
  readonly concreteBySuffix: Map<string, number>;
}

interface OutputOverlapIndexes {
  readonly exact: Map<string, MediaOverlapIndex>;
  readonly ranges: Map<string, MediaOverlapIndex>;
  readonly fallback: MediaOverlapIndex;
}

function createMediaOverlapIndex(): MediaOverlapIndex {
  return {
    firstByType: new Map(),
    typeRanges: new Map(),
    suffixes: new Map(),
    suffixesBySuffix: new Map(),
    concrete: new Map(),
    concreteBySuffix: new Map(),
  };
}

function responseMediaContract(contentType: string | undefined): ResponseMediaContract | null {
  if (contentType === undefined) return { kind: 'untyped' };
  const [type, subtype] = mediaTypeEssence(contentType).split('/', 2);
  if (type === undefined || subtype === undefined) return null;
  if (!type.includes('*') && !subtype.includes('*')) {
    return { kind: 'concrete', type, subtype };
  }
  if (type === '*' && subtype === '*') return { kind: 'any' };
  if (!type.includes('*') && subtype === '*') return { kind: 'type', type };
  if (
    (type === '*' || !type.includes('*')) &&
    subtype.startsWith('*+') &&
    subtype.length > 2 &&
    !subtype.slice(2).includes('*')
  ) {
    return { kind: 'suffix', type, suffix: subtype.slice(2) };
  }
  return null;
}

function mediaSuffixes(subtype: string): readonly string[] {
  const suffixes: string[] = [];
  for (let index = subtype.indexOf('+'); index >= 0; index = subtype.indexOf('+', index + 1)) {
    if (index + 1 < subtype.length) suffixes.push(subtype.slice(index + 1));
  }
  return suffixes;
}

function firstIndex(...candidates: readonly (number | undefined)[]): number | undefined {
  return candidates.find((candidate): candidate is number => candidate !== undefined);
}

function mediaOverlap(
  index: MediaOverlapIndex,
  contract: ResponseMediaContract,
): number | undefined {
  if (contract.kind === 'untyped') return index.untyped;
  if (contract.kind === 'any') return index.firstTyped;
  if (contract.kind === 'type') {
    return firstIndex(index.any, index.firstByType.get(contract.type), index.firstWildcardSuffix);
  }
  if (contract.kind === 'suffix') {
    if (contract.type === '*') {
      return firstIndex(
        index.any,
        index.firstTypeRange,
        index.suffixesBySuffix.get(contract.suffix),
        index.concreteBySuffix.get(contract.suffix),
      );
    }
    return firstIndex(
      index.any,
      index.typeRanges.get(contract.type),
      index.suffixes.get(`${contract.type}\0${contract.suffix}`),
      index.suffixes.get(`*\0${contract.suffix}`),
      index.concreteBySuffix.get(`${contract.type}\0${contract.suffix}`),
    );
  }
  const suffixConflicts = mediaSuffixes(contract.subtype).flatMap((suffix) => [
    index.suffixes.get(`${contract.type}\0${suffix}`),
    index.suffixes.get(`*\0${suffix}`),
  ]);
  return firstIndex(
    index.any,
    index.typeRanges.get(contract.type),
    index.concrete.get(`${contract.type}\0${contract.subtype}`),
    ...suffixConflicts,
  );
}

function recordMediaContract(
  index: MediaOverlapIndex,
  contract: ResponseMediaContract,
  responseIndex: number,
): void {
  if (contract.kind === 'untyped') {
    index.untyped ??= responseIndex;
    return;
  }
  index.firstTyped ??= responseIndex;
  if (contract.kind === 'any') {
    index.any ??= responseIndex;
    return;
  }
  if (contract.kind === 'type') {
    index.firstTypeRange ??= responseIndex;
    if (!index.typeRanges.has(contract.type)) index.typeRanges.set(contract.type, responseIndex);
    if (!index.firstByType.has(contract.type)) index.firstByType.set(contract.type, responseIndex);
    return;
  }
  if (contract.kind === 'suffix') {
    const key = `${contract.type}\0${contract.suffix}`;
    if (!index.suffixes.has(key)) index.suffixes.set(key, responseIndex);
    if (!index.suffixesBySuffix.has(contract.suffix)) {
      index.suffixesBySuffix.set(contract.suffix, responseIndex);
    }
    if (contract.type === '*') index.firstWildcardSuffix ??= responseIndex;
    else if (!index.firstByType.has(contract.type)) {
      index.firstByType.set(contract.type, responseIndex);
    }
    return;
  }
  const concreteKey = `${contract.type}\0${contract.subtype}`;
  if (!index.concrete.has(concreteKey)) index.concrete.set(concreteKey, responseIndex);
  if (!index.firstByType.has(contract.type)) index.firstByType.set(contract.type, responseIndex);
  for (const suffix of mediaSuffixes(contract.subtype)) {
    const typedKey = `${contract.type}\0${suffix}`;
    if (!index.concreteBySuffix.has(typedKey)) {
      index.concreteBySuffix.set(typedKey, responseIndex);
    }
    if (!index.concreteBySuffix.has(suffix)) {
      index.concreteBySuffix.set(suffix, responseIndex);
    }
  }
}

function overlapIndex(indexes: Map<string, MediaOverlapIndex>, key: string): MediaOverlapIndex {
  const existing = indexes.get(key);
  if (existing !== undefined) return existing;
  const created = createMediaOverlapIndex();
  indexes.set(key, created);
  return created;
}

function findResponseOverlap(
  indexes: OutputOverlapIndexes,
  statusCode: string,
  contract: ResponseMediaContract,
): number | undefined {
  const normalized = statusCode.toUpperCase();
  if (normalized === 'DEFAULT') return mediaOverlap(indexes.fallback, contract);
  if (normalized.endsWith('XX')) {
    const rangeIndex = indexes.ranges.get(normalized[0]!);
    return rangeIndex === undefined ? undefined : mediaOverlap(rangeIndex, contract);
  }
  const exactIndex = indexes.exact.get(normalized);
  return exactIndex === undefined ? undefined : mediaOverlap(exactIndex, contract);
}

function recordResponseContract(
  indexes: OutputOverlapIndexes,
  statusCode: string,
  contract: ResponseMediaContract,
  responseIndex: number,
): void {
  const normalized = statusCode.toUpperCase();
  const target =
    normalized === 'DEFAULT'
      ? indexes.fallback
      : normalized.endsWith('XX')
        ? overlapIndex(indexes.ranges, normalized[0]!)
        : overlapIndex(indexes.exact, normalized);
  recordMediaContract(target, contract, responseIndex);
}

function validateBindings(capability: Capability, diagnostics: Diagnostic[]): void {
  const credentialTargets = new Map<string, string>();
  for (const alternative of capability.auth.alternatives) {
    for (const requirement of alternative) {
      const scheme = capability.auth.schemes[requirement.scheme];
      if (scheme === undefined) continue;
      const target = credentialTarget(scheme);
      if (target !== null && !target.startsWith('transport\0')) {
        credentialTargets.set(target, requirement.scheme);
      }
    }
  }

  const inputBindings = [
    ...capability.execution.parameterBindings.map((binding, index) => ({
      role: 'value' as const,
      path: binding.inputPath,
      pointer: pointer('execution', 'parameterBindings', index, 'inputPath'),
    })),
    ...capability.execution.requestBodies.flatMap((binding, index) => [
      {
        role: 'value' as const,
        path: binding.inputPath,
        pointer: pointer('execution', 'requestBodies', index, 'inputPath'),
      },
      ...(binding.contentTypeInputPath === undefined
        ? []
        : [
            {
              role: 'selector' as const,
              path: binding.contentTypeInputPath,
              pointer: pointer('execution', 'requestBodies', index, 'contentTypeInputPath'),
            },
          ]),
    ]),
  ];
  for (let leftIndex = 0; leftIndex < inputBindings.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inputBindings.length; rightIndex += 1) {
      const left = inputBindings[leftIndex]!;
      const right = inputBindings[rightIndex]!;
      const sharedLength = Math.min(left.path.length, right.path.length);
      if (
        !left.path.slice(0, sharedLength).every((segment, index) => segment === right.path[index])
      ) {
        continue;
      }
      const exact = left.path.length === right.path.length;
      if (exact && left.role === right.role) continue;
      diagnostics.push(
        diagnostic({
          code: 'BINDING.INPUT_PATH_COLLISION',
          severity: 'error',
          message: exact
            ? `Selector path ${right.path.join('.')} collides with a bound input value.`
            : `Bound input paths overlap by strict prefix: ${left.path.join('.')} and ${right.path.join('.')}.`,
          pointer: right.pointer,
        }),
      );
    }
  }

  const occupiedTargets = new Map<string, number>();
  capability.execution.parameterBindings.forEach((binding, index) => {
    const bindingPointer = pointer('execution', 'parameterBindings', index);
    validateOneBinding(capability, binding, bindingPointer, diagnostics);

    if (
      (binding.location === 'path' || binding.location === 'query') &&
      !isWellFormedUnicode(binding.name)
    ) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.INVALID_PARAMETER_UNICODE',
          severity: 'error',
          message: 'Path and query parameter names cannot contain unpaired Unicode surrogates.',
          pointer: `${bindingPointer}/name`,
          recoverable: false,
        }),
      );
    }

    const wireConstraint = parameterTextWireConstraint(binding);
    const wireInputSchema = locateInputSchema(capability.inputSchema, binding.inputPath)?.schema;
    if (
      wireConstraint !== undefined &&
      (wireInputSchema === undefined ||
        !schemaProvesWireConstraint(wireInputSchema, wireConstraint, capability.inputSchema))
    ) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.PARAMETER_TEXT_DOMAIN_UNPROVEN',
          severity: 'error',
          message:
            binding.location === 'header'
              ? 'Header input must prove every serialized field value is a valid HTTP ByteString field value.'
              : 'URL-oriented parameter input must prove that every serialized string is well-formed Unicode.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    }

    const style = binding.style ?? DEFAULT_PARAMETER_STYLE[binding.location];
    if (!PARAMETER_STYLES[binding.location].has(style)) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.UNSUPPORTED_PARAMETER_STYLE',
          severity: 'error',
          message: `${binding.location} parameter ${binding.name} uses unsupported serialization style ${style}.`,
          pointer: `${bindingPointer}/style`,
        }),
      );
    }

    if (binding.allowReserved === true) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.ALLOW_RESERVED_UNSUPPORTED',
          severity: 'error',
          message:
            'allowReserved query serialization is not supported because reserved delimiters cannot be emitted safely without changing URL structure.',
          pointer: `${bindingPointer}/allowReserved`,
        }),
      );
    }

    if (binding.contentType !== undefined) {
      if (binding.style !== undefined || binding.explode !== undefined) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.PARAMETER_CONTENT_STYLE_CONFLICT',
            severity: 'error',
            message: 'A content-encoded parameter cannot also declare style or explode.',
            pointer: bindingPointer,
          }),
        );
      }
      const essence = mediaTypeEssence(binding.contentType);
      const jsonContent = essence === 'application/json' || essence.endsWith('+json');
      const textContent = essence.startsWith('text/');
      if (essence.includes('*') || (!jsonContent && !textContent)) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.PARAMETER_CONTENT_TYPE_UNSUPPORTED',
            severity: 'error',
            message: `Parameter media type ${binding.contentType} has no deterministic wire serializer.`,
            pointer: `${bindingPointer}/contentType`,
          }),
        );
      } else if (textContent && !schemaAcceptsOnlyScalars(binding.schema)) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.PARAMETER_CONTENT_SCHEMA_MISMATCH',
            severity: 'error',
            message: 'Text parameter content requires a scalar-only input schema.',
            pointer: `${bindingPointer}/schema`,
          }),
        );
      }
    } else if (
      binding.location === 'query' &&
      style === 'deepObject' &&
      !schemaAcceptsOnlyScalarPropertyObject(binding.schema)
    ) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.PARAMETER_STYLE_SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'deepObject query serialization requires a closed object schema with scalar-only property values.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    } else if (binding.location === 'cookie' && !schemaAcceptsOnlyScalars(binding.schema)) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.COOKIE_SCHEMA_UNSUPPORTED',
          severity: 'error',
          message: 'Cookie bindings require a scalar-only input schema.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    } else if (!schemaAcceptsOnlyParameterValues(binding.schema)) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.PARAMETER_SCHEMA_UNSUPPORTED',
          severity: 'error',
          message:
            'Style-based parameter serialization requires a scalar, scalar array, or closed object with scalar-only values.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    }
    if (binding.location === 'cookie' && !isHttpFieldName(binding.name)) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.INVALID_COOKIE_NAME',
          severity: 'error',
          message: 'Cookie binding name is not a valid HTTP cookie token.',
          pointer: `${bindingPointer}/name`,
        }),
      );
    }

    if (binding.location === 'header') {
      const normalizedHeader = normalizeHeaderName(binding.name);
      if (isForbiddenToolInputHeader(binding.name)) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.FORBIDDEN_HEADER',
            severity: 'error',
            message: `Header ${normalizedHeader} is controlled by credentials, routing, or HTTP transport and cannot be bound from tool input.`,
            pointer: `${bindingPointer}/name`,
            recoverable: false,
            details: { header: normalizedHeader },
          }),
        );
      }
      if (!isValidHeaderName(binding.name)) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.INVALID_HEADER_NAME',
            severity: 'error',
            message: 'Header binding name is not a valid HTTP field name.',
            pointer: `${bindingPointer}/name`,
            details: { header: normalizedHeader },
          }),
        );
      }
    }

    const normalizedName =
      binding.location === 'header' ? normalizeHeaderName(binding.name) : binding.name;
    const key = `${binding.location}\0${normalizedName}`;
    const credentialScheme = credentialTargets.get(key);
    if (credentialScheme !== undefined) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.CREDENTIAL_TARGET_CONFLICT',
          severity: 'error',
          message: `Tool input parameter ${binding.location}:${binding.name} conflicts with authentication scheme ${credentialScheme}.`,
          pointer: bindingPointer,
          recoverable: false,
          details: { credentialScheme, credentialTarget: key },
        }),
      );
    }
    const previous = occupiedTargets.get(key);
    if (previous !== undefined) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.DUPLICATE_TARGET',
          severity: 'error',
          message: `Multiple bindings target ${binding.location} parameter ${binding.name}.`,
          pointer: bindingPointer,
          details: { previousIndex: previous },
        }),
      );
    } else {
      occupiedTargets.set(key, index);
    }
  });

  const requestBodies = capability.execution.requestBodies;
  if (requestBodies.length > 1) {
    const first = requestBodies[0]!;
    const expectedInputPath = JSON.stringify(first.inputPath);
    const expectedSelector =
      first.contentTypeInputPath === undefined
        ? undefined
        : JSON.stringify(first.contentTypeInputPath);
    const contentTypes = new Map<string, number>();
    requestBodies.forEach((binding, index) => {
      const bindingPointer = pointer('execution', 'requestBodies', index);
      if (JSON.stringify(binding.inputPath) !== expectedInputPath) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.REQUEST_BODY_INPUT_PATH_INCONSISTENT',
            severity: 'error',
            message: 'All representations of one HTTP request body must share one input path.',
            pointer: `${bindingPointer}/inputPath`,
          }),
        );
      }
      if (binding.required !== first.required) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.REQUEST_BODY_REQUIRED_INCONSISTENT',
            severity: 'error',
            message: 'All request body representations must agree on whether the body is required.',
            pointer: `${bindingPointer}/required`,
          }),
        );
      }
      if (binding.contentTypeInputPath === undefined) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.REQUEST_BODY_SELECTOR_MISSING',
            severity: 'error',
            message:
              'Multiple request body representations require an explicit content-type selector.',
            pointer: `${bindingPointer}/contentTypeInputPath`,
          }),
        );
      } else if (JSON.stringify(binding.contentTypeInputPath) !== expectedSelector) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.REQUEST_BODY_SELECTOR_INCONSISTENT',
            severity: 'error',
            message: 'All request body representations must share one content-type selector path.',
            pointer: `${bindingPointer}/contentTypeInputPath`,
          }),
        );
      }
      const normalizedContentType = binding.contentType.trim().toLowerCase();
      const previousIndex = contentTypes.get(normalizedContentType);
      if (previousIndex !== undefined) {
        diagnostics.push(
          diagnostic({
            code: 'BINDING.DUPLICATE_REQUEST_BODY_REPRESENTATION',
            severity: 'error',
            message: `Request content type ${binding.contentType} duplicates representation index ${previousIndex}.`,
            pointer: `${bindingPointer}/contentType`,
          }),
        );
      } else {
        contentTypes.set(normalizedContentType, index);
      }
    });
  }

  requestBodies.forEach((binding, index) => {
    const bindingPointer = pointer('execution', 'requestBodies', index);
    validateOneBinding(capability, binding, bindingPointer, diagnostics);
    if (binding.contentTypeInputPath !== undefined) {
      validateOneBinding(
        capability,
        {
          inputPath: binding.contentTypeInputPath,
          required: binding.required,
          schema: { type: 'string', const: binding.contentType },
        },
        `${bindingPointer}/contentTypeSelector`,
        diagnostics,
      );
    }
    const serialization = binding.serialization ?? inferredBodySerialization(binding.contentType);
    const wireInputSchema = requestBodyInputSchema(capability, binding);
    if (mediaTypeEssence(binding.contentType).includes('*')) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.REQUEST_BODY_MEDIA_TYPE_UNSUPPORTED',
          severity: 'error',
          message: 'A request Content-Type must be a concrete media type, not a wildcard range.',
          pointer: `${bindingPointer}/contentType`,
        }),
      );
    }
    if (serialization === undefined) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.REQUEST_BODY_SERIALIZATION_UNSUPPORTED',
          severity: 'error',
          message: `Request media type ${binding.contentType} requires an explicit supported serialization.`,
          pointer: `${bindingPointer}/serialization`,
        }),
      );
      return;
    }
    if (serialization === 'base64' && !schemaAcceptsOnlyCanonicalBase64(wireInputSchema)) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.SERIALIZATION_SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'Base64 request serialization requires a finite schema that proves every accepted string is canonical base64.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    }
    if (
      serialization === 'form' &&
      (!schemaAcceptsOnlyFormObject(wireInputSchema) ||
        !schemaProvesWireConstraint(wireInputSchema, formTextWireSchema(), capability.inputSchema))
    ) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.SERIALIZATION_SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'Form request serialization requires well-formed Unicode field names and a closed object schema whose values are well-formed scalar or scalar-array entries.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    }
    if (
      serialization === 'text' &&
      (!schemaAcceptsOnlyScalars(wireInputSchema) ||
        !schemaProvesWireConstraint(
          wireInputSchema,
          scalarTextWireSchema(WELL_FORMED_UNICODE_PATTERN),
          capability.inputSchema,
        ))
    ) {
      diagnostics.push(
        diagnostic({
          code: 'BINDING.SERIALIZATION_SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'Text request serialization requires a scalar input schema whose strings are well-formed Unicode.',
          pointer: `${bindingPointer}/schema`,
        }),
      );
    }
  });
}

function validateSchemas(
  capability: Capability,
  options: CapabilityVerificationOptions,
  diagnostics: Diagnostic[],
): void {
  if (typeof capability.inputSchema === 'boolean' || capability.inputSchema['type'] !== 'object') {
    diagnostics.push(
      diagnostic({
        code: 'SCHEMA.INPUT_ROOT_NOT_OBJECT',
        severity: 'error',
        message: 'MCP tool inputSchema must have an object root type.',
        pointer: '/inputSchema',
      }),
    );
  }
  const schemas: Array<{ label: string; schema: JsonSchema; pointer: string }> = [
    { label: 'inputSchema', schema: capability.inputSchema, pointer: '/inputSchema' },
    ...(capability.outputSchema === undefined
      ? []
      : [{ label: 'outputSchema', schema: capability.outputSchema, pointer: '/outputSchema' }]),
    ...capability.execution.parameterBindings.map((binding, index) => ({
      label: `parameter binding ${binding.name}`,
      schema: binding.schema,
      pointer: pointer('execution', 'parameterBindings', index, 'schema'),
    })),
    ...capability.execution.requestBodies.map((binding, index) => ({
      label: `request body ${binding.contentType}`,
      schema: binding.schema,
      pointer: pointer('execution', 'requestBodies', index, 'schema'),
    })),
    ...capability.execution.successResponses.flatMap((response, index) =>
      response.schema === undefined
        ? []
        : [
            {
              label: `success response ${response.statusCode}`,
              schema: response.schema,
              pointer: pointer('execution', 'successResponses', index, 'schema'),
            },
          ],
    ),
  ];

  for (const item of schemas) {
    const failure = validateJsonSchema(item.schema, options.ajv, options.schemaLimits);
    if (failure === null) continue;
    diagnostics.push(
      diagnostic({
        code: failure.diagnosticCode,
        severity: 'error',
        message: `${item.label} is invalid: ${failure.message}`,
        pointer: item.pointer,
        details: { ajvErrorCount: failure.errors.length },
      }),
    );
  }
}

function validateOutputContract(capability: Capability, diagnostics: Diagnostic[]): void {
  const responseKeys = new Set<string>();
  const responseSchemas: JsonSchema[] = [];
  const overlapIndexes: OutputOverlapIndexes = {
    exact: new Map(),
    ranges: new Map(),
    fallback: createMediaOverlapIndex(),
  };
  let hasSuccessResponse = false;
  capability.execution.successResponses.forEach((response, index) => {
    const key = `${response.statusCode.toUpperCase()}\0${response.contentType ?? ''}`;
    if (responseKeys.has(key)) {
      diagnostics.push(
        diagnostic({
          code: 'OUTPUT.DUPLICATE_RESPONSE',
          severity: 'error',
          message: `Duplicate success response contract for ${response.statusCode} ${response.contentType ?? ''}.`,
          pointer: pointer('execution', 'successResponses', index),
        }),
      );
    }
    responseKeys.add(key);

    const successStatus = /^2(?:\d{2}|XX)$/i.test(response.statusCode);
    if (successStatus || response.statusCode.toLowerCase() === 'default') {
      hasSuccessResponse = true;
    } else {
      diagnostics.push(
        diagnostic({
          code: 'OUTPUT.NON_SUCCESS_STATUS',
          severity: 'error',
          message: `Status ${response.statusCode} cannot be listed as a success response because runtime accepts only 2xx/default contracts.`,
          pointer: pointer('execution', 'successResponses', index, 'statusCode'),
        }),
      );
    }

    const mediaContract = responseMediaContract(response.contentType);
    if (mediaContract === null) {
      diagnostics.push(
        diagnostic({
          code: 'OUTPUT.MEDIA_RANGE_UNSUPPORTED',
          severity: 'error',
          message: `Response media range ${response.contentType} is not supported by runtime matching.`,
          pointer: pointer('execution', 'successResponses', index, 'contentType'),
        }),
      );
    } else {
      const previousIndex = findResponseOverlap(overlapIndexes, response.statusCode, mediaContract);
      if (previousIndex !== undefined) {
        diagnostics.push(
          diagnostic({
            code: 'OUTPUT.RESPONSE_CONTRACT_OVERLAP',
            severity: 'error',
            message:
              'Response status and media contracts overlap at runtime and would be selected by declaration order.',
            pointer: pointer('execution', 'successResponses', index),
            details: { previousIndex },
          }),
        );
      }
      recordResponseContract(overlapIndexes, response.statusCode, mediaContract, index);
    }
    if (response.schema !== undefined) responseSchemas.push(response.schema);
  });

  if (!hasSuccessResponse) {
    diagnostics.push(
      diagnostic({
        code: 'OUTPUT.SUCCESS_RESPONSE_MISSING',
        severity: 'error',
        message: 'At least one 2xx or default success response contract is required.',
        pointer: '/execution/successResponses',
      }),
    );
  }

  if (capability.outputSchema !== undefined && responseSchemas.length === 0) {
    diagnostics.push(
      diagnostic({
        code: 'OUTPUT.UNGROUNDED_SCHEMA',
        severity: 'error',
        message: 'outputSchema exists but no success response supplies a schema.',
        pointer: '/outputSchema',
      }),
    );
  }
  if (
    capability.outputSchema !== undefined &&
    responseSchemas.length > 0 &&
    !schemaRepresentsVariants(
      capability.outputSchema as JsonSchema,
      responseSchemas,
      capability.outputSchema as JsonSchema,
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'OUTPUT.SCHEMA_TRANSFORMATION_UNVERIFIED',
        severity: 'warning',
        message:
          'outputSchema is not identical to a source success response; an explicit transform must be reviewed.',
        pointer: '/outputSchema',
      }),
    );
  }
}

function credentialTarget(scheme: SecuritySchemeMetadata): string | null {
  if (scheme.type === 'apiKey') {
    if (scheme.location === undefined || scheme.parameterName === undefined) return null;
    const parameterName =
      scheme.location === 'header'
        ? normalizeHeaderName(scheme.parameterName)
        : scheme.parameterName;
    return `${scheme.location}\0${parameterName}`;
  }
  if (scheme.type === 'http' || scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
    return 'header\0authorization';
  }
  if (scheme.type === 'mutualTLS') return 'transport\0mutual-tls';
  return null;
}

function validateAuthContract(capability: Capability, diagnostics: Diagnostic[]): void {
  const { auth } = capability;
  if (
    auth.required &&
    (auth.alternatives.length === 0 || auth.alternatives.some((group) => group.length === 0))
  ) {
    diagnostics.push(
      diagnostic({
        code: 'AUTH.MISSING_REQUIREMENT',
        severity: 'error',
        message:
          'Authentication is required but at least one alternative permits no security scheme.',
        pointer: '/auth/alternatives',
      }),
    );
  }
  if (!auth.required && auth.alternatives.some((group) => group.length > 0)) {
    const permitsAnonymous = auth.alternatives.some((group) => group.length === 0);
    diagnostics.push(
      diagnostic({
        code: permitsAnonymous ? 'AUTH.OPTIONAL_WITH_REQUIREMENTS' : 'AUTH.REQUIRED_FLAG_MISMATCH',
        severity: permitsAnonymous ? 'warning' : 'error',
        message: permitsAnonymous
          ? 'Authentication is optional while authenticated alternatives are also declared.'
          : 'Authentication is marked optional but every declared alternative requires credentials.',
        pointer: '/auth',
      }),
    );
  }

  for (const [schemeName, metadata] of Object.entries(auth.schemes)) {
    if (metadata.name !== schemeName) {
      diagnostics.push(
        diagnostic({
          code: 'AUTH.SCHEME_NAME_MISMATCH',
          severity: 'error',
          message: `Security scheme record key ${schemeName} does not match metadata name ${metadata.name}.`,
          pointer: pointer('auth', 'schemes', schemeName, 'name'),
          recoverable: false,
        }),
      );
    }
    if (
      metadata.type === 'apiKey' &&
      metadata.location === 'query' &&
      metadata.parameterName !== undefined &&
      !isWellFormedUnicode(metadata.parameterName)
    ) {
      diagnostics.push(
        diagnostic({
          code: 'AUTH.INVALID_PARAMETER_UNICODE',
          severity: 'error',
          message: 'Query apiKey parameter names cannot contain unpaired Unicode surrogates.',
          pointer: pointer('auth', 'schemes', schemeName, 'parameterName'),
          recoverable: false,
        }),
      );
    }
    if (
      metadata.type === 'apiKey' &&
      metadata.parameterName !== undefined &&
      (metadata.location === 'header' || metadata.location === 'cookie') &&
      !isHttpFieldName(metadata.parameterName)
    ) {
      diagnostics.push(
        diagnostic({
          code:
            metadata.location === 'header'
              ? 'AUTH.INVALID_HEADER_NAME'
              : 'AUTH.INVALID_COOKIE_NAME',
          severity: 'error',
          message: `${metadata.location === 'header' ? 'Header' : 'Cookie'} apiKey parameter names must be valid HTTP tokens.`,
          pointer: pointer('auth', 'schemes', schemeName, 'parameterName'),
          recoverable: false,
        }),
      );
    }
    if (
      metadata.type === 'apiKey' &&
      metadata.location === 'header' &&
      metadata.parameterName !== undefined &&
      isTransportControlledCredentialHeader(metadata.parameterName)
    ) {
      diagnostics.push(
        diagnostic({
          code: 'AUTH.FORBIDDEN_HEADER_TARGET',
          severity: 'error',
          message: 'Header apiKey schemes cannot target routing or framing headers.',
          pointer: pointer('auth', 'schemes', schemeName, 'parameterName'),
          recoverable: false,
        }),
      );
    }
  }

  let completeCredentialAlternatives = 0;
  auth.alternatives.forEach((group, groupIndex) => {
    const seen = new Set<string>();
    const occupiedCredentialTargets = new Set<string>();
    let completeCredentialAlternative = group.length > 0;
    group.forEach((requirement, itemIndex) => {
      const itemPointer = pointer('auth', 'alternatives', groupIndex, itemIndex);
      const scheme = auth.schemes[requirement.scheme];
      if (scheme === undefined) {
        completeCredentialAlternative = false;
        diagnostics.push(
          diagnostic({
            code: 'AUTH.UNKNOWN_SCHEME',
            severity: 'error',
            message: `Authentication requirement references unknown scheme ${requirement.scheme}.`,
            pointer: `${itemPointer}/scheme`,
          }),
        );
      }
      if (seen.has(requirement.scheme)) {
        diagnostics.push(
          diagnostic({
            code: 'AUTH.DUPLICATE_SCHEME',
            severity: 'error',
            message: `Authentication alternative repeats scheme ${requirement.scheme}.`,
            pointer: itemPointer,
          }),
        );
      }
      seen.add(requirement.scheme);
      if (scheme !== undefined) {
        const target = credentialTarget(scheme);
        if (target === null) {
          completeCredentialAlternative = false;
          diagnostics.push(
            diagnostic({
              code: 'AUTH.CREDENTIAL_METADATA_INCOMPLETE',
              severity: 'error',
              message: `Security scheme ${requirement.scheme} cannot produce a complete credential target.`,
              pointer: pointer('auth', 'schemes', requirement.scheme),
              recoverable: false,
            }),
          );
        } else if (occupiedCredentialTargets.has(target)) {
          completeCredentialAlternative = false;
          diagnostics.push(
            diagnostic({
              code: 'AUTH.CREDENTIAL_TARGET_CONFLICT',
              severity: 'error',
              message: `Authentication alternative ${groupIndex} maps multiple credentials to the same target.`,
              pointer: itemPointer,
              recoverable: false,
              details: { credentialTarget: target },
            }),
          );
        } else {
          occupiedCredentialTargets.add(target);
        }
      }
      if (
        requirement.scopes.length > 0 &&
        scheme !== undefined &&
        !['oauth2', 'openIdConnect'].includes(scheme.type)
      ) {
        diagnostics.push(
          diagnostic({
            code: 'AUTH.UNSUPPORTED_SCOPES',
            severity: 'warning',
            message: `Scopes are declared for non-OAuth scheme ${requirement.scheme}.`,
            pointer: `${itemPointer}/scopes`,
          }),
        );
      }
    });
    if (completeCredentialAlternative) completeCredentialAlternatives += 1;
  });

  if (auth.required && completeCredentialAlternatives === 0) {
    diagnostics.push(
      diagnostic({
        code: 'AUTH.REQUIRED_CREDENTIAL_COVERAGE_MISSING',
        severity: 'error',
        message: 'Required authentication has no complete, non-conflicting credential alternative.',
        pointer: '/auth/alternatives',
        recoverable: false,
      }),
    );
  }
}

function validateRiskContract(capability: Capability, diagnostics: Diagnostic[]): void {
  const { risk } = capability;
  const { method } = capability.execution;
  if (risk.level === 'destructive' && !risk.requiresConfirmation) {
    diagnostics.push(
      diagnostic({
        code: 'RISK.DESTRUCTIVE_WITHOUT_CONFIRMATION',
        severity: 'error',
        message: 'Destructive operations must require confirmation.',
        pointer: '/risk/requiresConfirmation',
      }),
    );
  }
  if (risk.level === 'destructive' && risk.sideEffect === 'none') {
    diagnostics.push(
      diagnostic({
        code: 'RISK.DESTRUCTIVE_WITHOUT_SIDE_EFFECT',
        severity: 'error',
        message: 'A destructive operation cannot declare that it has no side effect.',
        pointer: '/risk/sideEffect',
      }),
    );
  }
  if (risk.level === 'read' && risk.sideEffect === 'definite') {
    diagnostics.push(
      diagnostic({
        code: 'RISK.READ_WITH_SIDE_EFFECT',
        severity: 'error',
        message: 'A read operation cannot have a definite side effect.',
        pointer: '/risk',
      }),
    );
  }
  if (HTTP_SAFE_METHODS.has(capability.execution.method) && risk.idempotency === 'non-idempotent') {
    diagnostics.push(
      diagnostic({
        code: 'RISK.SAFE_METHOD_NON_IDEMPOTENT',
        severity: 'info',
        message: `${capability.execution.method} is declared non-idempotent by the authoritative API registration, so retries remain disabled.`,
        pointer: '/risk/idempotency',
      }),
    );
  }
  if (HTTP_SAFE_METHODS.has(method) && (risk.level !== 'read' || risk.sideEffect !== 'none')) {
    diagnostics.push(
      diagnostic({
        code: 'RISK.SAFE_METHOD_UPSTREAM_OVERRIDE',
        severity: risk.requiresConfirmation ? 'info' : 'error',
        message: `${method} has stricter upstream risk semantics than the HTTP default and must remain confirmation-gated.`,
        pointer: '/risk',
        recoverable: false,
      }),
    );
  }
  if (HTTP_MUTATION_METHODS.has(method) && !risk.requiresConfirmation) {
    diagnostics.push(
      diagnostic({
        code: 'RISK.MUTATION_WITHOUT_CONFIRMATION',
        severity: 'error',
        message: `${method} capabilities must require confirmation.`,
        pointer: '/risk/requiresConfirmation',
        recoverable: false,
      }),
    );
  }
  if (method === 'DELETE' && risk.level !== 'destructive') {
    diagnostics.push(
      diagnostic({
        code: 'RISK.DELETE_NOT_DESTRUCTIVE',
        severity: 'error',
        message: 'DELETE capabilities must retain a destructive risk classification.',
        pointer: '/risk/level',
        recoverable: false,
      }),
    );
  }
  if (HTTP_MUTATION_METHODS.has(method) && risk.level === 'read') {
    diagnostics.push(
      diagnostic({
        code: 'RISK.MUTATION_CLASSIFIED_READ',
        severity: 'error',
        message: `${method} cannot be classified as a read capability.`,
        pointer: '/risk/level',
        recoverable: false,
      }),
    );
  }
  if (risk.level === 'unknown' || risk.sideEffect === 'unknown' || risk.idempotency === 'unknown') {
    diagnostics.push(
      diagnostic({
        code: 'RISK.REVIEW_REQUIRED',
        severity: 'warning',
        message: 'Risk metadata contains unknown values and requires review before release.',
        pointer: '/risk',
      }),
    );
  }
}

function validateExecutionSecurity(capability: Capability, diagnostics: Diagnostic[]): void {
  if (FETCH_FORBIDDEN_METHODS.has(capability.execution.method)) {
    diagnostics.push(
      diagnostic({
        code: 'EXECUTION.METHOD_UNSUPPORTED',
        severity: 'error',
        message: `${capability.execution.method} is forbidden by the HTTP fetch execution boundary.`,
        pointer: '/execution/method',
        recoverable: false,
      }),
    );
  }
  if (
    (capability.execution.method === 'GET' || capability.execution.method === 'HEAD') &&
    capability.execution.requestBodies.length > 0
  ) {
    diagnostics.push(
      diagnostic({
        code: 'EXECUTION.SAFE_METHOD_BODY_UNSUPPORTED',
        severity: 'error',
        message: `${capability.execution.method} request bodies are not supported by the HTTP execution engine.`,
        pointer: '/execution/requestBodies',
        recoverable: false,
      }),
    );
  }
}

function compareSourceOperation(
  capability: Capability,
  source: NormalizedOperation,
  diagnostics: Diagnostic[],
): void {
  compareContract(
    diagnostics,
    'SOURCE.PROVENANCE_MISMATCH',
    'source operation provenance',
    '/provenance',
    capability.provenance,
    source.provenance,
  );
  compareContract(
    diagnostics,
    'SOURCE.METHOD_MISMATCH',
    'HTTP method',
    '/execution/method',
    capability.execution.method,
    source.method,
  );
  compareContract(
    diagnostics,
    'SOURCE.PATH_MISMATCH',
    'HTTP path',
    '/execution/pathTemplate',
    capability.execution.pathTemplate,
    source.path,
  );
  compareContract(
    diagnostics,
    'SOURCE.SERVER_MISMATCH',
    'server targets',
    '/execution/servers',
    capability.execution.servers,
    source.servers,
  );
  compareContract(
    diagnostics,
    'SOURCE.PARAMETER_MISMATCH',
    'parameter bindings',
    '/execution/parameterBindings',
    capability.execution.parameterBindings,
    source.parameters,
  );
  compareContract(
    diagnostics,
    'SOURCE.REQUEST_BODY_MISMATCH',
    'request body bindings',
    '/execution/requestBodies',
    capability.execution.requestBodies,
    source.requestBodies,
  );
  compareContract(
    diagnostics,
    'SOURCE.RESPONSE_MISMATCH',
    'success responses',
    '/execution/successResponses',
    capability.execution.successResponses,
    source.successResponses,
  );
  compareContract(
    diagnostics,
    'SOURCE.AUTH_MISMATCH',
    'authentication metadata',
    '/auth',
    capability.auth,
    source.auth,
  );
  if (source.risk !== undefined) {
    compareContract(
      diagnostics,
      'SOURCE.RISK_MISMATCH',
      'authoritative risk metadata',
      '/risk',
      capability.risk,
      source.risk,
    );
  }
}

function compareBaseline(
  capability: Capability,
  baseline: Capability,
  diagnostics: Diagnostic[],
): void {
  compareContract(
    diagnostics,
    'BASELINE.EXECUTION_MISMATCH',
    'execution plan',
    '/execution',
    capability.execution,
    baseline.execution,
  );
  compareContract(
    diagnostics,
    'BASELINE.AUTH_MISMATCH',
    'authentication metadata',
    '/auth',
    capability.auth,
    baseline.auth,
  );
  compareContract(
    diagnostics,
    'BASELINE.OUTPUT_MISMATCH',
    'output contract',
    '/outputSchema',
    capability.outputSchema,
    baseline.outputSchema,
  );
  compareContract(
    diagnostics,
    'BASELINE.RISK_MISMATCH',
    'risk contract',
    '/risk',
    capability.risk,
    baseline.risk,
  );
  compareContract(
    diagnostics,
    'BASELINE.PROVENANCE_MISMATCH',
    'source provenance',
    '/provenance',
    capability.provenance,
    baseline.provenance,
  );
}

/**
 * Verifies schemas, bindings and cross-field contracts without invoking a model or upstream API.
 * Supplying sourceOperation/baselineCapability upgrades grounding checks from local consistency to
 * immutable-source comparison.
 */
export function verifyCapability(
  input: unknown,
  options: CapabilityVerificationOptions = {},
): CapabilityVerificationResult {
  const inputFailure = inspectVerificationInput(input, options.inputLimits);
  if (inputFailure !== null) {
    const diagnostics = [
      diagnostic({
        code: inputFailure.kind === 'limit' ? 'IR.INPUT_LIMIT_EXCEEDED' : 'IR.UNSAFE_INPUT',
        severity: 'error',
        message: inputFailure.message,
        pointer: '/',
        recoverable: false,
      }),
    ];
    return { valid: false, diagnostics, errors: diagnostics, warnings: [] };
  }

  const parsed = CapabilitySchema.safeParse(input);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) =>
      diagnostic({
        code: 'IR.INVALID_CAPABILITY',
        severity: 'error',
        message: issue.message,
        pointer: pointer(...issue.path.map(String)),
        recoverable: false,
      }),
    );
    return { valid: false, diagnostics, errors: diagnostics, warnings: [] };
  }

  const capability = parsed.data;
  const diagnostics: Diagnostic[] = [];
  const { fingerprint: declaredFingerprint, ...fingerprintedContent } = capability;
  if (fingerprint(fingerprintedContent) !== declaredFingerprint) {
    diagnostics.push(
      diagnostic({
        code: 'IR.FINGERPRINT_MISMATCH',
        severity: 'error',
        message: 'Capability fingerprint does not match its canonical content.',
        pointer: '/fingerprint',
        recoverable: false,
      }),
    );
  }
  validateSchemas(capability, options, diagnostics);
  validateServers(capability, diagnostics);
  validatePathContract(capability, diagnostics);
  validateBindings(capability, diagnostics);
  validateOutputContract(capability, diagnostics);
  validateAuthContract(capability, diagnostics);
  validateRiskContract(capability, diagnostics);
  validateExecutionSecurity(capability, diagnostics);
  if (options.sourceOperation !== undefined) {
    compareSourceOperation(
      capability,
      NormalizedOperationSchema.parse(options.sourceOperation),
      diagnostics,
    );
  }
  if (options.baselineCapability !== undefined) {
    compareBaseline(capability, CapabilitySchema.parse(options.baselineCapability), diagnostics);
  }

  const ordered = [...diagnostics].sort(
    (left, right) =>
      (left.location?.pointer ?? '').localeCompare(right.location?.pointer ?? '') ||
      left.code.localeCompare(right.code),
  );
  const errors = ordered.filter((item) => item.severity === 'error');
  const warnings = ordered.filter((item) => item.severity === 'warning');
  return {
    valid: errors.length === 0,
    capability,
    diagnostics: ordered,
    errors,
    warnings,
  };
}
