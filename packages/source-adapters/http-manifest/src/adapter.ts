import {
  NormalizedApiDocumentSchema,
  NormalizedOperationSchema,
  fingerprint,
  isWellFormedUnicode,
  stableId,
  type AuthMetadata,
  type Diagnostic,
  type NormalizedOperation,
  type SecuritySchemeMetadata,
  type ServerTarget,
} from '@hi-mcp/capability-ir';
import {
  encodePointerSegment,
  parseSourceDocument,
  type SourceAdapter,
} from '@hi-mcp/source-adapter-core';

import { HttpApiManifestSchema, type HttpApiManifest } from './schema.js';
import type {
  HttpManifestAdapterOptions,
  HttpManifestAdapterResult,
  HttpManifestSource,
} from './types.js';

const ADAPTER_ID = 'http-manifest' as const;

function diagnostic(
  code: string,
  message: string,
  pointer: string,
  sourceUri?: string,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic {
  return {
    code: `HTTP_MANIFEST.${code}`,
    severity,
    message,
    location: {
      ...(sourceUri === undefined ? {} : { sourceUri }),
      pointer,
    },
    related: [],
    recoverable: severity !== 'error',
  };
}

function resolveServerUrl(
  url: string,
  pointer: string,
  diagnostics: Diagnostic[],
  options: HttpManifestAdapterOptions,
): string {
  if (!isWellFormedUnicode(url)) {
    diagnostics.push(
      diagnostic(
        'INVALID_SERVER_UNICODE',
        'Server URL cannot contain unpaired Unicode surrogates.',
        pointer,
        options.sourceUri,
      ),
    );
    return url;
  }
  try {
    const absolute = new URL(url);
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
      diagnostics.push(
        diagnostic(
          'UNSUPPORTED_SERVER_PROTOCOL',
          `Server URL protocol '${absolute.protocol}' is not executable by the HTTP runtime.`,
          pointer,
          options.sourceUri,
        ),
      );
    }
    if (absolute.search !== '' || absolute.hash !== '') {
      diagnostics.push(
        diagnostic(
          'SERVER_URL_COMPONENTS_UNSUPPORTED',
          'Server URL cannot contain a query string or fragment.',
          pointer,
          options.sourceUri,
        ),
      );
    }
    return absolute.toString();
  } catch {
    // Relative server URLs are resolved below when the caller provides a base URL.
  }

  if (options.baseUrl === undefined) {
    diagnostics.push(
      diagnostic(
        'RELATIVE_SERVER_URL',
        'Relative server URL requires baseUrl before deterministic HTTP execution.',
        pointer,
        options.sourceUri,
        'warning',
      ),
    );
    return url;
  }

  try {
    if (!isWellFormedUnicode(options.baseUrl)) {
      throw new TypeError('baseUrl cannot contain unpaired Unicode surrogates.');
    }
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new TypeError('baseUrl must use http or https.');
    }
    const resolved = new URL(url, baseUrl);
    if (resolved.search !== '' || resolved.hash !== '') {
      diagnostics.push(
        diagnostic(
          'SERVER_URL_COMPONENTS_UNSUPPORTED',
          'Resolved server URL cannot contain a query string or fragment.',
          pointer,
          options.sourceUri,
        ),
      );
    }
    return resolved.toString();
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'INVALID_BASE_URL',
        error instanceof Error ? error.message : 'baseUrl is invalid.',
        pointer,
        options.sourceUri,
      ),
    );
    return url;
  }
}

function serverTarget(
  server: HttpApiManifest['servers'][number],
  pointer: string,
  diagnostics: Diagnostic[],
  options: HttpManifestAdapterOptions,
): ServerTarget {
  return {
    template: server.url,
    resolvedUrl: resolveServerUrl(server.url, pointer, diagnostics, options),
    ...(server.description === undefined ? {} : { description: server.description }),
    variables: {},
    provenancePointer: pointer,
  };
}

interface InputBindingPath {
  readonly path: readonly string[];
  readonly pointer: string;
}

