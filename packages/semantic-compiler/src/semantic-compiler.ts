import {
  CapabilityCandidateSchema,
  CapabilitySchema,
  canonicalStringify,
  fingerprint,
  type Capability,
  type CapabilityCandidate,
  type JsonSchema,
  type JsonValue,
} from '@hi-mcp/capability-ir';
import { z } from 'zod';

import {
  type ModelRoutingRequirements,
  type RoutedSemanticModel,
  type SemanticModelRequest,
  type SemanticModelRouter,
} from './model-provider.js';
import {
  SemanticProposalApplicationError,
  SemanticProposalConflictError,
  SemanticProposalSchema,
  type InputAnnotationProposal,
  type SemanticProposal,
} from './proposal.js';
import {
  systemCompilationClock,
  type CompilationClock,
  type CompilationProvenance,
  type CompilerIdentity,
  type ModelAttemptProvenance,
} from './provenance.js';
import { refingerprintCapability } from './baseline.js';
import { assertSemanticDataSafe, type SemanticDataLimits } from './data-safety.js';

type MutableJsonObject = { [key: string]: JsonValue };

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export interface SemanticPrompt {
  readonly system: string;
  readonly user: string;
}

export interface SemanticPromptFactory {
  createPrompt(capability: Capability): SemanticPrompt;
}

export interface SemanticCompilerOptions {
  readonly router: SemanticModelRouter;
  readonly compiler: CompilerIdentity;
  readonly promptFactory?: SemanticPromptFactory;
  readonly clock?: CompilationClock;
  readonly dataLimits?: Partial<SemanticDataLimits>;
}

export interface SemanticCompilationRequest {
  readonly routing: ModelRoutingRequirements;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SemanticCompilationResult {
  readonly candidate: CapabilityCandidate;
  readonly proposal: SemanticProposal;
  readonly provenance: CompilationProvenance;
}

export class SemanticCompilationError extends Error {
  readonly attempts: readonly ModelAttemptProvenance[];

  constructor(message: string, attempts: readonly ModelAttemptProvenance[]) {
    super(message);
    this.name = 'SemanticCompilationError';
    this.attempts = attempts;
  }
}

export class DefaultSemanticPromptFactory implements SemanticPromptFactory {
  createPrompt(capability: Capability): SemanticPrompt {
    return {
      system: [
        'You improve the semantics of an MCP capability derived from an API contract.',
        'Return only data that conforms to the supplied response JSON Schema.',
        'Never invent or change an endpoint, HTTP method, authentication contract, output contract, or execution binding.',
        'Prefer precise user intent, actionable descriptions, and input annotations grounded in the supplied contract.',
        'Report risk observations for review; they are not authorization to mutate the executable contract.',
      ].join(' '),
      user: canonicalStringify({
        task: 'Propose grounded semantic improvements for this capability.',
        capability,
        immutableContractFields: ['execution', 'auth', 'risk', 'outputSchema', 'provenance'],
      }),
    };
  }
}

function cloneSchema(schema: JsonSchema): JsonSchema {
  return structuredClone(schema);
}

function asObject(value: JsonValue | undefined): MutableJsonObject | null {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    return null;
  }
  return value as MutableJsonObject;
}

function locatePropertySchema(
  root: MutableJsonObject,
  inputPath: readonly string[],
): { owner: MutableJsonObject; key: string; schema: JsonSchema } {
  let current = root;

  for (const [index, segment] of inputPath.entries()) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new SemanticProposalApplicationError(
        `Unsafe input path segment: ${segment}`,
        inputPath,
      );
    }

    const properties = asObject(current['properties']);
    const child = properties?.[segment] as JsonSchema | undefined;
    if (properties === null || child === undefined) {
      throw new SemanticProposalApplicationError(
        `Input annotation targets a path that does not exist: ${inputPath.join('.')}`,
        inputPath,
      );
    }
    if (index === inputPath.length - 1) return { owner: properties, key: segment, schema: child };
    if (typeof child === 'boolean') {
      throw new SemanticProposalApplicationError(
        `Input annotation cannot traverse a boolean schema: ${inputPath.join('.')}`,
        inputPath,
      );
    }
    current = child as MutableJsonObject;
  }

  throw new SemanticProposalApplicationError('Input annotation path cannot be empty.', inputPath);
}

function annotateInputSchema(
  inputSchema: JsonSchema,
  annotations: readonly InputAnnotationProposal[],
): JsonSchema {
  if (annotations.length === 0) return inputSchema;
  if (typeof inputSchema === 'boolean') {
    throw new SemanticProposalApplicationError(
      'A boolean input schema cannot receive field annotations.',
    );
  }

  const updated = cloneSchema(inputSchema) as MutableJsonObject;
  for (const annotation of annotations) {
    const target = locatePropertySchema(updated, annotation.inputPath);
    if (typeof target.schema === 'boolean') {
      throw new SemanticProposalApplicationError(
        `A boolean property schema cannot receive annotations: ${annotation.inputPath.join('.')}`,
        annotation.inputPath,
      );
    }

    target.owner[target.key] = {
      ...target.schema,
      ...(annotation.title === undefined ? {} : { title: annotation.title }),
      ...(annotation.description === undefined ? {} : { description: annotation.description }),
      ...(annotation.examples === undefined ? {} : { examples: annotation.examples }),
    };
  }
  return updated;
}

