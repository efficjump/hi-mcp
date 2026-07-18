import { NormalizedApiDocumentSchema, type Diagnostic } from '@hi-mcp/capability-ir';

import type { SourceAdapter, SourceAdapterResult, SourceInput, SourceProbe } from './types.js';

const ADAPTER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export class SourceAdapterSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAdapterSelectionError';
  }
}

export interface SourceAdapterRegistryOptions {
  readonly minimumConfidence?: number;
}

function validateProbe(adapterId: string, probe: SourceProbe): SourceProbe {
  if (
    !Number.isFinite(probe.confidence) ||
    probe.confidence < 0 ||
    probe.confidence > 1 ||
    typeof probe.reason !== 'string' ||
    probe.reason.trim().length === 0
  ) {
    throw new SourceAdapterSelectionError(`Adapter ${adapterId} returned an invalid source probe.`);
  }
  return probe;
}

function invalidDocumentDiagnostics(adapterId: string, messages: readonly string[]): Diagnostic[] {
  return messages.map((message) => ({
    code: 'SOURCE_ADAPTER.INVALID_DOCUMENT',
    severity: 'error' as const,
    message: `Adapter ${adapterId}: ${message}`,
    related: [],
    recoverable: false,
  }));
}

export class SourceAdapterRegistry {
  readonly #adapters = new Map<string, SourceAdapter>();
  readonly #minimumConfidence: number;

  constructor(adapters: readonly SourceAdapter[] = [], options: SourceAdapterRegistryOptions = {}) {
    const minimumConfidence = options.minimumConfidence ?? 0.5;
    if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
      throw new TypeError('Source adapter minimum confidence must be between zero and one.');
    }
    this.#minimumConfidence = minimumConfidence;
    adapters.forEach((adapter) => this.register(adapter));
  }

  register(adapter: SourceAdapter): void {
    if (!ADAPTER_ID.test(adapter.id)) {
      throw new TypeError(`Invalid source adapter id: ${adapter.id}`);
    }
    if (this.#adapters.has(adapter.id)) {
      throw new TypeError(`Duplicate source adapter id: ${adapter.id}`);
    }
    if (typeof adapter.probe !== 'function' || typeof adapter.adapt !== 'function') {
      throw new TypeError(`Source adapter ${adapter.id} must define probe() and adapt().`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  list(): readonly string[] {
    return [...this.#adapters.keys()].sort();
  }

  async select(
    input: SourceInput,
    requestedId = 'auto',
    options: Readonly<Record<string, unknown>> = {},
  ): Promise<SourceAdapter> {
    if (requestedId !== 'auto') {
      const requested = this.#adapters.get(requestedId);
      if (requested === undefined) {
        throw new SourceAdapterSelectionError(
          `Unknown source adapter '${requestedId}'. Available adapters: ${this.list().join(', ') || 'none'}.`,
        );
      }
      return requested;
    }

    const probes = await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => ({
        adapter,
        probe: validateProbe(adapter.id, await adapter.probe(input, options)),
      })),
    );
    probes.sort(
      (left, right) =>
        right.probe.confidence - left.probe.confidence ||
        left.adapter.id.localeCompare(right.adapter.id),
    );
    const winner = probes[0];
    if (winner === undefined || winner.probe.confidence < this.#minimumConfidence) {
      throw new SourceAdapterSelectionError(
        `No source adapter recognized the input with confidence ${this.#minimumConfidence} or higher.`,
      );
    }
    const runnerUp = probes[1];
    if (runnerUp !== undefined && runnerUp.probe.confidence === winner.probe.confidence) {
      throw new SourceAdapterSelectionError(
        `Source adapter detection is ambiguous between '${winner.adapter.id}' and '${runnerUp.adapter.id}'. Select one explicitly.`,
      );
    }
    return winner.adapter;
  }

  async adapt(
    input: SourceInput,
    requestedId = 'auto',
    options: Readonly<Record<string, unknown>> = {},
  ): Promise<SourceAdapterResult> {
    const adapter = await this.select(input, requestedId, options);
    const result = await adapter.adapt(input, options);
    if (result.adapterId !== adapter.id) {
      throw new SourceAdapterSelectionError(
        `Adapter ${adapter.id} returned mismatched adapterId '${result.adapterId}'.`,
      );
    }
    if (result.document === null) {
      return {
        ...result,
        hasErrors: true,
      };
    }
    const parsed = NormalizedApiDocumentSchema.safeParse(result.document);
    if (!parsed.success) {
      const diagnostics = [
        ...result.diagnostics,
        ...invalidDocumentDiagnostics(
          adapter.id,
          parsed.error.issues.map((issue) => `${issue.path.join('.') || '/'}: ${issue.message}`),
        ),
      ];
      return {
        adapterId: adapter.id,
        document: null,
        diagnostics,
        hasErrors: true,
      };
    }
    return {
      adapterId: adapter.id,
      document: parsed.data,
      diagnostics: result.diagnostics,
      hasErrors:
        result.hasErrors || result.diagnostics.some(({ severity }) => severity === 'error'),
    };
  }
}