interface InputPathNode {
  readonly children: Map<string, InputPathNode>;
  readonly bindings: InputBindingPath[];
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index] as string;
    const rightSegment = right[index] as string;
    if (leftSegment !== rightSegment) {
      return leftSegment < rightSegment ? -1 : 1;
    }
  }
  return left.length - right.length;
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function pathsConflict(left: readonly string[], right: readonly string[]): boolean {
  const sharedLength = Math.min(left.length, right.length);
  return left.slice(0, sharedLength).every((segment, index) => segment === right[index]);
}

function availableContentTypePath(
  bodyPath: readonly string[],
  occupiedPaths: readonly (readonly string[])[],
): string[] {
  const parent = bodyPath.slice(0, -1);
  const leaf = bodyPath.at(-1) ?? 'body';
  const stem = `${leaf}ContentType`;
  for (let suffix = 1; suffix <= occupiedPaths.length + 1; suffix += 1) {
    const candidate = [...parent, suffix === 1 ? stem : `${stem}${suffix}`];
    if (!occupiedPaths.some((path) => pathsConflict(candidate, path))) return candidate;
  }
  throw new TypeError('Unable to allocate a collision-free request content-type input path.');
}

function normalizeRequestBodyBindings(
  operation: HttpApiManifest['operations'][number],
  operationIndex: number,
  diagnostics: Diagnostic[],
  sourceUri?: string,
): NormalizedOperation['requestBodies'] {
  const resolvedPaths = operation.requestBodies.map((body) => body.inputPath ?? ['body']);
  const groups = new Map<string, number[]>();
  resolvedPaths.forEach((inputPath, index) => {
    const key = pathKey(inputPath);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });

  const occupiedPaths: (readonly string[])[] = [
    ...operation.parameters.map(
      (parameter) => parameter.inputPath ?? [parameter.in, parameter.name],
    ),
    ...resolvedPaths,
    ...operation.requestBodies.flatMap((body) =>
      body.contentTypeInputPath === undefined ? [] : [body.contentTypeInputPath],
    ),
  ];
  const inferredSelectors = new Map<number, string[]>();

  for (const indices of groups.values()) {
    if (indices.length <= 1) continue;
    const explicitSelectors = new Map<string, string[]>();
    const contentTypes = new Map<string, number>();
    for (const index of indices) {
      const body = operation.requestBodies[index]!;
      if (body.contentTypeInputPath !== undefined) {
        explicitSelectors.set(pathKey(body.contentTypeInputPath), body.contentTypeInputPath);
      }
      const normalizedContentType = body.contentType.trim().toLowerCase();
      const previousIndex = contentTypes.get(normalizedContentType);
      if (previousIndex !== undefined) {
        diagnostics.push(
          diagnostic(
            'DUPLICATE_REQUEST_BODY_REPRESENTATION',
            `Request content type '${body.contentType}' duplicates request body index ${previousIndex} at the same input path.`,
            `/operations/${operationIndex}/requestBodies/${index}/contentType`,
            sourceUri,
          ),
        );
      } else {
        contentTypes.set(normalizedContentType, index);
      }
    }

    if (explicitSelectors.size > 1) {
      diagnostics.push(
        diagnostic(
          'INCONSISTENT_REQUEST_BODY_SELECTOR',
          'Representations sharing one request body input path must use the same contentTypeInputPath.',
          `/operations/${operationIndex}/requestBodies`,
          sourceUri,
        ),
      );
      continue;
    }

    const explicitSelector = [...explicitSelectors.values()][0];
    const selector =
      explicitSelector ?? availableContentTypePath(resolvedPaths[indices[0]!]!, occupiedPaths);
    if (explicitSelector === undefined) occupiedPaths.push(selector);
    indices.forEach((index) => inferredSelectors.set(index, selector));
  }

  return operation.requestBodies.map((body, index) => {
    const selector = body.contentTypeInputPath ?? inferredSelectors.get(index);
    return {
      contentType: body.contentType,
      ...(body.serialization === undefined ? {} : { serialization: body.serialization }),
      inputPath: resolvedPaths[index]!,
      ...(selector === undefined ? {} : { contentTypeInputPath: selector }),
      required: body.required,
      ...(body.description === undefined ? {} : { description: body.description }),
      schema: body.schema,
      provenancePointer: `/operations/${operationIndex}/requestBodies/${index}`,
    };
  });
}

