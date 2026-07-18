import {
  type Capability,
  type Diagnostic,
  type JsonSchema,
  type JsonValue,
  type Release,
} from '@hi-mcp/capability-ir';
import {
  verifyRelease,
  type ReleaseVerificationOptions,
  type ReleaseVerificationResult,
} from '@hi-mcp/deterministic-verifier';
import {
  ExecutionEngineError,
  createExecutionEngine,
  type ExecutionContext,
  type ExecutionEngineDependencies,
  type ExecutionPolicy,
  type ExecutionResult,
} from '@hi-mcp/execution-engine';

import {
  inspectJsonValue,
  type JsonValueInspectionResult,
  type ToolInputLimits,
} from './input-limits.js';

export interface CapabilityExecutor {
  execute(
    capability: Capability,
    input: JsonValue,
    options?: {
      readonly policy?: ExecutionPolicy;
      readonly context?: ExecutionContext;
    },
  ): Promise<ExecutionResult<JsonValue>>;
}

export interface RuntimePolicy {
  /**
   * Coarse process-wide approval for every capability marked requiresConfirmation. Prefer the
   * per-call callback whenever an interactive or policy-aware approval mechanism is available.
   */
  readonly allowConfirmationRequired?: boolean;
  /**
   * Authoritative per-call approval. When configured, a false result or thrown error cannot be
   * bypassed by allowConfirmationRequired.
   */
  readonly approveConfirmationRequired?: (
    request: ConfirmationRequest,
  ) => boolean | Promise<boolean>;
  /** Development-only escape hatch that trusts destination hosts embedded in the release. */
  readonly trustCompiledHosts?: boolean;
  readonly execution?: ExecutionPolicy;
  readonly executionForCapability?: (
    capability: Capability,
  ) => ExecutionPolicy | Promise<ExecutionPolicy>;
}

export interface ConfirmationRequest {
  readonly capability: Capability;
  readonly input: JsonValue;
  readonly context: ExecutionContext;
}

export interface RuntimeOptions {
  readonly executor?: CapabilityExecutor;
  readonly executionDependencies?: ExecutionEngineDependencies;
  readonly inputLimits?: Partial<ToolInputLimits>;
  /** Optional authoritative normalized source documents for stronger release grounding. */
  readonly verification?: ReleaseVerificationOptions;
  readonly policy?: RuntimePolicy;
}

export interface RuntimeToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, JsonValue>;
  readonly outputSchema?: Record<string, JsonValue>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export interface RuntimeToolCallResult {
  readonly isError: boolean;
  readonly output?: JsonValue;
  readonly code?: string;
  readonly message?: string;
  readonly trace?: ExecutionResult['trace'];
}

export class UnknownCapabilityError extends Error {
  constructor(name: string) {
    super(`Unknown capability: ${name}`);
    this.name = 'UnknownCapabilityError';
  }
}

export class ReleaseVerificationError extends TypeError {
  readonly diagnostics: readonly Diagnostic[];

  constructor(result: ReleaseVerificationResult) {
    const codes = [...new Set(result.errors.map((item) => item.code))].slice(0, 5);
    super(
      `Release verification failed with ${result.errors.length} error(s): ${codes.join(', ') || 'unknown error'}`,
    );
    this.name = 'ReleaseVerificationError';
    this.diagnostics = result.diagnostics;
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function asObjectSchema(schema: JsonSchema, label: string): Record<string, JsonValue> {
  if (typeof schema === 'boolean' || schema['type'] !== 'object') {
    throw new TypeError(`${label} must be a JSON Schema with an object root.`);
  }
  return schema;
}

function optionalObjectSchema(
  schema: JsonSchema | undefined,
  label: string,
): Record<string, JsonValue> | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema === 'boolean' || schema['type'] !== 'object') return undefined;
  return asObjectSchema(schema, label);
}

function annotations(capability: Capability): RuntimeToolDefinition['annotations'] {
  return {
    readOnlyHint: capability.risk.level === 'read' && capability.risk.sideEffect === 'none',
    destructiveHint: capability.risk.level === 'destructive',
    idempotentHint: capability.risk.idempotency === 'idempotent',
    openWorldHint: true,
  };
}

function toToolDefinition(capability: Capability): RuntimeToolDefinition {
  const outputSchema = optionalObjectSchema(
    capability.outputSchema,
    `${capability.name}.outputSchema`,
  );
  return {
    name: capability.name,
    ...(capability.title === undefined ? {} : { title: capability.title }),
    description: capability.description,
    inputSchema: asObjectSchema(capability.inputSchema, `${capability.name}.inputSchema`),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    annotations: annotations(capability),
  };
}

function sanitizedExecutionFailure(error: ExecutionEngineError): RuntimeToolCallResult {
  return {
    isError: true,
    code: error.code,
    message: error.message,
    ...(error.trace === undefined ? {} : { trace: error.trace }),
  };
}

