import { DiagnosticSchema, type Diagnostic } from '@hi-mcp/capability-ir';

export function createDiagnostic(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  options: {
    readonly sourceUri?: string;
    readonly pointer?: string;
    readonly recoverable?: boolean;
    readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  } = {},
): Diagnostic {
  const hasLocation = options.sourceUri !== undefined || options.pointer !== undefined;
  return DiagnosticSchema.parse({
    code,
    severity,
    message,
    ...(hasLocation
      ? {
          location: {
            ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
            ...(options.pointer === undefined ? {} : { pointer: options.pointer }),
          },
        }
      : {}),
    related: [],
    recoverable: options.recoverable ?? true,
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

export function annotateDiagnostic(diagnostic: Diagnostic, capabilityId: string): Diagnostic {
  return DiagnosticSchema.parse({
    ...diagnostic,
    details: {
      ...diagnostic.details,
      capabilityId,
    },
  });
}
