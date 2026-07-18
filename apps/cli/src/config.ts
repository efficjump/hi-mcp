import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

import { readUtf8FileBounded } from './io.js';

const SemanticProviderConfigSchema = z
  .object({
    module: z
      .string()
      .min(1)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    export: z
      .string()
      .min(1)
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
      .default('createSemanticProvider'),
    enabled: z.boolean().default(true),
    allowLocal: z.boolean().default(false),
    integrity: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const UnitIntervalSchema = z.number().finite().min(0).max(1);
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

const SemanticRoutingConfigSchema = z
  .object({
    requiredCapabilities: z.array(z.string().min(1)).default([]),
    qualityWeights: z.record(z.string().min(1), NonNegativeFiniteSchema).optional(),
    objectiveWeights: z
      .object({
        quality: NonNegativeFiniteSchema.default(1),
        cost: NonNegativeFiniteSchema.default(1),
        latency: NonNegativeFiniteSchema.default(1),
        availability: NonNegativeFiniteSchema.default(1),
      })
      .strict()
      .default({ quality: 1, cost: 1, latency: 1, availability: 1 }),
    missingMetricScore: UnitIntervalSchema.default(0.5),
    estimatedOutputTokens: z.number().int().positive().default(1_024),
    charactersPerInputToken: z.number().finite().positive().default(4),
    minimumContextWindowTokens: z.number().int().positive().optional(),
    minimumAvailability: UnitIntervalSchema.optional(),
    maximumObservedLatencyMs: NonNegativeFiniteSchema.optional(),
    maximumEstimatedCost: NonNegativeFiniteSchema.optional(),
    allowedProviderIds: z.array(z.string().min(1)).optional(),
    allowedModelIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .default({
    requiredCapabilities: [],
    objectiveWeights: { quality: 1, cost: 1, latency: 1, availability: 1 },
    missingMetricScore: 0.5,
    estimatedOutputTokens: 1_024,
    charactersPerInputToken: 4,
  });

const HiMcpConfigSchema = z
  .object({
    semantic: z
      .object({
        required: z.boolean().default(false),
        providers: z.array(SemanticProviderConfigSchema).default([]),
        routing: SemanticRoutingConfigSchema,
        requestTimeoutMs: z.number().int().positive().max(MAX_TIMER_MILLISECONDS).default(60_000),
        maxConcurrency: z.number().int().positive().max(64).default(4),
        maxOutputTokens: z.number().int().positive().optional(),
        temperature: z.number().finite().optional(),
      })
      .strict()
      .default({
        required: false,
        providers: [],
        requestTimeoutMs: 60_000,
        maxConcurrency: 4,
        routing: {
          requiredCapabilities: [],
          objectiveWeights: { quality: 1, cost: 1, latency: 1, availability: 1 },
          missingMetricScore: 0.5,
          estimatedOutputTokens: 1_024,
          charactersPerInputToken: 4,
        },
      }),
    compile: z
      .object({
        strict: z.boolean().default(true),
        baseUrl: z.url().optional(),
      })
      .strict()
      .default({ strict: true }),
  })
  .strict();

export type HiMcpConfig = z.infer<typeof HiMcpConfigSchema>;
export type SemanticProviderConfig = z.infer<typeof SemanticProviderConfigSchema>;
export type SemanticRoutingConfig = z.infer<typeof SemanticRoutingConfigSchema>;

const defaultCandidates = ['.himcp.yaml', '.himcp.yml', '.himcp.json'] as const;
const MAX_CONFIG_BYTES = 1_048_576;

async function fileExists(location: string): Promise<boolean> {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
}

function parseConfig(content: string, location: string): unknown {
  if (location.endsWith('.json')) {
    return JSON.parse(content) as unknown;
  }

  return YAML.parse(content) as unknown;
}

export async function loadConfig(explicitLocation?: string): Promise<{
  readonly config: HiMcpConfig;
  readonly location?: string;
}> {
  let location: string | undefined;

  if (explicitLocation !== undefined) {
    location = resolve(explicitLocation);
  } else {
    for (const candidate of defaultCandidates) {
      const absoluteCandidate = resolve(candidate);
      if (await fileExists(absoluteCandidate)) {
        location = absoluteCandidate;
        break;
      }
    }
  }

  if (location === undefined) {
    return { config: HiMcpConfigSchema.parse({}) };
  }

  const content = await readUtf8FileBounded(location, MAX_CONFIG_BYTES);
  const parsed = parseConfig(content, location);
  return {
    config: HiMcpConfigSchema.parse(parsed),
    location,
  };
}
