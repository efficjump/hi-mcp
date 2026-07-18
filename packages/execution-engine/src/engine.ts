import { randomUUID } from 'node:crypto';

import { isWellFormedUnicode } from '@hi-mcp/capability-ir';

import {
  assertCredentialHeader,
  bindHttpRequest,
  credentialCookie,
  getValueAtPath,
  resolveServerUrl,
  type BoundHttpRequest,
} from './binding.js';
import {
  assertHostAllowed,
  defaultDnsResolver,
  inferredHostAllowlist,
  PublicDestinationPolicy,
} from './destination-policy.js';
import { ExecutionEngineError, isExecutionEngineError } from './errors.js';
import { isSensitiveHeader, redactOutputPaths, redactSensitiveValue } from './redaction.js';
import { isSuccessfulResponse, normalizedContentType, parseHttpResponse } from './response.js';
import { dispatchWithPinnedDns } from './pinned-fetch.js';
import {
  ComplexityLimitError,
  assertJsonValueComplexity,
  normalizeComplexityLimits,
} from './complexity.js';
import { SchemaValidator } from './schema-validator.js';
import type {
  CredentialMaterial,
  DestinationPolicy,
  DnsAddress,
  ExecutableHttpCapability,
  ExecutionContext,
  ExecutionEngineDependencies,
  ExecutionPolicy,
  ExecutionResult,
  ExecutionTraceMetadata,
  FetchImplementation,
  HostAllowRule,
  IdempotencyClassification,
  JsonSchema,
  JsonValueComplexityLimits,
  JsonValue,
  RetryPolicy,
  SleepImplementation,
} from './types.js';

export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRYABLE_STATUSES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
export const MAX_RETRY_ATTEMPTS = 10;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ExecuteHttpOptions {
  readonly policy?: ExecutionPolicy;
  readonly context?: ExecutionContext;
}

export interface ExecuteHttpCapabilityOptions extends ExecuteHttpOptions {
  readonly dependencies?: ExecutionEngineDependencies;
}

interface TraceState {
  attempts: number;
  status: number | undefined;
  responseBytes: number | undefined;
  responseContentType: string | undefined;
}

interface AttemptSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function createAttemptSignal(parent: AbortSignal | undefined, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) {
    onParentAbort();
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new DOMException('Execution attempt timed out.', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function validationDetails(
  errors: readonly { instancePath: string; keyword: string; message?: string }[],
): JsonValue {
  return errors.map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'Schema validation failed.',
  }));
}

function assertValid(
  validator: SchemaValidator,
  schema: JsonSchema,
  value: unknown,
  phase: 'input' | 'output' | 'request-body',
): void {
  let errors: ReturnType<SchemaValidator['validate']>;
  try {
    errors = validator.validate(schema, value);
  } catch (cause) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message:
        cause instanceof ComplexityLimitError
          ? 'The compiled JSON Schema exceeds the runtime safety policy.'
          : 'The compiled JSON Schema could not be prepared safely.',
      cause,
    });
  }
  if (errors === undefined) {
    return;
  }
  throw new ExecutionEngineError({
    code: phase === 'output' ? 'OUTPUT_VALIDATION_FAILED' : 'INPUT_VALIDATION_FAILED',
    message:
      phase === 'output'
        ? 'The upstream output does not satisfy the compiled output schema.'
        : 'The tool input does not satisfy the compiled input schema.',
    details: { phase, validationErrors: validationDetails(errors) },
  });
}

function retryPolicy(policy: ExecutionPolicy): Required<RetryPolicy> {
  const retry = policy.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The retry attempt count is outside the supported range.',
      details: { maxAttempts, maximum: MAX_RETRY_ATTEMPTS },
    });
  }
  const baseDelayMs = retry?.baseDelayMs ?? 100;
  const maxDelayMs = retry?.maxDelayMs ?? 2_000;
  if (baseDelayMs < 0 || maxDelayMs < 0 || baseDelayMs > maxDelayMs) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The retry delay configuration is invalid.',
    });
  }
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    retryableStatuses: retry?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES,
    respectRetryAfter: retry?.respectRetryAfter ?? true,
  };
}

