import type { Diagnostic, DiagnosticSeverity, JsonValue } from '@hi-mcp/capability-ir';

interface DiagnosticInput {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly pointer?: string;
  readonly recoverable?: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

const DIAGNOSTIC_NAMESPACE = /^[A-Z][A-Z0-9_]*$/;

export function normalizeDiagnosticNamespace(value: string | undefined): string {
  const namespace = value ?? 'SOURCE';
  if (!DIAGNOSTIC_NAMESPACE.test(namespace)) {
    throw new TypeError(
      'Diagnostic namespace must contain only uppercase letters, digits, and underscores.',
    );
  }
  return namespace;
}

export class SourceDiagnosticCollector {
  readonly #diagnostics: Diagnostic[] = [];
  readonly #seen = new Set<string>();

  public constructor(
    private readonly namespace: string,
    private readonly sourceUri?: string,
  ) {}

  public add(input: DiagnosticInput): void {
    const code = `${this.namespace}.${input.code}`;
    const key = `${code}\u0000${input.pointer ?? ''}\u0000${input.message}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const location =
      input.pointer !== undefined || this.sourceUri !== undefined
        ? {
            ...(this.sourceUri === undefined ? {} : { sourceUri: this.sourceUri }),
            ...(input.pointer === undefined ? {} : { pointer: input.pointer }),
          }
        : undefined;
    this.#diagnostics.push({
      code,
      severity: input.severity,
      message: input.message,
      ...(location === undefined ? {} : { location }),
      related: [],
      recoverable: input.recoverable ?? true,
      ...(input.details === undefined ? {} : { details: { ...input.details } }),
    });
  }

  public all(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  public hasErrors(): boolean {
    return this.#diagnostics.some(({ severity }) => severity === 'error');
  }
}
