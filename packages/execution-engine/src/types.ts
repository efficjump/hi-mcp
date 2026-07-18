import type { ErrorObject } from 'ajv';
import type {
  Capability,
  HttpExecution,
  HttpMethod as IrHttpMethod,
  JsonSchema as IrJsonSchema,
  JsonValue as IrJsonValue,
  ParameterBinding as IrParameterBinding,
  ParameterLocation as IrParameterLocation,
  RequestBodyBinding as IrRequestBodyBinding,
  ServerTarget as IrServerTarget,
  SuccessResponse as IrSuccessResponse,
} from '@hi-mcp/capability-ir';

export type JsonValue = IrJsonValue;
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = IrJsonSchema;
export type HttpMethod = IrHttpMethod;

/**
 * Structural mirror of the HTTP execution fields published by
 * @hi-mcp/capability-ir. Keeping the runtime contract structural lets the
 * engine consume parsed IR without converting it to an engine-specific DTO.
 */
export type ServerTarget = IrServerTarget;
export type ParameterLocation = IrParameterLocation;
export type ParameterBinding = IrParameterBinding;
export type RequestBodyBinding = IrRequestBodyBinding;
export type SuccessResponse = IrSuccessResponse;
export type HttpExecutionPlan = HttpExecution;
/** A capability parsed by @hi-mcp/capability-ir and ready for deterministic execution. */
export type ExecutableHttpCapability = Capability;

export interface HostAllowRule {
  /** Exact DNS name or IP literal. */
  readonly hostname: string;
  /** Include subdomains, but never the parent's sibling domains. */
  readonly includeSubdomains?: boolean;
  /** Omit to allow the URL scheme's default port only. */
  readonly ports?: readonly number[];
}

export interface CredentialReference {
  readonly id?: string;
  readonly kind?: string;
  readonly scopes?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface CredentialMaterial {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly cookies?: Readonly<Record<string, string>>;
}

export interface CredentialContext {
  readonly capability: ExecutableHttpCapability;
  readonly reference?: CredentialReference;
  readonly destination: Readonly<{
    protocol: string;
    hostname: string;
    port: string;
  }>;
  readonly principal?: Readonly<Record<string, JsonValue>>;
  readonly signal?: AbortSignal;
  readonly deadlineEpochMs?: number;
}

export interface CredentialProvider {
  resolve(context: CredentialContext): Promise<CredentialMaterial | undefined>;
}

export type IdempotencyClassification = 'safe' | 'idempotent' | 'non-idempotent' | 'unknown';

export interface RetryPolicy {
  /** Total attempts, including the initial request. */
  readonly maxAttempts: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly retryableStatuses?: readonly number[];
  readonly respectRetryAfter?: boolean;
}

export interface ResponsePolicy {
  readonly maxBytes?: number;
  readonly allowedContentTypes?: readonly string[];
  readonly allowMissingContentType?: boolean;
  readonly parseAs?: 'json' | 'text';
}

export interface RedactionPolicy {
  readonly replacement?: string;
  readonly sensitiveKeys?: readonly string[];
  readonly outputPaths?: readonly (readonly string[])[];
}

export interface ExecutionPolicy {
  readonly serverIndex?: number;
  /** Exact allowlist. When absent, the selected server host and port are used. */
  readonly allowedHosts?: readonly HostAllowRule[];
  readonly allowInsecureHttp?: boolean;
  readonly credential?: CredentialReference;
  readonly totalTimeoutMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly idempotency?: IdempotencyClassification;
  /** A stable key is attached to every attempt when this header is configured. */
  readonly idempotencyKeyHeader?: string;
  readonly retry?: RetryPolicy;
  readonly response?: ResponsePolicy;
  readonly redaction?: RedactionPolicy;
}

export interface ExecutionContext {
  readonly signal?: AbortSignal;
  readonly principal?: Readonly<Record<string, JsonValue>>;
  readonly traceAttributes?: Readonly<Record<string, JsonValue>>;
  readonly executionId?: string;
}

export interface DnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type DnsResolver = (
  hostname: string,
  context?: { readonly signal?: AbortSignal; readonly deadlineEpochMs?: number },
) => Promise<readonly DnsAddress[]>;

export interface DestinationPolicyContext {
  readonly url: URL;
  readonly addresses: readonly DnsAddress[];
  readonly allowedHosts: readonly HostAllowRule[];
  readonly allowInsecureHttp: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineEpochMs?: number;
}

export interface DestinationPolicy {
  assertAllowed(context: DestinationPolicyContext): Promise<void> | void;
}

export interface VerifiedFetchDestination {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  /** Every address was accepted by the destination policy immediately before dispatch. */
  readonly addresses: readonly DnsAddress[];
}

/**
 * A custom transport receives the already-verified DNS result. Implementations that establish
 * real network connections must pin resolution to these addresses while retaining hostname-based
 * Host and TLS SNI values. Ignoring this context reintroduces DNS-rebinding risk.
 */
export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
  destination?: VerifiedFetchDestination,
) => Promise<Response>;

export type SleepImplementation = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface ExecutionTraceMetadata {
  readonly executionId: string;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly method: HttpMethod;
  readonly serverIndex: number;
  readonly target: Readonly<{
    protocol: string;
    hostname: string;
    port: string;
    pathTemplate: string;
  }>;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly status?: number;
  readonly responseBytes?: number;
  readonly responseContentType?: string;
  readonly outcome: 'success' | 'error' | 'cancelled';
  readonly errorCode?: string;
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export interface TraceSink {
  record(trace: ExecutionTraceMetadata): Promise<void> | void;
}

export interface ExecutionResult<T = JsonValue> {
  readonly output: T;
  readonly trace: ExecutionTraceMetadata;
}

export interface ExecutionEngineDependencies {
  readonly fetch?: FetchImplementation;
  readonly resolveDns?: DnsResolver;
  readonly destinationPolicy?: DestinationPolicy;
  readonly credentialProvider?: CredentialProvider;
  readonly traceSink?: TraceSink;
  readonly sleep?: SleepImplementation;
  readonly now?: () => number;
  readonly createExecutionId?: () => string;
  readonly complexity?: ExecutionComplexityLimits;
}

export interface ValidationFailure {
  readonly phase: 'input' | 'output' | 'request-body';
  readonly errors: readonly ErrorObject[];
}

export interface JsonValueComplexityLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxTotalStringBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectProperties: number;
}

export interface JsonSchemaComplexityLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxPatternLength: number;
  readonly maxRegexRepetitions: number;
}

export interface ExecutionComplexityLimits {
  readonly values?: Partial<JsonValueComplexityLimits>;
  readonly schemas?: Partial<JsonSchemaComplexityLimits>;
}
