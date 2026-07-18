import {
  NormalizedApiDocumentSchema,
  NormalizedOperationSchema,
  SecuritySchemeTypeSchema,
  fingerprint,
  isWellFormedUnicode,
  stableId,
  validateHttpOperationPath,
  type AuthMetadata,
  type Diagnostic,
  type JsonSchema,
  type JsonValue,
  type NormalizedApiDocument,
  type NormalizedOperation,
  type ParameterBinding,
  type RequestBodyBinding,
  type SecurityRequirement,
  type SecuritySchemeMetadata,
  type ServerTarget,
  type SuccessResponse,
} from '@hi-mcp/capability-ir';

import { DiagnosticCollector } from './diagnostics.js';
import { encodePointerSegment, parseOpenApi } from './parse.js';
import { ReferenceResolver } from './references.js';
import { normalizeOpenApiSchemaDialect } from './schema-dialect.js';
import type { OpenApiAdapterOptions, OpenApiAdapterResult, OpenApiSource } from './types.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonExtensions(value: Record<string, unknown>): Record<string, JsonValue> | undefined {
  const entries = Object.entries(value).filter(([key]) => key.startsWith('x-'));
  return entries.length === 0
    ? undefined
    : (Object.fromEntries(entries) as Record<string, JsonValue>);
}

type JsonSchemaNormalizer = (value: unknown, pointer: string) => JsonSchema;

function toJsonSchema(
  value: unknown,
  resolver: ReferenceResolver,
  pointer: string,
  openapiVersion: string,
  collector: DiagnosticCollector,
): JsonSchema {
  const resolved = resolver.resolveSchema(value, pointer);
  const normalized = normalizeOpenApiSchemaDialect(resolved, openapiVersion, collector, pointer);
  return typeof normalized === 'boolean' || isRecord(normalized)
    ? (normalized as JsonSchema)
    : (Object.create(null) as JsonSchema);
}

