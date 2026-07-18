export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ConsoleDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: Readonly<{
    sourceUri?: string;
    pointer?: string;
    line?: number;
    column?: number;
  }>;
}

export interface ConsoleStatus {
  readonly application: Readonly<{ name: string; version: string }>;
  readonly runtime: Readonly<{
    mode: 'local';
    host: string;
    dataDirectory: string;
  }>;
  readonly adapters: readonly string[];
  readonly limits: Readonly<{
    maxSourceBytes: number;
    maxOperationSelectionItems: number;
    maxSelectionPresetsPerSource: number;
    maxSelectionPresetNameBytes: number;
  }>;
  readonly csrfToken: string;
}

export interface ConsoleSample {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
  readonly sourceType: string;
}

export interface SourceRequest {
  readonly source: string;
  readonly filename: string;
  readonly sourceType?: string;
}

export interface RegistrationRequest extends SourceRequest {
  readonly reviewedAnalysisFingerprint: string;
  readonly includedOperationIds: readonly string[];
}

export interface SelectionPresetRequest extends RegistrationRequest {
  readonly name: string;
}

export interface ContractDiffRequest extends SourceRequest {
  readonly baselineRegistrationId: string;
  readonly reviewedAnalysisFingerprint: string;
}

export type ContractDiffResponse = import('@hi-mcp/cli').ContractDiff;

export interface SelectionPresetReviewRequest extends SourceRequest {
  readonly reviewedAnalysisFingerprint: string;
  readonly selectionFingerprint: string;
}

export interface SelectionPresetReviewResponse {
  readonly preset: Readonly<{
    id: string;
    name: string;
    previousAnalysisFingerprint: string;
    selectionFingerprint: string;
  }>;
  readonly currentAnalysisFingerprint: string;
  /** Previous selected IDs that still exist. They remain untrusted until the operator reviews them. */
  readonly candidateOperationIds: readonly string[];
  readonly missingOperationIds: readonly string[];
  /** Current operations never selected by the previous preset and therefore excluded from candidates. */
  readonly unselectedCurrentOperationIds: readonly string[];
}

export interface OperationSummary {
  readonly id: string;
  readonly operationId?: string;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly authRequired: boolean;
  readonly authSchemes: readonly string[];
}

export interface AnalysisResponse {
  readonly adapterId: string;
  readonly sourceScopeId: string;
  readonly analysisFingerprint: string;
  readonly document: Readonly<{
    sourceId: string;
    sourceKind: string;
    sourceVersion?: string;
    title: string;
    version?: string;
    fingerprint: string;
    operationCount: number;
    serverOrigins: readonly string[];
    authSchemeCount: number;
  }>;
  readonly operations: readonly OperationSummary[];
  readonly diagnostics: readonly ConsoleDiagnostic[];
}

export type SelectionPresetCompatibility = 'exact' | 'stale';

export interface SelectionPresetSummary {
  readonly id: string;
  readonly sourceScopeId: string;
  readonly name: string;
  readonly adapterId: string;
  readonly sourceKind: string;
  readonly analysisFingerprint: string;
  readonly documentFingerprint: string;
  readonly sourceOperationCount: number;
  readonly includedOperationCount: number;
  readonly selectionFingerprint: string;
  readonly createdAt: string;
  readonly compatibility: SelectionPresetCompatibility;
}

export interface SelectionPresetDetail extends Omit<SelectionPresetSummary, 'compatibility'> {
  readonly compatibility: 'exact';
  readonly includedOperationIds: readonly string[];
}

export interface SelectionPresetSaveResponse {
  readonly preset: SelectionPresetSummary & { readonly compatibility: 'exact' };
  readonly created: boolean;
}

export interface CredentialBindingView {
  readonly scheme: string;
  readonly location: 'header' | 'query' | 'cookie';
  readonly parameterName: string;
  readonly prefix?: string;
  readonly environmentVariable: string;
}

export interface CapabilitySummary {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly servers: readonly string[];
  readonly authRequired: boolean;
  readonly authSchemes: readonly string[];
  readonly risk: Readonly<{
    level: string;
    sideEffect: string;
    requiresConfirmation: boolean;
  }>;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly provenance: unknown;
}

export interface RegistrationSummary {
  readonly id: string;
  readonly title: string;
  readonly sourceKind: string;
  readonly sourceVersion?: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly sourceFilename: string;
  readonly capabilityCount: number;
  readonly sourceOperationCount: number;
  readonly origins: readonly string[];
  readonly credentialBindings: readonly CredentialBindingView[];
  readonly diagnosticCounts: Readonly<Record<DiagnosticSeverity, number>>;
}

export interface RegistrationDetail {
  readonly registration: RegistrationSummary;
  readonly capabilities: readonly CapabilitySummary[];
  readonly diagnostics: readonly ConsoleDiagnostic[];
  readonly artifactUrls: Readonly<{ release: string }>;
}

export interface ConnectionRequest {
  readonly displayName: string;
  readonly description?: string;
  readonly approvedOrigins: readonly string[];
  readonly allowInsecureHttp: boolean;
  readonly confirmation: 'per-call' | 'process';
  readonly credentialEnvironment: Readonly<Record<string, string>>;
}

export interface ConnectionResponse {
  readonly profile: Readonly<{
    id: string;
    displayName: string;
    fingerprint: string;
    confirmation: 'per-call' | 'process';
  }>;
  readonly descriptor: Readonly<{
    mcpServers: Readonly<Record<string, Readonly<{ command: string; args: readonly string[] }>>>;
  }>;
  readonly requiredEnvironmentVariables: readonly string[];
  readonly artifactUrls: Readonly<{ profile: string; descriptor: string }>;
}

export interface ApiErrorPayload {
  readonly error: Readonly<{
    code: string;
    message: string;
    requestId: string;
    diagnostics?: readonly ConsoleDiagnostic[];
  }>;
}
