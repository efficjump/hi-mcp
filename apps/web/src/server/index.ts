import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readdir, readFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo } from 'node:net';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fingerprint, type NormalizedApiDocument } from '@hi-mcp/capability-ir';
import {
  AnalysisReviewStaleError,
  analyzeSource,
  compareReleaseToDocument,
  compileSource,
  createSourceAdapterRegistry,
  fingerprintAnalysis,
  loadConfig,
  OperationSelectionError,
  PipelineError,
  reviewOperationSelection,
  SourceAdapterSelectionError,
  type HiMcpConfig,
} from '@hi-mcp/cli';
import type { ViteDevServer } from 'vite';
import { z, ZodError } from 'zod';

import type {
  AnalysisResponse,
  ApiErrorPayload,
  ConnectionRequest,
  ContractDiffRequest,
  ConsoleDiagnostic,
  ConsoleSample,
  ConsoleStatus,
  RegistrationRequest,
  SelectionPresetDetail,
  SelectionPresetRequest,
  SelectionPresetReviewRequest,
  SelectionPresetReviewResponse,
  SelectionPresetSummary,
  SourceRequest,
} from '../shared/contracts.js';
import { HttpError } from './http-error.js';
import {
  SelectionPresetStore,
  selectionPresetSourceScopeId,
  type SelectionPresetListRecord,
  type SelectionPresetRecord,
} from './selection-preset-store.js';
import { ArtifactStore } from './store.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4_173;
const MAX_SOURCE_BYTES = 10 * 1_024 * 1024;
const MAX_SOURCE_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 64 * 1_024;
const MAX_JSON_REQUEST_BYTES = 256 * 1_024;
const MAX_OPERATION_SELECTION_ITEMS = 100_000;
const MAX_SELECTION_PRESETS_PER_SOURCE = 64;
const MAX_SELECTION_PRESET_NAME_BYTES = 256;
const MAX_SAMPLES = 100;
const MAX_SAMPLE_DEPTH = 6;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAMPLE_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);
const CONFIG_FILENAMES = ['.himcp.yaml', '.himcp.yml', '.himcp.json'] as const;
const SOURCE_TYPE = /^(?:auto|[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)$/;
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^[a-z][a-z0-9_-]*$/;
const MANAGED_ID = /^[a-z][a-z0-9_-]{0,127}$/;

const SourceRequestSchema = z
  .object({
    source: z.string().min(1),
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\u0000-\u001f\u007f\\/]+$/u),
    sourceType: z.string().regex(SOURCE_TYPE).default('auto'),
  })
  .strict();

const RegistrationRequestSchema = SourceRequestSchema.extend({
  reviewedAnalysisFingerprint: z.string().regex(FINGERPRINT),
  includedOperationIds: z
    .array(z.string().max(128).regex(OPERATION_ID))
    .min(1)
    .max(MAX_OPERATION_SELECTION_ITEMS),
})
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.includedOperationIds).size !== request.includedOperationIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['includedOperationIds'],
        message: 'Operation selection cannot contain duplicate IDs.',
      });
    }
  });

const SelectionPresetRequestSchema = SourceRequestSchema.extend({
  name: z.string().min(1).max(MAX_SELECTION_PRESET_NAME_BYTES),
  reviewedAnalysisFingerprint: z.string().regex(FINGERPRINT),
  includedOperationIds: z
    .array(z.string().max(128).regex(OPERATION_ID))
    .min(1)
    .max(MAX_OPERATION_SELECTION_ITEMS),
})
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.includedOperationIds).size !== request.includedOperationIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['includedOperationIds'],
        message: 'Operation selection cannot contain duplicate IDs.',
      });
    }
  });

const ContractDiffRequestSchema = SourceRequestSchema.extend({
  baselineRegistrationId: z.string().regex(MANAGED_ID),
  reviewedAnalysisFingerprint: z.string().regex(FINGERPRINT),
}).strict();

const SelectionPresetReviewRequestSchema = SourceRequestSchema.extend({
  reviewedAnalysisFingerprint: z.string().regex(FINGERPRINT),
  selectionFingerprint: z.string().regex(FINGERPRINT),
}).strict();

const ConnectionRequestSchema = z
  .object({
    displayName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    description: z
      .string()
      .max(4_096)
      .regex(/^[^\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u)
      .optional(),
    approvedOrigins: z.array(z.url()).min(1).max(128),
    allowInsecureHttp: z.boolean(),
    confirmation: z.enum(['per-call', 'process']),
    credentialEnvironment: z
      .record(
        z.string().regex(ENVIRONMENT_VARIABLE),
        z.string().regex(ENVIRONMENT_VARIABLE).max(128),
      )
      .refine((value) => Object.keys(value).length <= 128, 'Credential override limit exceeded.'),
  })
  .strict();

const PackageMetadataSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1) })
  .passthrough();

