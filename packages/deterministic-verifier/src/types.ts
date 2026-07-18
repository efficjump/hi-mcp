import type { Capability, Diagnostic, NormalizedOperation, Release } from '@hi-mcp/capability-ir';
import type { Options as AjvOptions } from 'ajv';

export interface CapabilityVerificationOptions {
  /** The normalized source operation is the authority for the HTTP execution plan. */
  readonly sourceOperation?: NormalizedOperation;
  /** A reviewed capability is the authority for fields that semantic compilation must lock. */
  readonly baselineCapability?: Capability;
  readonly ajv?: AjvOptions;
  readonly schemaLimits?: Partial<SchemaVerificationLimits>;
  readonly inputLimits?: Partial<VerificationInputLimits>;
}

export interface VerificationInputLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxTotalStringBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectProperties: number;
}

export interface SchemaVerificationLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxPatternLength: number;
  readonly maxRegexRepetitions: number;
}

export interface CapabilityVerificationResult {
  readonly valid: boolean;
  readonly capability?: Capability;
  readonly diagnostics: readonly Diagnostic[];
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

export interface ReleaseVerificationOptions {
  /**
   * Optional normalized source documents used to ground each matching capability against its
   * authoritative operation. Documents may be supplied incrementally for multi-source releases.
   */
  readonly sourceDocuments?: readonly unknown[];
  readonly ajv?: AjvOptions;
  readonly schemaLimits?: Partial<SchemaVerificationLimits>;
  readonly inputLimits?: Partial<VerificationInputLimits>;
}

export interface VerifiedReleaseCapability {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly result: CapabilityVerificationResult;
}

export interface ReleaseVerificationResult {
  readonly valid: boolean;
  /** Present when the release passed structural parsing, even if integrity checks failed. */
  readonly release?: Release;
  readonly capabilities: readonly VerifiedReleaseCapability[];
  readonly diagnostics: readonly Diagnostic[];
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}
