import { describe, expect, it } from 'vitest';

import {
  CapabilitySchema,
  CANONICAL_PADDED_BASE64_PATTERN,
  DiagnosticSchema,
  FingerprintSchema,
  HttpMediaTypeSchema,
  HttpOperationPathSchema,
  HTTP_HEADER_VALUE_PATTERN,
  InputPathSchema,
  NormalizedApiDocumentSchema,
  NormalizedOperationSchema,
  ParameterBindingSchema,
  ReleaseSchema,
  SecuritySchemeMetadataSchema,
  ServerTargetSchema,
  fingerprint,
  isCanonicalPaddedBase64,
  isHttpFieldName,
  isHttpHeaderValue,
  isTransportControlledCredentialHeader,
  isWellFormedUnicode,
  stableId,
  validateHttpOperationPath,
  WELL_FORMED_UNICODE_PATTERN,
  type Capability,
} from '../src/index.js';

function capabilityFixture(): Capability {
  const sourceFingerprint = fingerprint({ openapi: '3.1.0' });
  const capability = {
    schemaVersion: '1.0' as const,
    id: stableId('capability', 'listPets'),
    name: 'list_pets',
    description: 'Lists pets visible to the caller.',
    intent: { useWhen: [], avoidWhen: [], examples: [], tags: ['pets'] },
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'array', items: { type: 'object' } },
    auth: { required: false, alternatives: [], schemes: {} },
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
      pathTemplate: '/pets',
      servers: [{ template: 'https://api.example.test', variables: {} }],
      parameterBindings: [],
      requestBodies: [],
      successResponses: [{ statusCode: '200', contentType: 'application/json' }],
    },
    provenance: {
      sourceKind: 'openapi',
      sourceId: 'fixture',
      documentFingerprint: sourceFingerprint,
      pointer: '/paths/~1pets/get',
      operationId: 'listPets',
    },
    fingerprint: fingerprint({ operationId: 'listPets' }),
  };
  return CapabilitySchema.parse(capability);
}

