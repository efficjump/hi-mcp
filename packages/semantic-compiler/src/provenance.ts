import type { Capability } from '@hi-mcp/capability-ir';

export interface CompilerIdentity {
  readonly name: string;
  readonly version: string;
}

export interface ModelAttemptProvenance {
  readonly provider: string;
  readonly model: string;
  readonly routingScore: number;
  readonly status: 'succeeded' | 'failed';
  readonly error?: string;
}

export interface CompilationProvenance {
  readonly compiler: CompilerIdentity;
  readonly mode: 'deterministic-baseline' | 'semantic';
  readonly baseCapabilityFingerprint: string;
  readonly resultCapabilityFingerprint: string;
  readonly compiledAt: string;
  readonly promptFingerprint?: string;
  readonly proposalFingerprint?: string;
  readonly selectedModel?: Readonly<{
    provider: string;
    model: string;
    routingScore: number;
    requestId?: string;
  }>;
  readonly attempts: readonly ModelAttemptProvenance[];
}

export interface CompiledCapability {
  readonly capability: Capability;
  readonly provenance: CompilationProvenance;
}

export type CompilationClock = () => Date;

export function systemCompilationClock(): Date {
  return new Date();
}
