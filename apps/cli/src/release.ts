import {
  ReleaseSchema,
  fingerprint,
  stableId,
  type Capability,
  type Diagnostic,
  type NormalizedApiDocument,
  type Release,
} from '@hi-mcp/capability-ir';
import {
  DeterministicBaselineCompiler,
  type CompilationProvenance,
} from '@hi-mcp/semantic-compiler';

export interface BaselineReleaseOptions {
  readonly compilerName: string;
  readonly compilerVersion: string;
  readonly sequence?: number;
  readonly now?: () => Date;
}

export interface BaselineReleaseResult {
  readonly release: Release;
  readonly provenance: readonly CompilationProvenance[];
  readonly entries: readonly BaselineReleaseEntry[];
}

export interface BaselineReleaseEntry {
  readonly sourceOperationId: string;
  readonly capability: Capability;
  readonly provenance: CompilationProvenance;
}

export interface CreateReleaseOptions extends BaselineReleaseOptions {
  readonly capabilities: readonly Capability[];
  readonly provenance: readonly CompilationProvenance[];
}

function stableCompilationEvidence(provenance: readonly CompilationProvenance[]): unknown {
  return provenance.map((entry) => ({
    compiler: entry.compiler,
    mode: entry.mode,
    baseCapabilityFingerprint: entry.baseCapabilityFingerprint,
    resultCapabilityFingerprint: entry.resultCapabilityFingerprint,
    ...(entry.promptFingerprint === undefined
      ? {}
      : { promptFingerprint: entry.promptFingerprint }),
    ...(entry.proposalFingerprint === undefined
      ? {}
      : { proposalFingerprint: entry.proposalFingerprint }),
    ...(entry.selectedModel === undefined
      ? {}
      : {
          selectedModel: {
            provider: entry.selectedModel.provider,
            model: entry.selectedModel.model,
            routingScore: entry.selectedModel.routingScore,
          },
        }),
    attempts: entry.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      routingScore: attempt.routingScore,
      status: attempt.status,
    })),
  }));
}

/** Builds a content-addressed release while excluding wall-clock and request IDs from identity. */
export function createRelease(
  document: NormalizedApiDocument,
  diagnostics: readonly Diagnostic[],
  options: CreateReleaseOptions,
): Release {
  const compilerMetadata = {
    name: options.compilerName,
    version: options.compilerVersion,
  };
  const sources = [
    {
      sourceId: document.sourceId,
      ...(document.sourceUri === undefined ? {} : { sourceUri: document.sourceUri }),
      sourceKind:
        document.sourceVersion === undefined
          ? document.sourceKind
          : `${document.sourceKind}-${document.sourceVersion}`,
      fingerprint: document.documentFingerprint,
    },
  ];
  const sortedDiagnostics = [...diagnostics].sort((left, right) => {
    const bySeverity = left.severity.localeCompare(right.severity);
    return bySeverity === 0 ? left.code.localeCompare(right.code) : bySeverity;
  });
  const capabilities = [...options.capabilities].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const material = {
    schemaVersion: '1.0' as const,
    sequence: options.sequence ?? 0,
    compiler: compilerMetadata,
    sources,
    capabilities,
    diagnostics: sortedDiagnostics,
    extensions: {
      'hi-mcp.compilation': stableCompilationEvidence(options.provenance),
    },
  };
  const releaseFingerprint = fingerprint(material);

  return ReleaseSchema.parse({
    ...material,
    id: stableId('release', releaseFingerprint),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    fingerprint: releaseFingerprint,
  });
}

export function createBaselineRelease(
  document: NormalizedApiDocument,
  diagnostics: readonly Diagnostic[],
  options: BaselineReleaseOptions,
): BaselineReleaseResult {
  const compiler = new DeterministicBaselineCompiler({
    compiler: {
      name: options.compilerName,
      version: options.compilerVersion,
    },
    ...(options.now === undefined ? {} : { clock: options.now }),
  });
  const compilationResults = compiler.compileAll(document.operations);
  const entries = compilationResults.map((result) => ({
    sourceOperationId: result.candidate.sourceOperationId,
    capability: result.candidate.capability,
    provenance: result.provenance,
  }));
  const provenance = entries.map((entry) => entry.provenance);
  const release = createRelease(document, diagnostics, {
    ...options,
    capabilities: entries.map((entry) => entry.capability),
    provenance,
  });

  return {
    release,
    provenance,
    entries,
  };
}
