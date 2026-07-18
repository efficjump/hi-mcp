import {
  fingerprint,
  type Capability,
  type Diagnostic,
  type NormalizedApiDocument,
  type Release,
} from '@hi-mcp/capability-ir';
import { verifyCapability, verifyRelease } from '@hi-mcp/deterministic-verifier';
import type { SourceAdapterResult } from '@hi-mcp/source-adapter-core';
import type { CompilationProvenance } from '@hi-mcp/semantic-compiler';

import type { HiMcpConfig } from './config.js';
import { annotateDiagnostic, createDiagnostic } from './diagnostics.js';
import { loadSemanticProviders } from './providers.js';
import { createBaselineRelease, createRelease } from './release.js';
import { prepareSemanticCompiler } from './semantic-routing.js';
import { runSemanticStage } from './semantic-timeout.js';
import { adaptRegisteredSource } from './source-registry.js';
import { CLI_PACKAGE_NAME, CLI_VERSION } from './version.js';

export class PipelineError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = 'PipelineError';
    this.diagnostics = diagnostics;
  }
}

export class AnalysisReviewStaleError extends PipelineError {
  constructor(expected: string, actual: string) {
    super('The normalized API analysis changed after it was reviewed.', [
      createDiagnostic(
        'SELECTION.ANALYSIS_FINGERPRINT_MISMATCH',
        'error',
        'The reviewed analysis fingerprint does not match the current normalized API document.',
        { recoverable: true, details: { expected, actual } },
      ),
    ]);
    this.name = 'AnalysisReviewStaleError';
  }
}

export class OperationSelectionError extends PipelineError {
  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message, diagnostics);
    this.name = 'OperationSelectionError';
  }
}

export interface AnalyzeResult {
  readonly adapter: SourceAdapterResult;
  readonly sourceId: string;
  readonly sourceKind?: string;
  readonly sourceUri?: string;
}

export interface CompilePipelineOptions {
  readonly source: string;
  readonly location: string;
  readonly sourceType?: string;
  readonly config: HiMcpConfig;
  readonly configLocation?: string;
  readonly semantic: boolean;
  readonly sequence: number;
  readonly includedOperationIds?: readonly string[];
  readonly reviewedAnalysisFingerprint?: string;
  readonly now?: () => Date;
}

export interface CompilePipelineResult {
  readonly adapterId: string;
  readonly release: Release;
  readonly document: NormalizedApiDocument;
  readonly diagnostics: readonly Diagnostic[];
  readonly analysisFingerprint: string;
  readonly selection: Readonly<{
    sourceOperationCount: number;
    includedOperationIds: readonly string[];
  }>;
  readonly semantic: Readonly<{
    requested: boolean;
    providerCount: number;
    modelCount: number;
    compiledCapabilityCount: number;
    fallbackCapabilityCount: number;
  }>;
}

export interface ReviewedOperationSelection {
  readonly analysisFingerprint: string;
  readonly selection: Readonly<{
    sourceOperationCount: number;
    includedOperationIds: readonly string[];
  }>;
}