function inferredIdempotency(
  capability: ExecutableHttpCapability,
  policy: ExecutionPolicy,
): IdempotencyClassification {
  if (policy.idempotency !== undefined) {
    return policy.idempotency;
  }
  if (capability.risk.idempotency === 'non-idempotent') {
    return 'non-idempotent';
  }
  if (capability.risk.level === 'read' || capability.risk.sideEffect === 'none') {
    return 'safe';
  }
  if (capability.risk.idempotency === 'idempotent') {
    return 'idempotent';
  }
  return 'unknown';
}

function mayRetry(capability: ExecutableHttpCapability, policy: ExecutionPolicy): boolean {
  const classification = inferredIdempotency(capability, policy);
  return (
    classification === 'safe' ||
    classification === 'idempotent' ||
    policy.idempotencyKeyHeader !== undefined
  );
}

function retryAfterMilliseconds(
  response: Response,
  maximum: number,
  now: number,
): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maximum, seconds * 1_000);
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.min(maximum, Math.max(0, date - now));
}

function retryDelay(
  attempt: number,
  response: Response | undefined,
  retry: Required<RetryPolicy>,
  now: number,
): number {
  if (response !== undefined && retry.respectRetryAfter) {
    const fromHeader = retryAfterMilliseconds(response, retry.maxDelayMs, now);
    if (fromHeader !== undefined) {
      return fromHeader;
    }
  }
  return Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function assertRetryWithinDeadline(delayMs: number, deadline: number, now: number): void {
  if (delayMs >= deadline - now) {
    throw new ExecutionEngineError({
      code: 'REQUEST_TIMEOUT',
      message: 'The execution cannot retry within its total timeout.',
    });
  }
}

function normalizedTimeout(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_TIMEOUT_MS) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: `The ${name} timeout must be a positive integer no greater than ${MAX_TIMEOUT_MS}.`,
    });
  }
  return result;
}

function applyCredentials(
  request: BoundHttpRequest,
  material: CredentialMaterial | undefined,
): void {
  if (material === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(material.headers ?? {})) {
    assertCredentialHeader(name, value);
    request.headers.set(name, value);
  }
  for (const [name, rawValue] of Object.entries(material.query ?? {})) {
    if (!isWellFormedUnicode(name)) {
      throw new ExecutionEngineError({
        code: 'CREDENTIAL_RESOLUTION_FAILED',
        message: 'The credential provider returned an invalid HTTP query parameter.',
      });
    }
    request.url.searchParams.delete(name);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (!isWellFormedUnicode(value)) {
        throw new ExecutionEngineError({
          code: 'CREDENTIAL_RESOLUTION_FAILED',
          message: 'The credential provider returned an invalid HTTP query parameter.',
        });
      }
      request.url.searchParams.append(name, value);
    }
  }
  for (const [name, value] of Object.entries(material.cookies ?? {})) {
    const serialized = credentialCookie(name, value);
    const encodedName = serialized.slice(0, serialized.indexOf('='));
    const existing = request.headers.get('cookie');
    const existingParts =
      existing === null
        ? []
        : existing
            .split(';')
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    if (existingParts.some((part) => part.startsWith(`${encodedName}=`))) {
      throw new ExecutionEngineError({
        code: 'CREDENTIAL_RESOLUTION_FAILED',
        message: 'A credential cookie conflicts with a tool-input cookie.',
      });
    }
    request.headers.set('cookie', [...existingParts, serialized].join('; '));
  }
}

function inferredAllowlist(
  request: BoundHttpRequest,
  policy: ExecutionPolicy,
): readonly HostAllowRule[] {
  return policy.allowedHosts ?? inferredHostAllowlist(request.url);
}

function addressForLiteral(url: URL): readonly DnsAddress[] | undefined {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return [{ address: hostname, family: 4 }];
  }
  if (hostname.includes(':')) {
    return [{ address: hostname, family: 6 }];
  }
  return undefined;
}