interface SampleRecord extends ConsoleSample {
  readonly absolutePath: string;
}

export interface ConsoleServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dataDirectory?: string;
  readonly examplesDirectory?: string;
  readonly clientDirectory?: string;
  readonly cliEntryPath?: string;
  readonly config?: HiMcpConfig;
  readonly development?: boolean;
  readonly serveClient?: boolean;
}

export interface RunningConsoleServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function findAncestorWithMarker(start: string, marker: string): Promise<string | undefined> {
  let directory = resolve(start);
  for (;;) {
    if (await pathExists(join(directory, marker))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function discoverProjectRoot(): Promise<string> {
  const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
  return (
    (await findAncestorWithMarker(moduleDirectory, 'pnpm-workspace.yaml')) ??
    (await findAncestorWithMarker(process.cwd(), 'pnpm-workspace.yaml')) ??
    resolve(process.cwd())
  );
}

async function findProjectConfig(projectRoot: string): Promise<string | undefined> {
  for (const filename of CONFIG_FILENAMES) {
    const location = join(projectRoot, filename);
    if (await pathExists(location)) return location;
  }
  return undefined;
}

function hostFromHeader(value: string | undefined): string {
  if (value === undefined || value.includes('@') || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new HttpError(403, 'HOST_REJECTED', '허용되지 않은 Host 요청입니다.');
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username !== '' || parsed.password !== '' || !isLoopbackHost(parsed.hostname)) {
      throw new Error('not loopback');
    }
    return parsed.host;
  } catch {
    throw new HttpError(403, 'HOST_REJECTED', '허용되지 않은 Host 요청입니다.');
  }
}

function safeTokenMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function validateMutationRequest(request: IncomingMessage, csrfToken: string): void {
  const host = hostFromHeader(request.headers.host);
  const origin = request.headers.origin;
  if (origin === undefined) {
    throw new HttpError(403, 'ORIGIN_REQUIRED', '상태 변경 요청에는 Origin 헤더가 필요합니다.');
  }
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new HttpError(403, 'ORIGIN_REJECTED', '허용되지 않은 Origin 요청입니다.');
  }
  if (normalizedOrigin !== new URL(`http://${host}`).origin) {
    throw new HttpError(403, 'ORIGIN_REJECTED', '허용되지 않은 Origin 요청입니다.');
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    throw new HttpError(403, 'CROSS_SITE_REJECTED', '교차 사이트 요청은 허용되지 않습니다.');
  }
  if (!safeTokenMatches(csrfToken, request.headers['x-himcp-csrf'] as string | undefined)) {
    throw new HttpError(403, 'CSRF_REJECTED', 'Console 보안 토큰이 유효하지 않습니다.');
  }
}

function setSecurityHeaders(response: ServerResponse, development: boolean): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; base-uri 'none'; connect-src 'self'${development ? ' ws:' : ''}; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'${development ? " 'unsafe-inline'" : ''}; style-src 'self'${development ? " 'unsafe-inline'" : ''}`,
  );
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const content = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', content.length);
  response.end(content);
}

function sendArtifact(
  response: ServerResponse,
  filename: string,
  payload: unknown,
  headOnly = false,
): void {
  const content = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  response.statusCode = 200;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.setHeader('Content-Length', content.length);
  response.end(headOnly ? undefined : content);
}

