import type { Diagnostic } from '@hi-mcp/capability-ir';

const severityRank: Readonly<Record<Diagnostic['severity'], number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const bySeverity = severityRank[left.severity] - severityRank[right.severity];
    if (bySeverity !== 0) return bySeverity;

    const bySource = (left.location?.sourceUri ?? '').localeCompare(
      right.location?.sourceUri ?? '',
    );
    if (bySource !== 0) return bySource;

    const byPointer = (left.location?.pointer ?? '').localeCompare(right.location?.pointer ?? '');
    return byPointer === 0 ? left.code.localeCompare(right.code) : byPointer;
  });
}

function diagnosticLocation(diagnostic: Diagnostic): string {
  const source = diagnostic.location?.sourceUri;
  const pointer = diagnostic.location?.pointer;

  if (source === undefined && pointer === undefined) return '';
  return ` ${source ?? ''}${pointer === undefined ? '' : `#${pointer}`}`;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${diagnosticLocation(diagnostic)}: ${diagnostic.message}`;
}

export function writeHumanDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of sortDiagnostics(diagnostics)) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  }
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