function normalizeUnknownError(error: unknown): ExecutionEngineError {
  if (isExecutionEngineError(error)) {
    return error;
  }
  return new ExecutionEngineError({
    code: 'UPSTREAM_NETWORK_ERROR',
    message: 'The upstream request failed before a valid response was received.',
    retryable: true,
    cause: error,
  });
}

export class HttpExecutionEngine {
  readonly #fetch: FetchImplementation | undefined;
  readonly #resolveDns;
  readonly #destinationPolicy: DestinationPolicy;
  readonly #credentialProvider;
  readonly #traceSink;
  readonly #sleep: SleepImplementation;
  readonly #now: () => number;
  readonly #createExecutionId: () => string;
  readonly #validator: SchemaValidator;
  readonly #valueComplexityLimits: JsonValueComplexityLimits;

  constructor(dependencies: ExecutionEngineDependencies = {}) {
    const complexity = normalizeComplexityLimits(dependencies.complexity);
    this.#validator = new SchemaValidator(complexity.schemas);
    this.#valueComplexityLimits = complexity.values;
    this.#fetch = dependencies.fetch;
    this.#resolveDns = dependencies.resolveDns ?? defaultDnsResolver;
    this.#destinationPolicy = dependencies.destinationPolicy ?? new PublicDestinationPolicy();
    this.#credentialProvider = dependencies.credentialProvider;
    this.#traceSink = dependencies.traceSink;
    this.#sleep = dependencies.sleep ?? abortableSleep;
    this.#now = dependencies.now ?? Date.now;
    this.#createExecutionId = dependencies.createExecutionId ?? randomUUID;
  }