function apiError(
  error: unknown,
  requestId: string,
): { readonly status: number; readonly body: ApiErrorPayload } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
        },
      },
    };
  }
  if (error instanceof AnalysisReviewStaleError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'ANALYSIS_STALE',
          message: 'API source가 분석 이후 변경되었습니다. 다시 분석하고 선택을 검토하세요.',
          requestId,
          diagnostics: error.diagnostics as readonly ConsoleDiagnostic[],
        },
      },
    };
  }
  if (error instanceof OperationSelectionError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'OPERATION_SELECTION_INVALID',
          message: '선택한 operation이 현재 API 분석 결과와 일치하지 않습니다.',
          requestId,
          diagnostics: error.diagnostics as readonly ConsoleDiagnostic[],
        },
      },
    };
  }
  if (error instanceof PipelineError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'COMPILATION_FAILED',
          message: error.message,
          requestId,
          diagnostics: error.diagnostics as readonly ConsoleDiagnostic[],
        },
      },
    };
  }
  if (error instanceof SourceAdapterSelectionError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'ADAPTER_SELECTION_FAILED',
          message: error.message,
          requestId,
        },
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'REQUEST_INVALID',
          message: `요청 형식이 유효하지 않습니다: ${error.issues[0]?.message ?? 'unknown field'}`,
          requestId,
        },
      },
    };
  }
  if (error instanceof TypeError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'POLICY_INVALID',
          message: '연결 정책을 검증하지 못했습니다. 입력과 release 계약을 다시 확인하세요.',
          requestId,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: '요청을 처리하지 못했습니다. request ID로 로컬 로그를 확인하세요.',
        requestId,
      },
    },
  };
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpError(
      415,
      'CONTENT_TYPE_INVALID',
      'Content-Type은 application/json이어야 합니다.',
    );
  }
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', '요청 본문이 허용 크기를 초과했습니다.');
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      responseCloseAfterDrain(request);
      throw new HttpError(413, 'REQUEST_TOO_LARGE', '요청 본문이 허용 크기를 초과했습니다.');
    }
    chunks.push(buffer);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'JSON_INVALID', '요청 본문이 유효한 UTF-8 JSON이 아닙니다.');
  }
}

function responseCloseAfterDrain(request: IncomingMessage): void {
  request.resume();
  request.socket.setKeepAlive(false);
}

