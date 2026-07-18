import { fingerprint, type Capability } from '@hi-mcp/capability-ir';
import {
  DefaultSemanticPromptFactory,
  SemanticCompiler,
  assertSemanticDataSafe,
  SemanticModelDescriptorSchema,
  SemanticModelRouter,
  type CompilerIdentity,
  type ModelRoutingRequirements,
  type SemanticCompilationResult,
  type SemanticModelDescriptor,
  type SemanticModelProvider,
} from '@hi-mcp/semantic-compiler';

import type { HiMcpConfig } from './config.js';

export interface SemanticDiscoveryFailure {
  readonly provider: string;
  readonly message: string;
}

export interface PreparedSemanticCompiler {
  readonly providerCount: number;
  readonly modelCount: number;
  readonly qualityDimensions: readonly string[];
  readonly failures: readonly SemanticDiscoveryFailure[];
  compile(capability: Capability, signal?: AbortSignal): Promise<SemanticCompilationResult>;
}

function cachedProvider(
  provider: SemanticModelProvider,
  models: readonly SemanticModelDescriptor[],
): SemanticModelProvider {
  return {
    id: provider.id,
    async listModels() {
      return models;
    },
    generateStructured(request) {
      return provider.generateStructured(request);
    },
  };
}

function dynamicQualityWeights(
  configured: Readonly<Record<string, number>> | undefined,
  descriptors: readonly SemanticModelDescriptor[],
): Readonly<Record<string, number>> {
  if (configured !== undefined) return configured;

  const dimensions = new Set<string>();
  for (const descriptor of descriptors) {
    for (const dimension of Object.keys(descriptor.quality)) dimensions.add(dimension);
  }

  return Object.fromEntries([...dimensions].sort().map((dimension) => [dimension, 1]));
}

function routingRequirements(
  capability: Capability,
  semantic: HiMcpConfig['semantic'],
  promptFactory: DefaultSemanticPromptFactory,
): ModelRoutingRequirements {
  const prompt = promptFactory.createPrompt(capability);
  const promptCharacters = Buffer.byteLength(`${prompt.system}\n${prompt.user}`, 'utf8');
  const estimatedInputTokens = Math.max(
    1,
    Math.ceil(promptCharacters / semantic.routing.charactersPerInputToken),
  );

  return {
    requiredCapabilities: semantic.routing.requiredCapabilities,
    qualityWeights: semantic.routing.qualityWeights ?? {},
    estimatedInputTokens,
    estimatedOutputTokens: semantic.routing.estimatedOutputTokens,
    ...(semantic.routing.minimumContextWindowTokens === undefined
      ? {}
      : { minimumContextWindowTokens: semantic.routing.minimumContextWindowTokens }),
    ...(semantic.routing.minimumAvailability === undefined
      ? {}
      : { minimumAvailability: semantic.routing.minimumAvailability }),
    ...(semantic.routing.maximumObservedLatencyMs === undefined
      ? {}
      : { maximumObservedLatencyMs: semantic.routing.maximumObservedLatencyMs }),
    ...(semantic.routing.maximumEstimatedCost === undefined
      ? {}
      : { maximumEstimatedCost: semantic.routing.maximumEstimatedCost }),
    ...(semantic.routing.allowedProviderIds === undefined
      ? {}
      : { allowedProviderIds: semantic.routing.allowedProviderIds }),
    ...(semantic.routing.allowedModelIds === undefined
      ? {}
      : { allowedModelIds: semantic.routing.allowedModelIds }),
  };
}

/**
 * Discovers provider catalogues once, validates every model descriptor, and then lets the
 * router rank the currently available models. Nothing here selects a provider or model by name.
 */
export async function prepareSemanticCompiler(
  providers: readonly SemanticModelProvider[],
  semantic: HiMcpConfig['semantic'],
  compilerIdentity: CompilerIdentity,
  signal?: AbortSignal,
): Promise<PreparedSemanticCompiler> {
  const discoveries = await Promise.allSettled(
    providers.map(async (provider) => {
      const models = await provider.listModels(signal);
      if (!Array.isArray(models)) throw new TypeError('Provider model catalogue must be an array.');
      assertSemanticDataSafe(models);
      return { provider, models };
    }),
  );
  const failures: SemanticDiscoveryFailure[] = [];
  const discovered: Array<{
    readonly provider: SemanticModelProvider;
    readonly models: readonly SemanticModelDescriptor[];
  }> = [];

  discoveries.forEach((result, index) => {
    const provider = providers[index];
    if (provider === undefined) return;
    if (result.status === 'rejected') {
      failures.push({
        provider: provider.id,
        message: 'Model discovery failed; inspect the trusted provider process for details.',
      });
      return;
    }

    const models: SemanticModelDescriptor[] = [];
    result.value.models.forEach((rawDescriptor, modelIndex) => {
      const parsed = SemanticModelDescriptorSchema.safeParse(rawDescriptor);
      if (parsed.success) {
        models.push(parsed.data);
      } else {
        failures.push({
          provider: provider.id,
          message: `Model descriptor at index ${modelIndex} does not satisfy the provider contract.`,
        });
      }
    });
    if (models.length > 0) discovered.push({ provider, models });
  });

  const descriptors = discovered.flatMap(({ models }) => [...models]);
  if (descriptors.length === 0) {
    throw new TypeError('No valid semantic model descriptors were discovered.');
  }

  const qualityWeights = dynamicQualityWeights(semantic.routing.qualityWeights, descriptors);
  const cachedProviders = discovered.map(({ provider, models }) =>
    cachedProvider(provider, models),
  );
  const router = new SemanticModelRouter(cachedProviders, {
    objectiveWeights: semantic.routing.objectiveWeights,
    missingMetricScore: semantic.routing.missingMetricScore,
  });
  const promptFactory = new DefaultSemanticPromptFactory();
  const compiler = new SemanticCompiler({
    router,
    compiler: compilerIdentity,
    promptFactory,
  });

  return {
    providerCount: cachedProviders.length,
    modelCount: descriptors.length,
    qualityDimensions: Object.keys(qualityWeights).sort(),
    failures,
    compile(capability, signal) {
      const routing = {
        ...routingRequirements(capability, semantic, promptFactory),
        qualityWeights,
        ...(signal === undefined ? {} : { signal }),
      };
      return compiler.compile(capability, {
        routing,
        ...(semantic.maxOutputTokens === undefined
          ? { maxOutputTokens: semantic.routing.estimatedOutputTokens }
          : { maxOutputTokens: semantic.maxOutputTokens }),
        ...(semantic.temperature === undefined ? {} : { temperature: semantic.temperature }),
        ...(signal === undefined ? {} : { signal }),
        metadata: {
          capabilityId: capability.id,
          capabilityFingerprint: capability.fingerprint,
          compilationMaterialFingerprint: fingerprint({
            capabilityId: capability.id,
            capabilityFingerprint: capability.fingerprint,
          }),
        },
      });
    },
  };
}
