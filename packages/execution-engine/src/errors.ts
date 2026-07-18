import type { ExecutionTraceMetadata, JsonValue } from './types.js';

export type ExecutionErrorCode =
  | 'INPUT_VALIDATION_FAILED'
  | 'METHOD_NOT_ALLOWED'
  | 'BINDING_FAILED'
  | 'DESTINATION_BLOCKED'
  | 'CREDENTIAL_RESOLUTION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'UPSTREAM_NETWORK_ERROR'
  | 'UPSTREAM_HTTP_ERROR'
  | 'RESPONSE_CONTENT_TYPE_REJECTED'
  | 'RESPONSE_TOO_LARGE'
  | 'RESPONSE_PARSE_FAILED'
  | 'OUTPUT_VALIDATION_FAILED';

export class ExecutionEngineError extends Error {
  readonly code: ExecutionErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, JsonValue>>;
  trace: ExecutionTraceMetadata | undefined;

  constructor(options: {
    code: ExecutionErrorCode;
    message: string;
    retryable?: boolean;
    details?: Readonly<Record<string, JsonValue>>;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'ExecutionEngineError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function isExecutionEngineError(value: unknown): value is ExecutionEngineError {
  return value instanceof ExecutionEngineError;
}