function normalizeServers(
  rawServers: unknown,
  pointer: string,
  resolver: ReferenceResolver,
  collector: DiagnosticCollector,
  baseUrl?: string,
): ServerTarget[] {
  const resolveAgainstBase = (url: string, serverPointer: string): string => {
    if (!isWellFormedUnicode(url)) {
      collector.add({
        code: 'OPENAPI.INVALID_SERVER_UNICODE',
        severity: 'error',
        message: 'Server URL cannot contain unpaired Unicode surrogates',
        pointer: serverPointer,
      });
      return url;
    }
    try {
      const absolute = new URL(url);
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
        collector.add({
          code: 'OPENAPI.UNSUPPORTED_SERVER_PROTOCOL',
          severity: 'error',
          message: `Server URL protocol '${absolute.protocol}' is not executable by the HTTP runtime`,
          pointer: serverPointer,
        });
      }
      if (absolute.search !== '' || absolute.hash !== '') {
        collector.add({
          code: 'OPENAPI.SERVER_URL_COMPONENTS_UNSUPPORTED',
          severity: 'error',
          message: 'Server URL cannot contain a query string or fragment',
          pointer: serverPointer,
        });
      }
      return absolute.toString();
    } catch {
      // Relative URLs are valid in OpenAPI and may be resolved by the caller-provided base URL.
    }
    if (baseUrl === undefined) {
      collector.add({
        code: 'OPENAPI.RELATIVE_SERVER_URL',
        severity: 'warning',
        message: 'Relative server URL requires baseUrl before deterministic HTTP execution',
        pointer: serverPointer,
      });
      return url;
    }
    try {
      if (!isWellFormedUnicode(baseUrl)) {
        throw new TypeError('baseUrl cannot contain unpaired Unicode surrogates');
      }
      const parsedBase = new URL(baseUrl);
      if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
        throw new TypeError('baseUrl must use http or https');
      }
      const resolved = new URL(url, parsedBase);
      if (resolved.search !== '' || resolved.hash !== '') {
        collector.add({
          code: 'OPENAPI.SERVER_URL_COMPONENTS_UNSUPPORTED',
          severity: 'error',
          message: 'Resolved server URL cannot contain a query string or fragment',
          pointer: serverPointer,
        });
      }
      return resolved.toString();
    } catch (error) {
      collector.add({
        code: 'OPENAPI.INVALID_BASE_URL',
        severity: 'error',
        message: error instanceof Error ? error.message : 'baseUrl is invalid',
        pointer: serverPointer,
      });
      return url;
    }
  };
  if (rawServers === undefined) {
    return [
      {
        template: '/',
        resolvedUrl: resolveAgainstBase('/', pointer),
        variables: {},
        provenancePointer: pointer,
      },
    ];
  }
  if (!Array.isArray(rawServers) || rawServers.length === 0) {
    collector.add({
      code: 'OPENAPI.INVALID_SERVERS',
      severity: 'error',
      message: 'servers must be a non-empty array when provided',
      pointer,
    });
    return [
      {
        template: '/',
        resolvedUrl: resolveAgainstBase('/', pointer),
        variables: {},
        provenancePointer: pointer,
      },
    ];
  }

  const servers: ServerTarget[] = [];
  rawServers.forEach((rawServer, index) => {
    const serverPointer = `${pointer}/${index}`;
    const resolved = resolver.resolveShallow(rawServer, serverPointer);
    if (
      !isRecord(resolved) ||
      typeof resolved['url'] !== 'string' ||
      resolved['url'].length === 0
    ) {
      collector.add({
        code: 'OPENAPI.INVALID_SERVER',
        severity: 'error',
        message: 'Server requires a non-empty url',
        pointer: serverPointer,
      });
      return;
    }
    const template = resolved['url'];
    const variables: ServerTarget['variables'] = {};
    const rawVariables = resolved['variables'];
    let canResolve = isWellFormedUnicode(template);
    if (!canResolve) {
      collector.add({
        code: 'OPENAPI.INVALID_SERVER_UNICODE',
        severity: 'error',
        message: 'Server URL cannot contain unpaired Unicode surrogates',
        pointer: serverPointer,
      });
    }
    if (rawVariables !== undefined && !isRecord(rawVariables)) {
      collector.add({
        code: 'OPENAPI.INVALID_SERVER_VARIABLES',
        severity: 'error',
        message: 'Server variables must be an object',
        pointer: `${serverPointer}/variables`,
      });
      canResolve = false;
    } else if (isRecord(rawVariables)) {
      for (const variableName of Object.keys(rawVariables).sort()) {
        const variablePointer = `${serverPointer}/variables/${encodePointerSegment(variableName)}`;
        if (!isWellFormedUnicode(variableName)) {
          collector.add({
            code: 'OPENAPI.INVALID_SERVER_VARIABLE_UNICODE',
            severity: 'error',
            message: 'Server variable names cannot contain unpaired Unicode surrogates',
            pointer: variablePointer,
          });
          canResolve = false;
          continue;
        }
        const variable = resolver.resolveShallow(rawVariables[variableName], variablePointer);
        if (!isRecord(variable) || typeof variable['default'] !== 'string') {
          collector.add({
            code: 'OPENAPI.INVALID_SERVER_VARIABLE',
            severity: 'error',
            message: `Server variable '${variableName}' requires a string default`,
            pointer: variablePointer,
          });
          canResolve = false;
          continue;
        }
        if (!isWellFormedUnicode(variable['default'])) {
          collector.add({
            code: 'OPENAPI.INVALID_SERVER_VARIABLE_UNICODE',
            severity: 'error',
            message: `Server variable '${variableName}' default cannot contain unpaired Unicode surrogates`,
            pointer: `${variablePointer}/default`,
          });
          canResolve = false;
          continue;
        }
        const rawEnum = variable['enum'];
        const enumValues =
          Array.isArray(rawEnum) &&
          rawEnum.length > 0 &&
          rawEnum.every((entry) => typeof entry === 'string' && isWellFormedUnicode(entry))
            ? (rawEnum as string[])
            : undefined;
        if (rawEnum !== undefined && enumValues === undefined) {
          collector.add({
            code: 'OPENAPI.INVALID_SERVER_VARIABLE_ENUM',
            severity: 'warning',
            message: `Server variable '${variableName}' enum must contain only strings`,
            pointer: `${variablePointer}/enum`,
          });
        }
        if (enumValues !== undefined && !enumValues.includes(variable['default'])) {
          collector.add({
            code: 'OPENAPI.SERVER_VARIABLE_DEFAULT_OUTSIDE_ENUM',
            severity: 'error',
            message: `Server variable '${variableName}' default is outside its enum`,
            pointer: `${variablePointer}/default`,
          });
        }
        variables[variableName] = {
          default: variable['default'],
          ...(enumValues === undefined ? {} : { enum: enumValues }),
          ...(optionalString(variable['description']) === undefined
            ? {}
            : { description: optionalString(variable['description']) }),
        };
      }
    }

    const referencedVariables = [...template.matchAll(/\{([^{}]+)\}/g)].map(
      (match) => match[1] ?? '',
    );
    for (const variableName of referencedVariables) {
      if (!Object.hasOwn(variables, variableName)) {
        collector.add({
          code: 'OPENAPI.UNDEFINED_SERVER_VARIABLE',
          severity: 'error',
          message: `Server URL references undefined variable '${variableName}'`,
          pointer: serverPointer,
        });
        canResolve = false;
      }
    }
    const substitutedUrl = canResolve
      ? template.replace(/\{([^{}]+)\}/g, (_match, variableName: string) => {
          const value = variables[variableName]?.default;
          return value === undefined ? `{${variableName}}` : encodeURIComponent(value);
        })
      : undefined;
    const resolvedUrl =
      substitutedUrl === undefined ? undefined : resolveAgainstBase(substitutedUrl, serverPointer);
    servers.push({
      template,
      ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
      ...(optionalString(resolved['description']) === undefined
        ? {}
        : { description: optionalString(resolved['description']) }),
      variables,
      provenancePointer: serverPointer,
    });
  });

  return servers.length > 0
    ? servers
    : [
        {
          template: '/',
          resolvedUrl: resolveAgainstBase('/', pointer),
          variables: {},
          provenancePointer: pointer,
        },
      ];
}

