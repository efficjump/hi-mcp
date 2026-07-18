import type { ConsoleDiagnostic } from '../shared/contracts.js';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics: readonly ConsoleDiagnostic[] | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    diagnostics?: readonly ConsoleDiagnostic[],
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
