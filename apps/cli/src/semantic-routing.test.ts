import { describe, expect, it, vi } from 'vitest';
import type { SemanticModelProvider } from '@hi-mcp/semantic-compiler';

import { loadConfig } from './config.js';
import { prepareSemanticCompiler } from './semantic-routing.js';
import { createBaselineRelease } from './release.js';
import { NormalizedApiDocumentSchema, fingerprint, stableId } from '@hi-mcp/capability-ir';

function baselineCapability() {
  const document = NormalizedApiDocumentSchema.parse({
    sourceId: 'fixture',
    sourceFormat: 'object',
    sourceKind: 'openapi',
    sourceVersion: '3.1.0',
    openapiVersion: '3.1.0',
    title: 'Fixture',
    documentFingerprint: fingerprint({ source: 'fixture' }),
    servers: [
      {
        template: 'https://api.example.com',
        resolvedUrl: 'https://api.example.com/',
        variables: {},
      },
    ],
    securitySchemes: {},
    operations: [
      {
        id: stableId('operation', 'GET', '/items'),
        operationId: 'listItems',
        method: 'GET',
        path: '/items',
        summary: 'List items',
        tags: ['items'],
        deprecated: false,
        servers: [
          {
            template: 'https://api.example.com',
            resolvedUrl: 'https://api.example.com/',
            variables: {},
          },
        ],
        parameters: [],
        requestBodies: [],
        successResponses: [],
        auth: { required: false, alternatives: [], schemes: {} },
        provenance: {
          sourceKind: 'openapi',
          sourceId: 'fixture',
          documentFingerprint: fingerprint({ source: 'fixture' }),
          pointer: '/paths/~1items/get',
          operationId: 'listItems',
        },
        fingerprint: fingerprint({ operation: 'listItems' }),
      },
    ],
  });
  return createBaselineRelease(document, [], {
    compilerName: 'fixture',
    compilerVersion: '1.0.0',
  }).release.capabilities[0]!;
}

describe('prepareSemanticCompiler', () => {
  it('discovers quality dimensions and dynamically routes to the strongest model', async () => {
    const capability = baselineCapability();
    const generateStructured = vi.fn(async (request) => ({
      output: {
        schemaVersion: '1.0',
        capabilityId: capability.id,
        baseFingerprint: capability.fingerprint,
        changes: { description: `Improved by ${request.modelId}` },
        confidence: 0.9,
        rationale: ['Grounded in the source operation.'],
      },
    }));
    const provider: SemanticModelProvider = {
      id: 'fixture-provider',
      async listModels() {
        return [
          {
            id: 'lower-quality',
            capabilities: ['structured-output'],
            quality: { grounding: 0.3, schemaReasoning: 0.4 },
            contextWindowTokens: 32_000,
          },
          {
            id: 'higher-quality',
            capabilities: ['structured-output'],
            quality: { grounding: 0.95, schemaReasoning: 0.9 },
            contextWindowTokens: 32_000,
          },
        ];
      },
      generateStructured,
    };
    const defaults = (await loadConfig()).config;
    const semantic = {
      ...defaults.semantic,
      routing: {
        ...defaults.semantic.routing,
        requiredCapabilities: ['structured-output'],
        objectiveWeights: { quality: 1, cost: 0, latency: 0, availability: 0 },
      },
    };
    const prepared = await prepareSemanticCompiler([provider], semantic, {
      name: 'fixture',
      version: '1.0.0',
    });

    const result = await prepared.compile(capability);

    expect(prepared.qualityDimensions).toEqual(['grounding', 'schemaReasoning']);
    expect(result.candidate.capability.description).toBe('Improved by higher-quality');
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(generateStructured.mock.calls[0]?.[0]).toMatchObject({ modelId: 'higher-quality' });
  });
});