function validateSource(input: unknown): SourceRequest {
  const source = SourceRequestSchema.parse(input);
  if (Buffer.byteLength(source.source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new HttpError(413, 'SOURCE_TOO_LARGE', 'API source가 10 MiB 제한을 초과했습니다.');
  }
  return source;
}

function validateRegistration(input: unknown): RegistrationRequest {
  const registration = RegistrationRequestSchema.parse(input);
  if (Buffer.byteLength(registration.source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new HttpError(413, 'SOURCE_TOO_LARGE', 'API source가 10 MiB 제한을 초과했습니다.');
  }
  return registration;
}

function validateSelectionPreset(input: unknown): SelectionPresetRequest {
  const preset = SelectionPresetRequestSchema.parse(input);
  if (Buffer.byteLength(preset.source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new HttpError(413, 'SOURCE_TOO_LARGE', 'API source가 10 MiB 제한을 초과했습니다.');
  }
  return preset;
}

function validateContractDiff(input: unknown): ContractDiffRequest {
  const request = ContractDiffRequestSchema.parse(input);
  if (Buffer.byteLength(request.source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new HttpError(413, 'SOURCE_TOO_LARGE', 'API source가 10 MiB 제한을 초과했습니다.');
  }
  return request;
}

function validateSelectionPresetReview(input: unknown): SelectionPresetReviewRequest {
  const request = SelectionPresetReviewRequestSchema.parse(input);
  if (Buffer.byteLength(request.source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new HttpError(413, 'SOURCE_TOO_LARGE', 'API source가 10 MiB 제한을 초과했습니다.');
  }
  return request;
}

function selectionPresetListQuery(url: URL): {
  readonly sourceScopeId: string;
  readonly analysisFingerprint: string;
} {
  const allowed = new Set(['sourceScopeId', 'analysisFingerprint']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'SELECTION_PRESET_QUERY_INVALID', '알 수 없는 query 항목입니다.');
  }
  const sourceScopeIds = url.searchParams.getAll('sourceScopeId');
  const analysisFingerprints = url.searchParams.getAll('analysisFingerprint');
  if (
    sourceScopeIds.length !== 1 ||
    analysisFingerprints.length !== 1 ||
    !FINGERPRINT.test(analysisFingerprints[0] ?? '')
  ) {
    throw new HttpError(
      400,
      'SELECTION_PRESET_QUERY_INVALID',
      'source scope와 분석 fingerprint를 각각 하나씩 지정하세요.',
    );
  }
  return {
    sourceScopeId: sourceScopeIds[0]!,
    analysisFingerprint: analysisFingerprints[0]!,
  };
}

function selectionPresetDetailQuery(url: URL): {
  readonly analysisFingerprint: string;
  readonly selectionFingerprint: string;
} {
  const allowed = new Set(['analysisFingerprint', 'selectionFingerprint']);
  const keys = [...url.searchParams.keys()];
  const analysisFingerprints = url.searchParams.getAll('analysisFingerprint');
  const selectionFingerprints = url.searchParams.getAll('selectionFingerprint');
  if (
    keys.some((key) => !allowed.has(key)) ||
    analysisFingerprints.length !== 1 ||
    selectionFingerprints.length !== 1 ||
    !FINGERPRINT.test(analysisFingerprints[0] ?? '') ||
    !FINGERPRINT.test(selectionFingerprints[0] ?? '')
  ) {
    throw new HttpError(
      400,
      'SELECTION_PRESET_QUERY_INVALID',
      '현재 분석과 선택 fingerprint를 각각 하나씩 지정하세요.',
    );
  }
  return {
    analysisFingerprint: analysisFingerprints[0]!,
    selectionFingerprint: selectionFingerprints[0]!,
  };
}

function sourceLocation(source: SourceRequest): string {
  const digest = createHash('sha256').update(source.source, 'utf8').digest('hex');
  return `himcp://source/${digest}/${encodeURIComponent(source.filename)}`;
}

function canonicalOrigins(
  servers: readonly { readonly template: string; readonly resolvedUrl?: string | undefined }[],
): readonly string[] {
  const origins = new Set<string>();
  for (const server of servers) {
    try {
      const url = new URL(server.resolvedUrl ?? server.template);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // Unresolved templates remain visible in diagnostics but cannot become an approved origin.
    }
  }
  return [...origins].sort();
}

function selectionPresetDiscoveryKey(
  source: SourceRequest,
  document: NormalizedApiDocument,
): string {
  const documentOrigins = canonicalOrigins(document.servers);
  const discoveryOrigins =
    documentOrigins.length > 0
      ? documentOrigins
      : canonicalOrigins(document.operations.flatMap((operation) => operation.servers));
  return fingerprint({
    schemaVersion: '1.0',
    filename: source.filename.normalize('NFKC').trim(),
    title: document.title.normalize('NFKC').trim(),
    origins: discoveryOrigins,
  });
}

async function analyze(source: SourceRequest, config: HiMcpConfig): Promise<AnalysisResponse> {
  const result = await analyzeSource(
    source.source,
    sourceLocation(source),
    config,
    source.sourceType ?? 'auto',
  );
  const document = result.adapter.document;
  if (document === null) {
    throw new HttpError(
      422,
      'SOURCE_INVALID',
      'API source를 안전하게 정규화하지 못했습니다.',
      result.adapter.diagnostics as readonly ConsoleDiagnostic[],
    );
  }
  return {
    adapterId: result.adapter.adapterId,
    sourceScopeId: selectionPresetSourceScopeId(
      result.adapter.adapterId,
      document.sourceKind,
      selectionPresetDiscoveryKey(source, document),
    ),
    analysisFingerprint: fingerprintAnalysis(result.adapter.adapterId, document),
    document: {
      sourceId: document.sourceId,
      sourceKind: document.sourceKind,
      ...(document.sourceVersion === undefined ? {} : { sourceVersion: document.sourceVersion }),
      title: document.title,
      ...(document.version === undefined ? {} : { version: document.version }),
      fingerprint: document.documentFingerprint,
      operationCount: document.operations.length,
      serverOrigins: canonicalOrigins([
        ...document.servers,
        ...document.operations.flatMap((operation) => operation.servers),
      ]),
      authSchemeCount: Object.keys(document.securitySchemes).length,
    },
    operations: document.operations.map((operation) => ({
      id: operation.id,
      ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
      method: operation.method,
      path: operation.path,
      ...(operation.summary === undefined ? {} : { summary: operation.summary }),
      ...(operation.description === undefined ? {} : { description: operation.description }),
      tags: operation.tags,
      authRequired: operation.auth.required,
      authSchemes: Object.keys(operation.auth.schemes).sort(),
    })),
    diagnostics: result.adapter.diagnostics as readonly ConsoleDiagnostic[],
  };
}

function selectionPresetSummary(
  preset: SelectionPresetRecord | SelectionPresetListRecord,
  compatibility: SelectionPresetSummary['compatibility'],
): SelectionPresetSummary {
  return {
    id: preset.id,
    sourceScopeId: preset.sourceScopeId,
    name: preset.name,
    adapterId: preset.adapterId,
    sourceKind: preset.sourceKind,
    analysisFingerprint: preset.analysisFingerprint,
    documentFingerprint: preset.documentFingerprint,
    sourceOperationCount: preset.sourceOperationCount,
    includedOperationCount:
      'includedOperationCount' in preset
        ? preset.includedOperationCount
        : preset.includedOperationIds.length,
    selectionFingerprint: preset.selectionFingerprint,
    createdAt: preset.createdAt,
    compatibility,
  };
}

function selectionPresetDetail(preset: SelectionPresetRecord): SelectionPresetDetail {
  return {
    ...selectionPresetSummary(preset, 'exact'),
    compatibility: 'exact',
    includedOperationIds: preset.includedOperationIds,
  };
}

async function sampleCatalog(examplesDirectory: string): Promise<readonly SampleRecord[]> {
  const root = resolve(examplesDirectory);
  const results: SampleRecord[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_SAMPLE_DEPTH || results.length >= MAX_SAMPLES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (results.length >= MAX_SAMPLES) break;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !SAMPLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      const id = `sample_${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`;
      results.push({
        id,
        name: relativePath.replace(/\.(?:json|ya?ml)$/i, ''),
        filename: basename(relativePath),
        sourceType: 'auto',
        absolutePath,
      });
    }
  }

  await visit(root, 0);
  return results;
}

async function readSample(sample: SampleRecord): Promise<string> {
  const handle = await open(sample.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
      throw new HttpError(413, 'SAMPLE_TOO_LARGE', '예제 API source가 크기 제한을 초과했습니다.');
    }
    const content = await handle.readFile();
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, 'SAMPLE_INVALID', '예제 API source를 읽지 못했습니다.');
  } finally {
    await handle.close();
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  clientDirectory: string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'PATH_INVALID', '요청 경로가 유효하지 않습니다.');
  }
  const root = resolve(clientDirectory);
  let path = resolve(root, `.${pathname}`);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
  }
  if (pathname === '/' || extname(pathname) === '') path = join(root, 'index.html');
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a file');
      const body = await handle.readFile();
      response.statusCode = 200;
      response.setHeader(
        'Cache-Control',
        basename(path) === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      );
      response.setHeader('Content-Type', contentType(path));
      response.setHeader('Content-Length', body.length);
      response.end(request.method === 'HEAD' ? undefined : body);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
  }
}