function validateInputPaths(
  operation: HttpApiManifest['operations'][number],
  operationIndex: number,
  diagnostics: Diagnostic[],
  sourceUri?: string,
): boolean {
  const operationPointer = `/operations/${operationIndex}`;
  const bindings: InputBindingPath[] = [
    ...operation.parameters.map((parameter, index) => ({
      path: parameter.inputPath ?? [parameter.in, parameter.name],
      pointer: `${operationPointer}/parameters/${index}/inputPath`,
    })),
    ...operation.requestBodies.map((body, index) => ({
      path: body.inputPath ?? ['body'],
      pointer: `${operationPointer}/requestBodies/${index}/inputPath`,
    })),
  ].sort(
    (left, right) =>
      left.path.length - right.path.length ||
      comparePaths(left.path, right.path) ||
      left.pointer.localeCompare(right.pointer),
  );
  const root: InputPathNode = { children: new Map(), bindings: [] };
  let valid = true;

  for (const binding of bindings) {
    let node = root;
    let prefix: InputBindingPath | undefined;
    for (const segment of binding.path) {
      if (node.bindings.length > 0) {
        prefix = node.bindings[0];
        break;
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), bindings: [] };
        node.children.set(segment, child);
      }
      node = child;
    }

    if (prefix !== undefined) {
      diagnostics.push(
        diagnostic(
          'INPUT_PATH_COLLISION',
          `Input path ${JSON.stringify(binding.path)} is nested below ${JSON.stringify(prefix.path)} from ${prefix.pointer}.`,
          binding.pointer,
          sourceUri,
        ),
      );
      valid = false;
      continue;
    }

    node.bindings.push(binding);
  }

  return valid;
}

function validateParameterTargets(
  operation: HttpApiManifest['operations'][number],
  operationIndex: number,
  diagnostics: Diagnostic[],
  sourceUri?: string,
): boolean {
  const occupied = new Map<string, Map<string, number>>();
  let valid = true;

  operation.parameters.forEach((parameter, index) => {
    const name = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;
    let names = occupied.get(parameter.in);
    if (names === undefined) {
      names = new Map();
      occupied.set(parameter.in, names);
    }
    const previousIndex = names.get(name);
    if (previousIndex !== undefined) {
      diagnostics.push(
        diagnostic(
          'DUPLICATE_PARAMETER_TARGET',
          `Parameter target '${parameter.in}:${parameter.name}' duplicates parameter index ${previousIndex}.`,
          `/operations/${operationIndex}/parameters/${index}`,
          sourceUri,
        ),
      );
      valid = false;
      return;
    }
    names.set(name, index);
  });

  return valid;
}

function securitySchemes(
  manifest: HttpApiManifest,
): Readonly<Record<string, SecuritySchemeMetadata>> {
  return Object.fromEntries(
    Object.entries(manifest.securitySchemes).map(([name, scheme]) => [
      name,
      {
        name,
        ...scheme,
        provenancePointer: `/securitySchemes/${encodePointerSegment(name)}`,
      },
    ]),
  );
}

function authMetadata(
  alternatives: HttpApiManifest['security'],
  schemes: Readonly<Record<string, SecuritySchemeMetadata>>,
): AuthMetadata {
  const referencedSchemeNames = new Set(
    alternatives.flatMap((alternative) => alternative.map(({ scheme }) => scheme)),
  );
  const referencedSchemes = Object.fromEntries(
    [...referencedSchemeNames].sort().flatMap((name) => {
      const scheme = schemes[name];
      return scheme === undefined ? [] : ([[name, structuredClone(scheme)]] as const);
    }),
  );
  return {
    required: alternatives.length > 0 && alternatives.every((group) => group.length > 0),
    alternatives: structuredClone(alternatives),
    schemes: referencedSchemes,
  };
}

