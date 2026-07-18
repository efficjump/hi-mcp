import type { Diagnostic, NormalizedApiDocument, NormalizedOperation } from '@hi-mcp/capability-ir';

export type OpenApiSource = string | Uint8Array | Readonly<Record<string, unknown>>;

export interface ExternalReferenceContext {
  /** URI of the document containing the reference, not necessarily the root OpenAPI document. */
  readonly sourceUri?: string;
  /** Reference resolved against sourceUri when URI resolution is possible. */
  readonly resolvedReference: string;
  readonly usagePointer: string;
}

/**
 * Resolves an entire external reference to its target value. The adapter never performs I/O;
 * consumers must opt in by supplying this callback and enforce their own URI allow-list.
 */
export type ExternalReferenceResolver = (
  reference: string,
  context: ExternalReferenceContext,
) => unknown;

export interface OpenApiAdapterOptions {
  readonly sourceId?: string;
  readonly sourceUri?: string;
  /** Base URL used only to resolve relative OpenAPI server URLs. */
  readonly baseUrl?: string;
  readonly maxInputBytes?: number;
  /** Maximum plain-JSON nodes inspected before normalization. */
  readonly maxInputNodes?: number;
  readonly maxObjectDepth?: number;
  readonly maxRefDepth?: number;
  /** Global node-visit budget shared by reference audit, resolution, and schema bundling. */
  readonly maxResolvedNodes?: number;
  readonly maxYamlAliases?: number;
  readonly externalRefResolver?: ExternalReferenceResolver;
}

export interface OpenApiParseResult {
  readonly document: Readonly<Record<string, unknown>> | null;
  readonly format: 'json' | 'yaml' | 'object' | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}

export interface OpenApiAdapterResult {
  readonly document: NormalizedApiDocument | null;
  readonly operations: readonly NormalizedOperation[];
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}
