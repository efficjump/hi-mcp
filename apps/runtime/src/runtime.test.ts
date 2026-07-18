import {
  ReleaseSchema,
  WELL_FORMED_UNICODE_PATTERN,
  fingerprint,
  shallowParameterTextWireSchema,
  stableId,
  type Capability,
  type Release,
} from '@hi-mcp/capability-ir';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReleaseRuntime, ReleaseVerificationError } from './runtime.js';
import { createReleaseServer } from './server.js';

const OPERATOR_EXECUTION_POLICY = {
  allowedHosts: [{ hostname: 'api.example.com' }],
} as const;

function capability(
  method: 'GET' | 'POST' | 'DELETE',
  requiresConfirmation = method !== 'GET',
): Capability {
  const risk =
    method === 'GET'
      ? {
          level: 'read' as const,
          sideEffect: 'none' as const,
          idempotency: 'idempotent' as const,
          requiresConfirmation,
          rationale: [],
        }
      : method === 'POST'
        ? {
            level: 'write' as const,
            sideEffect: 'definite' as const,
            idempotency: 'non-idempotent' as const,
            requiresConfirmation,
            rationale: [],
          }
        : {
            level: 'destructive' as const,
            sideEffect: 'definite' as const,
            idempotency: 'idempotent' as const,
            requiresConfirmation,
            rationale: [],
          };
  const draft = {
    schemaVersion: '1.0' as const,
    id: stableId('capability', method, '/items/{itemId}'),
    name: method === 'GET' ? 'getItem' : method === 'POST' ? 'updateItem' : 'deleteItem',
    description: `${method} an item`,
    intent: { useWhen: [], avoidWhen: [], examples: [], tags: [] },
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
    risk,
    execution: {
      kind: 'http' as const,
      method,
      pathTemplate: '/items/{itemId}',
      servers: [
        {
          template: 'https://api.example.com',
          resolvedUrl: 'https://api.example.com/',
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
      documentFingerprint: fingerprint({ fixture: true }),
      pointer: `/paths/~1items~1{itemId}/${method.toLowerCase()}`,
    },
  };
  return { ...draft, fingerprint: fingerprint(draft) };
}

function release(capabilities: readonly Capability[]): Release {
  const material = {
    schemaVersion: '1.0' as const,
    sequence: 0,
    compiler: { name: 'fixture', version: '1.0.0' },
    sources: [
      {
        sourceId: 'fixture',
        sourceKind: 'openapi-3.1.0',
        fingerprint: fingerprint({ fixture: true }),
      },
    ],
    capabilities,
    diagnostics: [],
  };
  const releaseFingerprint = fingerprint(material);
  return ReleaseSchema.parse({
    ...material,
    id: stableId('release', releaseFingerprint),
    createdAt: '2026-07-14T00:00:00.000Z',
    fingerprint: releaseFingerprint,
  });
}

function successfulExecution(capability: Capability) {
  return {
    output: { id: 'item_1' },
    trace: {
      executionId: `exec_${capability.name}`,
      capabilityId: capability.id,
      capabilityName: capability.name,
      method: capability.execution.method,
      serverIndex: 0,
      target: {
        protocol: 'https:',
        hostname: 'api.example.com',
        port: '',
        pathTemplate: capability.execution.pathTemplate,
      },
      startedAt: '2026-07-14T00:00:00.000Z',
      durationMs: 1,
      attempts: 1,
      status: 200,
      outcome: 'success' as const,
      attributes: {},
    },
  };
}

describe('ReleaseRuntime', () => {
  it('exposes deterministic tool definitions and risk annotations', () => {
    const runtime = new ReleaseRuntime(release([capability('GET')]));

    expect(runtime.listTools()).toEqual([
      expect.objectContaining({
        name: 'getItem',
        annotations: expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        }),
      }),
    ]);
  });

  it('deep-freezes the verified release before exposing it to policy callbacks', () => {
    const runtime = new ReleaseRuntime(release([capability('GET')]));

    expect(Object.isFrozen(runtime.release)).toBe(true);
    expect(Object.isFrozen(runtime.release.capabilities[0]?.execution)).toBe(true);
  });

  it.each([
    ['GET', 'getItem'],
    ['POST', 'updateItem'],
    ['DELETE', 'deleteItem'],
  ] as const)(
    'gates a confirmation-required %s capability regardless of risk level',
    async (method, name) => {
      const execute = vi.fn();
      const runtime = new ReleaseRuntime(release([capability(method, true)]), {
        executor: { execute },
        policy: { execution: OPERATOR_EXECUTION_POLICY },
      });

      await expect(runtime.callTool(name, { itemId: 'item_1' })).resolves.toMatchObject({
        isError: true,
        code: 'CONFIRMATION_REQUIRED',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('uses a per-call callback as the authoritative approval decision', async () => {
    const write = capability('POST');
    const execute = vi.fn(async () => successfulExecution(write));
    const approveConfirmationRequired = vi.fn(async () => true);
    const runtime = new ReleaseRuntime(release([write]), {
      executor: { execute },
      policy: { approveConfirmationRequired, execution: OPERATOR_EXECUTION_POLICY },
    });

    const context = { traceAttributes: { request: 'mcp_1' } };
    await expect(
      runtime.callTool('updateItem', { itemId: 'item_1' }, context),
    ).resolves.toMatchObject({ isError: false, output: { id: 'item_1' } });
    expect(approveConfirmationRequired).toHaveBeenCalledWith({
      capability: write,
      input: { itemId: 'item_1' },
      context,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not let the coarse opt-in bypass a rejecting per-call callback', async () => {
    const destructive = capability('DELETE');
    const execute = vi.fn();
    const runtime = new ReleaseRuntime(release([destructive]), {
      executor: { execute },
      policy: {
        allowConfirmationRequired: true,
        approveConfirmationRequired: () => false,
        execution: OPERATOR_EXECUTION_POLICY,
      },
    });

    await expect(runtime.callTool('deleteItem', { itemId: 'item_1' })).resolves.toMatchObject({
      isError: true,
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('supports an explicitly named coarse opt-in for non-interactive runtimes', async () => {
    const destructive = capability('DELETE');
    const execute = vi.fn(async () => successfulExecution(destructive));
    const runtime = new ReleaseRuntime(release([destructive]), {
      executor: { execute },
      policy: {
        allowConfirmationRequired: true,
        execution: OPERATOR_EXECUTION_POLICY,
      },
    });

    await expect(runtime.callTool('deleteItem', { itemId: 'item_1' })).resolves.toMatchObject({
      isError: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns structured output from the injected deterministic executor', async () => {
    const get = capability('GET');
    const execute = vi.fn(async () => successfulExecution(get));
    const runtime = new ReleaseRuntime(release([get]), {
      executor: { execute },
      policy: { execution: OPERATOR_EXECUTION_POLICY },
    });

    await expect(runtime.callTool('getItem', { itemId: 'item_1' })).resolves.toMatchObject({
      isError: false,
      output: { id: 'item_1' },
    });
  });

  it('rejects complex post-parse tool input before approval or execution', async () => {
    const get = capability('GET');
    const execute = vi.fn();
    const runtime = new ReleaseRuntime(release([get]), {
      executor: { execute },
      inputLimits: { maxDepth: 1, maxNodes: 10, maxStringBytes: 64 },
    });

    await expect(
      runtime.callTool('getItem', { nested: { value: 'too-deep' } }),
    ).resolves.toMatchObject({
      isError: true,
      code: 'TOOL_ARGUMENT_LIMIT_EXCEEDED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires operator host authorization unless the development opt-in is explicit', async () => {
    const get = capability('GET');
    const execute = vi.fn(async () => successfulExecution(get));
    const lockedRuntime = new ReleaseRuntime(release([get]), { executor: { execute } });

    await expect(lockedRuntime.callTool('getItem', { itemId: 'item_1' })).resolves.toMatchObject({
      isError: true,
      code: 'DESTINATION_ALLOWLIST_REQUIRED',
    });
    expect(execute).not.toHaveBeenCalled();

    const developmentRuntime = new ReleaseRuntime(release([get]), {
      executor: { execute },
      policy: { trustCompiledHosts: true },
    });
    await expect(
      developmentRuntime.callTool('getItem', { itemId: 'item_1' }),
    ).resolves.toMatchObject({ isError: false });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails closed when endpoint, risk, or release metadata is tampered', () => {
    const original = release([capability('GET')]);
    const originalCapability = original.capabilities[0]!;
    const endpointTampered = {
      ...original,
      capabilities: [
        {
          ...originalCapability,
          execution: {
            ...originalCapability.execution,
            servers: [
              {
                template: 'https://attacker.example.test',
                resolvedUrl: 'https://attacker.example.test/',
                variables: {},
              },
            ],
          },
        },
      ],
    };
    const riskTampered = {
      ...original,
      capabilities: [
        {
          ...originalCapability,
          risk: {
            ...originalCapability.risk,
            level: 'destructive' as const,
            sideEffect: 'definite' as const,
            requiresConfirmation: false,
          },
        },
      ],
    };
    const releaseTampered = {
      ...original,
      compiler: { ...original.compiler, version: '9.9.9' },
    };

    for (const tampered of [endpointTampered, riskTampered, releaseTampered]) {
      expect(() => new ReleaseRuntime(tampered)).toThrow(ReleaseVerificationError);
    }
  });

  it('negotiates MCP and exposes the verified tools through a real client transport', async () => {
    const get = capability('GET');
    const runtime = new ReleaseRuntime(release([get]), {
      policy: { execution: OPERATOR_EXECUTION_POLICY },
      executor: {
        async execute() {
          return {
            output: { id: 'item_1' },
            trace: {
              executionId: 'exec_mcp',
              capabilityId: get.id,
              capabilityName: get.name,
              method: 'GET',
              serverIndex: 0,
              target: {
                protocol: 'https:',
                hostname: 'api.example.com',
                port: '',
                pathTemplate: '/items/{itemId}',
              },
              startedAt: '2026-07-14T00:00:00.000Z',
              durationMs: 1,
              attempts: 1,
              status: 200,
              outcome: 'success',
              attributes: {},
            },
          };
        },
      },
    });
    const server = createReleaseServer(runtime, { version: '1.0.0' });
    const client = new Client({ name: 'fixture-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const listed = await client.listTools();
      expect(listed.tools).toEqual([
        expect.objectContaining({
          name: 'getItem',
          annotations: expect.objectContaining({ readOnlyHint: true }),
        }),
      ]);
      await expect(
        client.callTool({ name: 'getItem', arguments: { itemId: 'item_1' } }),
      ).resolves.toMatchObject({
        isError: false,
        structuredContent: { id: 'item_1' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns the confirmation gate as an MCP tool error before execution', async () => {
    const write = capability('POST');
    const execute = vi.fn();
    const runtime = new ReleaseRuntime(release([write]), {
      executor: { execute },
      policy: { execution: OPERATOR_EXECUTION_POLICY },
    });
    const server = createReleaseServer(runtime, { version: '1.0.0' });
    const client = new Client({ name: 'fixture-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: 'updateItem',
        arguments: { itemId: 'item_1' },
      });
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('CONFIRMATION_REQUIRED'),
        }),
      ]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