function immutableContract(capability: Capability): string {
  return canonicalStringify({
    execution: capability.execution,
    auth: capability.auth,
    risk: capability.risk,
    outputSchema: capability.outputSchema,
    provenance: capability.provenance,
  });
}

/** Applies only semantic fields; executable and security contracts remain immutable. */
export function applySemanticProposal(rawCapability: unknown, rawProposal: unknown): Capability {
  assertSemanticDataSafe(rawCapability);
  assertSemanticDataSafe(rawProposal);
  const capability = CapabilitySchema.parse(rawCapability);
  const proposal = SemanticProposalSchema.parse(rawProposal);

  if (proposal.capabilityId !== capability.id) {
    throw new SemanticProposalConflictError(
      `Proposal capability ${proposal.capabilityId} does not match ${capability.id}.`,
    );
  }
  if (proposal.baseFingerprint !== capability.fingerprint) {
    throw new SemanticProposalConflictError(
      `Proposal was generated from ${proposal.baseFingerprint}, not ${capability.fingerprint}.`,
    );
  }

  const beforeContract = immutableContract(capability);
  const changes = proposal.changes;
  const intentChanges = changes.intent;
  const updated: Capability = {
    ...capability,
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.description === undefined ? {} : { description: changes.description }),
    intent: {
      useWhen: intentChanges?.useWhen ?? capability.intent.useWhen,
      avoidWhen: intentChanges?.avoidWhen ?? capability.intent.avoidWhen,
      examples: intentChanges?.examples ?? capability.intent.examples,
      tags: intentChanges?.tags ?? capability.intent.tags,
    },
    inputSchema: annotateInputSchema(capability.inputSchema, changes.inputAnnotations ?? []),
  };
  const validated = refingerprintCapability(updated);

  if (immutableContract(validated) !== beforeContract) {
    throw new SemanticProposalApplicationError(
      'Semantic application attempted to alter an immutable execution or security contract.',
    );
  }

  return validated;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelRequest(
  selected: RoutedSemanticModel,
  prompt: SemanticPrompt,
  responseSchema: Readonly<Record<string, unknown>>,
  request: SemanticCompilationRequest,
): SemanticModelRequest {
  return {
    modelId: selected.descriptor.id,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseSchema,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  };
}

export class SemanticCompiler {
  readonly #router: SemanticModelRouter;
  readonly #compiler: CompilerIdentity;
  readonly #promptFactory: SemanticPromptFactory;
  readonly #clock: CompilationClock;
  readonly #dataLimits: Partial<SemanticDataLimits> | undefined;

  constructor(options: SemanticCompilerOptions) {
    this.#router = options.router;
    this.#compiler = options.compiler;
    this.#promptFactory = options.promptFactory ?? new DefaultSemanticPromptFactory();
    this.#clock = options.clock ?? systemCompilationClock;
    this.#dataLimits = options.dataLimits;
  }

  async compile(
    rawCapability: unknown,
    request: SemanticCompilationRequest,
  ): Promise<SemanticCompilationResult> {
    assertSemanticDataSafe(rawCapability, this.#dataLimits);
    const capability = CapabilitySchema.parse(rawCapability);
    const prompt = this.#promptFactory.createPrompt(capability);
    const responseSchema = z.toJSONSchema(SemanticProposalSchema, { target: 'draft-7' });
    const promptFingerprint = fingerprint({ prompt, responseSchema });
    const ranked = await this.#router.rank(request.routing);
    const attempts: ModelAttemptProvenance[] = [];

    for (const selected of ranked) {
      try {
        const response = await selected.provider.generateStructured(
          modelRequest(selected, prompt, responseSchema, request),
        );
        assertSemanticDataSafe(response.output, this.#dataLimits);
        const proposal = SemanticProposalSchema.parse(response.output);
        const compiled = applySemanticProposal(capability, proposal);
        attempts.push({
          provider: selected.provider.id,
          model: selected.descriptor.id,
          routingScore: selected.score,
          status: 'succeeded',
        });
        const provenance: CompilationProvenance = {
          compiler: this.#compiler,
          mode: 'semantic',
          baseCapabilityFingerprint: capability.fingerprint,
          resultCapabilityFingerprint: compiled.fingerprint,
          compiledAt: this.#clock().toISOString(),
          promptFingerprint,
          proposalFingerprint: fingerprint(proposal),
          selectedModel: {
            provider: selected.provider.id,
            model: selected.descriptor.id,
            routingScore: selected.score,
            ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
          },
          attempts,
        };
        const candidate = CapabilityCandidateSchema.parse({
          sourceOperationId: capability.id,
          stage: 'semantic',
          capability: compiled,
          rationale: proposal.rationale,
          diagnostics: [],
        });

        return { candidate, proposal, provenance };
      } catch (error) {
        attempts.push({
          provider: selected.provider.id,
          model: selected.descriptor.id,
          routingScore: selected.score,
          status: 'failed',
          error: message(error),
        });
      }
    }

    throw new SemanticCompilationError(
      'Every eligible semantic model failed to return an applicable structured proposal.',
      attempts,
    );
  }
}

export function compileSemanticCapability(
  capability: unknown,
  request: SemanticCompilationRequest,
  options: SemanticCompilerOptions,
): Promise<SemanticCompilationResult> {
  return new SemanticCompiler(options).compile(capability, request);
}
