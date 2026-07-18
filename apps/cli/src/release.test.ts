import {
  NormalizedApiDocumentSchema,
  fingerprint,
  stableId,
  type NormalizedApiDocument,
} from '@hi-mcp/capability-ir';
import { verifyRelease } from '@hi-mcp/deterministic-verifier';
import { adaptOpenApi } from '@hi-mcp/openapi-adapter';
import { describe, expect, it } from 'vitest';
import { createBaselineRelease } from './release.js';

function exampleDocument(): NormalizedApiDocument {
  const provenance = {
    sourceKind: 'openapi',
    sourceId: 'fixture',
    documentFingerprint: fingerprint({ fixture: true }),
    pointer: '/paths/~1customers/get',
    operationId: 'searchCustomers',
  };
  const operation = {
    id: stableId('operation', 'GET', '/customers'),
    operationId: 'searchCustomers',
    method: 'GET' as const,
    path: '/customers',
    summary: 'Search customers',
    description: 'Search customers by email address.',
    tags: ['customers'],
    deprecated: false,
    servers: [{ template: 'https://api.example.com', resolvedUrl: 'https://api.example.com/' }],
    parameters: [
      {
        location: 'query' as const,
        name: 'query',
        inputPath: ['query'],
        required: true,
        schema: { type: 'string' },
      },
    ],
    requestBodies: [],
    successResponses: [
      {
        statusCode: '200',
        contentType: 'application/json',
        schema: { type: 'object' },
      },
    ],
    auth: { required: false, alternatives: [], schemes: {} },
    provenance,
    fingerprint: fingerprint({ operation: 'searchCustomers' }),
  };

  return NormalizedApiDocumentSchema.parse({
    sourceId: 'fixture',
    sourceFormat: 'object',
    sourceKind: 'openapi',
    sourceVersion: '3.1.0',
    openapiVersion: '3.1.0',
    title: 'Fixture API',
    version: '1.0.0',
    documentFingerprint: provenance.documentFingerprint,
    servers: operation.servers,
    securitySchemes: {},
    operations: [operation],
  });
}

describe('createBaselineRelease', () => {
  it('produces the same material identity independently of compilation time', () => {
    const document = exampleDocument();
    const first = createBaselineRelease(document, [], {
      compilerName: '@hi-mcp/cli',
      compilerVersion: '0.1.0',
      now: () => new Date('2026-07-14T01:00:00.000Z'),
    });
    const second = createBaselineRelease(document, [], {
      compilerName: '@hi-mcp/cli',
      compilerVersion: '0.1.0',
      now: () => new Date('2026-07-14T02:00:00.000Z'),
    });

    expect(first.release.fingerprint).toBe(second.release.fingerprint);
    expect(first.release.id).toBe(second.release.id);
    expect(first.release.createdAt).not.toBe(second.release.createdAt);
    expect(first.release.capabilities).toHaveLength(1);
  });

  it('creates a verified release when distinct operation ids normalize to the same tool name', () => {
    const adapted = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Colliding tool names' },
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/one': {
          get: { operationId: 'get.user', responses: { '204': { description: 'ok' } } },
        },
        '/two': {
          get: { operationId: 'get/user', responses: { '204': { description: 'ok' } } },
        },
      },
    });
    expect(adapted.hasErrors).toBe(false);
    expect(adapted.document).not.toBeNull();
    if (adapted.document === null) throw new Error('Expected a normalized document');

    const { release } = createBaselineRelease(adapted.document, adapted.diagnostics, {
      compilerName: '@hi-mcp/cli',
      compilerVersion: '0.1.0',
      now: () => new Date('2026-07-14T01:00:00.000Z'),
    });

    expect(new Set(release.capabilities.map(({ name }) => name)).size).toBe(2);
    expect(verifyRelease(release, { sourceDocuments: [adapted.document] }).valid).toBe(true);
  });
});
