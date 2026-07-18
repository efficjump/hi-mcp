import type { Diagnostic, NormalizedApiDocument, NormalizedOperation } from '@hi-mcp/capability-ir';
import type { BoundedSourceOptions, SourceDocumentInput } from '@hi-mcp/source-adapter-core';

export type HttpManifestSource = SourceDocumentInput;

export interface HttpManifestAdapterOptions extends BoundedSourceOptions {
  readonly sourceId?: string;
  /** Base URL used only to resolve relative HTTP manifest server URLs. */
  readonly baseUrl?: string;
}

export interface HttpManifestAdapterResult {
  readonly adapterId: 'http-manifest';
  readonly document: NormalizedApiDocument | null;
  readonly operations: readonly NormalizedOperation[];
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}
