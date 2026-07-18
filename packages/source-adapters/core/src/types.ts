import type { Diagnostic, NormalizedApiDocument } from '@hi-mcp/capability-ir';

export type SourceDocumentInput = string | Uint8Array | Readonly<Record<string, unknown>>;

export type SourceDocumentFormat = 'json' | 'yaml' | 'object';

export interface BoundedSourceOptions {
  readonly sourceUri?: string;
  readonly maxInputBytes?: number;
  readonly maxInputNodes?: number;
  readonly maxObjectDepth?: number;
  readonly maxYamlAliases?: number;
  /** Machine-readable diagnostic prefix such as SOURCE, OPENAPI, or HTTP_MANIFEST. */
  readonly diagnosticNamespace?: string;
}

export interface ParsedSourceDocument {
  readonly document: Readonly<Record<string, unknown>> | null;
  readonly format: SourceDocumentFormat | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}

export interface SourceInput {
  readonly value: SourceDocumentInput;
  readonly location: string;
  readonly sourceId?: string;
  readonly sourceUri?: string;
  readonly mediaType?: string;
}

export interface SourceProbe {
  readonly confidence: number;
  readonly reason: string;
}

export interface SourceAdapterResult {
  readonly adapterId: string;
  readonly document: NormalizedApiDocument | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}

export interface SourceAdapter {
  readonly id: string;
  probe(
    input: SourceInput,
    options?: Readonly<Record<string, unknown>>,
  ): SourceProbe | Promise<SourceProbe>;
  adapt(
    input: SourceInput,
    options?: Readonly<Record<string, unknown>>,
  ): SourceAdapterResult | Promise<SourceAdapterResult>;
}
