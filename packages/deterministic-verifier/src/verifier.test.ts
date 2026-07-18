import {
  CapabilitySchema,
  HTTP_HEADER_VALUE_PATTERN,
  NormalizedOperationSchema,
  WELL_FORMED_UNICODE_PATTERN,
  fingerprint,
  shallowParameterTextWireSchema,
  type Capability,
  type NormalizedOperation,
} from '@hi-mcp/capability-ir';
import { describe, expect, it } from 'vitest';

import { FORBIDDEN_TOOL_INPUT_HEADERS } from './header-policy.js';
import { verifyCapability } from './verifier.js';

function withFingerprint(content: Omit<Capability, 'fingerprint'>): Capability {
  return CapabilitySchema.parse({ ...content, fingerprint: fingerprint(content) });
}

function capabilityFixture(): Capability {
  return withFingerprint({
    schemaVersion: '1.0',
    id: 'get_user',
    name: 'getUser',
    title: 'Get a user',
    description: 'Returns one user by identifier.',
    intent: {
      useWhen: ['An exact user identifier is available.'],
      avoidWhen: [],
      examples: ['Get user u-123.'],
      tags: ['users'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: {
            userId: {
              allOf: [
                { type: 'string', minLength: 1 },
                shallowParameterTextWireSchema(WELL_FORMED_UNICODE_PATTERN),
              ],
            },
          },
          required: ['userId'],
          additionalProperties: false,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    auth: {
      required: true,
      alternatives: [[{ scheme: 'bearer', scopes: [] }]],
      schemes: {
        bearer: { name: 'bearer', type: 'http', scheme: 'bearer' },
      },
    },
    risk: {
      level: 'read',
      sideEffect: 'none',
      idempotency: 'idempotent',
      requiresConfirmation: false,
      rationale: ['HTTP GET semantics.'],
    },
    execution: {
      kind: 'http',
      method: 'GET',
      pathTemplate: '/users/{userId}',
      servers: [
        {
          template: 'https://{region}.example.test',
          resolvedUrl: 'https://eu.example.test/',
          variables: {
            region: { default: 'eu', enum: ['eu', 'us'] },
          },
        },
      ],
      parameterBindings: [
        {
          location: 'path',
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
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      ],
    },
    provenance: {
      sourceKind: 'openapi',
      sourceId: 'fixture',
      documentFingerprint: fingerprint({ fixture: 'document' }),
      pointer: '/paths/~1users~1{userId}/get',
      operationId: 'getUser',
    },
  });
}

function replaceCapability(
  original: Capability,
  transform: (draft: Omit<Capability, 'fingerprint'>) => Omit<Capability, 'fingerprint'>,
): Capability {
  const { fingerprint: _declared, ...content } = original;
  return withFingerprint(transform(structuredClone(content)));
}

function sourceOperation(capability: Capability): NormalizedOperation {
  const draft = {
    id: 'get_user',
    operationId: capability.provenance.operationId,
    method: capability.execution.method,
    path: capability.execution.pathTemplate,
    summary: capability.title,
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
  return NormalizedOperationSchema.parse({ ...draft, fingerprint: fingerprint(draft) });
}

function withHeaderBinding(name: string): Capability {
  return replaceCapability(capabilityFixture(), (draft) => ({
    ...draft,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: {
            userId: {
              allOf: [
                { type: 'string', minLength: 1 },
                shallowParameterTextWireSchema(WELL_FORMED_UNICODE_PATTERN),
                shallowParameterTextWireSchema(HTTP_HEADER_VALUE_PATTERN),
              ],
            },
          },
          required: ['userId'],
          additionalProperties: false,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execution: {
      ...draft.execution,
      parameterBindings: [
        ...draft.execution.parameterBindings,
        {
          location: 'header',
          name,
          inputPath: ['path', 'userId'],
          required: true,
          schema: { type: 'string', minLength: 1 },
        },
      ],
    },
  }));
}

describe('verifyCapability', () => {
  it('accepts a grounded capability with valid schemas and bindings', () => {
    const capability = capabilityFixture();
    const result = verifyCapability(capability, { baselineCapability: capability });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects execution bindings whose input path does not exist', () => {
    const capability = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        parameterBindings: draft.execution.parameterBindings.map((binding) => ({
          ...binding,
          inputPath: ['missingUserId'],
        })),
      },
    }));

    const result = verifyCapability(capability);

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('BINDING.INPUT_PATH_MISSING');
  });

  it('rejects static paths and query names that URL parsing would replace', () => {
    const invalidPath = structuredClone(capabilityFixture()) as Capability;
    invalidPath.execution.pathTemplate = `/items/${String.fromCharCode(0xd800)}`;
    const invalidQuery = structuredClone(capabilityFixture()) as Capability;
    invalidQuery.execution.parameterBindings.push({
      location: 'query',
      name: String.fromCharCode(0xd800),
      inputPath: ['path', 'userId'],
      required: true,
      schema: { type: 'string', minLength: 1 },
    });

    expect(verifyCapability(invalidPath).valid).toBe(false);
    expect(verifyCapability(invalidQuery).valid).toBe(false);
  });

  it('detects endpoint and method changes against an authoritative baseline', () => {
    const baseline = capabilityFixture();
    const changed = replaceCapability(baseline, (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        method: 'POST',
        pathTemplate: '/admin/users/{userId}',
      },
    }));

    const result = verifyCapability(changed, {
      baselineCapability: baseline,
      sourceOperation: sourceOperation(baseline),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'BASELINE.EXECUTION_MISMATCH',
        'SOURCE.METHOD_MISMATCH',
        'SOURCE.PATH_MISMATCH',
      ]),
    );
  });

  it('rejects decoder-sensitive operation paths at the verifier boundary', () => {
    for (const pathTemplate of ['/%252e%252e/admin', '/safe\\..\\admin', '/items?fixed=true']) {
      const { fingerprint: _fingerprint, ...content } = structuredClone(capabilityFixture());
      content.execution.pathTemplate = pathTemplate;
      const result = verifyCapability({ ...content, fingerprint: fingerprint(content) });

      expect(result.valid, pathTemplate).toBe(false);
      expect(
        result.errors.map(({ code }) => code),
        pathTemplate,
      ).toContain('IR.INVALID_CAPABILITY');
    }
  });

  it('grounds capability provenance against the selected normalized operation', () => {
    const original = capabilityFixture();
    const source = sourceOperation(original);
    const forged = replaceCapability(original, (draft) => ({
      ...draft,
      provenance: {
        ...draft.provenance,
        pointer: '/paths/~1forged/get',
      },
    }));

    expect(
      verifyCapability(forged, { sourceOperation: source }).errors.map(({ code }) => code),
    ).toContain('SOURCE.PROVENANCE_MISMATCH');
  });

  it('uses Ajv to reject invalid input and output JSON Schemas', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      outputSchema: { type: 'not-a-json-schema-type' },
    }));

    const result = verifyCapability(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('SCHEMA.INVALID');
  });

  it('rejects potentially catastrophic JSON Schema patterns before Ajv compilation', () => {
    const unsafePattern = { type: 'string', pattern: '(a+)+$' };
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      outputSchema: {
        type: 'object',
        properties: { id: unsafePattern },
        required: ['id'],
      },
      execution: {
        ...draft.execution,
        successResponses: draft.execution.successResponses.map((response) => ({
          ...response,
          schema: {
            type: 'object',
            properties: { id: unsafePattern },
            required: ['id'],
          },
        })),
      },
    }));

    const result = verifyCapability(invalid);

    expect(result.errors.map((item) => item.code)).toContain('SCHEMA.UNSAFE_PATTERN');
  });

  it('rejects server base URLs with a query and non-object MCP input schemas', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      inputSchema: true,
      execution: {
        ...draft.execution,
        servers: [
          {
            template: 'https://api.example.test?tenant=hidden',
            resolvedUrl: 'https://api.example.test?tenant=hidden',
            variables: {},
          },
        ],
      },
    }));

    const result = verifyCapability(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(['SCHEMA.INPUT_ROOT_NOT_OBJECT', 'SERVER.URL_QUERY']),
    );
  });

  it('rejects a resolved server URL that would be normalized to another path', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        servers: [
          {
            template: 'https://api.example.test/v1/%2e%2e/admin',
            resolvedUrl: 'https://api.example.test/v1/%2e%2e/admin',
            variables: {},
          },
        ],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
      'SERVER.NON_CANONICAL_RESOLVED_URL',
    );
  });

  it('rejects inconsistent destructive risk and authentication contracts', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      risk: {
        ...draft.risk,
        level: 'destructive',
        sideEffect: 'none',
        requiresConfirmation: false,
      },
      auth: {
        required: true,
        alternatives: [[{ scheme: 'missing', scopes: [] }]],
        schemes: {},
      },
    }));

    const result = verifyCapability(invalid);

    expect(result.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'RISK.DESTRUCTIVE_WITHOUT_CONFIRMATION',
        'RISK.DESTRUCTIVE_WITHOUT_SIDE_EFFECT',
        'AUTH.UNKNOWN_SCHEME',
      ]),
    );
  });

  it('requires a complete non-conflicting credential alternative for required auth', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      auth: {
        required: true,
        alternatives: [
          [
            { scheme: 'primary', scopes: [] },
            { scheme: 'secondary', scopes: [] },
          ],
        ],
        schemes: {
          primary: {
            name: 'primary',
            type: 'apiKey',
            location: 'header',
            parameterName: 'X-API-Key',
          },
          secondary: {
            name: 'secondary',
            type: 'apiKey',
            location: 'header',
            parameterName: 'x-api-key',
          },
        },
      },
    }));

    const result = verifyCapability(invalid);

    expect(result.errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'AUTH.CREDENTIAL_TARGET_CONFLICT',
        'AUTH.REQUIRED_CREDENTIAL_COVERAGE_MISSING',
      ]),
    );
  });

  it('grounds security scheme record identity before credential derivation', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      auth: {
        ...draft.auth,
        schemes: {
          bearer: {
            name: 'renamed-bearer',
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
    }));

    const result = verifyCapability(invalid);

    expect(result.errors.map(({ code }) => code)).toContain('AUTH.SCHEME_NAME_MISMATCH');
  });

  it.each([
    { location: 'header', parameterName: 'Bad Header' },
    { location: 'header', parameterName: 'Host' },
    { location: 'cookie', parameterName: 'bad;name' },
  ] as const)(
    'rejects an apiKey target the HTTP runtime cannot apply: $location:$parameterName',
    ({ location, parameterName }) => {
      const invalid = structuredClone(capabilityFixture());
      invalid.auth = {
        required: true,
        alternatives: [[{ scheme: 'apiKey', scopes: [] }]],
        schemes: {
          apiKey: { name: 'apiKey', type: 'apiKey', location, parameterName },
        },
      };

      const result = verifyCapability(invalid);

      expect(result.valid).toBe(false);
      expect(result.errors.map(({ code }) => code)).toContain('IR.INVALID_CAPABILITY');
    },
  );

  it('rejects optional auth metadata when every alternative actually requires credentials', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      auth: { ...draft.auth, required: false },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
      'AUTH.REQUIRED_FLAG_MISMATCH',
    );
  });

  it('rejects a stricter safe-method risk declaration when confirmation is disabled', () => {
    const unsafeGet = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      risk: {
        ...draft.risk,
        level: 'write',
        sideEffect: 'definite',
        requiresConfirmation: false,
      },
    }));

    const result = verifyCapability(unsafeGet);

    expect(result.errors.map((item) => item.code)).toContain('RISK.SAFE_METHOD_UPSTREAM_OVERRIDE');
    expect(result.errors.map((item) => item.code)).not.toContain('IR.FINGERPRINT_MISMATCH');
  });

  it('accepts a confirmation-gated authoritative risk escalation for a nonconforming API', () => {
    const confirmationGatedGet = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      risk: {
        ...draft.risk,
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
      },
    }));

    const result = verifyCapability(confirmationGatedGet);

    expect(result.errors).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'RISK.SAFE_METHOD_NON_IDEMPOTENT',
        'RISK.SAFE_METHOD_UPSTREAM_OVERRIDE',
      ]),
    );
  });

  it('detects a stale or manually altered fingerprint', () => {
    const capability = capabilityFixture();
    const altered = { ...capability, description: 'Changed without refingerprinting.' };

    const result = verifyCapability(altered);

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('IR.FINGERPRINT_MISMATCH');
  });

  it('preflights deeply nested capability input before recursive schema parsing', () => {
    let deep: unknown = true;
    for (let index = 0; index < 64; index += 1) deep = { next: deep };
    const capability = { ...capabilityFixture(), extensions: { deep } };

    const result = verifyCapability(capability, { inputLimits: { maxDepth: 16 } });

    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toEqual(['IR.INPUT_LIMIT_EXCEEDED']);
  });

  it.each(['CONNECT', 'TRACE', 'TRACK'])(
    'rejects fetch-forbidden %s capabilities before credentials can be used',
    (method) => {
      const trace = replaceCapability(capabilityFixture(), (draft) => ({
        ...draft,
        execution: { ...draft.execution, method },
      }));

      const result = verifyCapability(trace);

      expect(result.valid).toBe(false);
      expect(result.errors.map((item) => item.code)).toContain('EXECUTION.METHOD_UNSUPPORTED');
    },
  );

  it.each(FORBIDDEN_TOOL_INPUT_HEADERS)(
    'fails closed when tool input is bound to protected header %s',
    (header) => {
      const result = verifyCapability(withHeaderBinding(header));

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'BINDING.FORBIDDEN_HEADER',
            details: { header },
          }),
        ]),
      );
    },
  );

  it('does not reserve conventional API-key header names without a matching auth scheme', () => {
    const result = verifyCapability(withHeaderBinding('X-API-KEY'));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['header', 'X-API-Key', 'x-api-key'],
    ['query', 'access_key', 'access_key'],
    ['cookie', 'session_key', 'session_key'],
  ] as const)(
    'rejects a tool binding that targets the %s credential destination declared by auth',
    (location, parameterName, bindingName) => {
      const invalid = replaceCapability(capabilityFixture(), (draft) => ({
        ...draft,
        auth: {
          required: true,
          alternatives: [[{ scheme: 'apiKey', scopes: [] }]],
          schemes: {
            apiKey: { name: 'apiKey', type: 'apiKey', location, parameterName },
          },
        },
        execution: {
          ...draft.execution,
          parameterBindings: [
            ...draft.execution.parameterBindings,
            {
              location,
              name: bindingName,
              inputPath: ['path', 'userId'],
              required: true,
              schema: { type: 'string' },
            },
          ],
        },
      }));

      expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
        'BINDING.CREDENTIAL_TARGET_CONFLICT',
      );
    },
  );

  it('rejects whitespace bypasses and syntactically invalid header names', () => {
    const whitespaceBypass = verifyCapability(withHeaderBinding(' Authorization '));
    const invalidToken = verifyCapability(withHeaderBinding('x-route\r\nhost'));

    expect(whitespaceBypass.errors.map((item) => item.code)).toEqual(
      expect.arrayContaining(['BINDING.FORBIDDEN_HEADER', 'BINDING.INVALID_HEADER_NAME']),
    );
    expect(invalidToken.errors.map((item) => item.code)).toContain('BINDING.INVALID_HEADER_NAME');
  });

  it('allows non-sensitive application headers', () => {
    const result = verifyCapability(withHeaderBinding('x-request-id'));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a header binding whose advertised MCP input includes invalid field values', () => {
    const unsafe = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        parameterBindings: [
          ...draft.execution.parameterBindings,
          {
            location: 'header',
            name: 'x-request-id',
            inputPath: ['path', 'userId'],
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
      },
    }));

    expect(verifyCapability(unsafe).errors.map(({ code }) => code)).toContain(
      'BINDING.PARAMETER_TEXT_DOMAIN_UNPROVEN',
    );
  });

  it('rejects parameter styles and cookie names the HTTP engine cannot execute', () => {
    const unsupportedPathStyle = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        parameterBindings: draft.execution.parameterBindings.map((binding) => ({
          ...binding,
          style: 'deepObject',
        })),
      },
    }));
    const invalidCookie = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        parameterBindings: [
          ...draft.execution.parameterBindings,
          {
            location: 'cookie' as const,
            name: 'bad;cookie',
            inputPath: ['path', 'userId'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
    }));

    expect(verifyCapability(unsupportedPathStyle).errors.map(({ code }) => code)).toContain(
      'BINDING.UNSUPPORTED_PARAMETER_STYLE',
    );
    expect(verifyCapability(invalidCookie).errors.map(({ code }) => code)).toContain(
      'BINDING.INVALID_COOKIE_NAME',
    );
  });

  it('fails closed for unconstrained or nested values in style-based parameter serializers', () => {
    const nested = {
      type: 'object',
      properties: { child: { type: 'object', additionalProperties: false } },
      additionalProperties: false,
    } as const;
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      inputSchema: {
        type: 'object',
        required: ['path', 'query'],
        properties: {
          path: {
            type: 'object',
            required: ['userId'],
            properties: { userId: { type: 'string' } },
            additionalProperties: false,
          },
          query: {
            type: 'object',
            required: ['filter', 'deep'],
            properties: { filter: nested, deep: {} },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      execution: {
        ...draft.execution,
        parameterBindings: [
          ...draft.execution.parameterBindings,
          {
            location: 'query',
            name: 'filter',
            inputPath: ['query', 'filter'],
            required: true,
            schema: nested,
          },
          {
            location: 'query',
            name: 'deep',
            inputPath: ['query', 'deep'],
            required: true,
            style: 'deepObject',
            schema: {},
          },
        ],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'BINDING.PARAMETER_SCHEMA_UNSUPPORTED',
        'BINDING.PARAMETER_STYLE_SCHEMA_MISMATCH',
      ]),
    );
  });

  it('rejects unsupported allowReserved and ambiguous parameter content contracts', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        parameterBindings: [
          ...draft.execution.parameterBindings,
          {
            location: 'query',
            name: 'raw',
            inputPath: ['path', 'userId'],
            required: true,
            allowReserved: true,
            schema: { type: 'string' },
          },
          {
            location: 'header',
            name: 'X-Structured',
            inputPath: ['path', 'userId'],
            required: true,
            contentType: 'application/xml',
            schema: { type: 'string' },
          },
          {
            location: 'query',
            name: 'message',
            inputPath: ['path', 'userId'],
            required: true,
            contentType: 'text/plain',
            style: 'form',
            schema: {},
          },
        ],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'BINDING.ALLOW_RESERVED_UNSUPPORTED',
        'BINDING.PARAMETER_CONTENT_TYPE_UNSUPPORTED',
        'BINDING.PARAMETER_CONTENT_STYLE_CONFLICT',
        'BINDING.PARAMETER_CONTENT_SCHEMA_MISMATCH',
      ]),
    );
  });

  it('rejects request bodies that have no executable wire serialization', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string' } },
      },
      risk: {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
        rationale: [],
      },
      execution: {
        ...draft.execution,
        method: 'POST',
        pathTemplate: '/upload',
        parameterBindings: [],
        requestBodies: [
          {
            contentType: 'application/octet-stream',
            inputPath: ['body'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
    }));

    const result = verifyCapability(invalid);

    expect(result.errors.map(({ code }) => code)).toContain(
      'BINDING.REQUEST_BODY_SERIALIZATION_UNSUPPORTED',
    );
  });

  it.each([
    ['text', 'text/plain', {}],
    ['form', 'application/x-www-form-urlencoded', {}],
    ['base64', 'application/octet-stream', { type: 'string' }],
  ] as const)(
    'rejects %s request serialization when the schema does not prove the runtime wire domain',
    (serialization, contentType, bodySchema) => {
      const invalid = replaceCapability(capabilityFixture(), (draft) => ({
        ...draft,
        inputSchema: {
          type: 'object',
          required: ['body'],
          properties: { body: bodySchema },
          additionalProperties: false,
        },
        risk: {
          level: 'write',
          sideEffect: 'definite',
          idempotency: 'non-idempotent',
          requiresConfirmation: true,
          rationale: [],
        },
        execution: {
          ...draft.execution,
          method: 'POST',
          pathTemplate: '/upload',
          parameterBindings: [],
          requestBodies: [
            {
              contentType,
              serialization,
              inputPath: ['body'],
              required: true,
              schema: bodySchema,
            },
          ],
        },
      }));

      expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
        'BINDING.SERIALIZATION_SCHEMA_MISMATCH',
      );
    },
  );

  it('rejects nested form entries and request wildcard media ranges', () => {
    const nestedForm = {
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object', additionalProperties: false } },
      },
      additionalProperties: false,
    } as const;
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: { body: nestedForm },
        additionalProperties: false,
      },
      risk: {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
        rationale: [],
      },
      execution: {
        ...draft.execution,
        method: 'POST',
        pathTemplate: '/submit',
        parameterBindings: [],
        requestBodies: [
          {
            contentType: 'application/*',
            serialization: 'form',
            inputPath: ['body'],
            required: true,
            schema: nestedForm,
          },
        ],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'BINDING.SERIALIZATION_SCHEMA_MISMATCH',
        'BINDING.REQUEST_BODY_MEDIA_TYPE_UNSUPPORTED',
      ]),
    );
  });

  it('rejects ambiguous multiple request body representations without one shared selector', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string' } },
      },
      risk: {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
        rationale: [],
      },
      execution: {
        ...draft.execution,
        method: 'POST',
        pathTemplate: '/execute',
        parameterBindings: [],
        requestBodies: [
          {
            contentType: 'application/graphql',
            serialization: 'text',
            inputPath: ['body'],
            required: true,
            schema: { type: 'string' },
          },
          {
            contentType: 'text/plain',
            serialization: 'text',
            inputPath: ['body'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
    }));

    const codes = verifyCapability(invalid).errors.map(({ code }) => code);
    expect(codes).toContain('BINDING.REQUEST_BODY_SELECTOR_MISSING');
  });

  it('requires multiple body representations to share path, requiredness, and selector', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      inputSchema: {
        type: 'object',
        required: ['body', 'alternate', 'bodyType', 'alternateType'],
        properties: {
          body: { type: 'string' },
          alternate: { type: 'string' },
          bodyType: { type: 'string' },
          alternateType: { type: 'string' },
        },
        additionalProperties: false,
      },
      risk: {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'non-idempotent',
        requiresConfirmation: true,
        rationale: [],
      },
      execution: {
        ...draft.execution,
        method: 'POST',
        pathTemplate: '/execute',
        parameterBindings: [],
        requestBodies: [
          {
            contentType: 'text/plain',
            serialization: 'text',
            inputPath: ['body'],
            contentTypeInputPath: ['bodyType'],
            required: true,
            schema: { type: 'string' },
          },
          {
            contentType: 'application/graphql',
            serialization: 'text',
            inputPath: ['alternate'],
            contentTypeInputPath: ['alternateType'],
            required: false,
            schema: { type: 'string' },
          },
        ],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'BINDING.REQUEST_BODY_INPUT_PATH_INCONSISTENT',
        'BINDING.REQUEST_BODY_REQUIRED_INCONSISTENT',
        'BINDING.REQUEST_BODY_SELECTOR_INCONSISTENT',
      ]),
    );
  });

  it('rejects GET and HEAD request bodies before runtime binding', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        requestBodies: [
          {
            contentType: 'text/plain',
            inputPath: ['path', 'userId'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
      'EXECUTION.SAFE_METHOD_BODY_UNSUPPORTED',
    );
  });

  it.each([
    [
      { statusCode: '200', contentType: 'application/json; profile=a' },
      { statusCode: '200', contentType: 'application/json; profile=b' },
    ],
    [
      { statusCode: '200', contentType: 'application/*+json' },
      { statusCode: '200', contentType: 'application/problem+json' },
    ],
    [{ statusCode: '2XX' }, { statusCode: '2XX' }],
  ] as const)(
    'rejects response contracts whose status and runtime media match regions overlap',
    (first, second) => {
      const responseSchema = capabilityFixture().execution.successResponses[0]!.schema;
      const invalid = replaceCapability(capabilityFixture(), (draft) => ({
        ...draft,
        execution: {
          ...draft.execution,
          successResponses: [
            { ...first, ...(responseSchema === undefined ? {} : { schema: responseSchema }) },
            { ...second, ...(responseSchema === undefined ? {} : { schema: responseSchema }) },
          ],
        },
      }));

      expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
        'OUTPUT.RESPONSE_CONTRACT_OVERLAP',
      );
    },
  );

  it('allows an exact response status to override an overlapping class contract', () => {
    const responseSchema = capabilityFixture().execution.successResponses[0]!.schema!;
    const valid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        successResponses: [
          { statusCode: '200', contentType: 'application/json', schema: responseSchema },
          { statusCode: '2XX', contentType: 'application/json', schema: responseSchema },
        ],
      },
    }));

    expect(verifyCapability(valid).errors.map(({ code }) => code)).not.toContain(
      'OUTPUT.RESPONSE_CONTRACT_OVERLAP',
    );
  });

  it('rejects unsupported response wildcard spellings before runtime matching', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        successResponses: draft.execution.successResponses.map((response) => ({
          ...response,
          contentType: 'application/j*son',
        })),
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
      'OUTPUT.MEDIA_RANGE_UNSUPPORTED',
    );
  });

  it('requires at least one runtime-successful 2xx or default response contract', () => {
    const invalid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        successResponses: [],
      },
    }));

    expect(verifyCapability(invalid).errors.map(({ code }) => code)).toContain(
      'OUTPUT.SUCCESS_RESPONSE_MISSING',
    );

    const nonSuccess = structuredClone(capabilityFixture());
    nonSuccess.execution.successResponses[0]!.statusCode = '404';
    expect(verifyCapability(nonSuccess).errors.map(({ code }) => code)).toContain(
      'IR.INVALID_CAPABILITY',
    );
  });

  it('allows a typed response contract to precede one untyped fallback at the same status', () => {
    const valid = replaceCapability(capabilityFixture(), (draft) => ({
      ...draft,
      execution: {
        ...draft.execution,
        successResponses: [
          ...draft.execution.successResponses,
          {
            statusCode: '200',
            schema: draft.execution.successResponses[0]!.schema!,
          },
        ],
      },
    }));

    expect(verifyCapability(valid).errors.map(({ code }) => code)).not.toContain(
      'OUTPUT.RESPONSE_CONTRACT_OVERLAP',
    );
  });
});