export async function createConsoleServer(options: ConsoleServerOptions = {}): Promise<{
  readonly listen: () => Promise<RunningConsoleServer>;
}> {
  const host = options.host ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new TypeError('The web console can bind only to a loopback host.');
  }
  const environmentPort =
    process.env['HIMCP_WEB_PORT'] === undefined ? undefined : Number(process.env['HIMCP_WEB_PORT']);
  const port = options.port ?? environmentPort ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('Web console port must be an integer between 0 and 65535.');
  }

  const development = options.development ?? process.env['HIMCP_WEB_DEV'] === '1';
  const serveClient = options.serveClient ?? true;
  const projectRoot = await discoverProjectRoot();
  const dataDirectory =
    options.dataDirectory ??
    process.env['HIMCP_WEB_DATA_DIR'] ??
    resolve(projectRoot, '.himcp/console');
  const examplesDirectory = options.examplesDirectory ?? resolve(projectRoot, 'examples');
  const cliIndexUrl = import.meta.resolve('@hi-mcp/cli');
  const cliEntryPath = options.cliEntryPath ?? fileURLToPath(new URL('./bin.js', cliIndexUrl));
  const loadedConfig =
    options.config === undefined
      ? await loadConfig(await findProjectConfig(projectRoot))
      : { config: options.config };
  const config = loadedConfig.config;
  const store = new ArtifactStore({
    rootDirectory: dataDirectory,
    nodePath: process.execPath,
    cliEntryPath,
  });
  await store.initialize();
  const selectionPresetStore = new SelectionPresetStore({
    rootDirectory: dataDirectory,
    limits: {
      maxPresetsPerSource: MAX_SELECTION_PRESETS_PER_SOURCE,
      maxPresetNameBytes: MAX_SELECTION_PRESET_NAME_BYTES,
      maxIncludedOperationIds: MAX_OPERATION_SELECTION_ITEMS,
    },
  });
  await selectionPresetStore.initialize();
  const csrfToken = randomBytes(32).toString('base64url');
  const packageMetadata = PackageMetadataSchema.parse(
    JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as unknown,
  );

  let vite: ViteDevServer | undefined;
  const server = createHttpServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    const requestId = randomUUID();
    setSecurityHeaders(response, development);
    response.setHeader('X-Request-ID', requestId);
    try {
      hostFromHeader(request.headers.host);
      if (request.method === 'OPTIONS') {
        throw new HttpError(405, 'CORS_DISABLED', '교차 origin 요청은 지원하지 않습니다.');
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const rawSegments = url.pathname.split('/').filter(Boolean);
      let segments: string[];
      try {
        segments = rawSegments.map(decodeURIComponent);
      } catch {
        throw new HttpError(400, 'PATH_INVALID', '요청 경로가 유효하지 않습니다.');
      }

      if (segments[0] === 'api') {
        if (request.method === 'GET' && url.pathname === '/api/status') {
          const relativeDataDirectory = relative(projectRoot, store.displayDirectory);
          const status: ConsoleStatus = {
            application: {
              name: packageMetadata.name,
              version: packageMetadata.version,
            },
            runtime: {
              mode: 'local',
              host,
              dataDirectory:
                relativeDataDirectory === '' || relativeDataDirectory.startsWith('..')
                  ? store.displayDirectory
                  : relativeDataDirectory,
            },
            adapters: createSourceAdapterRegistry().list(),
            limits: {
              maxSourceBytes: MAX_SOURCE_BYTES,
              maxOperationSelectionItems: selectionPresetStore.limits.maxIncludedOperationIds,
              maxSelectionPresetsPerSource: selectionPresetStore.limits.maxPresetsPerSource,
              maxSelectionPresetNameBytes: selectionPresetStore.limits.maxPresetNameBytes,
            },
            csrfToken,
          };
          sendJson(response, 200, status);
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/samples') {
          const samples = await sampleCatalog(examplesDirectory);
          sendJson(
            response,
            200,
            samples.map(({ absolutePath: _absolutePath, ...sample }) => sample),
          );
          return;
        }

        if (request.method === 'GET' && segments.length === 3 && segments[1] === 'samples') {
          const sample = (await sampleCatalog(examplesDirectory)).find(
            (candidate) => candidate.id === segments[2],
          );
          if (sample === undefined) {
            throw new HttpError(404, 'SAMPLE_NOT_FOUND', '예제 API source를 찾을 수 없습니다.');
          }
          const payload: SourceRequest = {
            source: await readSample(sample),
            filename: sample.filename,
            sourceType: sample.sourceType,
          };
          sendJson(response, 200, payload);
          return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          validateMutationRequest(request, csrfToken);
        }

        if (request.method === 'POST' && url.pathname === '/api/analyze') {
          const source = validateSource(await readJson(request, MAX_SOURCE_REQUEST_BYTES));
          sendJson(response, 200, await analyze(source, config));
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/contract-diffs') {
          const diffRequest = validateContractDiff(
            await readJson(request, MAX_SOURCE_REQUEST_BYTES),
          );
          const normalized = await analyzeSource(
            diffRequest.source,
            sourceLocation(diffRequest),
            config,
            diffRequest.sourceType ?? 'auto',
          );
          const document = normalized.adapter.document;
          if (document === null || normalized.adapter.hasErrors) {
            throw new HttpError(
              422,
              'SOURCE_INVALID',
              '현재 API source를 계약 비교에 사용할 수 없습니다.',
              normalized.adapter.diagnostics as readonly ConsoleDiagnostic[],
            );
          }
          reviewOperationSelection(
            normalized.adapter.adapterId,
            document,
            undefined,
            diffRequest.reviewedAnalysisFingerprint,
          );
          const baseline = await store.getReleaseArtifact(diffRequest.baselineRegistrationId);
          sendJson(response, 200, compareReleaseToDocument(baseline, document));
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/selection-presets') {
          const query = selectionPresetListQuery(url);
          const presets = await selectionPresetStore.list(
            query.sourceScopeId,
            query.analysisFingerprint,
          );
          sendJson(
            response,
            200,
            presets.map((preset) => selectionPresetSummary(preset, preset.compatibility)),
          );
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/selection-presets') {
          const presetRequest = validateSelectionPreset(
            await readJson(request, MAX_SOURCE_REQUEST_BYTES),
          );
          const normalized = await analyzeSource(
            presetRequest.source,
            sourceLocation(presetRequest),
            config,
            presetRequest.sourceType ?? 'auto',
          );
          const document = normalized.adapter.document;
          if (document === null || normalized.adapter.hasErrors) {
            throw new HttpError(
              422,
              'SOURCE_INVALID',
              '선택 프리셋을 현재 API source에 안전하게 연결하지 못했습니다.',
              normalized.adapter.diagnostics as readonly ConsoleDiagnostic[],
            );
          }
          const review = reviewOperationSelection(
            normalized.adapter.adapterId,
            document,
            presetRequest.includedOperationIds,
            presetRequest.reviewedAnalysisFingerprint,
          );
          const saved = await selectionPresetStore.create({
            sourceScopeKey: selectionPresetDiscoveryKey(presetRequest, document),
            name: presetRequest.name,
            adapterId: normalized.adapter.adapterId,
            sourceKind: document.sourceKind,
            analysisFingerprint: review.analysisFingerprint,
            documentFingerprint: document.documentFingerprint,
            sourceOperationCount: review.selection.sourceOperationCount,
            includedOperationIds: review.selection.includedOperationIds,
          });
          sendJson(response, saved.created ? 201 : 200, {
            preset: selectionPresetSummary(saved.preset, 'exact'),
            created: saved.created,
          });
          return;
        }

        if (
          request.method === 'GET' &&
          segments.length === 4 &&
          segments[1] === 'selection-presets'
        ) {
          const detailQuery = selectionPresetDetailQuery(url);
          const preset = await selectionPresetStore.getExact(
            segments[2]!,
            segments[3]!,
            detailQuery.analysisFingerprint,
            detailQuery.selectionFingerprint,
          );
          sendJson(response, 200, selectionPresetDetail(preset));
          return;
        }

        if (
          request.method === 'POST' &&
          segments.length === 5 &&
          segments[1] === 'selection-presets' &&
          segments[4] === 'review'
        ) {
          const reviewRequest = validateSelectionPresetReview(
            await readJson(request, MAX_SOURCE_REQUEST_BYTES),
          );
          const normalized = await analyzeSource(
            reviewRequest.source,
            sourceLocation(reviewRequest),
            config,
            reviewRequest.sourceType ?? 'auto',
          );
          const document = normalized.adapter.document;
          if (document === null || normalized.adapter.hasErrors) {
            throw new HttpError(
              422,
              'SOURCE_INVALID',
              '현재 API source를 프리셋 재검토에 사용할 수 없습니다.',
              normalized.adapter.diagnostics as readonly ConsoleDiagnostic[],
            );
          }
          const currentScopeId = selectionPresetSourceScopeId(
            normalized.adapter.adapterId,
            document.sourceKind,
            selectionPresetDiscoveryKey(reviewRequest, document),
          );
          if (currentScopeId !== segments[2]) {
            throw new HttpError(
              409,
              'SELECTION_PRESET_SCOPE_MISMATCH',
              '선택 프리셋이 현재 API source 범위에 속하지 않습니다.',
            );
          }
          const currentReview = reviewOperationSelection(
            normalized.adapter.adapterId,
            document,
            undefined,
            reviewRequest.reviewedAnalysisFingerprint,
          );
          const preset = await selectionPresetStore.getForReview(
            segments[2]!,
            segments[3]!,
            reviewRequest.selectionFingerprint,
          );
          const previousIds = new Set(preset.includedOperationIds);
          const currentIds = new Set(document.operations.map(({ id }) => id));
          const payload: SelectionPresetReviewResponse = {
            preset: {
              id: preset.id,
              name: preset.name,
              previousAnalysisFingerprint: preset.analysisFingerprint,
              selectionFingerprint: preset.selectionFingerprint,
            },
            currentAnalysisFingerprint: currentReview.analysisFingerprint,
            candidateOperationIds: document.operations
              .filter(({ id }) => previousIds.has(id))
              .map(({ id }) => id),
            missingOperationIds: preset.includedOperationIds.filter((id) => !currentIds.has(id)),
            unselectedCurrentOperationIds: document.operations
              .filter(({ id }) => !previousIds.has(id))
              .map(({ id }) => id),
          };
          sendJson(response, 200, payload);
          return;
        }

        if (
          request.method === 'DELETE' &&
          segments.length === 4 &&
          segments[1] === 'selection-presets'
        ) {
          await selectionPresetStore.delete(segments[2]!, segments[3]!);
          sendJson(response, 200, { deleted: true });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/registrations') {
          sendJson(response, 200, await store.listRegistrations());
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/registrations') {
          const registration = validateRegistration(
            await readJson(request, MAX_SOURCE_REQUEST_BYTES),
          );
          const result = await compileSource({
            source: registration.source,
            location: sourceLocation(registration),
            sourceType: registration.sourceType ?? 'auto',
            config,
            semantic: false,
            sequence: 0,
            reviewedAnalysisFingerprint: registration.reviewedAnalysisFingerprint,
            includedOperationIds: registration.includedOperationIds,
          });
          sendJson(
            response,
            201,
            await store.persistRegistration({
              sourceFilename: registration.filename,
              adapterId: result.adapterId,
              release: result.release,
              document: result.document,
            }),
          );
          return;
        }

        if (
          (request.method === 'GET' || request.method === 'HEAD') &&
          segments.length === 4 &&
          segments[1] === 'registrations' &&
          segments[3] === 'release.json'
        ) {
          const id = segments[2]!;
          sendArtifact(
            response,
            `${id}.release.json`,
            await store.getReleaseArtifact(id),
            request.method === 'HEAD',
          );
          return;
        }

        if (
          request.method === 'POST' &&
          segments.length === 4 &&
          segments[1] === 'registrations' &&
          segments[3] === 'connections'
        ) {
          const parsedInput = ConnectionRequestSchema.parse(
            await readJson(request, MAX_JSON_REQUEST_BYTES),
          );
          const input: ConnectionRequest = {
            displayName: parsedInput.displayName,
            ...(parsedInput.description === undefined
              ? {}
              : { description: parsedInput.description }),
            approvedOrigins: parsedInput.approvedOrigins,
            allowInsecureHttp: parsedInput.allowInsecureHttp,
            confirmation: parsedInput.confirmation,
            credentialEnvironment: parsedInput.credentialEnvironment,
          };
          sendJson(response, 201, await store.createConnection(segments[2]!, input));
          return;
        }

        if (
          (request.method === 'GET' || request.method === 'HEAD') &&
          segments.length === 6 &&
          segments[1] === 'registrations' &&
          segments[3] === 'connections' &&
          (segments[5] === 'profile.json' || segments[5] === 'mcp.json')
        ) {
          const descriptor = segments[5] === 'mcp.json';
          sendArtifact(
            response,
            descriptor ? `${segments[4]}.mcp.json` : `${segments[4]}.profile.json`,
            await store.getConnectionArtifact(
              segments[2]!,
              segments[4]!,
              descriptor ? 'descriptor' : 'profile',
            ),
            request.method === 'HEAD',
          );
          return;
        }

        if (request.method === 'GET' && segments.length === 3 && segments[1] === 'registrations') {
          sendJson(response, 200, await store.getRegistration(segments[2]!));
          return;
        }

        throw new HttpError(404, 'API_NOT_FOUND', 'API 경로를 찾을 수 없습니다.');
      }

      if (!serveClient) throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
      const viteServer = vite;
      if (viteServer !== undefined) {
        await new Promise<void>((resolveMiddleware, rejectMiddleware) => {
          const finish = () => {
            cleanup();
            resolveMiddleware();
          };
          const cleanup = () => response.off('finish', finish);
          response.once('finish', finish);
          viteServer.middlewares(request, response, (error?: unknown) => {
            cleanup();
            if (error === undefined) resolveMiddleware();
            else rejectMiddleware(error);
          });
        });
        if (!response.writableEnded) response.end();
        return;
      }
      await serveStatic(
        request,
        response,
        options.clientDirectory ?? fileURLToPath(new URL('../client', import.meta.url)),
      );
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const failure = apiError(error, requestId);
      sendJson(response, failure.status, failure.body);
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  if (development && serveClient) {
    vite = await import('vite').then(({ createServer }) =>
      createServer({
        root: fileURLToPath(new URL('../..', import.meta.url)),
        server: {
          middlewareMode: { server },
          ws: { server, host },
        },
        appType: 'spa',
      }),
    );
  }

  server.on('upgrade', (request, socket) => {
    const protocol = request.headers['sec-websocket-protocol'];
    let viteUpgrade = false;
    try {
      hostFromHeader(request.headers.host);
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const tokenAccepted =
        protocol === 'vite-ping' ||
        request.headers.origin === undefined ||
        safeTokenMatches(
          vite?.config.webSocketToken ?? '',
          requestUrl.searchParams.get('token') ?? undefined,
        );
      viteUpgrade =
        vite !== undefined &&
        (protocol === 'vite-hmr' || protocol === 'vite-ping') &&
        requestUrl.pathname === '/' &&
        tokenAccepted;
    } catch {
      // Invalid upgrade requests are closed below.
    }
    if (!viteUpgrade) socket.destroy();
  });

  return {
    listen: async () => {
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(port, host, () => {
            server.off('error', rejectListen);
            resolveListen();
          });
        });
      } catch (error) {
        await vite?.close();
        throw error;
      }
      const address = server.address() as AddressInfo;
      const originHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      return {
        origin: `http://${originHost}:${address.port}`,
        close: async () => {
          await vite?.close();
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
            server.closeIdleConnections();
          });
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const server = await createConsoleServer();
  const running = await server.listen();
  process.stdout.write(`HiMCP local console: ${running.origin}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Could not start the HiMCP local console: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