  async execute<T extends JsonValue = JsonValue>(
    capability: ExecutableHttpCapability,
    input: JsonValue,
    options: ExecuteHttpOptions = {},
  ): Promise<ExecutionResult<T>> {
    const policy = options.policy ?? {};
    const context = options.context ?? {};
    const startedEpoch = this.#now();
    const startedAt = new Date(startedEpoch).toISOString();
    const totalTimeoutMs = normalizedTimeout(
      policy.totalTimeoutMs,
      DEFAULT_TOTAL_TIMEOUT_MS,
      'total',
    );
    const deadline = startedEpoch + totalTimeoutMs;
    const executionId = context.executionId ?? this.#createExecutionId();
    const serverIndex = policy.serverIndex ?? 0;
    const method = capability.execution.method;
    const traceState: TraceState = {
      attempts: 0,
      status: undefined,
      responseBytes: undefined,
      responseContentType: undefined,
    };
    let contextFailure: ExecutionEngineError | undefined;
    let traceAttributes: Readonly<Record<string, JsonValue>> = {};
    try {
      if (typeof executionId !== 'string' || executionId.length === 0) {
        throw new TypeError('The execution id must be a non-empty string.');
      }
      if (Buffer.byteLength(executionId, 'utf8') > this.#valueComplexityLimits.maxStringBytes) {
        throw new TypeError('The execution id exceeds the runtime string limit.');
      }
      if (context.principal !== undefined) {
        assertJsonValueComplexity(context.principal, this.#valueComplexityLimits);
      }
      if (context.traceAttributes !== undefined) {
        assertJsonValueComplexity(context.traceAttributes, this.#valueComplexityLimits);
        if (
          context.traceAttributes === null ||
          typeof context.traceAttributes !== 'object' ||
          Array.isArray(context.traceAttributes)
        ) {
          throw new TypeError('Trace attributes must be a JSON object.');
        }
        traceAttributes = redactSensitiveValue(
          { ...context.traceAttributes },
          policy.redaction,
        ) as Readonly<Record<string, JsonValue>>;
      }
    } catch (cause) {
      contextFailure = new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'The execution context exceeds the runtime safety policy.',
        cause,
      });
    }
    const baseServer = capability.execution.servers[serverIndex];
    let baseUrl: URL | undefined;
    try {
      if (baseServer !== undefined) {
        baseUrl = resolveServerUrl(baseServer);
      }
    } catch {
      // The binding phase below returns a sanitized, typed error.
    }
    let response: Response | undefined;
    let responseDisposer: (() => Promise<void>) | undefined;
    const disposeResponse = async (): Promise<void> => {
      const disposer = responseDisposer;
      responseDisposer = undefined;
      if (disposer === undefined) return;
      try {
        await disposer();
      } catch {
        // Connection cleanup must not mask a typed execution result or failure.
      }
    };

    try {
      if (contextFailure !== undefined) throw contextFailure;
      if (isAborted(context.signal)) {
        throw new ExecutionEngineError({
          code: 'REQUEST_CANCELLED',
          message: 'The execution was cancelled before dispatch.',
        });
      }

      if (['CONNECT', 'TRACE', 'TRACK'].includes(method)) {
        throw new ExecutionEngineError({
          code: 'METHOD_NOT_ALLOWED',
          message: `HTTP ${method} is disabled by the fetch execution boundary.`,
        });
      }

      try {
        assertJsonValueComplexity(input, this.#valueComplexityLimits);
      } catch (cause) {
        throw new ExecutionEngineError({
          code: 'INPUT_VALIDATION_FAILED',
          message: 'The tool input exceeds the runtime complexity policy.',
          cause,
        });
      }
      assertValid(this.#validator, capability.inputSchema, input, 'input');
      for (const binding of capability.execution.parameterBindings) {
        const parameter = getValueAtPath(input, binding.inputPath);
        if (parameter.found) {
          assertValid(this.#validator, binding.schema, parameter.value, 'input');
        }
      }
      const request = bindHttpRequest(
        capability,
        input,
        serverIndex,
        (schema, value) => this.#validator.validate(schema, value) === undefined,
      );
      if (request.requestBodyBinding?.schema !== undefined) {
        assertValid(
          this.#validator,
          request.requestBodyBinding.schema,
          request.requestBodyValue,
          'request-body',
        );
      }

      const allowedHosts = inferredAllowlist(request, policy);
      assertHostAllowed(request.url, allowedHosts);
      await this.#withinDeadline(
        (signal) =>
          this.#assertDestination(
            request.url,
            allowedHosts,
            policy.allowInsecureHttp ?? false,
            signal,
            deadline,
          ),
        deadline,
        context.signal,
        'destination validation',
      );

      const credentialMaterial = await this.#withinDeadline(
        (signal) =>
          this.#resolveCredentials(capability, policy, context, request.url, signal, deadline),
        deadline,
        context.signal,
        'credential resolution',
      );
      applyCredentials(request, credentialMaterial);
      if (policy.idempotencyKeyHeader !== undefined) {
        if (isSensitiveHeader(policy.idempotencyKeyHeader, policy.redaction)) {
          throw new ExecutionEngineError({
            code: 'BINDING_FAILED',
            message: 'A sensitive header cannot be used as an idempotency key.',
          });
        }
        assertCredentialHeader(policy.idempotencyKeyHeader, executionId);
        request.headers.set(policy.idempotencyKeyHeader, executionId);
      }

      const attemptTimeoutMs = normalizedTimeout(
        policy.attemptTimeoutMs,
        DEFAULT_ATTEMPT_TIMEOUT_MS,
        'attempt',
      );
      const retry = retryPolicy(policy);
      const maximumAttempts = mayRetry(capability, policy) ? retry.maxAttempts : 1;

      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        traceState.attempts = attempt;
        if (deadline - this.#now() <= 0) {
          throw new ExecutionEngineError({
            code: 'REQUEST_TIMEOUT',
            message: 'The execution exceeded its total timeout.',
          });
        }

        const verifiedAddresses = await this.#withinDeadline(
          (signal) =>
            this.#assertDestination(
              request.url,
              allowedHosts,
              policy.allowInsecureHttp ?? false,
              signal,
              deadline,
            ),
          deadline,
          context.signal,
          'destination validation',
        );
        const attemptRemaining = deadline - this.#now();
        if (attemptRemaining <= 0) {
          throw new ExecutionEngineError({
            code: 'REQUEST_TIMEOUT',
            message: 'The execution exceeded its total timeout before dispatch.',
          });
        }
        const attemptSignal = createAttemptSignal(
          context.signal,
          Math.min(attemptTimeoutMs, attemptRemaining),
        );
        try {
          const dispatched = await awaitWithSignal(
            this.#dispatch(
              request.url,
              {
                method: request.method,
                headers: request.headers,
                ...(request.body === undefined ? {} : { body: request.body }),
                redirect: 'manual',
                signal: attemptSignal.signal,
              },
              verifiedAddresses,
            ),
            attemptSignal.signal,
          );
          response = dispatched.response;
          responseDisposer = dispatched.dispose;
        } catch (cause) {
          if (isAborted(context.signal)) {
            throw new ExecutionEngineError({
              code: 'REQUEST_CANCELLED',
              message: 'The execution was cancelled during dispatch.',
              cause,
            });
          }
          if (attemptSignal.timedOut()) {
            const timeoutError = new ExecutionEngineError({
              code: 'REQUEST_TIMEOUT',
              message: 'The upstream request attempt timed out.',
              retryable: true,
              cause,
            });
            if (attempt >= maximumAttempts) {
              throw timeoutError;
            }
          } else if (attempt >= maximumAttempts) {
            throw normalizeUnknownError(cause);
          }

          const now = this.#now();
          const delay = retryDelay(attempt, undefined, retry, now);
          assertRetryWithinDeadline(delay, deadline, now);
          await this.#withinDeadline(
            (signal) => this.#sleep(delay, signal),
            deadline,
            context.signal,
            'retry delay',
          );
          continue;
        } finally {
          attemptSignal.dispose();
        }

        traceState.status = response.status;
        traceState.responseContentType = normalizedContentType(
          response.headers.get('content-type'),
        );
        if (retry.retryableStatuses.includes(response.status) && attempt < maximumAttempts) {
          const now = this.#now();
          const delay = retryDelay(attempt, response, retry, now);
          assertRetryWithinDeadline(delay, deadline, now);
          await response.body?.cancel();
          await disposeResponse();
          response = undefined;
          await this.#withinDeadline(
            (signal) => this.#sleep(delay, signal),
            deadline,
            context.signal,
            'retry delay',
          );
          continue;
        }
        break;
      }

      if (response === undefined) {
        throw new ExecutionEngineError({
          code: 'UPSTREAM_NETWORK_ERROR',
          message: 'The upstream request did not produce a response.',
        });
      }
      const responseContentType = normalizedContentType(response.headers.get('content-type'));
      if (!isSuccessfulResponse(capability.execution, response.status, responseContentType)) {
        await response.body?.cancel();
        await disposeResponse();
        throw new ExecutionEngineError({
          code: 'UPSTREAM_HTTP_ERROR',
          message: 'The upstream API returned a status outside the compiled success contract.',
          retryable: false,
          details: { status: response.status },
        });
      }

      const responseRemaining = deadline - this.#now();
      if (responseRemaining <= 0) {
        throw new ExecutionEngineError({
          code: 'REQUEST_TIMEOUT',
          message: 'The execution exceeded its total timeout before reading the response.',
        });
      }
      const responseSignal = createAttemptSignal(
        context.signal,
        Math.min(attemptTimeoutMs, responseRemaining),
      );
      let parsed: Awaited<ReturnType<typeof parseHttpResponse>>;
      try {
        parsed = await parseHttpResponse(
          response,
          capability.execution,
          policy.response,
          responseSignal.signal,
        );
      } catch (cause) {
        if (isAborted(context.signal)) {
          throw new ExecutionEngineError({
            code: 'REQUEST_CANCELLED',
            message: 'The execution was cancelled while reading the upstream response.',
            cause,
          });
        }
        if (responseSignal.timedOut()) {
          throw new ExecutionEngineError({
            code: 'REQUEST_TIMEOUT',
            message: 'Reading the upstream response timed out.',
            cause,
          });
        }
        throw cause;
      } finally {
        responseSignal.dispose();
        await disposeResponse();
      }
      traceState.responseBytes = parsed.bytes;
      traceState.responseContentType = parsed.contentType;
      try {
        assertJsonValueComplexity(parsed.rawOutput, this.#valueComplexityLimits);
      } catch (cause) {
        throw new ExecutionEngineError({
          code: 'OUTPUT_VALIDATION_FAILED',
          message: 'The upstream output exceeds the runtime complexity policy.',
          cause,
        });
      }
      if (parsed.selectedResponse.schema !== undefined) {
        assertValid(this.#validator, parsed.selectedResponse.schema, parsed.rawOutput, 'output');
      }
      const output = redactOutputPaths(parsed.output, policy.redaction);
      if (capability.outputSchema !== undefined) {
        assertValid(this.#validator, capability.outputSchema, output, 'output');
      }

      const trace = this.#trace(
        capability,
        traceAttributes,
        executionId,
        serverIndex,
        baseUrl,
        startedEpoch,
        startedAt,
        traceState,
        'success',
      );
      await this.#recordTrace(trace);
      return { output: output as T, trace };
    } catch (caught) {
      try {
        await response?.body?.cancel();
      } catch {
        // The original typed failure takes precedence over best-effort body cancellation.
      }
      await disposeResponse();
      const error =
        isAborted(context.signal) && !isExecutionEngineError(caught)
          ? new ExecutionEngineError({
              code: 'REQUEST_CANCELLED',
              message: 'The execution was cancelled.',
              cause: caught,
            })
          : normalizeUnknownError(caught);
      const outcome = error.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'error';
      const trace = this.#trace(
        capability,
        traceAttributes,
        executionId,
        serverIndex,
        baseUrl,
        startedEpoch,
        startedAt,
        traceState,
        outcome,
        error.code,
      );
      error.trace = trace;
      await this.#recordTrace(trace);
      throw error;
    }
  }

  async #resolveCredentials(
    capability: ExecutableHttpCapability,
    policy: ExecutionPolicy,
    context: ExecutionContext,
    url: URL,
    signal: AbortSignal,
    deadlineEpochMs: number,
  ): Promise<CredentialMaterial | undefined> {
    if (this.#credentialProvider === undefined) {
      if (capability.auth.required) {
        throw new ExecutionEngineError({
          code: 'CREDENTIAL_RESOLUTION_FAILED',
          message: 'The capability requires upstream credentials, but no provider is configured.',
        });
      }
      return undefined;
    }

    try {
      const material = await this.#credentialProvider.resolve({
        capability,
        ...(policy.credential === undefined ? {} : { reference: policy.credential }),
        destination: {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
        },
        ...(context.principal === undefined ? {} : { principal: context.principal }),
        signal,
        deadlineEpochMs,
      });
      if (capability.auth.required && material === undefined) {
        throw new ExecutionEngineError({
          code: 'CREDENTIAL_RESOLUTION_FAILED',
          message: 'The credential provider returned no credentials for a protected capability.',
        });
      }
      return material;
    } catch (cause) {
      if (isExecutionEngineError(cause)) {
        throw cause;
      }
      throw new ExecutionEngineError({
        code: 'CREDENTIAL_RESOLUTION_FAILED',
        message: 'Upstream credentials could not be resolved.',
        cause,
      });
    }
  }

  async #withinDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    deadline: number,
    parentSignal: AbortSignal | undefined,
    phase: string,
  ): Promise<T> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) {
      throw new ExecutionEngineError({
        code: 'REQUEST_TIMEOUT',
        message: `The execution timed out before ${phase}.`,
      });
    }

    const bounded = createAttemptSignal(parentSignal, remaining);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(bounded.signal.reason);
      if (bounded.signal.aborted) onAbort();
      else bounded.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([Promise.resolve().then(() => operation(bounded.signal)), aborted]);
    } catch (cause) {
      if (parentSignal?.aborted === true) {
        throw new ExecutionEngineError({
          code: 'REQUEST_CANCELLED',
          message: `The execution was cancelled during ${phase}.`,
          cause,
        });
      }
      if (bounded.timedOut()) {
        throw new ExecutionEngineError({
          code: 'REQUEST_TIMEOUT',
          message: `The execution timed out during ${phase}.`,
          cause,
        });
      }
      throw cause;
    } finally {
      if (onAbort !== undefined) bounded.signal.removeEventListener('abort', onAbort);
      bounded.dispose();
    }
  }

  async #dispatch(
    url: URL,
    init: RequestInit,
    verifiedAddresses: readonly DnsAddress[],
  ): Promise<{ readonly response: Response; dispose(): Promise<void> }> {
    if (this.#fetch === undefined) {
      return dispatchWithPinnedDns(url, init, verifiedAddresses);
    }

    const response = await this.#fetch(url, init, {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      addresses: verifiedAddresses,
    });
    return { response, async dispose() {} };
  }

  async #assertDestination(
    url: URL,
    allowedHosts: readonly HostAllowRule[],
    allowInsecureHttp: boolean,
    signal: AbortSignal,
    deadlineEpochMs: number,
  ): Promise<readonly DnsAddress[]> {
    assertHostAllowed(url, allowedHosts);
    let addresses: readonly DnsAddress[];
    try {
      const resolved =
        addressForLiteral(url) ??
        (await this.#resolveDns(url.hostname, { signal, deadlineEpochMs }));
      addresses = resolved.map(({ address, family }) => ({ address, family }));
    } catch (cause) {
      throw new ExecutionEngineError({
        code: 'UPSTREAM_NETWORK_ERROR',
        message: 'The upstream destination could not be resolved.',
        retryable: true,
        cause,
      });
    }
    await this.#destinationPolicy.assertAllowed({
      url,
      addresses,
      allowedHosts,
      allowInsecureHttp,
      signal,
      deadlineEpochMs,
    });
    return addresses;
  }

  #trace(
    capability: ExecutableHttpCapability,
    attributes: Readonly<Record<string, JsonValue>>,
    executionId: string,
    serverIndex: number,
    baseUrl: URL | undefined,
    startedEpoch: number,
    startedAt: string,
    state: TraceState,
    outcome: ExecutionTraceMetadata['outcome'],
    errorCode?: string,
  ): ExecutionTraceMetadata {
    return {
      executionId,
      capabilityId: capability.id,
      capabilityName: capability.name,
      method: capability.execution.method,
      serverIndex,
      target: {
        protocol: baseUrl?.protocol ?? 'unresolved:',
        hostname: baseUrl?.hostname ?? 'unresolved',
        port: baseUrl?.port ?? '',
        pathTemplate: capability.execution.pathTemplate,
      },
      startedAt,
      durationMs: Math.max(0, this.#now() - startedEpoch),
      attempts: state.attempts,
      ...(state.status === undefined ? {} : { status: state.status }),
      ...(state.responseBytes === undefined ? {} : { responseBytes: state.responseBytes }),
      ...(state.responseContentType === undefined
        ? {}
        : { responseContentType: state.responseContentType }),
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      attributes,
    };
  }

  async #recordTrace(trace: ExecutionTraceMetadata): Promise<void> {
    try {
      await this.#traceSink?.record(trace);
    } catch {
      // Observability failures must not alter an upstream execution outcome.
    }
  }
}

export function createExecutionEngine(
  dependencies: ExecutionEngineDependencies = {},
): HttpExecutionEngine {
  return new HttpExecutionEngine(dependencies);
}

export async function executeHttpCapability<T extends JsonValue = JsonValue>(
  capability: ExecutableHttpCapability,
  input: JsonValue,
  options: ExecuteHttpCapabilityOptions = {},
): Promise<ExecutionResult<T>> {
  return new HttpExecutionEngine(options.dependencies).execute<T>(capability, input, options);
}
