import { z } from 'zod';

import { assertSemanticDataSafe } from './data-safety.js';

const UnitIntervalSchema = z.number().finite().min(0).max(1);

export const SemanticModelDescriptorSchema = z
  .object({
    id: z.string().min(1),
    capabilities: z.array(z.string().min(1)).min(1),
    quality: z.record(z.string().min(1), UnitIntervalSchema),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive().optional(),
    estimatedInputCostPerMillionTokens: z.number().finite().nonnegative().optional(),
    estimatedOutputCostPerMillionTokens: z.number().finite().nonnegative().optional(),
    observedLatencyMs: z.number().finite().nonnegative().optional(),
    availability: UnitIntervalSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type SemanticModelDescriptor = z.infer<typeof SemanticModelDescriptorSchema>;

export interface SemanticModelRequest {
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly responseSchema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SemanticModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface SemanticModelResponse {
  readonly output: unknown;
  readonly requestId?: string;
  readonly usage?: SemanticModelUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The semantic compiler depends on this small interface rather than any model SDK.
 * Providers may discover models dynamically from a remote catalogue or expose a
 * locally configured list.
 */
export interface SemanticModelProvider {
  readonly id: string;

  listModels(signal?: AbortSignal): Promise<readonly SemanticModelDescriptor[]>;

  generateStructured(request: SemanticModelRequest): Promise<SemanticModelResponse>;
}

export interface RoutedSemanticModel {
  readonly provider: SemanticModelProvider;
  readonly descriptor: SemanticModelDescriptor;
  readonly score: number;
  readonly scoreBreakdown: Readonly<{
    quality: number;
    cost: number | null;
    latency: number | null;
    availability: number | null;
  }>;
  readonly estimatedCost: number | null;
}

export interface ModelRoutingRequirements {
  readonly requiredCapabilities: readonly string[];
  readonly qualityWeights: Readonly<Record<string, number>>;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly minimumContextWindowTokens?: number;
  readonly minimumAvailability?: number;
  readonly maximumObservedLatencyMs?: number;
  readonly maximumEstimatedCost?: number;
  readonly allowedProviderIds?: readonly string[];
  readonly allowedModelIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface RoutingObjectiveWeights {
  readonly quality: number;
  readonly cost: number;
  readonly latency: number;
  readonly availability: number;
}

export interface SemanticModelRouterOptions {
  readonly objectiveWeights: RoutingObjectiveWeights;
  /** Score used when a candidate does not publish an optional metric. */
  readonly missingMetricScore: number;
}

export class NoEligibleSemanticModelError extends Error {
  readonly providerFailures: Readonly<Record<string, string>>;

  constructor(message: string, providerFailures: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'NoEligibleSemanticModelError';
    this.providerFailures = providerFailures;
  }
}

interface Candidate {
  readonly provider: SemanticModelProvider;
  readonly descriptor: SemanticModelDescriptor;
  readonly quality: number;
  readonly estimatedCost: number | null;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, non-negative number.`);
  }
}

function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between 0 and 1.`);
  }
}

function weightedAverage(
  values: Readonly<Record<string, number>>,
  weights: Readonly<Record<string, number>>,
): number {
  let weightedSum = 0;
  let weightSum = 0;

  for (const [dimension, weight] of Object.entries(weights)) {
    assertFiniteNonNegative(weight, `qualityWeights.${dimension}`);
    if (weight === 0) continue;

    weightedSum += (values[dimension] ?? 0) * weight;
    weightSum += weight;
  }

  return weightSum === 0 ? 0 : weightedSum / weightSum;
}

function estimateCost(
  model: SemanticModelDescriptor,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): number | null {
  const inputRate = model.estimatedInputCostPerMillionTokens;
  const outputRate = model.estimatedOutputCostPerMillionTokens;

  if (inputRate === undefined || outputRate === undefined) return null;

  return (inputRate * estimatedInputTokens + outputRate * estimatedOutputTokens) / 1_000_000;
}

function lowerIsBetter(value: number, values: readonly number[]): number {
  if (values.length < 2) return 1;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum === minimum ? 1 : 1 - (value - minimum) / (maximum - minimum);
}

function normalizeObjectiveWeights(weights: RoutingObjectiveWeights): RoutingObjectiveWeights {
  const entries = Object.entries(weights) as Array<[keyof RoutingObjectiveWeights, number]>;
  for (const [key, value] of entries) assertFiniteNonNegative(value, `objectiveWeights.${key}`);

  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total === 0) throw new TypeError('At least one routing objective weight must be positive.');

  return {
    quality: weights.quality / total,
    cost: weights.cost / total,
    latency: weights.latency / total,
    availability: weights.availability / total,
  };
}

function isAllowed(value: string, allowList: readonly string[] | undefined): boolean {
  return allowList === undefined || allowList.includes(value);
}

function satisfiesRequirements(
  providerId: string,
  descriptor: SemanticModelDescriptor,
  estimatedCost: number | null,
  requirements: ModelRoutingRequirements,
): boolean {
  if (!isAllowed(providerId, requirements.allowedProviderIds)) return false;
  if (!isAllowed(descriptor.id, requirements.allowedModelIds)) return false;
  if (
    !requirements.requiredCapabilities.every((capability) =>
      descriptor.capabilities.includes(capability),
    )
  ) {
    return false;
  }

  const requiredContext = Math.max(
    requirements.minimumContextWindowTokens ?? 0,
    requirements.estimatedInputTokens + requirements.estimatedOutputTokens,
  );
  if (descriptor.contextWindowTokens < requiredContext) return false;
  if (
    descriptor.maxOutputTokens !== undefined &&
    descriptor.maxOutputTokens < requirements.estimatedOutputTokens
  ) {
    return false;
  }
  if (
    requirements.minimumAvailability !== undefined &&
    (descriptor.availability === undefined ||
      descriptor.availability < requirements.minimumAvailability)
  ) {
    return false;
  }
  if (
    requirements.maximumObservedLatencyMs !== undefined &&
    (descriptor.observedLatencyMs === undefined ||
      descriptor.observedLatencyMs > requirements.maximumObservedLatencyMs)
  ) {
    return false;
  }
  if (
    requirements.maximumEstimatedCost !== undefined &&
    (estimatedCost === null || estimatedCost > requirements.maximumEstimatedCost)
  ) {
    return false;
  }

  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ranks every currently eligible model instead of relying on provider/model names. */
export class SemanticModelRouter {
  readonly #providers: readonly SemanticModelProvider[];
  readonly #options: SemanticModelRouterOptions;

  constructor(providers: readonly SemanticModelProvider[], options: SemanticModelRouterOptions) {
    if (providers.length === 0)
      throw new TypeError('At least one semantic model provider is required.');
    const duplicate = providers.find(
      (provider, index) =>
        providers.findIndex((candidate) => candidate.id === provider.id) !== index,
    );
    if (duplicate) throw new TypeError(`Duplicate semantic model provider id: ${duplicate.id}`);

    assertUnitInterval(options.missingMetricScore, 'missingMetricScore');
    this.#providers = [...providers];
    this.#options = {
      objectiveWeights: normalizeObjectiveWeights(options.objectiveWeights),
      missingMetricScore: options.missingMetricScore,
    };
  }

  async rank(requirements: ModelRoutingRequirements): Promise<readonly RoutedSemanticModel[]> {
    assertFiniteNonNegative(requirements.estimatedInputTokens, 'estimatedInputTokens');
    assertFiniteNonNegative(requirements.estimatedOutputTokens, 'estimatedOutputTokens');
    if (requirements.minimumContextWindowTokens !== undefined) {
      assertFiniteNonNegative(
        requirements.minimumContextWindowTokens,
        'minimumContextWindowTokens',
      );
    }
    if (requirements.minimumAvailability !== undefined) {
      assertUnitInterval(requirements.minimumAvailability, 'minimumAvailability');
    }
    if (requirements.maximumObservedLatencyMs !== undefined) {
      assertFiniteNonNegative(requirements.maximumObservedLatencyMs, 'maximumObservedLatencyMs');
    }
    if (requirements.maximumEstimatedCost !== undefined) {
      assertFiniteNonNegative(requirements.maximumEstimatedCost, 'maximumEstimatedCost');
    }

    const discoveries = await Promise.allSettled(
      this.#providers.map(async (provider) => {
        const models = await provider.listModels(requirements.signal);
        if (!Array.isArray(models)) {
          throw new TypeError('Provider model catalogue must be an array.');
        }
        assertSemanticDataSafe(models);
        return { provider, models };
      }),
    );
    const failures: Record<string, string> = {};
    const candidates: Candidate[] = [];

    discoveries.forEach((discovery, index) => {
      const provider = this.#providers[index];
      if (!provider) return;
      if (discovery.status === 'rejected') {
        failures[provider.id] = errorMessage(discovery.reason);
        return;
      }

      for (const rawDescriptor of discovery.value.models) {
        const parsedDescriptor = SemanticModelDescriptorSchema.safeParse(rawDescriptor);
        if (!parsedDescriptor.success) {
          const descriptorId =
            typeof rawDescriptor === 'object' &&
            rawDescriptor !== null &&
            'id' in rawDescriptor &&
            typeof rawDescriptor.id === 'string'
              ? rawDescriptor.id
              : 'unknown-model';
          failures[`${provider.id}/${descriptorId}`] = parsedDescriptor.error.message;
          continue;
        }
        const descriptor = parsedDescriptor.data;
        const cost = estimateCost(
          descriptor,
          requirements.estimatedInputTokens,
          requirements.estimatedOutputTokens,
        );
        if (!satisfiesRequirements(provider.id, descriptor, cost, requirements)) continue;

        candidates.push({
          provider,
          descriptor,
          quality: weightedAverage(descriptor.quality, requirements.qualityWeights),
          estimatedCost: cost,
        });
      }
    });

    if (candidates.length === 0) {
      throw new NoEligibleSemanticModelError(
        'No semantic model satisfies the requested capabilities and operational constraints.',
        failures,
      );
    }

    const costs = candidates.flatMap((candidate) =>
      candidate.estimatedCost === null ? [] : [candidate.estimatedCost],
    );
    const latencies = candidates.flatMap((candidate) =>
      candidate.descriptor.observedLatencyMs === undefined
        ? []
        : [candidate.descriptor.observedLatencyMs],
    );
    const weight = this.#options.objectiveWeights;

    return candidates
      .map((candidate): RoutedSemanticModel => {
        const costScore =
          candidate.estimatedCost === null ? null : lowerIsBetter(candidate.estimatedCost, costs);
        const latencyScore =
          candidate.descriptor.observedLatencyMs === undefined
            ? null
            : lowerIsBetter(candidate.descriptor.observedLatencyMs, latencies);
        const availabilityScore = candidate.descriptor.availability ?? null;
        const score =
          candidate.quality * weight.quality +
          (costScore ?? this.#options.missingMetricScore) * weight.cost +
          (latencyScore ?? this.#options.missingMetricScore) * weight.latency +
          (availabilityScore ?? this.#options.missingMetricScore) * weight.availability;

        return {
          provider: candidate.provider,
          descriptor: candidate.descriptor,
          score,
          scoreBreakdown: {
            quality: candidate.quality,
            cost: costScore,
            latency: latencyScore,
            availability: availabilityScore,
          },
          estimatedCost: candidate.estimatedCost,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.provider.id.localeCompare(right.provider.id) ||
          left.descriptor.id.localeCompare(right.descriptor.id),
      );
  }

  async select(requirements: ModelRoutingRequirements): Promise<RoutedSemanticModel> {
    const [selected] = await this.rank(requirements);
    if (!selected) throw new NoEligibleSemanticModelError('No semantic model could be selected.');
    return selected;
  }
}