function normalizeSecuritySchemes(
  root: Readonly<Record<string, unknown>>,
  resolver: ReferenceResolver,
  collector: DiagnosticCollector,
): Record<string, SecuritySchemeMetadata> {
  const components = root['components'];
  if (components === undefined) {
    return {};
  }
  if (!isRecord(components)) {
    collector.add({
      code: 'OPENAPI.INVALID_COMPONENTS',
      severity: 'error',
      message: 'components must be an object',
      pointer: '/components',
    });
    return {};
  }
  const rawSchemes = components['securitySchemes'];
  if (rawSchemes === undefined) {
    return {};
  }
  if (!isRecord(rawSchemes)) {
    collector.add({
      code: 'OPENAPI.INVALID_SECURITY_SCHEMES',
      severity: 'error',
      message: 'components.securitySchemes must be an object',
      pointer: '/components/securitySchemes',
    });
    return {};
  }

  const schemes: Record<string, SecuritySchemeMetadata> = {};
  for (const name of Object.keys(rawSchemes).sort()) {
    const schemePointer = `/components/securitySchemes/${encodePointerSegment(name)}`;
    const scheme = resolver.resolveShallow(rawSchemes[name], schemePointer);
    const schemeType = isRecord(scheme) ? SecuritySchemeTypeSchema.safeParse(scheme['type']) : null;
    if (!isRecord(scheme) || schemeType === null || !schemeType.success) {
      collector.add({
        code: 'OPENAPI.INVALID_SECURITY_SCHEME',
        severity: 'error',
        message: `Security scheme '${name}' requires a supported OpenAPI security type`,
        pointer: schemePointer,
      });
      continue;
    }
    const location = ['query', 'header', 'cookie'].includes(String(scheme['in']))
      ? (scheme['in'] as 'query' | 'header' | 'cookie')
      : undefined;
    const parameterName = optionalString(scheme['name']);
    if (
      schemeType.data === 'apiKey' &&
      location === 'query' &&
      parameterName !== undefined &&
      !isWellFormedUnicode(parameterName)
    ) {
      collector.add({
        code: 'OPENAPI.INVALID_SECURITY_PARAMETER_UNICODE',
        severity: 'error',
        message: 'Query apiKey parameter names cannot contain unpaired Unicode surrogates',
        pointer: `${schemePointer}/name`,
      });
    }
    const flows = isRecord(scheme['flows'])
      ? (Object.fromEntries(
          Object.entries(scheme['flows']).map(([flowName, flow]) => [
            flowName,
            isRecord(flow) ? (flow as JsonSchema) : ({} as JsonSchema),
          ]),
        ) as Record<string, JsonSchema>)
      : undefined;
    schemes[name] = {
      name,
      type: schemeType.data,
      ...(optionalString(scheme['description']) === undefined
        ? {}
        : { description: optionalString(scheme['description']) }),
      ...(location === undefined ? {} : { location }),
      ...(parameterName === undefined ? {} : { parameterName }),
      ...(optionalString(scheme['scheme']) === undefined
        ? {}
        : { scheme: optionalString(scheme['scheme']) }),
      ...(optionalString(scheme['bearerFormat']) === undefined
        ? {}
        : { bearerFormat: optionalString(scheme['bearerFormat']) }),
      ...(optionalString(scheme['openIdConnectUrl']) === undefined
        ? {}
        : { openIdConnectUrl: optionalString(scheme['openIdConnectUrl']) }),
      ...(flows === undefined ? {} : { oauthFlows: flows }),
      provenancePointer: schemePointer,
      ...(jsonExtensions(scheme) === undefined ? {} : { extensions: jsonExtensions(scheme) }),
    };
  }
  return schemes;
}

