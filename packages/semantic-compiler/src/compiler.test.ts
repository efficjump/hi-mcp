import {
  CANONICAL_PADDED_BASE64_PATTERN,
  HTTP_HEADER_VALUE_PATTERN,
  NormalizedOperationSchema,
  WELL_FORMED_UNICODE_PATTERN,
  canonicalStringify,
  fingerprint,
  type Capability,
  type NormalizedOperation,
} from '@hi-mcp/capability-ir';
import { verifyCapability } from '@hi-mcp/deterministic-verifier';
import { adaptOpenApi } from '@hi-mcp/openapi-adapter';
import { describe, expect, it } from 'vitest';

import { DeterministicBaselineCompiler } from './baseline.js';
import { SemanticModelRouter, type SemanticModelProvider } from './model-provider.js';
import { SemanticProposalSchema, SemanticProposalConflictError } from './proposal.js';
import {
  SemanticCompiler,
  applySemanticProposal,
  type SemanticCompilationRequest,
} from './semantic-compiler.js';

function operationFixture(): NormalizedOperation {
  const draft = {
    id: 'get_user',
    operationId: 'getUser',
    method: 'GET' as const,
    path: '/users/{userId}',
    summary: 'Get a user',
    description: 'Returns a user by identifier.',
    tags: ['users'],
    deprecated: false,
    servers: [
      {
        template: 'https://api.example.test',
        resolvedUrl: 'https://api.example.test/',
        variables: {},
      },
    ],
    parameters: [
      {
        location: 'path' as const,
        name: 'userId',
        inputPath: ['path', 'userId'],
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
    ],
    requestBodies: [],
    successResponses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, displayName: { type: 'string' } },
          required: ['id'],
        },
      },
    ],
    auth: {
      required: true,
      alternatives: [[{ scheme: 'bearer', scopes: [] }]],
      schemes: {
        bearer: { name: 'bearer', type: 'http', scheme: 'bearer' },
      },
    },
    provenance: {
      sourceKind: 'openapi',
      sourceId: 'fixture',
      documentFingerprint: fingerprint({ fixture: 'document' }),
      pointer: '/paths/~1users~1{userId}/get',
      operationId: 'getUser',
    },
  };
  return NormalizedOperationSchema.parse({ ...draft, fingerprint: fingerprint(draft) });
}

function baselineCapability(): Capability {
  return new DeterministicBaselineCompiler({
    compiler: { name: 'test-baseline', version: '1' },
    clock: () => new Date('2026-07-14T00:00:00.000Z'),
  }).compile(operationFixture()).candidate.capability;
}

