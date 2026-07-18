import { describe, expect, it } from 'vitest';

import {
  NoEligibleSemanticModelError,
  SemanticModelRouter,
  type SemanticModelProvider,
  type SemanticModelRequest,
  type SemanticModelResponse,
} from './model-provider.js';

function provider(
  id: string,
  models: Awaited<ReturnType<SemanticModelProvider['listModels']>>,
): SemanticModelProvider {
  return {
    id,
    async listModels() {
      return models;
    },
    async generateStructured(_request: SemanticModelRequest): Promise<SemanticModelResponse> {
      return { output: {} };
    },
  };
}

describe('SemanticModelRouter', () => {
  it('selects dynamically using capabilities, quality, cost, latency and availability', async () => {
    const router = new SemanticModelRouter(
      [
        provider('provider-a', [
          {
            id: 'high-quality',
            capabilities: ['structured-output', 'long-context'],
            quality: { semanticCompilation: 0.96 },
            contextWindowTokens: 32_000,
            estimatedInputCostPerMillionTokens: 4,
            estimatedOutputCostPerMillionTokens: 12,
            observedLatencyMs: 800,
            availability: 0.99,
          },
        ]),
        provider('provider-b', [
          {
            id: 'balanced',
            capabilities: ['structured-output', 'long-context'],
            quality: { semanticCompilation: 0.88 },
            contextWindowTokens: 64_000,
            estimatedInputCostPerMillionTokens: 0.5,
            estimatedOutputCostPerMillionTokens: 1.5,
            observedLatencyMs: 180,
            availability: 0.999,
          },
        ]),
      ],
      {
        objectiveWeights: { quality: 0.2, cost: 0.25, latency: 0.25, availability: 0.3 },
        missingMetricScore: 0,
      },
    );

    const selected = await router.select({
      requiredCapabilities: ['structured-output'],
      qualityWeights: { semanticCompilation: 1 },
      estimatedInputTokens: 3_000,
      estimatedOutputTokens: 1_000,
    });

    expect(selected.provider.id).toBe('provider-b');
    expect(selected.descriptor.id).toBe('balanced');
  });

  it('filters models that do not meet operational constraints', async () => {
    const router = new SemanticModelRouter(
      [
        provider('provider-a', [
          {
            id: 'small',
            capabilities: ['structured-output'],
            quality: { semanticCompilation: 1 },
            contextWindowTokens: 1_000,
          },
        ]),
      ],
      {
        objectiveWeights: { quality: 1, cost: 0, latency: 0, availability: 0 },
        missingMetricScore: 0,
      },
    );

    await expect(
      router.select({
        requiredCapabilities: ['structured-output'],
        qualityWeights: { semanticCompilation: 1 },
        estimatedInputTokens: 2_000,
        estimatedOutputTokens: 500,
      }),
    ).rejects.toBeInstanceOf(NoEligibleSemanticModelError);
  });

  it('continues discovery when one provider is unavailable', async () => {
    const failing: SemanticModelProvider = {
      id: 'offline',
      async listModels() {
        throw new Error('catalog unavailable');
      },
      async generateStructured() {
        return { output: {} };
      },
    };
    const healthy = provider('healthy', [
      {
        id: 'ready',
        capabilities: ['structured-output'],
        quality: { semanticCompilation: 0.8 },
        contextWindowTokens: 8_000,
      },
    ]);
    const router = new SemanticModelRouter([failing, healthy], {
      objectiveWeights: { quality: 1, cost: 0, latency: 0, availability: 0 },
      missingMetricScore: 0,
    });

    const selected = await router.select({
      requiredCapabilities: ['structured-output'],
      qualityWeights: { semanticCompilation: 1 },
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
    });

    expect(selected.provider.id).toBe('healthy');
  });

  it('rejects a provider catalogue that is not a bounded plain array', async () => {
    const malformed: SemanticModelProvider = {
      id: 'malformed',
      async listModels() {
        return { model: 'not-an-array' } as unknown as readonly never[];
      },
      async generateStructured() {
        return { output: {} };
      },
    };
    const router = new SemanticModelRouter([malformed], {
      objectiveWeights: { quality: 1, cost: 0, latency: 0, availability: 0 },
      missingMetricScore: 0,
    });

    await expect(
      router.rank({
        requiredCapabilities: [],
        qualityWeights: {},
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      }),
    ).rejects.toBeInstanceOf(NoEligibleSemanticModelError);
  });
});
