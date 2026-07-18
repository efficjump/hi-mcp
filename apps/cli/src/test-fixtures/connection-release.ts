import {
  CapabilitySchema,
  ReleaseSchema,
  fingerprint,
  stableId,
  type AuthMetadata,
  type Release,
  type SecuritySchemeMetadata,
} from '@hi-mcp/capability-ir';

export interface ConnectionReleaseFixtureOptions {
  readonly origin?: string;
  readonly required?: boolean;
  readonly alternatives?: AuthMetadata['alternatives'];
  readonly schemes?: Readonly<Record<string, SecuritySchemeMetadata>>;
}

const DEFAULT_SCHEMES: Readonly<Record<string, SecuritySchemeMetadata>> = {
  ApiKey: {
    name: 'ApiKey',
    type: 'apiKey',
    location: 'header',
    parameterName: 'X-API-Key',
  },
  BearerAuth: {
    name: 'BearerAuth',
    type: 'http',
    scheme: 'bearer',
  },
  QueryKey: {
    name: 'QueryKey',
    type: 'apiKey',
    location: 'query',
    parameterName: 'access_key',
  },
};

export function exampleReleaseForConnectionTest(
  options: ConnectionReleaseFixtureOptions = {},
): Release {
  const origin = options.origin ?? 'https://api.example.com';
  const documentFingerprint = fingerprint({ fixture: 'connection-profile' });
  const schemes = structuredClone(options.schemes ?? DEFAULT_SCHEMES);
  const alternatives = structuredClone(
    options.alternatives ?? [
      [{ scheme: 'ApiKey', scopes: [] }],
      [{ scheme: 'BearerAuth', scopes: [] }],
    ],
  );
  const capabilityMaterial = {
    schemaVersion: '1.0' as const,
    id: stableId('capability', 'GET', '/items'),
    name: 'listItems',
    title: 'List items',
    description: 'Returns items from an example API.',
    intent: {
      useWhen: ['Items are needed.'],
      avoidWhen: [],
      examples: [],
      tags: ['items'],
    },
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    auth: {
      required: options.required ?? true,
      alternatives,
      schemes,
    },
    risk: {
      level: 'read' as const,
      sideEffect: 'none' as const,
      idempotency: 'idempotent' as const,
      requiresConfirmation: false,
      rationale: [],
    },
    execution: {
      kind: 'http' as const,
      method: 'GET' as const,
      pathTemplate: '/items',
      servers: [{ template: origin, resolvedUrl: new URL(origin).toString() }],
      parameterBindings: [],
      requestBodies: [],
      successResponses: [
        {
          statusCode: '200',
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      ],
    },
    provenance: {
      sourceKind: 'http-manifest',
      sourceId: 'fixture',
      documentFingerprint,
      pointer: '/operations/0',
      operationId: 'listItems',
    },
  };
  const capabilityWithPlaceholder = CapabilitySchema.parse({
    ...capabilityMaterial,
    fingerprint: fingerprint({ placeholder: true }),
  });
  const { fingerprint: _placeholder, ...material } = capabilityWithPlaceholder;
  const capability = CapabilitySchema.parse({
    ...material,
    fingerprint: fingerprint(material),
  });
  const releaseMaterial = {
    schemaVersion: '1.0' as const,
    sequence: 0,
    compiler: { name: '@hi-mcp/cli', version: 'test' },
    sources: [
      {
        sourceId: 'fixture',
        sourceKind: 'http-manifest-1.0',
        fingerprint: documentFingerprint,
      },
    ],
    capabilities: [capability],
    diagnostics: [],
  };
  const releaseFingerprint = fingerprint(releaseMaterial);
  return ReleaseSchema.parse({
    ...releaseMaterial,
    id: stableId('release', releaseFingerprint),
    createdAt: '2026-07-14T00:00:00.000Z',
    fingerprint: releaseFingerprint,
  });
}