export class ReleaseRuntime {
  readonly #release: Release;
  readonly #capabilitiesByName: ReadonlyMap<string, Capability>;
  readonly #executor: CapabilityExecutor;
  readonly #inputLimits: Partial<ToolInputLimits> | undefined;
  readonly #policy: RuntimePolicy;

  constructor(release: unknown, options: RuntimeOptions = {}) {
    const verification = verifyRelease(release, options.verification);
    if (!verification.valid || verification.release === undefined) {
      throw new ReleaseVerificationError(verification);
    }
    this.#release = deepFreeze(verification.release);
    // Validate operator configuration at startup instead of failing on the first tool call.
    inspectJsonValue(null, options.inputLimits);
    this.#inputLimits = options.inputLimits;
    this.#policy = options.policy ?? {};
    this.#executor = options.executor ?? createExecutionEngine(options.executionDependencies);

    const capabilitiesByName = new Map<string, Capability>();
    for (const capability of this.#release.capabilities) {
      if (capabilitiesByName.has(capability.name)) {
        throw new TypeError(`Release contains duplicate capability name: ${capability.name}`);
      }
      asObjectSchema(capability.inputSchema, `${capability.name}.inputSchema`);
      capabilitiesByName.set(capability.name, capability);
    }
    this.#capabilitiesByName = capabilitiesByName;
  }

  get release(): Release {
    return this.#release;
  }

  listTools(): readonly RuntimeToolDefinition[] {
    return [...this.#capabilitiesByName.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(toToolDefinition);
  }

  async callTool(
    name: string,
    rawArguments: unknown,
    context: ExecutionContext = {},
  ): Promise<RuntimeToolCallResult> {
    const capability = this.#capabilitiesByName.get(name);
    if (capability === undefined) throw new UnknownCapabilityError(name);

    let inspectedArguments: JsonValueInspectionResult;
    try {
      inspectedArguments = inspectJsonValue(rawArguments ?? {}, this.#inputLimits);
    } catch {
      return {
        isError: true,
        code: 'INVALID_TOOL_ARGUMENTS',
        message: 'Tool arguments could not be safely inspected.',
      };
    }
    if (!inspectedArguments.valid) {
      return {
        isError: true,
        code: inspectedArguments.limitExceeded
          ? 'TOOL_ARGUMENT_LIMIT_EXCEEDED'
          : 'INVALID_TOOL_ARGUMENTS',
        message: inspectedArguments.message,
      };
    }
    let executionInput: JsonValue;
    try {
      executionInput = structuredClone(inspectedArguments.value);
    } catch {
      return {
        isError: true,
        code: 'INVALID_TOOL_ARGUMENTS',
        message: 'Tool arguments could not be safely copied.',
      };
    }

    let executionPolicy: ExecutionPolicy | undefined;
    try {
      executionPolicy =
        (await this.#policy.executionForCapability?.(capability)) ?? this.#policy.execution;
    } catch {
      return {
        isError: true,
        code: 'EXECUTION_POLICY_ERROR',
        message: 'The execution policy could not be resolved for this call.',
      };
    }
    if (executionPolicy?.allowedHosts === undefined && this.#policy.trustCompiledHosts !== true) {
      return {
        isError: true,
        code: 'DESTINATION_ALLOWLIST_REQUIRED',
        message: 'An operator-supplied destination host allowlist is required.',
      };
    }

    if (capability.risk.requiresConfirmation) {
      const approver = this.#policy.approveConfirmationRequired;
      if (approver !== undefined) {
        try {
          const approved = await approver({
            capability,
            input: structuredClone(executionInput),
            context,
          });
          if (!approved) {
            return {
              isError: true,
              code: 'CONFIRMATION_REQUIRED',
              message: 'This capability requires approval for the current call.',
            };
          }
        } catch {
          return {
            isError: true,
            code: 'CONFIRMATION_POLICY_ERROR',
            message: 'The confirmation policy could not approve this call.',
          };
        }
      } else if (this.#policy.allowConfirmationRequired !== true) {
        return {
          isError: true,
          code: 'CONFIRMATION_REQUIRED',
          message: 'This capability requires an explicitly approved runtime policy.',
        };
      }
    }

    try {
      const result = await this.#executor.execute(capability, executionInput, {
        ...(executionPolicy === undefined ? {} : { policy: executionPolicy }),
        context,
      });
      return { isError: false, output: result.output, trace: result.trace };
    } catch (error) {
      if (error instanceof ExecutionEngineError) return sanitizedExecutionFailure(error);
      return {
        isError: true,
        code: 'INTERNAL_EXECUTION_ERROR',
        message: 'The capability could not be executed.',
      };
    }
  }
}
