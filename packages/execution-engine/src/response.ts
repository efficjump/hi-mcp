import { ExecutionEngineError } from './errors.js';
import type { HttpExecutionPlan, JsonValue, ResponsePolicy, SuccessResponse } from './types.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export interface ParsedHttpResponse {
  readonly output: JsonValue;
  readonly rawOutput: JsonValue;
  readonly selectedResponse: SuccessResponse;
  readonly contentType?: string;
  readonly bytes: number;
}

export function normalizedContentType(value: string | null): string | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === '' || mediaType === undefined ? undefined : mediaType;
}

export function mediaTypeMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizedContentType(actual);
  const normalizedExpected = normalizedContentType(expected);
  if (normalizedActual === undefined || normalizedExpected === undefined) {
    return false;
  }
  if (normalizedExpected === '*/*' || normalizedActual === normalizedExpected) {
    return true;
  }

  const [expectedType, expectedSubtype] = normalizedExpected.split('/', 2);
  const [actualType, actualSubtype] = normalizedActual.split('/', 2);
  if (expectedType === undefined || expectedSubtype === undefined) {
    return false;
  }
  if (expectedType !== '*' && expectedType !== actualType) {
    return false;
  }
  if (expectedSubtype === '*') {
    return true;
  }
  if (expectedSubtype.startsWith('*+') && actualSubtype?.endsWith(expectedSubtype.slice(1))) {
    return true;
  }
  return false;
}

export function selectSuccessResponse(
  execution: HttpExecutionPlan,
  status: number,
  contentType: string | undefined,
): SuccessResponse | undefined {
  const statusCandidates = successResponseCandidates(execution, status);
  const typed = statusCandidates.find(
    (candidate: SuccessResponse) =>
      candidate.contentType !== undefined &&
      contentType !== undefined &&
      mediaTypeMatches(contentType, candidate.contentType),
  );
  return (
    typed ??
    statusCandidates.find((candidate: SuccessResponse) => candidate.contentType === undefined)
  );
}

function successResponseCandidates(
  execution: HttpExecutionPlan,
  status: number,
): readonly SuccessResponse[] {
  const exact = execution.successResponses.filter(
    (candidate: SuccessResponse) => candidate.statusCode.toUpperCase() === String(status),
  );
  if (exact.length > 0) return exact;
  const statusClass = execution.successResponses.filter(
    (candidate: SuccessResponse) =>
      candidate.statusCode.toUpperCase() === `${Math.floor(status / 100)}XX`,
  );
  if (statusClass.length > 0) return statusClass;
  const fallback = execution.successResponses.filter(
    (candidate: SuccessResponse) => candidate.statusCode.toLowerCase() === 'default',
  );
  return fallback;
}

export function isSuccessfulResponse(
  execution: HttpExecutionPlan,
  status: number,
  _contentType: string | undefined,
): boolean {
  if (status < 200 || status >= 300) return false;
  if (execution.successResponses.length === 0) {
    return true;
  }
  return successResponseCandidates(execution, status).length > 0;
}

async function readFromStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  if (signal === undefined) {
    return reader.read();
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ExecutionEngineError({
      code: 'RESPONSE_TOO_LARGE',
      message: 'The configured response-size limit is invalid.',
    });
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ExecutionEngineError({
      code: 'RESPONSE_TOO_LARGE',
      message: 'The upstream response exceeds the configured size limit.',
      details: { maxBytes, declaredLength },
    });
  }
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readFromStream(reader, signal);
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ExecutionEngineError({
          code: 'RESPONSE_TOO_LARGE',
          message: 'The upstream response exceeds the configured size limit.',
          details: { maxBytes },
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseBody(bytes: Uint8Array, parseAs: 'json' | 'text'): JsonValue {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ExecutionEngineError({
      code: 'RESPONSE_PARSE_FAILED',
      message: 'The upstream response is not valid UTF-8.',
      cause,
    });
  }

  if (parseAs === 'text') {
    return text;
  }
  if (text.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw new ExecutionEngineError({
      code: 'RESPONSE_PARSE_FAILED',
      message: 'The upstream response is not valid JSON.',
      cause,
    });
  }
}

function isJsonMediaType(contentType: string | undefined): boolean {
  return (
    contentType === 'application/json' ||
    contentType?.endsWith('+json') === true ||
    contentType?.endsWith('/json') === true
  );
}

export async function parseHttpResponse(
  response: Response,
  execution: HttpExecutionPlan,
  policy: ResponsePolicy | undefined,
  signal?: AbortSignal,
): Promise<ParsedHttpResponse> {
  const contentType = normalizedContentType(response.headers.get('content-type'));
  const selectedResponse = selectSuccessResponse(execution, response.status, contentType);
  const maxBytes = policy?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  if (selectedResponse === undefined) {
    throw new ExecutionEngineError({
      code: 'RESPONSE_CONTENT_TYPE_REJECTED',
      message:
        'The upstream response does not match a media contract in the compiled success-response status tier.',
      details: {
        status: response.status,
        contentType: contentType ?? null,
      },
    });
  }

  if (response.status !== 204 && response.status !== 205) {
    if (contentType === undefined) {
      if (policy?.allowMissingContentType !== true) {
        throw new ExecutionEngineError({
          code: 'RESPONSE_CONTENT_TYPE_REJECTED',
          message: 'The upstream response is missing a required Content-Type header.',
        });
      }
    } else if (
      policy?.allowedContentTypes !== undefined &&
      !policy.allowedContentTypes.some((expected) => mediaTypeMatches(contentType, expected))
    ) {
      throw new ExecutionEngineError({
        code: 'RESPONSE_CONTENT_TYPE_REJECTED',
        message: 'The upstream response Content-Type is not allowed by runtime response policy.',
        details: { contentType },
      });
    }
  }

  const bytes = await readLimitedBody(response, maxBytes, signal);
  const parseAs = policy?.parseAs ?? (isJsonMediaType(contentType) ? 'json' : 'text');
  const rawOutput = parseBody(bytes, parseAs);

  return {
    output: rawOutput,
    rawOutput,
    selectedResponse,
    ...(contentType === undefined ? {} : { contentType }),
    bytes: bytes.byteLength,
  };
}