describe('DeterministicBaselineCompiler', () => {
  it('compiles a normalized operation without changing its HTTP execution contract', () => {
    const operation = operationFixture();
    const result = new DeterministicBaselineCompiler({
      compiler: { name: 'baseline', version: '1.2.3' },
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
    }).compile(operation);

    expect(result.candidate.capability.execution).toEqual({
      kind: 'http',
      method: operation.method,
      pathTemplate: operation.path,
      servers: operation.servers,
      parameterBindings: operation.parameters,
      requestBodies: operation.requestBodies,
      successResponses: operation.successResponses,
    });
    expect(result.candidate.capability.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: {
              allOf: [
                { type: 'string' },
                {
                  anyOf: expect.arrayContaining([
                    {
                      type: ['null', 'boolean', 'number', 'string'],
                      pattern: WELL_FORMED_UNICODE_PATTERN,
                    },
                  ]),
                },
              ],
            },
          },
        },
      },
    });
    expect(result.candidate.capability.risk).toMatchObject({
      level: 'read',
      sideEffect: 'none',
      idempotency: 'idempotent',
    });
    const { fingerprint: declared, ...content } = result.candidate.capability;
    expect(declared).toBe(fingerprint(content));
  });

  it('allocates deterministic unique MCP names when normalized operation ids collide', () => {
    const withIdentity = (
      id: string,
      operationId: string,
      pointer: string,
    ): NormalizedOperation => {
      const { fingerprint: _fingerprint, ...base } = operationFixture();
      const draft = {
        ...base,
        id,
        operationId,
        provenance: { ...base.provenance, pointer, operationId },
      };
      return NormalizedOperationSchema.parse({ ...draft, fingerprint: fingerprint(draft) });
    };
    const operations = [
      withIdentity('operation_a', 'get.user', '/paths/~1a/get'),
      withIdentity('operation_b', 'get/user', '/paths/~1b/get'),
    ];
    const compiler = new DeterministicBaselineCompiler({
      compiler: { name: 'baseline', version: '1.2.3' },
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    const first = compiler.compileAll(operations);
    const reversed = compiler.compileAll([...operations].reverse());
    const namesById = (results: typeof first) =>
      Object.fromEntries(
        results.map(({ candidate }) => [candidate.capability.id, candidate.capability.name]),
      );

    expect(new Set(first.map(({ candidate }) => candidate.capability.name)).size).toBe(2);
    expect(first.map(({ candidate }) => candidate.capability.name)).toEqual([
      'get_user',
      expect.stringMatching(/^get_user_[0-9a-f]{24}$/),
    ]);
    expect(namesById(first)).toEqual(namesById(reversed));
    for (const result of first) {
      const capability = result.candidate.capability;
      const { fingerprint: declared, ...content } = capability;
      expect(declared).toBe(fingerprint(content));
      expect(result.provenance.baseCapabilityFingerprint).toBe(declared);
      expect(result.provenance.resultCapabilityFingerprint).toBe(declared);
      expect(verifyCapability(capability).valid).toBe(true);
    }
  });

  it('composes recursive component parameter and body schemas into an Ajv-valid capability', () => {
    const adapted = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Recursive input' },
      servers: [{ url: 'https://api.example.test' }],
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              child: { $ref: '#/components/schemas/Node' },
            },
          },
        },
      },
      paths: {
        '/nodes': {
          post: {
            operationId: 'createNode',
            parameters: [
              {
                name: 'filter',
                in: 'query',
                required: true,
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Node' } },
                },
              },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Node' } },
              },
            },
            responses: {
              '200': {
                description: 'Created node',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Node' } },
                },
              },
              '201': {
                description: 'Created identifier',
                content: {
                  'text/plain': { schema: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    });
    const operation = adapted.operations[0];
    expect(operation).toBeDefined();
    if (operation === undefined) throw new Error('Expected one normalized operation');

    const capability = new DeterministicBaselineCompiler({
      compiler: { name: 'recursive-test', version: '1' },
    }).compile(operation).candidate.capability;
    const verification = verifyCapability(capability, { sourceOperation: operation });

    expect(adapted.hasErrors).toBe(false);
    expect(capability.inputSchema).toHaveProperty('$defs');
    expect(capability.outputSchema).toHaveProperty('$defs');
    expect(verification.valid).toBe(true);
    expect(verification.diagnostics.map(({ code }) => code)).not.toContain('SCHEMA.INVALID');
    expect(verification.diagnostics.map(({ code }) => code)).not.toContain(
      'BINDING.SCHEMA_MISMATCH',
    );
  });

  it('verifies bundled external recursion and converted OpenAPI 3.0 schemas', () => {
    const adapted = adaptOpenApi(
      {
        openapi: '3.0.3',
        info: { title: 'Dialect and external recursion' },
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/dialect': {
            get: {
              operationId: 'getDialectValue',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'number',
                        nullable: true,
                        minimum: 0,
                        exclusiveMinimum: true,
                      },
                    },
                  },
                },
              },
            },
          },
          '/recursive': {
            get: {
              operationId: 'getRecursiveValue',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { $ref: 'contract:node' } },
                  },
                },
              },
            },
          },
        },
      },
      {
        externalRefResolver(reference) {
          return reference === 'contract:node'
            ? { type: 'object', properties: { child: { $ref: 'contract:node' } } }
            : undefined;
        },
      },
    );
    expect(adapted.hasErrors).toBe(false);

    const compiler = new DeterministicBaselineCompiler({
      compiler: { name: 'schema-verification-test', version: '1' },
    });
    const capabilities = compiler.compileAll(adapted.operations);
    for (const result of capabilities) {
      const operation = adapted.operations.find(
        ({ id }) => id === result.candidate.sourceOperationId,
      );
      expect(operation).toBeDefined();
      if (operation === undefined) throw new Error('Expected source operation for capability');
      expect(
        verifyCapability(result.candidate.capability, { sourceOperation: operation }).valid,
      ).toBe(true);
    }
  });

  it('compiles an explicit media-type selector even when request body schemas are identical', () => {
    const adapted = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Text representations' },
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/execute': {
          post: {
            operationId: 'executeText',
            requestBody: {
              required: true,
              content: {
                'application/graphql': { schema: { type: 'string' } },
                'text/plain': { schema: { type: 'string' } },
              },
            },
            responses: { '204': { description: 'Accepted' } },
          },
        },
      },
    });
    const operation = adapted.operations[0];
    expect(operation).toBeDefined();
    if (operation === undefined) throw new Error('Expected one normalized operation');

    const capability = new DeterministicBaselineCompiler({
      compiler: { name: 'selector-test', version: '1' },
    }).compile(operation).candidate.capability;

    expect(capability.inputSchema).toMatchObject({
      type: 'object',
      required: ['body', 'bodyContentType'],
      properties: {
        body: {
          allOf: [
            { type: 'string' },
            {
              type: ['null', 'boolean', 'number', 'string'],
              pattern: WELL_FORMED_UNICODE_PATTERN,
            },
          ],
        },
        bodyContentType: {
          oneOf: [
            { type: 'string', const: 'application/graphql' },
            { type: 'string', const: 'text/plain' },
          ],
        },
      },
    });
    expect(verifyCapability(capability, { sourceOperation: operation }).valid).toBe(true);
  });

  it('combines a parameter and body at the same input path without losing either binding schema', () => {
    const base = operationFixture();
    const { fingerprint: _fingerprint, ...material } = base;
    const parameterSchema = { type: 'string', minLength: 1 } as const;
    const jsonBodySchema = { type: 'string', maxLength: 128 } as const;
    const problemBodySchema = { type: 'string', pattern: '^[A-Za-z0-9]+$' } as const;
    const operationMaterial = {
      ...material,
      id: 'submit_shared_payload',
      operationId: 'submitSharedPayload',
      method: 'POST' as const,
      path: '/submit',
      parameters: [
        {
          location: 'query' as const,
          name: 'payload',
          inputPath: ['payload'],
          required: true,
          schema: parameterSchema,
        },
      ],
      requestBodies: [
        {
          contentType: 'application/json',
          inputPath: ['payload'],
          contentTypeInputPath: ['payloadContentType'],
          required: true,
          schema: jsonBodySchema,
        },
        {
          contentType: 'application/problem+json',
          inputPath: ['payload'],
          contentTypeInputPath: ['payloadContentType'],
          required: true,
          schema: problemBodySchema,
        },
      ],
      risk: {
        level: 'write' as const,
        sideEffect: 'definite' as const,
        idempotency: 'non-idempotent' as const,
        requiresConfirmation: true,
        rationale: ['HTTP POST semantics.'],
      },
      provenance: {
        ...material.provenance,
        pointer: '/paths/~1submit/post',
        operationId: 'submitSharedPayload',
      },
    };
    const operation = NormalizedOperationSchema.parse({
      ...operationMaterial,
      fingerprint: fingerprint(operationMaterial),
    });
    const capability = new DeterministicBaselineCompiler({
      compiler: { name: 'shared-path-test', version: '1' },
    }).compile(operation).candidate.capability;
    const verification = verifyCapability(capability, { sourceOperation: operation });

    expect(capability.inputSchema).toMatchObject({
      properties: {
        payload: {
          allOf: [expect.any(Object), { anyOf: [expect.any(Object), expect.any(Object)] }],
        },
      },
    });
    expect(verification.valid).toBe(true);
    expect(verification.diagnostics.map(({ code }) => code)).not.toContain(
      'BINDING.SCHEMA_MISMATCH',
    );
  });

  it('couples an optional request body with its required media selector when either is present', () => {
    const base = operationFixture();
    const { fingerprint: _fingerprint, ...material } = base;
    const operationMaterial = {
      ...material,
      id: 'optional_body',
      operationId: 'optionalBody',
      method: 'POST' as const,
      path: '/optional',
      parameters: [],
      requestBodies: [
        {
          contentType: 'application/json',
          inputPath: ['body'],
          contentTypeInputPath: ['bodyContentType'],
          required: false,
          schema: { type: 'object' },
        },
        {
          contentType: 'text/plain',
          serialization: 'text' as const,
          inputPath: ['body'],
          contentTypeInputPath: ['bodyContentType'],
          required: false,
          schema: { type: 'string' },
        },
      ],
      risk: {
        level: 'write' as const,
        sideEffect: 'definite' as const,
        idempotency: 'non-idempotent' as const,
        requiresConfirmation: true,
        rationale: ['HTTP POST semantics.'],
      },
      provenance: {
        ...material.provenance,
        pointer: '/paths/~1optional/post',
        operationId: 'optionalBody',
      },
    };
    const operation = NormalizedOperationSchema.parse({
      ...operationMaterial,
      fingerprint: fingerprint(operationMaterial),
    });
    const capability = new DeterministicBaselineCompiler({
      compiler: { name: 'optional-selector-test', version: '1' },
    }).compile(operation).candidate.capability;

    expect(capability.inputSchema).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          if: expect.objectContaining({ required: ['body'] }),
          then: expect.objectContaining({ required: ['bodyContentType'] }),
        }),
        expect.objectContaining({
          if: expect.objectContaining({ required: ['bodyContentType'] }),
          then: expect.objectContaining({ required: ['body'] }),
        }),
      ]),
    });
    expect(verifyCapability(capability, { sourceOperation: operation }).valid).toBe(true);
  });

  it('narrows a general string source schema to the shared canonical base64 MCP input contract', () => {
    const base = operationFixture();
    const { fingerprint: _fingerprint, ...material } = base;
    const operationMaterial = {
      ...material,
      id: 'upload_binary',
      operationId: 'uploadBinary',
      method: 'POST' as const,
      path: '/binary',
      parameters: [],
      requestBodies: [
        {
          contentType: 'application/octet-stream',
          serialization: 'base64' as const,
          inputPath: ['body'],
          required: true,
          schema: { type: 'string' },
        },
      ],
      risk: {
        level: 'write' as const,
        sideEffect: 'definite' as const,
        idempotency: 'non-idempotent' as const,
        requiresConfirmation: true,
        rationale: ['HTTP POST semantics.'],
      },
      provenance: {
        ...material.provenance,
        pointer: '/paths/~1binary/post',
        operationId: 'uploadBinary',
      },
    };
    const operation = NormalizedOperationSchema.parse({
      ...operationMaterial,
      fingerprint: fingerprint(operationMaterial),
    });
    const capability = new DeterministicBaselineCompiler({
      compiler: { name: 'base64-test', version: '1' },
    }).compile(operation).candidate.capability;

    expect(capability.inputSchema).toMatchObject({
      properties: {
        body: {
          allOf: [{ type: 'string' }, { type: 'string', pattern: CANONICAL_PADDED_BASE64_PATTERN }],
        },
      },
    });
    expect(verifyCapability(capability, { sourceOperation: operation }).errors).toEqual([]);
  });

  it('narrows raw header inputs to the shared HTTP field-value wire domain', () => {
    const base = operationFixture();
    const { fingerprint: _fingerprint, ...material } = base;
    const operationMaterial = {
      ...material,
      id: 'read_header',
      operationId: 'readHeader',
      path: '/headers',
      parameters: [
        {
          location: 'header' as const,
          name: 'x-request-id',
          inputPath: ['requestId'],
          required: true,
          schema: { type: 'string' },
        },
      ],
      provenance: {
        ...material.provenance,
        pointer: '/paths/~1headers/get',
        operationId: 'readHeader',
      },
    };
    const operation = NormalizedOperationSchema.parse({
      ...operationMaterial,
      fingerprint: fingerprint(operationMaterial),
    });
    const capability = new DeterministicBaselineCompiler({
      compiler: { name: 'header-test', version: '1' },
    }).compile(operation).candidate.capability;

    expect(capability.inputSchema).toMatchObject({
      properties: {
        requestId: {
          allOf: [
            { type: 'string' },
            {
              anyOf: expect.arrayContaining([
                expect.objectContaining({ pattern: HTTP_HEADER_VALUE_PATTERN }),
              ]),
            },
          ],
        },
      },
    });
    expect(verifyCapability(capability, { sourceOperation: operation }).errors).toEqual([]);
  });
});