function normalizeOperation(
  operation: HttpApiManifest['operations'][number],
  operationIndex: number,
  manifest: HttpApiManifest,
  sourceId: string,
  documentFingerprint: string,
  rootServers: readonly ServerTarget[],
  schemes: Readonly<Record<string, SecuritySchemeMetadata>>,
  diagnostics: Diagnostic[],
  options: HttpManifestAdapterOptions,
): ReturnType<typeof NormalizedOperationSchema.safeParse> {
  const pointer = `/operations/${operationIndex}`;
  const servers =
    operation.servers === undefined
      ? rootServers
      : operation.servers.map((server, index) =>
          serverTarget(server, `${pointer}/servers/${index}`, diagnostics, options),
        );
  const parameters = operation.parameters.map((parameter, index) => ({
    location: parameter.in,
    name: parameter.name,
    inputPath: parameter.inputPath ?? [parameter.in, parameter.name],
    required: parameter.required ?? parameter.in === 'path',
    ...(parameter.description === undefined ? {} : { description: parameter.description }),
    ...(parameter.deprecated === undefined ? {} : { deprecated: parameter.deprecated }),
    ...(parameter.style === undefined ? {} : { style: parameter.style }),
    ...(parameter.explode === undefined ? {} : { explode: parameter.explode }),
    ...(parameter.allowReserved === undefined ? {} : { allowReserved: parameter.allowReserved }),
    ...(parameter.contentType === undefined ? {} : { contentType: parameter.contentType }),
    schema: parameter.schema,
    provenancePointer: `${pointer}/parameters/${index}`,
  }));
  const requestBodies = normalizeRequestBodyBindings(
    operation,
    operationIndex,
    diagnostics,
    options.sourceUri,
  );
  const successResponses = operation.successResponses.map((response, index) => ({
    ...response,
    provenancePointer: `${pointer}/successResponses/${index}`,
  }));
  const provenance = {
    sourceKind: ADAPTER_ID,
    sourceId,
    ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
    documentFingerprint,
    pointer,
    operationId: operation.id,
  };
  const base = {
    id: stableId('operation', sourceId, operation.id),
    operationId: operation.id,
    method: operation.method,
    path: operation.path,
    ...(operation.summary === undefined ? {} : { summary: operation.summary }),
    ...(operation.description === undefined ? {} : { description: operation.description }),
    tags: operation.tags,
    deprecated: operation.deprecated,
    servers,
    parameters,
    requestBodies,
    successResponses,
    auth: authMetadata(operation.security ?? manifest.security, schemes),
    ...(operation.risk === undefined ? {} : { risk: operation.risk }),
    provenance,
  };
  return NormalizedOperationSchema.safeParse({ ...base, fingerprint: fingerprint(base) });
}