function normalizeAuth(
  rawSecurity: unknown,
  pointer: string,
  schemes: Record<string, SecuritySchemeMetadata>,
  collector: DiagnosticCollector,
): AuthMetadata {
  if (rawSecurity === undefined) {
    return { required: false, alternatives: [], schemes: {} };
  }
  if (!Array.isArray(rawSecurity)) {
    collector.add({
      code: 'OPENAPI.INVALID_SECURITY_REQUIREMENTS',
      severity: 'error',
      message: 'security must be an array',
      pointer,
    });
    return { required: false, alternatives: [], schemes: {} };
  }

  const alternatives: SecurityRequirement[] = [];
  rawSecurity.forEach((rawRequirement, requirementIndex) => {
    if (!isRecord(rawRequirement)) {
      collector.add({
        code: 'OPENAPI.INVALID_SECURITY_REQUIREMENT',
        severity: 'error',
        message: 'Each security requirement must be an object',
        pointer: `${pointer}/${requirementIndex}`,
      });
      return;
    }
    const requirement: SecurityRequirement = [];
    for (const schemeName of Object.keys(rawRequirement).sort()) {
      const rawScopes = rawRequirement[schemeName];
      if (!Array.isArray(rawScopes) || !rawScopes.every((scope) => typeof scope === 'string')) {
        collector.add({
          code: 'OPENAPI.INVALID_SECURITY_SCOPES',
          severity: 'error',
          message: `Security scopes for '${schemeName}' must be an array of strings`,
          pointer: `${pointer}/${requirementIndex}/${encodePointerSegment(schemeName)}`,
        });
        continue;
      }
      if (!Object.hasOwn(schemes, schemeName)) {
        collector.add({
          code: 'OPENAPI.UNKNOWN_SECURITY_SCHEME',
          severity: 'warning',
          message: `Security requirement references unknown scheme '${schemeName}'`,
          pointer: `${pointer}/${requirementIndex}/${encodePointerSegment(schemeName)}`,
        });
      }
      requirement.push({ scheme: schemeName, scopes: rawScopes as string[] });
    }
    alternatives.push(requirement);
  });
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
    required:
      alternatives.length > 0 && alternatives.every((alternative) => alternative.length > 0),
    alternatives,
    schemes: referencedSchemes,
  };
}

function parameterKey(location: ParameterBinding['location'], name: string): string {
  return `${location}:${location === 'header' ? name.toLowerCase() : name}`;
}