describe('semantic proposal application', () => {
  it('changes semantic annotations while preserving execution, auth, output and risk', () => {
    const baseline = baselineCapability();
    const locked = canonicalStringify({
      execution: baseline.execution,
      auth: baseline.auth,
      outputSchema: baseline.outputSchema,
      risk: baseline.risk,
    });
    const proposal = SemanticProposalSchema.parse({
      schemaVersion: '1.0',
      capabilityId: baseline.id,
      baseFingerprint: baseline.fingerprint,
      changes: {
        description: 'Find one user from an exact user identifier.',
        intent: {
          useWhen: ['An exact user identifier is available.'],
          avoidWhen: ['The user must be searched by name.'],
        },
        inputAnnotations: [
          {
            inputPath: ['path', 'userId'],
            description: 'The exact immutable user identifier.',
            confidence: 0.98,
            rationale: 'The source path parameter is required.',
          },
        ],
      },
      riskObservation: {
        level: 'destructive',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
        confidence: 0.2,
        rationale: 'An intentionally incorrect observation used to prove it is review-only.',
      },
      confidence: 0.95,
      rationale: ['Clarifies exact lookup semantics.'],
    });

    const result = applySemanticProposal(baseline, proposal);

    expect(result.description).toBe('Find one user from an exact user identifier.');
    expect(result.inputSchema).toMatchObject({
      properties: {
        path: {
          properties: { userId: { description: 'The exact immutable user identifier.' } },
        },
      },
    });
    expect(
      canonicalStringify({
        execution: result.execution,
        auth: result.auth,
        outputSchema: result.outputSchema,
        risk: result.risk,
      }),
    ).toBe(locked);
  });

  it('rejects stale proposals and proposal fields outside the structured contract', () => {
    const baseline = baselineCapability();
    const proposal = {
      schemaVersion: '1.0' as const,
      capabilityId: baseline.id,
      baseFingerprint: fingerprint({ stale: true }),
      changes: {},
      confidence: 1,
      rationale: ['No-op'],
    };

    expect(() => applySemanticProposal(baseline, proposal)).toThrow(SemanticProposalConflictError);
    expect(
      SemanticProposalSchema.safeParse({
        ...proposal,
        baseFingerprint: baseline.fingerprint,
        execution: { method: 'DELETE', pathTemplate: '/different' },
      }).success,
    ).toBe(false);
  });
});