describe('canonical IR schemas', () => {
  it('validates a complete HTTP capability', () => {
    expect(CapabilitySchema.parse(capabilityFixture()).name).toBe('list_pets');
  });

  it('enforces required path parameters', () => {
    const fixture = capabilityFixture();
    fixture.execution.parameterBindings.push({
      location: 'path',
      name: 'petId',
      inputPath: ['path', 'petId'],
      required: false,
      schema: { type: 'string' },
    });

    expect(CapabilitySchema.safeParse(fixture).success).toBe(false);
  });

  it('accepts canonical HTTP extension methods and rejects non-token spellings', () => {
    const extension = capabilityFixture();
    extension.execution.method = 'PROPFIND';
    expect(CapabilitySchema.safeParse(extension).success).toBe(true);

    for (const invalid of ['propfind', 'BAD METHOD', 'GET\r\n']) {
      const fixture = capabilityFixture();
      fixture.execution.method = invalid;
      expect(CapabilitySchema.safeParse(fixture).success).toBe(false);
    }
  });

  it('accepts canonical Unicode paths and rejects paths that change across decoders', () => {
    for (const valid of [
      '/pets/{petId}',
      '/caf%C3%A9/%ED%95%9C%EA%B8%80',
      '/café/한글',
      '/literal%25/encoded-question%3F',
    ]) {
      expect(HttpOperationPathSchema.safeParse(valid).success).toBe(true);
      expect(validateHttpOperationPath(valid)).toBeNull();
    }

    const unsafe = [
      'relative/path',
      '/control\u0000value',
      '/delete\u007fvalue',
      '/query?fixed=true',
      '/fragment#section',
      '/windows\\path',
      '/bad%',
      '/bad%2',
      '/bad%GG',
      '/bad%FF',
      '/./admin',
      '/../admin',
      '/%2e%2e/admin',
      '/%252e%252e/admin',
      '/encoded%2Fseparator',
      '/encoded%255Cseparator',
      '/literal-percent%25%252Fseparator',
      '/literal-percent%25%255Cseparator',
      `/items/${String.fromCharCode(0xd800)}`,
    ];
    for (const path of unsafe) {
      expect(HttpOperationPathSchema.safeParse(path).success, path).toBe(false);
      expect(validateHttpOperationPath(path), path).not.toBeNull();
    }
  });

  it('rejects unpaired Unicode in static wire names and server targets', () => {
    const unpaired = String.fromCharCode(0xd800);
    expect(
      ParameterBindingSchema.safeParse({
        location: 'query',
        name: unpaired,
        inputPath: ['value'],
        required: false,
        schema: { type: 'string' },
      }).success,
    ).toBe(false);
    expect(
      SecuritySchemeMetadataSchema.safeParse({
        name: 'key',
        type: 'apiKey',
        location: 'query',
        parameterName: unpaired,
      }).success,
    ).toBe(false);
    expect(
      ServerTargetSchema.safeParse({
        template: `https://api.example.test/${unpaired}`,
        variables: {},
      }).success,
    ).toBe(false);
  });

  it('shares exact text predicates with JSON Schema wire patterns', () => {
    const unicodePattern = new RegExp(WELL_FORMED_UNICODE_PATTERN, 'u');
    const headerPattern = new RegExp(HTTP_HEADER_VALUE_PATTERN, 'u');
    const samples = [
      '',
      'plain text',
      'café',
      '한글',
      'emoji 😀',
      'nul\u0000',
      'line\nfeed',
      'internal\t whitespace',
      ' leading',
      'trailing\t',
      '\t',
      '\ud800',
      '\udc00',
    ];

    for (const sample of samples) {
      expect(unicodePattern.test(sample), sample).toBe(isWellFormedUnicode(sample));
      expect(headerPattern.test(sample), sample).toBe(isHttpHeaderValue(sample));
    }
    expect(isHttpHeaderValue('opaque\t token')).toBe(true);
    expect(isHttpHeaderValue(' opaque-token')).toBe(false);
    expect(isHttpHeaderValue('opaque-token\t')).toBe(false);
  });

  it('shares HTTP token and transport-controlled credential header predicates', () => {
    expect(isHttpFieldName('X-API-Key')).toBe(true);
    expect(isHttpFieldName('Bad Header')).toBe(false);
    expect(isTransportControlledCredentialHeader('HOST')).toBe(true);
    expect(isTransportControlledCredentialHeader('Authorization')).toBe(false);
  });

  it('validates immutable release-shaped manifests', () => {
    const capability = capabilityFixture();
    const sourceFingerprint = capability.provenance.documentFingerprint;
    const release = {
      schemaVersion: '1.0',
      id: stableId('release', sourceFingerprint),
      sequence: 0,
      createdAt: '2026-07-14T00:00:00+09:00',
      compiler: { name: 'himcp', version: '0.1.0' },
      sources: [
        {
          sourceId: 'fixture',
          sourceKind: 'openapi',
          fingerprint: sourceFingerprint,
        },
      ],
      capabilities: [capability],
      diagnostics: [],
      fingerprint: fingerprint({ sourceFingerprint, capabilities: [capability.fingerprint] }),
    };

    expect(ReleaseSchema.parse(release).capabilities).toHaveLength(1);
  });

  it('requires machine-readable diagnostic codes', () => {
    expect(
      DiagnosticSchema.safeParse({
        code: 'unsafe ref',
        severity: 'error',
        message: 'External reference rejected',
      }).success,
    ).toBe(false);
  });

  it('accepts only canonical SHA-256 fingerprint strings', () => {
    expect(FingerprintSchema.safeParse(fingerprint({ canonical: true })).success).toBe(true);
    for (const invalid of [
      'sha256:',
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'A'.repeat(64)}`,
      `sha512:${'a'.repeat(64)}`,
      `sha256:${'g'.repeat(64)}`,
    ]) {
      expect(FingerprintSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('enforces type-specific security scheme metadata completeness', () => {
    const valid = [
      { name: 'key', type: 'apiKey', location: 'header', parameterName: 'X-API-Key' },
      { name: 'bearer', type: 'http', scheme: 'bearer' },
      { name: 'mtls', type: 'mutualTLS' },
      { name: 'oauth', type: 'oauth2', oauthFlows: { clientCredentials: {} } },
      {
        name: 'oidc',
        type: 'openIdConnect',
        openIdConnectUrl: 'https://issuer.example.test/.well-known/openid-configuration',
      },
    ];
    for (const scheme of valid) {
      expect(SecuritySchemeMetadataSchema.safeParse(scheme).success).toBe(true);
    }

    const invalid = [
      { name: 'key-without-location', type: 'apiKey', parameterName: 'X-API-Key' },
      { name: 'key-without-name', type: 'apiKey', location: 'header' },
      { name: 'http-without-scheme', type: 'http' },
      { name: 'oauth-without-flows', type: 'oauth2' },
      { name: 'oidc-without-url', type: 'openIdConnect' },
      { name: 'relative-oidc', type: 'openIdConnect', openIdConnectUrl: '/discovery' },
      {
        name: 'invalid-header-key',
        type: 'apiKey',
        location: 'header',
        parameterName: 'Bad Header',
      },
      {
        name: 'transport-header-key',
        type: 'apiKey',
        location: 'header',
        parameterName: 'Host',
      },
      {
        name: 'invalid-cookie-key',
        type: 'apiKey',
        location: 'cookie',
        parameterName: 'bad;name',
      },
      { name: 'unsupported', type: 'custom' },
    ];
    for (const scheme of invalid) {
      expect(SecuritySchemeMetadataSchema.safeParse(scheme).success).toBe(false);
    }
  });

  it('rejects prototype-sensitive binding and credential path material', () => {
    for (const unsafe of ['__proto__', 'prototype', 'constructor']) {
      expect(InputPathSchema.safeParse(['input', unsafe]).success).toBe(false);
      expect(
        SecuritySchemeMetadataSchema.safeParse({
          name: 'key',
          type: 'apiKey',
          location: 'query',
          parameterName: unsafe,
        }).success,
      ).toBe(false);
    }
    expect(InputPathSchema.safeParse(['input', 'constructorId']).success).toBe(true);
  });

  it('accepts valid parameterized HTTP media types and rejects malformed or injected values', () => {
    for (const valid of [
      'application/json',
      'application/vnd.example+json; charset=utf-8',
      'text/plain; profile="human readable"',
      'application/*+json',
      '*/*',
    ]) {
      expect(HttpMediaTypeSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      'text/',
      '/plain',
      'application/json; charset',
      'application/json; charset="unterminated',
      'text/plain\r\nx-injected: yes',
      ' application/json',
    ]) {
      expect(HttpMediaTypeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('shares one exact canonical padded base64 contract across schema and runtime validation', () => {
    expect(CANONICAL_PADDED_BASE64_PATTERN).toMatch(/^\^/);
    expect(new RegExp(CANONICAL_PADDED_BASE64_PATTERN).test('aGVsbG8=\n')).toBe(false);
    expect(isCanonicalPaddedBase64('aGVsbG8=')).toBe(true);
    expect(isCanonicalPaddedBase64('d29ybGQ')).toBe(false);
    expect(isCanonicalPaddedBase64('AB==')).toBe(false);
    expect(isCanonicalPaddedBase64('aGVsbG8=\n')).toBe(false);
  });

  it('allows only 2xx or default contracts in the success response collection', () => {
    const fixture = capabilityFixture();
    fixture.execution.successResponses[0]!.statusCode = '404';

    expect(CapabilitySchema.safeParse(fixture).success).toBe(false);
  });

  it('rejects normalized bindings whose input paths overlap by prefix', () => {
    const provenance = {
      sourceKind: 'http-manifest',
      sourceId: 'fixture',
      documentFingerprint: fingerprint({ fixture: 'document' }),
      pointer: '/operations/0',
    };
    const base = {
      id: stableId('operation', 'fixture'),
      operationId: 'sendPayload',
      method: 'POST' as const,
      path: '/payload',
      servers: [{ template: 'https://api.example.test', variables: {} }],
      parameters: [
        {
          location: 'header' as const,
          name: 'X-Payload',
          inputPath: ['payload'],
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBodies: [
        {
          contentType: 'application/json',
          inputPath: ['payload', 'child'],
          required: true,
          schema: { type: 'object' },
        },
      ],
      successResponses: [{ statusCode: '204' }],
      auth: { required: false, alternatives: [], schemes: {} },
      provenance,
    };

    expect(
      NormalizedOperationSchema.safeParse({ ...base, fingerprint: fingerprint(base) }).success,
    ).toBe(false);
  });

  it('rejects duplicate normalized operation ids at the document boundary', () => {
    const capability = capabilityFixture();
    const operationMaterial = {
      id: stableId('operation', 'fixture', 'listPets'),
      operationId: 'listPets',
      method: capability.execution.method,
      path: capability.execution.pathTemplate,
      description: capability.description,
      tags: capability.intent.tags,
      deprecated: false,
      servers: capability.execution.servers,
      parameters: capability.execution.parameterBindings,
      requestBodies: capability.execution.requestBodies,
      successResponses: capability.execution.successResponses,
      auth: capability.auth,
      provenance: capability.provenance,
    };
    const operation = NormalizedOperationSchema.parse({
      ...operationMaterial,
      fingerprint: fingerprint(operationMaterial),
    });
    const result = NormalizedApiDocumentSchema.safeParse({
      sourceId: capability.provenance.sourceId,
      sourceFormat: 'object',
      sourceKind: 'openapi',
      sourceVersion: '3.1.0',
      openapiVersion: '3.1.0',
      title: 'Duplicate operation fixture',
      documentFingerprint: capability.provenance.documentFingerprint,
      servers: capability.execution.servers,
      securitySchemes: {},
      operations: [operation, operation],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected duplicate operation IDs to be rejected.');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['operations', 1, 'id'],
          message: expect.stringContaining(operation.id),
        }),
      ]),
    );
  });
});