function normalizeParameters(
  rawParameters: unknown,
  pointer: string,
  resolver: ReferenceResolver,
  collector: DiagnosticCollector,
  normalizeSchema: JsonSchemaNormalizer,
): ParameterBinding[] {
  if (rawParameters === undefined) {
    return [];
  }
  if (!Array.isArray(rawParameters)) {
    collector.add({
      code: 'OPENAPI.INVALID_PARAMETERS',
      severity: 'error',
      message: 'parameters must be an array',
      pointer,
    });
    return [];
  }

  const parameters: ParameterBinding[] = [];
  rawParameters.forEach((rawParameter, index) => {
    const parameterPointer = `${pointer}/${index}`;
    const parameter = resolver.resolveShallow(rawParameter, parameterPointer);
    if (!isRecord(parameter) || typeof parameter['name'] !== 'string') {
      collector.add({
        code: 'OPENAPI.INVALID_PARAMETER',
        severity: 'error',
        message: 'Parameter requires a string name',
        pointer: parameterPointer,
      });
      return;
    }
    const rawLocation = parameter['in'];
    if (
      rawLocation !== 'path' &&
      rawLocation !== 'query' &&
      rawLocation !== 'header' &&
      rawLocation !== 'cookie'
    ) {
      collector.add({
        code: 'OPENAPI.UNSUPPORTED_PARAMETER_LOCATION',
        severity: 'warning',
        message: `Unsupported parameter location '${String(rawLocation)}'`,
        pointer: parameterPointer,
      });
      return;
    }
    const location = rawLocation;
    const parameterName = parameter['name'];
    if ((location === 'path' || location === 'query') && !isWellFormedUnicode(parameterName)) {
      collector.add({
        code: 'OPENAPI.INVALID_PARAMETER_UNICODE',
        severity: 'error',
        message: 'Path and query parameter names cannot contain unpaired Unicode surrogates',
        pointer: `${parameterPointer}/name`,
      });
      return;
    }
    let required = parameter['required'] === true;
    if (location === 'path' && !required) {
      collector.add({
        code: 'OPENAPI.PATH_PARAMETER_REQUIRED',
        severity: 'warning',
        message: `Path parameter '${parameterName}' was normalized to required`,
        pointer: parameterPointer,
      });
      required = true;
    }

    let schemaSource = parameter['schema'];
    let contentType: string | undefined;
    if (schemaSource === undefined && isRecord(parameter['content'])) {
      const firstContentType = Object.keys(parameter['content']).sort()[0];
      if (firstContentType !== undefined) {
        contentType = firstContentType;
        const media = parameter['content'][firstContentType];
        schemaSource = isRecord(media) ? media['schema'] : undefined;
      }
    }
    if (schemaSource === undefined) {
      collector.add({
        code: 'OPENAPI.PARAMETER_SCHEMA_MISSING',
        severity: 'warning',
        message: `Parameter '${parameterName}' has no schema; accepting any JSON value`,
        pointer: parameterPointer,
      });
      schemaSource = {};
    }
    parameters.push({
      location,
      name: parameterName,
      inputPath: [location, parameterName],
      required,
      ...(optionalString(parameter['description']) === undefined
        ? {}
        : { description: optionalString(parameter['description']) }),
      ...(typeof parameter['deprecated'] === 'boolean'
        ? { deprecated: parameter['deprecated'] }
        : {}),
      ...(optionalString(parameter['style']) === undefined
        ? {}
        : { style: optionalString(parameter['style']) }),
      ...(typeof parameter['explode'] === 'boolean' ? { explode: parameter['explode'] } : {}),
      ...(typeof parameter['allowReserved'] === 'boolean'
        ? { allowReserved: parameter['allowReserved'] }
        : {}),
      ...(contentType === undefined ? {} : { contentType }),
      schema: normalizeSchema(schemaSource, `${parameterPointer}/schema`),
      provenancePointer: parameterPointer,
    });
  });
  return parameters;
}

function mergeParameters(
  pathParameters: readonly ParameterBinding[],
  operationParameters: readonly ParameterBinding[],
): ParameterBinding[] {
  const merged = new Map<string, ParameterBinding>();
  for (const parameter of [...pathParameters, ...operationParameters]) {
    merged.set(parameterKey(parameter.location, parameter.name), parameter);
  }
  return [...merged.values()].sort((left, right) =>
    parameterKey(left.location, left.name).localeCompare(parameterKey(right.location, right.name)),
  );
}