describe('SemanticCompiler', () => {
  it('records model and prompt provenance for a structured proposal', async () => {
    const baseline = baselineCapability();
    const provider: SemanticModelProvider = {
      id: 'dynamic-provider',
      async listModels() {
        return [
          {
            id: 'catalog-model',
            capabilities: ['structured-output'],
            quality: { semanticCompilation: 0.9 },
            contextWindowTokens: 16_000,
          },
        ];
      },
      async generateStructured() {
        return {
          requestId: 'request-1',
          output: {
            schemaVersion: '1.0',
            capabilityId: baseline.id,
            baseFingerprint: baseline.fingerprint,
            changes: { description: 'Retrieve a user by exact identifier.' },
            confidence: 0.9,
            rationale: ['Uses user-facing terminology.'],
          },
        };
      },
    };
    const compiler = new SemanticCompiler({
      router: new SemanticModelRouter([provider], {
        objectiveWeights: { quality: 1, cost: 0, latency: 0, availability: 0 },
        missingMetricScore: 0,
      }),
      compiler: { name: 'semantic-test', version: '1' },
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
    });
    const request: SemanticCompilationRequest = {
      routing: {
        requiredCapabilities: ['structured-output'],
        qualityWeights: { semanticCompilation: 1 },
        estimatedInputTokens: 500,
        estimatedOutputTokens: 500,
      },
    };

    const result = await compiler.compile(baseline, request);

    expect(result.candidate.capability.description).toBe('Retrieve a user by exact identifier.');
    expect(result.provenance.selectedModel).toEqual({
      provider: 'dynamic-provider',
      model: 'catalog-model',
      routingScore: 0.9,
      requestId: 'request-1',
    });
    expect(result.provenance.promptFingerprint).toMatch(/^sha256:/);
  });
});
