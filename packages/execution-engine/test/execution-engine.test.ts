import { describe, expect, it, vi } from 'vitest';

import {
  ExecutionEngineError,
  HttpExecutionEngine,
  PublicDestinationPolicy,
  redactOutputPaths,
  type DestinationPolicy,
  type DnsResolver,
  type ExecutableHttpCapability,
  type FetchImplementation,
  type JsonSchema,
  type JsonValue,
} from '../src/index.js';
import { createPinnedLookup } from '../src/pinned-fetch.js';

const publicResolver: DnsResolver = vi.fn(async () => [
  { address: '93.184.216.34', family: 4 as const },
]);

function capability(
  overrides: {
    method?: ExecutableHttpCapability['execution']['method'];
    pathTemplate?: string;
    inputSchema?: JsonSchema;
    outputSchema?: JsonSchema;
    parameterBindings?: ExecutableHttpCapability['execution']['parameterBindings'];
    requestBodies?: ExecutableHttpCapability['execution']['requestBodies'];
    successResponses?: ExecutableHttpCapability['execution']['successResponses'];
    servers?: ExecutableHttpCapability['execution']['servers'];
    authRequired?: boolean;
    risk?: Partial<ExecutableHttpCapability['risk']>;
  } = {},
): ExecutableHttpCapability {
  return {
    schemaVersion: '1.0',
    id: 'test_capability',
    name: 'test_capability',
    description: 'A deterministic execution test capability.',
    intent: { useWhen: [], avoidWhen: [], examples: [], tags: [] },
    inputSchema: overrides.inputSchema ?? {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    ...(overrides.outputSchema === undefined ? {} : { outputSchema: overrides.outputSchema }),
    auth: {
      required: overrides.authRequired ?? false,
      alternatives: [],
      schemes: {},
    },
    risk: {
      level: overrides.risk?.level ?? 'read',
      sideEffect: overrides.risk?.sideEffect ?? 'none',
      idempotency: overrides.risk?.idempotency ?? 'idempotent',
      requiresConfirmation: overrides.risk?.requiresConfirmation ?? false,
      rationale: overrides.risk?.rationale ?? [],
    },
    execution: {
      kind: 'http',
      method: overrides.method ?? 'GET',
      pathTemplate: overrides.pathTemplate ?? '/health',
      servers: [
        ...(overrides.servers ?? [
          {
            template: 'https://api.example.com/v1',
            variables: {},
          },
        ]),
      ],
      parameterBindings: [...(overrides.parameterBindings ?? [])],
      requestBodies: [...(overrides.requestBodies ?? [])],
      successResponses: [
        ...(overrides.successResponses ?? [
          {
            statusCode: '200',
            contentType: 'application/json',
            schema: {},
          },
        ]),
      ],
    },
    provenance: {
      sourceKind: 'openapi',
      sourceId: 'test-source',
      documentFingerprint: `sha256:${'0'.repeat(64)}`,
      pointer: '/paths/~1health/get',
    },
    fingerprint: `sha256:${'1'.repeat(64)}`,
  };
}

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpExecutionEngine', () => {
  it('never traverses inherited properties while applying output redaction paths', () => {
    const originalToString = Object.prototype.toString;

    expect(
      redactOutputPaths(
        { safe: { value: 'visible' } },
        {
          outputPaths: [['__proto__', 'toString']],
        },
      ),
    ).toEqual({ safe: { value: 'visible' } });
    expect(Object.prototype.toString).toBe(originalToString);
  });

  it('binds path, query, header, cookie and credentials without exposing secrets in trace metadata', async () => {
    const calls: Array<{
      url: URL;
      init: RequestInit | undefined;
      destination: Parameters<FetchImplementation>[2];
    }> = [];
    const fetch: FetchImplementation = vi.fn(async (input, init, destination) => {
      calls.push({ url: new URL(String(input)), init, destination });
      return jsonResponse({ ok: true, accessToken: 'upstream-token' });
    });
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns: publicResolver,
      credentialProvider: {
        resolve: vi.fn(async () => ({
          headers: { authorization: 'Bearer credential-secret' },
          query: { api_key: 'query-secret' },
          cookies: { session: 'cookie-secret' },
        })),
      },
      createExecutionId: () => 'execution-1',
      now: () => Date.parse('2026-07-14T10:00:00.000Z'),
    });
    const executable = capability({
      pathTemplate: '/users/{userId}',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['userId', 'tags', 'tenant', 'locale'],
        properties: {
          userId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          tenant: { type: 'string' },
          locale: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['ok', 'accessToken'],
        properties: {
          ok: { type: 'boolean' },
          accessToken: { type: 'string' },
        },
      },
      parameterBindings: [
        {
          location: 'path',
          name: 'userId',
          inputPath: ['userId'],
          required: true,
          style: 'simple',
          schema: { type: 'string' },
        },
        {
          location: 'query',
          name: 'tag',
          inputPath: ['tags'],
          required: true,
          style: 'form',
          explode: true,
          schema: { type: 'array' },
        },
        {
          location: 'header',
          name: 'x-tenant',
          inputPath: ['tenant'],
          required: true,
          schema: { type: 'string' },
        },
        {
          location: 'cookie',
          name: 'locale',
          inputPath: ['locale'],
          required: true,
          schema: { type: 'string' },
        },
      ],
      authRequired: true,
    });

    const result = await engine.execute(
      executable,
      {
        userId: 'a/b',
        tags: ['one', 'two'],
        tenant: 'acme',
        locale: 'ko-KR',
      },
      {
        policy: {
          redaction: { outputPaths: [['accessToken']] },
        },
        context: {
          traceAttributes: {
            requestKind: 'test',
            accessToken: 'trace-secret',
          },
        },
      },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url.pathname).toBe('/v1/users/a%2Fb');
    expect(call?.url.searchParams.getAll('tag')).toEqual(['one', 'two']);
    expect(call?.url.searchParams.get('api_key')).toBe('query-secret');
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('x-tenant')).toBe('acme');
    expect(headers.get('cookie')).toBe('locale=ko-KR; session=cookie-secret');
    expect(headers.get('authorization')).toBe('Bearer credential-secret');
    expect(call?.destination).toEqual({
      protocol: 'https:',
      hostname: 'api.example.com',
      port: '',
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });
    expect(result.output).toEqual({ ok: true, accessToken: '[REDACTED]' });
    expect(result.trace.attributes).toEqual({
      requestKind: 'test',
      accessToken: '[REDACTED]',
    });
    expect(JSON.stringify(result.trace)).not.toContain('credential-secret');
    expect(JSON.stringify(result.trace)).not.toContain('query-secret');
    expect(JSON.stringify(result.trace)).not.toContain('cookie-secret');
  });

  it('serializes JSON parameter content and permits non-auth application API-key headers', async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const engine = new HttpExecutionEngine({
      fetch: vi.fn(async (input, init) => {
        calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
        return jsonResponse({ ok: true });
      }),
      resolveDns: publicResolver,
    });
    const objectSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' }, active: { type: 'boolean' } },
    } as const;
    const executable = capability({
      pathTemplate: '/search/{criteria}',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['criteria', 'filter', 'applicationKey', 'metadata', 'preferences'],
        properties: {
          criteria: objectSchema,
          filter: objectSchema,
          applicationKey: { type: 'string' },
          metadata: objectSchema,
          preferences: objectSchema,
        },
      },
      parameterBindings: [
        {
          location: 'path',
          name: 'criteria',
          inputPath: ['criteria'],
          required: true,
          contentType: 'application/json',
          schema: objectSchema,
        },
        {
          location: 'query',
          name: 'filter',
          inputPath: ['filter'],
          required: true,
          contentType: 'application/vnd.example+json',
          schema: objectSchema,
        },
        {
          location: 'header',
          name: 'X-API-Key',
          inputPath: ['applicationKey'],
          required: true,
          contentType: 'text/plain',
          schema: { type: 'string' },
        },
        {
          location: 'header',
          name: 'X-Metadata',
          inputPath: ['metadata'],
          required: true,
          contentType: 'application/json',
          schema: objectSchema,
        },
        {
          location: 'cookie',
          name: 'preferences',
          inputPath: ['preferences'],
          required: true,
          contentType: 'application/json',
          schema: objectSchema,
        },
      ],
    });

    await engine.execute(executable, {
      criteria: { id: 'a/b' },
      filter: { active: true },
      applicationKey: 'public-routing-key',
      metadata: { id: '한글😀' },
      preferences: { active: false },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/v1/search/%7B%22id%22%3A%22a%2Fb%22%7D');
    expect(calls[0]?.url.searchParams.get('filter')).toBe('{"active":true}');
    expect(calls[0]?.headers.get('x-api-key')).toBe('public-routing-key');
    expect(calls[0]?.headers.get('x-metadata')).toBe('{"id":"\\ud55c\\uae00\\ud83d\\ude00"}');
    expect(calls[0]?.headers.get('cookie')).toBe('preferences=%7B%22active%22%3Afalse%7D');
  });

  it.each(['nul\u0000value', '한글', 'delete\u007fvalue', ' leading', 'trailing\t'])(
    'rejects a raw header outside the verified HTTP field-value domain: %s',
    async (value) => {
      const fetch = vi.fn<FetchImplementation>();
      const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
      const executable = capability({
        inputSchema: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
        parameterBindings: [
          {
            location: 'header',
            name: 'x-value',
            inputPath: ['value'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      });

      await expect(engine.execute(executable, { value })).rejects.toMatchObject({
        code: 'BINDING_FAILED',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('percent-encodes cookie delimiters and rejects unpaired Unicode before fetch', async () => {
    const calls: Headers[] = [];
    const fetch = vi.fn<FetchImplementation>(async (_input, init) => {
      calls.push(new Headers(init?.headers));
      return jsonResponse({ ok: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      inputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      parameterBindings: [
        {
          location: 'cookie',
          name: 'preference',
          inputPath: ['value'],
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    await expect(engine.execute(executable, { value: 'a;b\n' })).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(calls[0]?.get('cookie')).toBe('preference=a%3Bb%0A');

    await expect(engine.execute(executable, { value: '\ud800' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { headers: { authorization: 'Bearer 한글' } },
    { headers: { authorization: ' Bearer token' } },
    { headers: { authorization: 'Bearer token\t' } },
    { query: { api_key: '\ud800' } },
    { cookies: { session: '\ud800' } },
  ])(
    'rejects credential material that cannot be represented on the HTTP wire',
    async (material) => {
      const fetch = vi.fn<FetchImplementation>();
      const engine = new HttpExecutionEngine({
        fetch,
        resolveDns: publicResolver,
        credentialProvider: { resolve: vi.fn(async () => material) },
      });

      await expect(engine.execute(capability({ authRequired: true }), {})).rejects.toMatchObject({
        code: 'CREDENTIAL_RESOLUTION_FAILED',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('pins connector lookup to the verified DNS snapshot without a system-DNS fallback', async () => {
    const lookup = createPinnedLookup('api.example.com', [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const resolved = await new Promise<unknown>((resolve, reject) => {
      lookup('api.example.com', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });

    expect(resolved).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    await expect(
      new Promise((resolve, reject) => {
        lookup('attacker.invalid', { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses);
        });
      }),
    ).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('validates input before DNS resolution or fetch dispatch', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const resolveDns = vi.fn<DnsResolver>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns });
    const executable = capability({
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    });

    await expect(engine.execute(executable, {})).rejects.toMatchObject({
      code: 'INPUT_VALIDATION_FAILED',
    });
    expect(resolveDns).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe execution context values without attempting credentials or network I/O', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const resolveDns = vi.fn<DnsResolver>();
    const resolveCredentials = vi.fn();
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns,
      credentialProvider: { resolve: resolveCredentials },
    });
    const circular: Record<string, JsonValue> = {};
    circular['self'] = circular;

    await expect(
      engine.execute(capability(), {}, { context: { traceAttributes: circular } }),
    ).rejects.toMatchObject({
      code: 'BINDING_FAILED',
      trace: { attributes: {} },
    });
    expect(resolveDns).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects TRACE before resolving credentials or dispatching a request', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const resolveDns = vi.fn<DnsResolver>();
    const resolveCredentials = vi.fn();
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns,
      credentialProvider: { resolve: resolveCredentials },
    });

    await expect(
      engine.execute(capability({ method: 'TRACE', authRequired: true }), {}),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    expect(resolveDns).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe schema patterns before DNS or network activity', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const resolveDns = vi.fn<DnsResolver>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns });
    const executable = capability({
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', pattern: '(a+)+$' } },
      },
    });

    await expect(engine.execute(executable, { value: 'aaaa' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(resolveDns).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces configurable input complexity limits before validation', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns: publicResolver,
      complexity: { values: { maxArrayItems: 2 } },
    });
    const executable = capability({
      inputSchema: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'number' } } },
      },
    });

    await expect(engine.execute(executable, { values: [1, 2, 3] })).rejects.toMatchObject({
      code: 'INPUT_VALIDATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies the total deadline to DNS and propagates an abort signal', async () => {
    vi.useFakeTimers();
    try {
      let resolverSignal: AbortSignal | undefined;
      let markResolverStarted: (() => void) | undefined;
      const resolverStarted = new Promise<void>((resolve) => {
        markResolverStarted = resolve;
      });
      const resolveDns: DnsResolver = async (_hostname, context) => {
        resolverSignal = context?.signal;
        markResolverStarted?.();
        return new Promise<never>(() => undefined);
      };
      const fetch = vi.fn<FetchImplementation>();
      const engine = new HttpExecutionEngine({ fetch, resolveDns });

      const execution = engine.execute(capability(), {}, { policy: { totalTimeoutMs: 10 } });
      const timeout = expect(execution).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
      await resolverStarted;
      await vi.advanceTimersByTimeAsync(10);

      await timeout;
      expect(resolverSignal?.aborted).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates each compiled parameter schema even when the aggregate schema is permissive', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      pathTemplate: '/items/{id}',
      inputSchema: { type: 'object' },
      parameterBindings: [
        {
          location: 'path',
          name: 'id',
          inputPath: ['id'],
          required: true,
          schema: { type: 'integer' },
        },
      ],
    });

    await expect(engine.execute(executable, { id: 'not-an-integer' })).rejects.toMatchObject({
      code: 'INPUT_VALIDATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects dot-segment path traversal produced by a bound parameter', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      pathTemplate: '/users/{id}',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      parameterBindings: [
        {
          location: 'path',
          name: 'id',
          inputPath: ['id'],
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    await expect(engine.execute(executable, { id: '..' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    '/%2e%2e/admin',
    '/%252e%252e/admin',
    '/safe\\..\\admin',
    '/items?fixed=true',
    `/items/${String.fromCharCode(0xd800)}`,
  ])('blocks decoder-sensitive static path %s before fetch', async (pathTemplate) => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await expect(engine.execute(capability({ pathTemplate }), {})).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks repeatedly encoded dot segments produced by a bound parameter before fetch', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      pathTemplate: '/users/{id}',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      parameterBindings: [
        {
          location: 'path',
          name: 'id',
          inputPath: ['id'],
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    await expect(engine.execute(executable, { id: '%2e%2e' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the server base path for valid Unicode percent encoding and templates', async () => {
    const calls: string[] = [];
    const fetch = vi.fn<FetchImplementation>(async (input) => {
      calls.push(String(input));
      return jsonResponse({ ok: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      pathTemplate: '/caf%C3%A9/{name}',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      parameterBindings: [
        {
          location: 'path',
          name: 'name',
          inputPath: ['name'],
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    await expect(engine.execute(executable, { name: '한글' })).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(calls).toEqual(['https://api.example.com/v1/caf%C3%A9/%ED%95%9C%EA%B8%80']);
  });

  it('preserves valid Unicode query names and rejects lone surrogates before fetch', async () => {
    const calls: string[] = [];
    const fetch = vi.fn<FetchImplementation>(async (input) => {
      calls.push(String(input));
      return jsonResponse({ ok: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const binding = {
      location: 'query' as const,
      name: '검색',
      inputPath: ['value'],
      required: true,
      schema: { type: 'string' } as const,
    };
    const executable = capability({
      inputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      parameterBindings: [binding],
    });

    await engine.execute(executable, { value: '서울' });
    expect(new URL(calls[0]!).searchParams.get('검색')).toBe('서울');

    const unsafe = capability({
      inputSchema: executable.inputSchema,
      parameterBindings: [{ ...binding, name: String.fromCharCode(0xd800) }],
    });
    await expect(engine.execute(unsafe, { value: '서울' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the same percent-encoded server-variable substitution as verification', async () => {
    const calls: string[] = [];
    const fetch = vi.fn<FetchImplementation>(async (input) => {
      calls.push(String(input));
      return jsonResponse({ ok: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await engine.execute(
      capability({
        servers: [
          {
            template: 'https://api.example.com/v1/{tenant}',
            variables: { tenant: { default: 'a/b' } },
          },
        ],
      }),
      {},
    );

    expect(calls).toEqual(['https://api.example.com/v1/a%2Fb/health']);
  });

  it('rejects a non-canonical resolved server URL before fetch', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await expect(
      engine.execute(
        capability({
          servers: [
            {
              template: 'https://api.example.com/v1/%2e%2e/admin',
              resolvedUrl: 'https://api.example.com/v1/%2e%2e/admin',
              variables: {},
            },
          ],
        }),
        {},
      ),
    ).rejects.toMatchObject({ code: 'BINDING_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['loopback', '127.0.0.1', 4],
    ['private', '10.1.2.3', 4],
    ['link-local metadata', '169.254.169.254', 4],
    ['IPv6 loopback', '::1', 6],
    ['IPv6 unique-local', 'fd00:ec2::254', 6],
    ['IPv6 deprecated site-local', 'fec0::1', 6],
    ['IPv6 NAT64 transition', '64:ff9b::7f00:1', 6],
    ['IPv6 6to4 transition', '2002:7f00:1::', 6],
    ['IPv6 Teredo transition', '2001:0:4136:e378::', 6],
    ['IPv4-mapped IPv6 loopback', '::ffff:7f00:1', 6],
    ['expanded IPv4-mapped IPv6 loopback', '0:0:0:0:0:ffff:7f00:1', 6],
    ['expanded dotted IPv4-mapped IPv6 loopback', '0:0:0:0:0:ffff:127.0.0.1', 6],
    ['expanded IPv4-mapped IPv6 private address', '0:0:0:0:0:ffff:a00:1', 6],
    ['expanded dotted IPv4-mapped IPv6 private address', '0:0:0:0:0:ffff:10.0.0.1', 6],
    ['partially compressed dotted IPv4-mapped IPv6 private address', '0:0::ffff:192.168.1.1', 6],
  ] as const)('blocks %s destinations before fetch', async (_label, address, family) => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns: vi.fn(async () => [{ address, family }]),
    });

    await expect(engine.execute(capability(), {})).rejects.toMatchObject({
      code: 'DESTINATION_BLOCKED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['compressed hexadecimal', '::ffff:5db8:d822'],
    ['partially compressed hexadecimal', '0:0::ffff:5db8:d822'],
    ['expanded hexadecimal', '0:0:0:0:0:ffff:5db8:d822'],
    ['compressed embedded dotted', '::ffff:93.184.216.34'],
    ['partially compressed embedded dotted', '0:0::ffff:93.184.216.34'],
    ['expanded embedded dotted', '0:0:0:0:0:ffff:93.184.216.34'],
  ] as const)(
    'allows a public IPv4-mapped IPv6 destination in %s form',
    async (_label, address) => {
      const fetch = vi.fn<FetchImplementation>(async () => jsonResponse({ ok: true }));
      const engine = new HttpExecutionEngine({
        fetch,
        resolveDns: vi.fn(async () => [{ address, family: 6 as const }]),
      });

      await expect(engine.execute(capability(), {})).resolves.toMatchObject({
        output: { ok: true },
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('always enforces the host allowlist independently of the injected destination policy', async () => {
    const destinationPolicy: DestinationPolicy = { assertAllowed: vi.fn() };
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns: publicResolver,
      destinationPolicy,
    });

    await expect(
      engine.execute(
        capability(),
        {},
        {
          policy: { allowedHosts: [{ hostname: 'other.example.com' }] },
        },
      ),
    ).rejects.toMatchObject({ code: 'DESTINATION_BLOCKED' });
    expect(destinationPolicy.assertAllowed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows an injected destination policy to authorize a private network intentionally', async () => {
    const destinationPolicy: DestinationPolicy = { assertAllowed: vi.fn() };
    const fetch: FetchImplementation = vi.fn(async () => jsonResponse({ ok: true }));
    const engine = new HttpExecutionEngine({
      fetch,
      resolveDns: vi.fn(async () => [{ address: '10.10.0.2', family: 4 }] as const),
      destinationPolicy,
    });

    await expect(engine.execute(capability(), {})).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(destinationPolicy.assertAllowed).toHaveBeenCalled();
  });

  it('retries only capabilities proven idempotent and reuses one idempotency key', async () => {
    const sleep = vi.fn(async () => undefined);
    const idempotentFetch: FetchImplementation = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ updated: true }));
    const engine = new HttpExecutionEngine({
      fetch: idempotentFetch,
      resolveDns: publicResolver,
      sleep,
      createExecutionId: () => 'stable-key',
    });
    const executable = capability({
      method: 'PUT',
      risk: {
        level: 'write',
        sideEffect: 'definite',
        idempotency: 'idempotent',
      },
    });

    await engine.execute(
      executable,
      {},
      {
        policy: {
          idempotencyKeyHeader: 'idempotency-key',
          retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        },
      },
    );
    expect(idempotentFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    for (const call of vi.mocked(idempotentFetch).mock.calls) {
      expect(new Headers(call[1]?.headers).get('idempotency-key')).toBe('stable-key');
    }

    const nonIdempotentFetch: FetchImplementation = vi.fn(async () =>
      jsonResponse({ retry: false }, 503),
    );
    const nonIdempotentEngine = new HttpExecutionEngine({
      fetch: nonIdempotentFetch,
      resolveDns: publicResolver,
      sleep,
    });
    await expect(
      nonIdempotentEngine.execute(
        capability({
          method: 'POST',
          risk: {
            level: 'write',
            sideEffect: 'definite',
            idempotency: 'non-idempotent',
          },
        }),
        {},
        { policy: { retry: { maxAttempts: 3 } } },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR' });
    expect(nonIdempotentFetch).toHaveBeenCalledTimes(1);
  });

  it('never retries an explicitly non-idempotent safe-method override', async () => {
    const fetch: FetchImplementation = vi.fn(async () => jsonResponse({ retry: false }, 503));
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await expect(
      engine.execute(
        capability({
          method: 'GET',
          risk: {
            level: 'read',
            sideEffect: 'none',
            idempotency: 'non-idempotent',
          },
        }),
        {},
        { policy: { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } } },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('binds and validates a JSON request body', async () => {
    let capturedBody: string | undefined;
    const fetch: FetchImplementation = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body);
      return jsonResponse({ created: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      method: 'POST',
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
      requestBodies: [
        {
          contentType: 'application/json',
          inputPath: ['body'],
          required: true,
          schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      ],
    });

    await engine.execute(executable, { body: { name: 'Ada' } });
    expect(JSON.parse(capturedBody ?? '')).toEqual({ name: 'Ada' });
  });

  it('selects the only request media type whose schema matches the supplied body', async () => {
    const captured: Array<{ body: string; contentType: string | null }> = [];
    const fetch: FetchImplementation = vi.fn(async (_input, init) => {
      captured.push({
        body: String(init?.body),
        contentType: new Headers(init?.headers).get('content-type'),
      });
      return jsonResponse({ accepted: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      method: 'POST',
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: {
          body: {
            oneOf: [
              { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
              { type: 'string' },
            ],
          },
        },
      },
      requestBodies: [
        {
          contentType: 'application/json',
          inputPath: ['body'],
          required: true,
          schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
        {
          contentType: 'text/plain',
          serialization: 'text',
          inputPath: ['body'],
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    await engine.execute(executable, { body: 'plain request' });

    expect(captured).toEqual([{ body: 'plain request', contentType: 'text/plain' }]);
  });

  it('fails closed when a request body matches multiple declared media types', async () => {
    const fetch = vi.fn<FetchImplementation>();
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      method: 'POST',
      inputSchema: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string' } },
      },
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
    });

    await expect(engine.execute(executable, { body: 'ambiguous' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses an explicit selector for identical request body schemas and rejects invalid selector states', async () => {
    const captured: Array<{ body: string; contentType: string | null }> = [];
    const fetch: FetchImplementation = vi.fn(async (_input, init) => {
      captured.push({
        body: String(init?.body),
        contentType: new Headers(init?.headers).get('content-type'),
      });
      return jsonResponse({ accepted: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      method: 'POST',
      inputSchema: {
        type: 'object',
        properties: {
          body: { type: 'string' },
          bodyContentType: { type: 'string' },
        },
      },
      requestBodies: [
        {
          contentType: 'application/graphql',
          serialization: 'text',
          inputPath: ['body'],
          contentTypeInputPath: ['bodyContentType'],
          required: true,
          schema: { type: 'string' },
        },
        {
          contentType: 'text/plain',
          serialization: 'text',
          inputPath: ['body'],
          contentTypeInputPath: ['bodyContentType'],
          required: true,
          schema: { type: 'string' },
        },
      ],
    });

    await engine.execute(executable, {
      body: 'query { viewer { id } }',
      bodyContentType: 'application/graphql',
    });
    expect(captured).toEqual([
      { body: 'query { viewer { id } }', contentType: 'application/graphql' },
    ]);

    await expect(engine.execute(executable, { body: 'missing selector' })).rejects.toMatchObject({
      code: 'BINDING_FAILED',
    });
    await expect(
      engine.execute(executable, { body: 'unknown', bodyContentType: 'application/unknown' }),
    ).rejects.toMatchObject({ code: 'BINDING_FAILED' });
    await expect(
      engine.execute(executable, { bodyContentType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'BINDING_FAILED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serializes explicit XML text and canonical base64 request bodies', async () => {
    const captured: Array<{ body: BodyInit | null | undefined; contentType: string | null }> = [];
    const fetch: FetchImplementation = vi.fn(async (_input, init) => {
      captured.push({
        body: init?.body,
        contentType: new Headers(init?.headers).get('content-type'),
      });
      return jsonResponse({ accepted: true });
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const inputSchema: JsonSchema = {
      type: 'object',
      required: ['body'],
      properties: { body: { type: 'string' } },
    };

    await engine.execute(
      capability({
        method: 'POST',
        inputSchema,
        requestBodies: [
          {
            contentType: 'application/soap+xml',
            serialization: 'text',
            inputPath: ['body'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      }),
      { body: '<Envelope />' },
    );
    await engine.execute(
      capability({
        method: 'POST',
        inputSchema,
        requestBodies: [
          {
            contentType: 'application/octet-stream',
            serialization: 'base64',
            inputPath: ['body'],
            required: true,
            schema: { type: 'string' },
          },
        ],
      }),
      { body: Buffer.from('binary payload').toString('base64') },
    );

    expect(captured[0]).toMatchObject({
      body: '<Envelope />',
      contentType: 'application/soap+xml',
    });
    expect(Buffer.from(captured[1]?.body as Uint8Array).toString('utf8')).toBe('binary payload');
    expect(captured[1]?.contentType).toBe('application/octet-stream');

    await expect(
      engine.execute(
        capability({
          method: 'POST',
          inputSchema,
          requestBodies: [
            {
              contentType: 'application/octet-stream',
              serialization: 'base64',
              inputPath: ['body'],
              required: true,
              schema: { type: 'string' },
            },
          ],
        }),
        { body: 'not base64' },
      ),
    ).rejects.toMatchObject({ code: 'BINDING_FAILED' });
    await expect(
      engine.execute(
        capability({
          method: 'POST',
          inputSchema,
          requestBodies: [
            {
              contentType: 'application/octet-stream',
              serialization: 'base64',
              inputPath: ['body'],
              required: true,
              schema: { type: 'string' },
            },
          ],
        }),
        { body: 'd29ybGQ' },
      ),
    ).rejects.toMatchObject({ code: 'BINDING_FAILED' });
  });

  it('enforces response size, media type and output schema', async () => {
    const sizeEngine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ value: 'too large' })),
      resolveDns: publicResolver,
    });
    await expect(
      sizeEngine.execute(capability(), {}, { policy: { response: { maxBytes: 4 } } }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });

    const typeEngine = new HttpExecutionEngine({
      fetch: vi.fn(
        async () =>
          new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
      resolveDns: publicResolver,
    });
    await expect(typeEngine.execute(capability(), {})).rejects.toMatchObject({
      code: 'RESPONSE_CONTENT_TYPE_REJECTED',
    });

    const schemaEngine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ count: 'not-a-number' })),
      resolveDns: publicResolver,
    });
    await expect(
      schemaEngine.execute(
        capability({
          outputSchema: {
            type: 'object',
            required: ['count'],
            properties: { count: { type: 'number' } },
          },
        }),
        {},
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_VALIDATION_FAILED' });
  });

  it('requires both a 2xx status and a compiled response media type', async () => {
    const defaultResponseCapability = capability({
      successResponses: [
        {
          statusCode: 'default',
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      ],
    });
    const errorEngine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ error: 'failed' }, 500)),
      resolveDns: publicResolver,
    });
    await expect(errorEngine.execute(defaultResponseCapability, {})).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP_ERROR',
    });

    const typedCapability = capability({
      successResponses: [
        {
          statusCode: '200',
          contentType: 'text/plain',
          schema: { type: 'string' },
        },
        {
          statusCode: 'default',
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      ],
    });
    const wrongTypeEngine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ value: 'unexpected' })),
      resolveDns: publicResolver,
    });
    await expect(wrongTypeEngine.execute(typedCapability, {})).rejects.toMatchObject({
      code: 'RESPONSE_CONTENT_TYPE_REJECTED',
    });
  });

  it('does not let a runtime media allowlist replace the compiled response contract', async () => {
    const engine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ value: 'unexpected' })),
      resolveDns: publicResolver,
    });
    const executable = capability({
      successResponses: [
        {
          statusCode: '200',
          contentType: 'text/plain',
          schema: { type: 'string' },
        },
      ],
    });

    await expect(
      engine.execute(
        executable,
        {},
        {
          policy: {
            response: {
              allowedContentTypes: ['application/json'],
              parseAs: 'json',
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'RESPONSE_CONTENT_TYPE_REJECTED' });
  });

  it('does not let missing-content-type policy bypass a typed-only response contract', async () => {
    const engine = new HttpExecutionEngine({
      fetch: vi.fn(
        async () =>
          new Response(new TextEncoder().encode('"plain"'), {
            status: 200,
          }),
      ),
      resolveDns: publicResolver,
    });
    const executable = capability({
      successResponses: [
        {
          statusCode: '200',
          contentType: 'text/plain',
          schema: { type: 'string' },
        },
      ],
    });

    await expect(
      engine.execute(
        executable,
        {},
        {
          policy: {
            response: {
              allowMissingContentType: true,
              parseAs: 'json',
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'RESPONSE_CONTENT_TYPE_REJECTED' });
  });

  it('selects and validates an untyped fallback after applying runtime media policy', async () => {
    const engine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ count: 'not-a-number' })),
      resolveDns: publicResolver,
    });
    const executable = capability({
      outputSchema: { type: 'object' },
      successResponses: [
        {
          statusCode: '200',
          contentType: 'text/plain',
          schema: { type: 'string' },
        },
        {
          statusCode: '200',
          schema: {
            type: 'object',
            required: ['count'],
            properties: { count: { type: 'number' } },
          },
        },
      ],
    });

    await expect(
      engine.execute(
        executable,
        {},
        {
          policy: { response: { allowedContentTypes: ['application/json'] } },
        },
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_VALIDATION_FAILED' });
  });

  it('selects exact status contracts before class ranges and ranges before default', async () => {
    const engine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse('exact', 200)),
      resolveDns: publicResolver,
    });
    const executable = capability({
      outputSchema: { type: 'string' },
      successResponses: [
        {
          statusCode: 'default',
          contentType: 'application/json',
          schema: { const: 'fallback' },
        },
        {
          statusCode: '2XX',
          contentType: 'application/json',
          schema: { const: 'range' },
        },
        {
          statusCode: '200',
          contentType: 'application/json',
          schema: { const: 'exact' },
        },
      ],
    });

    await expect(engine.execute(executable, {})).resolves.toMatchObject({ output: 'exact' });
  });

  it('enforces configurable output complexity limits before schema validation', async () => {
    const engine = new HttpExecutionEngine({
      fetch: vi.fn(async () => jsonResponse({ values: [1, 2, 3] })),
      resolveDns: publicResolver,
      complexity: { values: { maxArrayItems: 2 } },
    });

    await expect(engine.execute(capability(), {})).rejects.toMatchObject({
      code: 'OUTPUT_VALIDATION_FAILED',
    });
  });

  it('aborts a stalled fetch at the configured attempt timeout', async () => {
    const fetch: FetchImplementation = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await expect(
      engine.execute(
        capability(),
        {},
        {
          policy: { attemptTimeoutMs: 5, totalTimeoutMs: 50 },
        },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('returns at the attempt deadline even when a custom transport ignores abort signals', async () => {
    const fetch: FetchImplementation = vi.fn(async () => new Promise<Response>(() => undefined));
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await expect(
      engine.execute(
        capability(),
        {},
        {
          policy: { attemptTimeoutMs: 5, totalTimeoutMs: 25 },
        },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('also applies the timeout while streaming the response body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: async () => new Promise<void>(() => undefined),
    });
    const fetch: FetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });

    await expect(
      engine.execute(
        capability(),
        {},
        {
          policy: { attemptTimeoutMs: 5, totalTimeoutMs: 50 },
        },
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('supports string status classes from the shared IR contract', async () => {
    const fetch: FetchImplementation = vi.fn(async (_input, init) => {
      expect(init?.method).toBe('GET');
      return jsonResponse({ traced: true }, 207);
    });
    const engine = new HttpExecutionEngine({ fetch, resolveDns: publicResolver });
    const executable = capability({
      method: 'GET',
      successResponses: [
        {
          statusCode: '2XX',
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      ],
    });

    await expect(engine.execute(executable, {})).resolves.toMatchObject({
      output: { traced: true },
    });
  });
});

describe('PublicDestinationPolicy', () => {
  it('rejects direct localhost URL literals even with a forged public resolver result', () => {
    const policy = new PublicDestinationPolicy();
    expect(() =>
      policy.assertAllowed({
        url: new URL('https://localhost/mcp'),
        addresses: [{ address: '93.184.216.34', family: 4 }],
        allowedHosts: [{ hostname: 'localhost' }],
        allowInsecureHttp: false,
      }),
    ).toThrowError(ExecutionEngineError);
  });
});
