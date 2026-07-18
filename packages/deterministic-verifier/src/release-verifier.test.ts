import {
  CapabilitySchema,
  DiagnosticSchema,
  NormalizedApiDocumentSchema,
  NormalizedOperationSchema,
  ReleaseSchema,
  WELL_FORMED_UNICODE_PATTERN,
  fingerprint,
  shallowParameterTextWireSchema,
  stableId,
  type Capability,
  type Diagnostic,
  type NormalizedApiDocument,
  type Release,
} from '@hi-mcp/capability-ir';
import { describe, expect, it } from 'vitest';

import { verifyRelease } from './release-verifier.js';

function capabilityFixture(): Capability {
  const content = {
    schemaVersion: '1.0' as const,
    id: 'get_item',
    name: 'getItem',
    description: 'Gets one item by identifier.',
    intent: { useWhen: [], avoidWhen: [], examples: [], tags: ['items'] },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['itemId'],
      properties: {
        itemId: {
          allOf: [{ type: 'string' }, shallowParameterTextWireSchema(WELL_FORMED_UNICODE_PATTERN)],
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
    },
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
      pathTemplate: '/items/{itemId}',
      servers: [
        {
          template: 'https://api.example.test',
          resolvedUrl: 'https://api.example.test/',
          variables: {},
        },
      ],
      parameterBindings: [
        {
          location: 'path' as const,
          name: 'itemId',
          inputPath: ['itemId'],
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBodies: [],
      successResponses: [
        {
          statusCode: '200',
          contentType: 'application/json',
          schema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
    },
    provenance: {
      sourceKind: 'openapi',
      sourceId: 'fixture',
      documentFingerprint: fingerprint({ fixture: 'source' }),
      pointer: '/paths/~1items~1{itemId}/get',
      operationId: 'getItem',
    },
  };
  return { ...content, fingerprint: fingerprint(content) };
}

function sourceDocumentFixture(capability: Capability): NormalizedApiDocument {
  const operationContent = {
    id: capability.id,
    operationId: capability.provenance.operationId,
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
    ...operationContent,
    fingerprint: fingerprint(operationContent),
  });
  return NormalizedApiDocumentSchema.parse({
    sourceId: capability.provenance.sourceId,
    sourceFormat: 'object',
    sourceKind: 'openapi',
    sourceVersion: '3.1.0',
    openapiVersion: '3.1.0',
    title: 'Fixture API',
    documentFingerprint: capability.provenance.documentFingerprint,
    servers: capability.execution.servers,
    securitySchemes: {},
    operations: [operation],
  });
}

function releaseFixture(
  capabilities: readonly Capability[] = [capabilityFixture()],
  diagnostics: readonly Diagnostic[] = [],
): Release {
  const sources = [
    ...new Map(
      capabilities.map((capability) => [
        `${capability.provenance.sourceId}\0${capability.provenance.documentFingerprint}`,
        {
          sourceId: capability.provenance.sourceId,
          sourceKind: `${capability.provenance.sourceKind}-3.1.0`,
          fingerprint: capability.provenance.documentFingerprint,
        },
      ]),
    ).values(),
  ];
  const material = {
    schemaVersion: '1.0' as const,
    sequence: 0,
    compiler: { name: 'fixture', version: '1.0.0' },
    sources,
    capabilities,
    diagnostics,
  };
  const releaseFingerprint = fingerprint(material);
  return ReleaseSchema.parse({
    ...material,
    id: stableId('release', releaseFingerprint),
    createdAt: '2026-07-14T00:00:00.000Z',
    fingerprint: releaseFingerprint,
  });
}

describe('verifyRelease', () => {
  it('accepts a canonical release only after verifying every capability', () => {
    const result = verifyRelease(releaseFixture());

    expect(result.valid).toBe(true);
    expect(result.capabilities).toHaveLength(1);
    expect(result.capabilities[0]?.result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a tampered endpoint even when the envelope remains structurally valid', () => {
    const original = releaseFixture();
    const changedCapability = {
      ...original.capabilities[0]!,
      execution: {
        ...original.capabilities[0]!.execution,
        servers: [
          {
            template: 'https://attacker.example.test',
            resolvedUrl: 'https://attacker.example.test/',
            variables: {},
          },
        ],
      },
    };
    const tampered = { ...original, capabilities: [changedCapability] };

    const result = verifyRelease(tampered);

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(['RELEASE.FINGERPRINT_MISMATCH', 'IR.FINGERPRINT_MISMATCH']),
    );
  });

  it('grounds a fully refingerprinted endpoint against an optional source document', () => {
    const original = capabilityFixture();
    const sourceDocument = sourceDocumentFixture(original);
    const { fingerprint: _fingerprint, ...content } = original;
    const changedContent = {
      ...content,
      execution: {
        ...content.execution,
        servers: [
          {
            template: 'https://attacker.example.test',
            resolvedUrl: 'https://attacker.example.test/',
            variables: {},
          },
        ],
      },
    };
    const changed = CapabilitySchema.parse({
      ...changedContent,
      fingerprint: fingerprint(changedContent),
    });
    const canonicalTamperedRelease = releaseFixture([changed]);

    const result = verifyRelease(canonicalTamperedRelease, {
      sourceDocuments: [sourceDocument],
    });

    expect(result.errors.map((item) => item.code)).toContain('SOURCE.SERVER_MISMATCH');
    expect(result.errors.map((item) => item.code)).not.toEqual(
      expect.arrayContaining(['RELEASE.FINGERPRINT_MISMATCH', 'IR.FINGERPRINT_MISMATCH']),
    );
  });

  it('rejects fully refingerprinted capability provenance that does not match its source operation', () => {
    const original = capabilityFixture();
    const source = sourceDocumentFixture(original);
    const { fingerprint: _fingerprint, ...material } = original;
    const forgedMaterial = {
      ...material,
      provenance: {
        ...material.provenance,
        pointer: '/paths/~1forged/get',
      },
    };
    const forged = CapabilitySchema.parse({
      ...forgedMaterial,
      fingerprint: fingerprint(forgedMaterial),
    });

    const result = verifyRelease(releaseFixture([forged]), { sourceDocuments: [source] });

    expect(result.errors.map(({ code }) => code)).toContain('SOURCE.PROVENANCE_MISMATCH');
    expect(result.errors.map(({ code }) => code)).not.toContain('IR.FINGERPRINT_MISMATCH');
  });

  it('requires an exact source operation id even when provenance points to an existing operation', () => {
    const original = capabilityFixture();
    const source = sourceDocumentFixture(original);
    const { fingerprint: _fingerprint, ...material } = original;
    const reboundMaterial = {
      ...material,
      id: 'get_item_rebound',
    };
    const rebound = CapabilitySchema.parse({
      ...reboundMaterial,
      fingerprint: fingerprint(reboundMaterial),
    });

    const result = verifyRelease(releaseFixture([rebound]), { sourceDocuments: [source] });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RELEASE.SOURCE_OPERATION_ID_MISMATCH',
          details: expect.objectContaining({
            capabilityId: rebound.id,
            sourceOperationId: original.id,
          }),
        }),
      ]),
    );
    expect(result.errors.map(({ code }) => code)).not.toContain('IR.FINGERPRINT_MISMATCH');
  });

  it('grounds authoritative source risk metadata instead of trusting a refingerprinted downgrade', () => {
    const capability = capabilityFixture();
    const source = sourceDocumentFixture(capability);
    const sourceOperation = source.operations[0]!;
    const { fingerprint: _operationFingerprint, ...operationMaterial } = sourceOperation;
    const operationWithRiskMaterial = {
      ...operationMaterial,
      risk: {
        level: 'write' as const,
        sideEffect: 'definite' as const,
        idempotency: 'non-idempotent' as const,
        requiresConfirmation: true,
        rationale: ['The upstream GET advances a server cursor.'],
      },
    };
    const operationWithRisk = NormalizedOperationSchema.parse({
      ...operationWithRiskMaterial,
      fingerprint: fingerprint(operationWithRiskMaterial),
    });
    const authoritativeSource = NormalizedApiDocumentSchema.parse({
      ...source,
      operations: [operationWithRisk],
    });

    const result = verifyRelease(releaseFixture([capability]), {
      sourceDocuments: [authoritativeSource],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code }) => code)).toContain('SOURCE.RISK_MISMATCH');
  });

  it('rejects supplied source operations whose provenance escapes the containing document', () => {
    const capability = capabilityFixture();
    const source = sourceDocumentFixture(capability);
    const originalOperation = source.operations[0]!;
    const { fingerprint: _fingerprint, ...operationMaterial } = originalOperation;
    const escapedMaterial = {
      ...operationMaterial,
      provenance: {
        ...operationMaterial.provenance,
        sourceKind: 'http-manifest',
        sourceId: 'another-source',
        documentFingerprint: fingerprint({ another: 'document' }),
      },
    };
    const escapedOperation = NormalizedOperationSchema.parse({
      ...escapedMaterial,
      fingerprint: fingerprint(escapedMaterial),
    });
    const escapedSource = NormalizedApiDocumentSchema.parse({
      ...source,
      operations: [escapedOperation],
    });

    const result = verifyRelease(releaseFixture([capability]), {
      sourceDocuments: [escapedSource],
    });

    expect(
      result.errors.filter(({ code }) => code === 'RELEASE.SOURCE_OPERATION_PROVENANCE_MISMATCH'),
    ).toHaveLength(3);
  });

  it('recomputes every supplied normalized operation fingerprint', () => {
    const capability = capabilityFixture();
    const source = sourceDocumentFixture(capability);
    const staleSource = NormalizedApiDocumentSchema.parse({
      ...source,
      operations: [
        {
          ...source.operations[0]!,
          description: 'Changed after the normalized operation was fingerprinted.',
        },
      ],
    });

    const result = verifyRelease(releaseFixture([capability]), {
      sourceDocuments: [staleSource],
    });

    expect(result.errors.map(({ code }) => code)).toContain(
      'RELEASE.SOURCE_OPERATION_FINGERPRINT_MISMATCH',
    );
  });

  it('grounds release source kind and version against each supplied document', () => {
    const capability = capabilityFixture();
    const source = sourceDocumentFixture(capability);
    const wrongVersionSource = NormalizedApiDocumentSchema.parse({
      ...source,
      sourceVersion: '3.0.0',
      openapiVersion: '3.0.0',
    });

    const result = verifyRelease(releaseFixture([capability]), {
      sourceDocuments: [wrongVersionSource],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RELEASE.SOURCE_KIND_MISMATCH',
          details: expect.objectContaining({ expectedSourceKind: 'openapi-3.0.0' }),
        }),
      ]),
    );
  });

  it('requires every recorded source when source-grounded verification is requested', () => {
    const first = capabilityFixture();
    const { fingerprint: _firstFingerprint, ...firstMaterial } = first;
    const secondMaterial = {
      ...structuredClone(firstMaterial),
      id: 'get_other_item',
      name: 'getOtherItem',
      provenance: {
        ...first.provenance,
        sourceId: 'fixture-b',
        documentFingerprint: fingerprint({ fixture: 'source-b' }),
        pointer: '/paths/~1other-items~1{itemId}/get',
      },
    };
    const second = CapabilitySchema.parse({
      ...secondMaterial,
      fingerprint: fingerprint(secondMaterial),
    });

    const result = verifyRelease(releaseFixture([first, second]), {
      sourceDocuments: [sourceDocumentFixture(first)],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RELEASE.SOURCE_DOCUMENT_MISSING',
          details: expect.objectContaining({ sourceId: 'fixture-b' }),
        }),
      ]),
    );
  });

  it('rejects tampered risk metadata and the resulting unsafe contract', () => {
    const original = releaseFixture();
    const changedCapability = {
      ...original.capabilities[0]!,
      risk: {
        level: 'destructive' as const,
        sideEffect: 'definite' as const,
        idempotency: 'idempotent' as const,
        requiresConfirmation: false,
        rationale: [],
      },
    };

    const result = verifyRelease({ ...original, capabilities: [changedCapability] });

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'RELEASE.FINGERPRINT_MISMATCH',
        'IR.FINGERPRINT_MISMATCH',
        'RISK.DESTRUCTIVE_WITHOUT_CONFIRMATION',
      ]),
    );
  });

  it('rejects tampered release material and a non-canonical release id', () => {
    const original = releaseFixture();

    const changedMaterial = verifyRelease({
      ...original,
      compiler: { name: 'fixture', version: '9.9.9' },
    });
    const changedId = verifyRelease({ ...original, id: stableId('release', 'unrelated') });

    expect(changedMaterial.errors.map((item) => item.code)).toContain(
      'RELEASE.FINGERPRINT_MISMATCH',
    );
    expect(changedId.errors.map((item) => item.code)).toContain('RELEASE.ID_MISMATCH');
  });

  it('rejects fingerprint-shaped prefixes without a complete lowercase SHA-256 digest', () => {
    const result = verifyRelease({
      ...releaseFixture(),
      fingerprint: 'sha256:not-a-digest',
    });

    expect(result.errors.map(({ code }) => code)).toEqual(['RELEASE.INVALID_SCHEMA']);
  });

  it('preflights the release envelope before recursive Zod parsing', () => {
    let deep: unknown = true;
    for (let index = 0; index < 128; index += 1) deep = { next: deep };
    const input = { ...releaseFixture(), extensions: { deep } };

    const result = verifyRelease(input, { inputLimits: { maxDepth: 32 } });

    expect(result.valid).toBe(false);
    expect(result.capabilities).toEqual([]);
    expect(result.errors.map((item) => item.code)).toEqual(['RELEASE.INPUT_LIMIT_EXCEEDED']);
  });

  it('rejects duplicate capability ids and MCP tool names', () => {
    const duplicate = capabilityFixture();
    const release = releaseFixture([duplicate, duplicate]);

    const result = verifyRelease(release);

    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(['RELEASE.DUPLICATE_CAPABILITY_ID', 'RELEASE.DUPLICATE_TOOL_NAME']),
    );
  });

  it('rejects releases that embed error diagnostics', () => {
    const embedded = DiagnosticSchema.parse({
      code: 'SOURCE.INVALID',
      severity: 'error',
      message: 'The source could not be compiled safely.',
      related: [],
      recoverable: false,
    });

    const result = verifyRelease(releaseFixture(undefined, [embedded]));

    expect(result.errors.map((item) => item.code)).toContain('RELEASE.CONTAINS_ERROR_DIAGNOSTICS');
  });
});