/** Binds a review to one adapter result and the exact normalized operation contracts. */
export function fingerprintAnalysis(adapterId: string, document: NormalizedApiDocument): string {
  return fingerprint({
    adapterId,
    documentFingerprint: document.documentFingerprint,
    operations: [...document.operations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((operation) => ({ id: operation.id, fingerprint: operation.fingerprint })),
  });
}

function resolveOperationSelection(
  document: NormalizedApiDocument,
  requestedIds: readonly string[] | undefined,
): Readonly<{ sourceOperationCount: number; includedOperationIds: readonly string[] }> {
  const sourceIds = document.operations.map((operation) => operation.id);
  const sourceIdSet = new Set(sourceIds);
  if (sourceIdSet.size !== sourceIds.length) {
    throw new OperationSelectionError('The normalized API contains duplicate operation IDs.', [
      createDiagnostic(
        'SELECTION.DUPLICATE_SOURCE_OPERATION_ID',
        'error',
        'The normalized API must contain unique operation IDs before a subset can be selected.',
        { recoverable: false },
      ),
    ]);
  }

  if (requestedIds === undefined) {
    return {
      sourceOperationCount: sourceIds.length,
      includedOperationIds: [...sourceIds].sort(),
    };
  }
  if (requestedIds.length === 0) {
    throw new OperationSelectionError('At least one operation must be selected.', [
      createDiagnostic(
        'SELECTION.EMPTY',
        'error',
        'At least one normalized operation must be included in the release.',
      ),
    ]);
  }

  const requestedSet = new Set(requestedIds);
  if (requestedSet.size !== requestedIds.length) {
    throw new OperationSelectionError('The operation selection contains duplicate IDs.', [
      createDiagnostic(
        'SELECTION.DUPLICATE_OPERATION_ID',
        'error',
        'Each selected operation ID must occur exactly once.',
      ),
    ]);
  }

  const unknownIds = requestedIds.filter((id) => !sourceIdSet.has(id)).sort();
  if (unknownIds.length > 0) {
    throw new OperationSelectionError('The operation selection is not grounded in the source.', [
      createDiagnostic(
        'SELECTION.OPERATION_NOT_FOUND',
        'error',
        `Selected operation ${unknownIds[0]} does not exist in the normalized API document.`,
        {
          details: {
            operationId: unknownIds[0]!,
            unknownOperationCount: unknownIds.length,
          },
        },
      ),
    ]);
  }

  return {
    sourceOperationCount: sourceIds.length,
    includedOperationIds: [...requestedSet].sort(),
  };
}

/**
 * Revalidates an exact operation allowlist against the normalized document that is current now.
 * Consumers that persist a review decision should call this instead of duplicating the pipeline
 * selection rules.
 */
export function reviewOperationSelection(
  adapterId: string,
  document: NormalizedApiDocument,
  requestedIds: readonly string[] | undefined,
  reviewedAnalysisFingerprint?: string,
): ReviewedOperationSelection {
  const currentAnalysisFingerprint = fingerprintAnalysis(adapterId, document);
  if (
    reviewedAnalysisFingerprint !== undefined &&
    reviewedAnalysisFingerprint !== currentAnalysisFingerprint
  ) {
    throw new AnalysisReviewStaleError(reviewedAnalysisFingerprint, currentAnalysisFingerprint);
  }
  return {
    analysisFingerprint: currentAnalysisFingerprint,
    selection: resolveOperationSelection(document, requestedIds),
  };
}

export async function analyzeSource(
  source: string,
  location: string,
  config: HiMcpConfig,
  sourceType = 'auto',
): Promise<AnalyzeResult> {
  const adapter = await adaptRegisteredSource({ source, location, config, sourceType });
  const document = adapter.document;
  return {
    adapter,
    sourceId: document?.sourceId ?? location,
    ...(document === null ? {} : { sourceKind: document.sourceKind }),
    ...(document?.sourceUri === undefined ? {} : { sourceUri: document.sourceUri }),
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<readonly PromiseSettledResult<R>[]> {
  const results: Array<PromiseSettledResult<R> | undefined> = new Array(values.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) continue;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(value, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results.filter((result): result is PromiseSettledResult<R> => result !== undefined);
}

function verifierDiagnostics(
  capability: Capability,
  baseline: Capability,
  document: NormalizedApiDocument,
): readonly Diagnostic[] {
  const sourceOperation = document.operations.find((operation) => operation.id === capability.id);
  if (sourceOperation === undefined) {
    return [
      createDiagnostic(
        'SOURCE.OPERATION_NOT_FOUND',
        'error',
        `Capability ${capability.id} has no normalized source operation.`,
        { recoverable: false, details: { capabilityId: capability.id } },
      ),
    ];
  }
  return verifyCapability(capability, {
    sourceOperation,
    baselineCapability: baseline,
  }).diagnostics.map((diagnostic) => annotateDiagnostic(diagnostic, capability.id));
}

function enforceCompilationPolicy(diagnostics: readonly Diagnostic[], strict: boolean): void {
  const hasErrors = diagnostics.some(({ severity }) => severity === 'error');
  const hasWarnings = diagnostics.some(({ severity }) => severity === 'warning');
  if (hasErrors || (strict && hasWarnings)) {
    throw new PipelineError(
      hasErrors
        ? 'Compilation stopped because deterministic verification found errors.'
        : 'Compilation stopped because strict mode treats warnings as blocking.',
      diagnostics,
    );
  }
}

export async function compileSource(
  options: CompilePipelineOptions,
): Promise<CompilePipelineResult> {
  const analysis = await analyzeSource(
    options.source,
    options.location,
    options.config,
    options.sourceType,
  );
  const diagnostics: Diagnostic[] = [...analysis.adapter.diagnostics];
  const document = analysis.adapter.document;
  if (document === null || analysis.adapter.hasErrors) {
    throw new PipelineError('The API source could not be normalized safely.', diagnostics);
  }

  const review = reviewOperationSelection(
    analysis.adapter.adapterId,
    document,
    options.includedOperationIds,
    options.reviewedAnalysisFingerprint,
  );
  const currentAnalysisFingerprint = review.analysisFingerprint;
  const selection = review.selection;
  const includedOperationIds = new Set(selection.includedOperationIds);

  const baseline = createBaselineRelease(document, diagnostics, {
    compilerName: CLI_PACKAGE_NAME,
    compilerVersion: CLI_VERSION,
    sequence: options.sequence,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const selectedBaselineEntries = baseline.entries.filter((entry) =>
    includedOperationIds.has(entry.sourceOperationId),
  );
  const baselineById = new Map(
    selectedBaselineEntries.map((entry) => [entry.capability.id, entry.capability]),
  );
  const capabilities = selectedBaselineEntries.map((entry) => entry.capability);
  const provenance: CompilationProvenance[] = selectedBaselineEntries.map(
    (entry) => entry.provenance,
  );
  let providerCount = 0;
  let modelCount = 0;
  let compiledCapabilityCount = 0;
  let fallbackCapabilityCount = 0;

  if (options.semantic && options.config.semantic.providers.some(({ enabled }) => enabled)) {
    const loaded = await loadSemanticProviders(options.config.semantic.providers, {
      ...(options.configLocation === undefined ? {} : { configLocation: options.configLocation }),
    });
    for (const failure of loaded.failures) {
      diagnostics.push(
        createDiagnostic(
          'SEMANTIC.PROVIDER_LOAD_FAILED',
          options.config.semantic.required ? 'error' : 'warning',
          `Could not load semantic provider ${failure.module}: ${failure.message}`,
        ),
      );
    }

    if (loaded.providers.length === 0) {
      if (options.config.semantic.required) {
        throw new PipelineError(
          'Semantic compilation is required but no provider loaded.',
          diagnostics,
        );
      }
      fallbackCapabilityCount = capabilities.length;
    } else {
      try {
        const prepared = await runSemanticStage(
          'model discovery',
          options.config.semantic.requestTimeoutMs,
          (signal) =>
            prepareSemanticCompiler(
              loaded.providers,
              options.config.semantic,
              {
                name: CLI_PACKAGE_NAME,
                version: CLI_VERSION,
              },
              signal,
            ),
        );
        providerCount = prepared.providerCount;
        modelCount = prepared.modelCount;
        for (const failure of prepared.failures) {
          diagnostics.push(
            createDiagnostic(
              'SEMANTIC.MODEL_DISCOVERY_FAILED',
              options.config.semantic.required ? 'error' : 'warning',
              `Provider ${failure.provider}: ${failure.message}`,
            ),
          );
        }

        const results = await mapWithConcurrency(
          capabilities,
          options.config.semantic.maxConcurrency,
          (capability) =>
            runSemanticStage(
              `compilation for ${capability.id}`,
              options.config.semantic.requestTimeoutMs,
              (signal) => prepared.compile(capability, signal),
            ),
        );
        results.forEach((result, index) => {
          const baselineCapability = capabilities[index];
          if (baselineCapability === undefined) return;
          if (result.status === 'fulfilled') {
            capabilities[index] = result.value.candidate.capability;
            provenance.push(result.value.provenance);
            compiledCapabilityCount += 1;
          } else {
            fallbackCapabilityCount += 1;
            diagnostics.push(
              createDiagnostic(
                'SEMANTIC.COMPILATION_FAILED',
                options.config.semantic.required ? 'error' : 'warning',
                `Capability ${baselineCapability.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
                { details: { capabilityId: baselineCapability.id } },
              ),
            );
          }
        });
      } catch (error) {
        diagnostics.push(
          createDiagnostic(
            'SEMANTIC.ROUTING_FAILED',
            options.config.semantic.required ? 'error' : 'warning',
            error instanceof Error ? error.message : String(error),
          ),
        );
        fallbackCapabilityCount = capabilities.length;
      }
    }
  }

  capabilities.forEach((capability) => {
    const baselineCapability = baselineById.get(capability.id);
    if (baselineCapability === undefined) {
      diagnostics.push(
        createDiagnostic(
          'BASELINE.CAPABILITY_NOT_FOUND',
          'error',
          `Capability ${capability.id} has no deterministic baseline.`,
          { recoverable: false, details: { capabilityId: capability.id } },
        ),
      );
      return;
    }
    diagnostics.push(...verifierDiagnostics(capability, baselineCapability, document));
  });

  enforceCompilationPolicy(diagnostics, options.config.compile.strict);
  const release = createRelease(document, diagnostics, {
    compilerName: CLI_PACKAGE_NAME,
    compilerVersion: CLI_VERSION,
    sequence: options.sequence,
    capabilities,
    provenance,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const releaseVerification = verifyRelease(release, { sourceDocuments: [document] });
  if (!releaseVerification.valid) {
    throw new PipelineError(
      'Compilation produced a release that failed deterministic envelope verification.',
      releaseVerification.diagnostics,
    );
  }

  return {
    adapterId: analysis.adapter.adapterId,
    release,
    document,
    diagnostics,
    analysisFingerprint: currentAnalysisFingerprint,
    selection,
    semantic: {
      requested: options.semantic,
      providerCount,
      modelCount,
      compiledCapabilityCount,
      fallbackCapabilityCount,
    },
  };
}

export interface ValidateReleaseOptions {
  readonly value: unknown;
  readonly source?: {
    readonly content: string;
    readonly location: string;
    readonly sourceType?: string;
  };
  readonly config?: HiMcpConfig;
}

export interface ValidateReleaseResult {
  readonly valid: boolean;
  readonly release?: Release;
  readonly diagnostics: readonly Diagnostic[];
}

export async function validateRelease(
  options: ValidateReleaseOptions,
): Promise<ValidateReleaseResult> {
  const diagnostics: Diagnostic[] = [];
  let sourceDocument: NormalizedApiDocument | undefined;
  if (options.source !== undefined) {
    if (options.config === undefined) {
      throw new TypeError('Source-grounded release validation requires compiler configuration.');
    }
    const analysis = await analyzeSource(
      options.source.content,
      options.source.location,
      options.config,
      options.source.sourceType,
    );
    diagnostics.push(...analysis.adapter.diagnostics);
    sourceDocument = analysis.adapter.document ?? undefined;
  }

  const verification = verifyRelease(options.value, {
    ...(sourceDocument === undefined ? {} : { sourceDocuments: [sourceDocument] }),
  });
  diagnostics.push(...verification.diagnostics);

  return {
    valid: !diagnostics.some(({ severity }) => severity === 'error'),
    ...(verification.release === undefined ? {} : { release: verification.release }),
    diagnostics,
  };
}