function normalizeRequestBodies(
  rawBody: unknown,
  pointer: string,
  resolver: ReferenceResolver,
  collector: DiagnosticCollector,
  normalizeSchema: JsonSchemaNormalizer,
): RequestBodyBinding[] {
  if (rawBody === undefined) {
    return [];
  }
  const body = resolver.resolveShallow(rawBody, pointer);
  if (!isRecord(body) || !isRecord(body['content'])) {
    collector.add({
      code: 'OPENAPI.INVALID_REQUEST_BODY',
      severity: 'error',
      message: 'requestBody requires a content object',
      pointer,
    });
    return [];
  }
  const required = body['required'] === true;
  const bindings: RequestBodyBinding[] = [];
  for (const contentType of Object.keys(body['content']).sort()) {
    const mediaPointer = `${pointer}/content/${encodePointerSegment(contentType)}`;
    const media = resolver.resolveShallow(body['content'][contentType], mediaPointer);
    if (!isRecord(media)) {
      collector.add({
        code: 'OPENAPI.INVALID_MEDIA_TYPE',
        severity: 'error',
        message: `Request media type '${contentType}' must be an object`,
        pointer: mediaPointer,
      });
      continue;
    }
    if (media['encoding'] !== undefined) {
      collector.add({
        code: 'OPENAPI.REQUEST_BODY_ENCODING_UNSUPPORTED',
        severity: 'error',
        message:
          'Request media encoding cannot be represented by the current HTTP execution contract',
        pointer: `${mediaPointer}/encoding`,
        recoverable: false,
        details: { contentType },
      });
    }
    bindings.push({
      contentType,
      ...(/^(?:application|text)\/(?:[^;]+\+)?xml(?:\s*;|$)/i.test(contentType) ||
      /^application\/graphql(?:\s*;|$)/i.test(contentType)
        ? { serialization: 'text' as const }
        : {}),
      inputPath: ['body'],
      required,
      ...(optionalString(body['description']) === undefined
        ? {}
        : { description: optionalString(body['description']) }),
      schema: normalizeSchema(media['schema'] ?? {}, `${mediaPointer}/schema`),
      provenancePointer: mediaPointer,
    });
  }
  if (bindings.length <= 1) return bindings;
  return bindings.map((binding) => ({
    ...binding,
    contentTypeInputPath: ['bodyContentType'],
  }));
}

function normalizeSuccessResponses(
  rawResponses: unknown,
  pointer: string,
  resolver: ReferenceResolver,
  collector: DiagnosticCollector,
  normalizeSchema: JsonSchemaNormalizer,
): SuccessResponse[] {
  if (!isRecord(rawResponses)) {
    collector.add({
      code: 'OPENAPI.INVALID_RESPONSES',
      severity: 'error',
      message: 'Operation responses must be an object',
      pointer,
    });
    return [];
  }
  const successCodes = Object.keys(rawResponses)
    .filter((status) => /^2(?:\d{2}|XX)$/i.test(status))
    .sort();
  const selectedCodes = [
    ...successCodes,
    ...(Object.hasOwn(rawResponses, 'default') ? ['default'] : []),
  ];
  if (selectedCodes.length === 0) {
    collector.add({
      code: 'OPENAPI.SUCCESS_RESPONSE_MISSING',
      severity: 'error',
      message: 'Operation responses must declare at least one 2xx or default contract',
      pointer,
    });
    return [];
  }
  const responses: SuccessResponse[] = [];
  for (const statusCode of selectedCodes) {
    const responsePointer = `${pointer}/${encodePointerSegment(statusCode)}`;
    const response = resolver.resolveShallow(rawResponses[statusCode], responsePointer);
    if (!isRecord(response)) {
      collector.add({
        code: 'OPENAPI.INVALID_RESPONSE',
        severity: 'error',
        message: `Response '${statusCode}' must be an object`,
        pointer: responsePointer,
      });
      continue;
    }
    const description = optionalString(response['description']);
    if (!isRecord(response['content']) || Object.keys(response['content']).length === 0) {
      responses.push({
        statusCode,
        ...(description === undefined ? {} : { description }),
        provenancePointer: responsePointer,
      });
      continue;
    }
    for (const contentType of Object.keys(response['content']).sort()) {
      const mediaPointer = `${responsePointer}/content/${encodePointerSegment(contentType)}`;
      const media = resolver.resolveShallow(response['content'][contentType], mediaPointer);
      const schema =
        isRecord(media) && media['schema'] !== undefined
          ? normalizeSchema(media['schema'], `${mediaPointer}/schema`)
          : undefined;
      responses.push({
        statusCode,
        ...(description === undefined ? {} : { description }),
        contentType,
        ...(schema === undefined ? {} : { schema }),
        provenancePointer: mediaPointer,
      });
    }
  }
  return responses;
}