export function adaptHttpManifest(
  source: HttpManifestSource,
  options: HttpManifestAdapterOptions = {},
): HttpManifestAdapterResult {
  const parsed = parseSourceDocument(source, {
    ...options,
    diagnosticNamespace: 'HTTP_MANIFEST',
  });
  if (parsed.document === null || parsed.format === null || parsed.hasErrors) {
    return {
      adapterId: ADAPTER_ID,
      document: null,
      operations: [],
      diagnostics: parsed.diagnostics,
      hasErrors: true,
    };
  }

  const manifestResult = HttpApiManifestSchema.safeParse(parsed.document);
  if (!manifestResult.success) {
    const schemaDiagnostics = manifestResult.error.issues.map((issue) =>
      diagnostic(
        'INVALID_SCHEMA',
        issue.message,
        `/${issue.path.map((part) => encodePointerSegment(String(part))).join('/')}`,
        options.sourceUri,
      ),
    );
    return {
      adapterId: ADAPTER_ID,
      document: null,
      operations: [],
      diagnostics: [...parsed.diagnostics, ...schemaDiagnostics],
      hasErrors: true,
    };
  }

  const manifest = manifestResult.data;
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const sourceId = options.sourceId ?? manifest.id;
  const documentFingerprint = fingerprint(parsed.document);
  const rootServers = manifest.servers.map((server, index) =>
    serverTarget(server, `/servers/${index}`, diagnostics, options),
  );
  const schemes = securitySchemes(manifest);
  const operations: NormalizedOperation[] = [];
  const ids = new Map<string, number>();
  const endpoints = new Map<string, number>();

  manifest.operations.forEach((operation, index) => {
    const previousId = ids.get(operation.id);
    if (previousId !== undefined) {
      diagnostics.push(
        diagnostic(
          'DUPLICATE_OPERATION_ID',
          `Operation id '${operation.id}' duplicates index ${previousId}.`,
          `/operations/${index}/id`,
          options.sourceUri,
        ),
      );
      return;
    }
    ids.set(operation.id, index);
    const endpoint = `${operation.method}\u0000${operation.path}`;
    const previousEndpoint = endpoints.get(endpoint);
    if (previousEndpoint !== undefined) {
      diagnostics.push(
        diagnostic(
          'DUPLICATE_ENDPOINT',
          `${operation.method} ${operation.path} duplicates operation index ${previousEndpoint}.`,
          `/operations/${index}`,
          options.sourceUri,
        ),
      );
      return;
    }
    endpoints.set(endpoint, index);

    const inputPathsValid = validateInputPaths(operation, index, diagnostics, options.sourceUri);
    const parameterTargetsValid = validateParameterTargets(
      operation,
      index,
      diagnostics,
      options.sourceUri,
    );
    if (!inputPathsValid || !parameterTargetsValid) {
      return;
    }

    const normalized = normalizeOperation(
      operation,
      index,
      manifest,
      sourceId,
      documentFingerprint,
      rootServers,
      schemes,
      diagnostics,
      options,
    );
    if (normalized.success) {
      operations.push(normalized.data);
    } else {
      normalized.error.issues.forEach((issue) => {
        diagnostics.push(
          diagnostic(
            'OPERATION_NORMALIZATION_FAILED',
            issue.message,
            `/operations/${index}/${issue.path
              .map((part) => encodePointerSegment(String(part)))
              .join('/')}`,
            options.sourceUri,
          ),
        );
      });
    }
  });

  const documentBase = {
    sourceId,
    ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
    sourceFormat: parsed.format,
    sourceKind: ADAPTER_ID,
    sourceVersion: manifest.schemaVersion,
    title: manifest.title,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    documentFingerprint,
    servers: rootServers,
    securitySchemes: schemes,
    operations,
  };
  const normalizedDocument = NormalizedApiDocumentSchema.safeParse(documentBase);
  if (!normalizedDocument.success) {
    normalizedDocument.error.issues.forEach((issue) => {
      diagnostics.push(
        diagnostic(
          'DOCUMENT_NORMALIZATION_FAILED',
          issue.message,
          `/${issue.path.map((part) => encodePointerSegment(String(part))).join('/')}`,
          options.sourceUri,
        ),
      );
    });
  }
  const hasErrors = diagnostics.some(({ severity }) => severity === 'error');
  return {
    adapterId: ADAPTER_ID,
    document: hasErrors || !normalizedDocument.success ? null : normalizedDocument.data,
    operations,
    diagnostics,
    hasErrors,
  };
}

export const httpManifestSourceAdapter: SourceAdapter = {
  id: ADAPTER_ID,
  async probe(input, rawOptions = {}) {
    const options = rawOptions as HttpManifestAdapterOptions;
    const parsed = parseSourceDocument(input.value, {
      ...options,
      diagnosticNamespace: 'HTTP_MANIFEST_PROBE',
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
    });
    if (parsed.document === null) {
      return { confidence: 0, reason: 'Input is not a safe JSON or YAML object.' };
    }
    const kind = parsed.document['kind'];
    const schemaVersion = parsed.document['schemaVersion'];
    if (kind === 'http' && schemaVersion === '1.0') {
      return { confidence: 1, reason: 'HiMCP HTTP manifest markers are present.' };
    }
    return { confidence: 0, reason: 'HiMCP HTTP manifest markers are absent.' };
  },
  adapt(input, rawOptions = {}) {
    const options = rawOptions as HttpManifestAdapterOptions;
    return adaptHttpManifest(input.value, {
      ...options,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
    });
  },
};