export function adaptOpenApi(
  source: OpenApiSource,
  options: OpenApiAdapterOptions = {},
): OpenApiAdapterResult {
  const parsed = parseOpenApi(source, options);
  if (parsed.hasErrors || parsed.document === null || parsed.format === null) {
    return { document: null, operations: [], diagnostics: parsed.diagnostics, hasErrors: true };
  }

  const root = parsed.document;
  const collector = new DiagnosticCollector(options.sourceUri);
  const openapiVersion = optionalString(root['openapi']);
  if (openapiVersion === undefined || !/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(openapiVersion)) {
    collector.add({
      code: 'OPENAPI.UNSUPPORTED_VERSION',
      severity: 'error',
      message: 'Only OpenAPI 3.x documents are supported',
      pointer: '/openapi',
      recoverable: false,
    });
  }
  const info = root['info'];
  const title = isRecord(info) ? optionalString(info['title']) : undefined;
  if (title === undefined) {
    collector.add({
      code: 'OPENAPI.MISSING_TITLE',
      severity: 'error',
      message: 'info.title is required',
      pointer: '/info/title',
      recoverable: false,
    });
  }
  if (openapiVersion === undefined || title === undefined) {
    const diagnostics = [...parsed.diagnostics, ...collector.all()];
    return { document: null, operations: [], diagnostics, hasErrors: true };
  }

  const sourceId =
    options.sourceId ?? stableId('source', options.sourceUri ?? title.normalize('NFKC'));
  const resolver = new ReferenceResolver(root, collector, {
    ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
    ...(options.maxRefDepth === undefined ? {} : { maxRefDepth: options.maxRefDepth }),
    ...(options.maxObjectDepth === undefined ? {} : { maxObjectDepth: options.maxObjectDepth }),
    ...(options.maxResolvedNodes === undefined
      ? {}
      : { maxResolvedNodes: options.maxResolvedNodes }),
    ...(options.externalRefResolver === undefined
      ? {}
      : { externalRefResolver: options.externalRefResolver }),
  });
  resolver.audit();
  const externalReferencesFingerprint = resolver.externalReferencesFingerprint();
  const documentFingerprint =
    externalReferencesFingerprint === undefined
      ? fingerprint(root)
      : fingerprint({ document: root, externalReferencesFingerprint });
  const normalizeSchema: JsonSchemaNormalizer = (value, pointer) =>
    toJsonSchema(value, resolver, pointer, openapiVersion, collector);

  const rootServers = normalizeServers(
    root['servers'],
    '/servers',
    resolver,
    collector,
    options.baseUrl,
  );
  const schemes = normalizeSecuritySchemes(root, resolver, collector);
  const rootSecurity = root['security'];
  const paths = root['paths'];
  if (!isRecord(paths)) {
    collector.add({
      code: 'OPENAPI.INVALID_PATHS',
      severity: 'error',
      message: 'paths must be an object',
      pointer: '/paths',
      recoverable: false,
    });
  }

  const operations: NormalizedOperation[] = [];
  if (isRecord(paths)) {
    for (const path of Object.keys(paths).sort()) {
      const pathPointer = `/paths/${encodePointerSegment(path)}`;
      const pathIssue = validateHttpOperationPath(path);
      if (pathIssue !== null) {
        collector.add({
          code: 'OPENAPI.INVALID_PATH_TEMPLATE',
          severity: 'error',
          message: `Path '${path}' is unsafe: ${pathIssue.message}`,
          pointer: pathPointer,
          recoverable: false,
          details: { reason: pathIssue.code },
        });
        continue;
      }
      const pathItem = resolver.resolveShallow(paths[path], pathPointer);
      if (!isRecord(pathItem)) {
        collector.add({
          code: 'OPENAPI.INVALID_PATH_ITEM',
          severity: 'error',
          message: `Path item '${path}' must be an object`,
          pointer: pathPointer,
        });
        continue;
      }
      const pathParameters = normalizeParameters(
        pathItem['parameters'],
        `${pathPointer}/parameters`,
        resolver,
        collector,
        normalizeSchema,
      );
      for (const methodKey of HTTP_METHODS) {
        if (pathItem[methodKey] === undefined) {
          continue;
        }
        const operationPointer = `${pathPointer}/${methodKey}`;
        const operationValue = resolver.resolveShallow(pathItem[methodKey], operationPointer);
        if (!isRecord(operationValue)) {
          collector.add({
            code: 'OPENAPI.INVALID_OPERATION',
            severity: 'error',
            message: `${methodKey.toUpperCase()} ${path} operation must be an object`,
            pointer: operationPointer,
          });
          continue;
        }
        const method = methodKey.toUpperCase() as NormalizedOperation['method'];
        const operationParameters = normalizeParameters(
          operationValue['parameters'],
          `${operationPointer}/parameters`,
          resolver,
          collector,
          normalizeSchema,
        );
        const parameters = mergeParameters(pathParameters, operationParameters);
        const placeholders = new Set(
          [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? ''),
        );
        for (const placeholder of placeholders) {
          if (
            !parameters.some(
              (parameter) => parameter.location === 'path' && parameter.name === placeholder,
            )
          ) {
            collector.add({
              code: 'OPENAPI.MISSING_PATH_PARAMETER',
              severity: 'error',
              message: `Path template variable '${placeholder}' has no matching path parameter`,
              pointer: operationPointer,
            });
          }
        }
        for (const parameter of parameters.filter(({ location }) => location === 'path')) {
          if (!placeholders.has(parameter.name)) {
            collector.add({
              code: 'OPENAPI.UNUSED_PATH_PARAMETER',
              severity: 'error',
              message: `Path parameter '${parameter.name}' is absent from the path template`,
              pointer: parameter.provenancePointer ?? operationPointer,
            });
          }
        }
        const requestBodies = normalizeRequestBodies(
          operationValue['requestBody'],
          `${operationPointer}/requestBody`,
          resolver,
          collector,
          normalizeSchema,
        );
        const successResponses = normalizeSuccessResponses(
          operationValue['responses'],
          `${operationPointer}/responses`,
          resolver,
          collector,
          normalizeSchema,
        );
        const servers =
          operationValue['servers'] === undefined
            ? rootServers
            : normalizeServers(
                operationValue['servers'],
                `${operationPointer}/servers`,
                resolver,
                collector,
                options.baseUrl,
              );
        const auth = normalizeAuth(
          operationValue['security'] ?? rootSecurity,
          operationValue['security'] === undefined ? '/security' : `${operationPointer}/security`,
          schemes,
          collector,
        );
        const operationId = optionalString(operationValue['operationId']);
        const provenance = {
          sourceKind: 'openapi',
          sourceId,
          ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
          documentFingerprint,
          pointer: operationPointer,
          ...(operationId === undefined ? {} : { operationId }),
        };
        const base = {
          id: stableId('operation', sourceId, method, path),
          ...(operationId === undefined ? {} : { operationId }),
          method,
          path,
          ...(optionalString(operationValue['summary']) === undefined
            ? {}
            : { summary: optionalString(operationValue['summary']) }),
          ...(optionalString(operationValue['description']) === undefined
            ? {}
            : { description: optionalString(operationValue['description']) }),
          tags: Array.isArray(operationValue['tags'])
            ? operationValue['tags'].filter((tag): tag is string => typeof tag === 'string')
            : [],
          deprecated: operationValue['deprecated'] === true,
          servers,
          parameters,
          requestBodies,
          successResponses,
          auth,
          provenance,
        };
        const parsedOperation = NormalizedOperationSchema.safeParse({
          ...base,
          fingerprint: fingerprint(base),
        });
        if (!parsedOperation.success) {
          collector.add({
            code: 'OPENAPI.NORMALIZATION_FAILED',
            severity: 'error',
            message: parsedOperation.error.message,
            pointer: operationPointer,
          });
          continue;
        }
        operations.push(parsedOperation.data);
      }
    }
  }

  const documentBase = {
    sourceId,
    ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
    sourceFormat: parsed.format,
    sourceKind: 'openapi',
    sourceVersion: openapiVersion,
    openapiVersion,
    title,
    ...(isRecord(info) && optionalString(info['version']) !== undefined
      ? { version: optionalString(info['version']) }
      : {}),
    ...(isRecord(info) && optionalString(info['description']) !== undefined
      ? { description: optionalString(info['description']) }
      : {}),
    documentFingerprint,
    servers: rootServers,
    securitySchemes: schemes,
    operations,
  };
  const parsedDocument = NormalizedApiDocumentSchema.safeParse(documentBase);
  let document: NormalizedApiDocument | null = null;
  if (!parsedDocument.success) {
    collector.add({
      code: 'OPENAPI.DOCUMENT_NORMALIZATION_FAILED',
      severity: 'error',
      message: parsedDocument.error.message,
      pointer: '',
      recoverable: false,
    });
  } else {
    document = parsedDocument.data;
  }

  const diagnostics: Diagnostic[] = [...parsed.diagnostics, ...collector.all()];
  return {
    document,
    operations,
    diagnostics,
    hasErrors: diagnostics.some(({ severity }) => severity === 'error'),
  };
}
