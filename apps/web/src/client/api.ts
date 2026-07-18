import type {
  AnalysisResponse,
  ApiErrorPayload,
  ConnectionRequest,
  ConnectionResponse,
  ConsoleDiagnostic,
  ConsoleSample,
  ConsoleStatus,
  ContractDiffRequest,
  ContractDiffResponse,
  RegistrationDetail,
  RegistrationRequest,
  RegistrationSummary,
  SelectionPresetDetail,
  SelectionPresetRequest,
  SelectionPresetReviewRequest,
  SelectionPresetReviewResponse,
  SelectionPresetSaveResponse,
  SelectionPresetSummary,
  SourceRequest,
} from '../shared/contracts.js';

export class ConsoleApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly diagnostics: readonly ConsoleDiagnostic[] | undefined;

  constructor(
    message: string,
    code = 'REQUEST_FAILED',
    requestId?: string,
    diagnostics?: readonly ConsoleDiagnostic[],
  ) {
    super(message);
    this.name = 'ConsoleApiError';
    this.code = code;
    this.requestId = requestId;
    this.diagnostics = diagnostics;
  }
}

let csrfToken: string | undefined;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');

  if (init?.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (init?.method !== undefined && init.method !== 'GET') {
    if (!csrfToken) {
      throw new ConsoleApiError(
        '보안 세션이 준비되지 않았습니다. 페이지를 새로고침해 주세요.',
        'CSRF_TOKEN_UNAVAILABLE',
      );
    }
    headers.set('X-HiMCP-CSRF', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch {
    throw new ConsoleApiError(
      '로컬 콘솔 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.',
      'NETWORK_ERROR',
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as unknown)
    : await response.text();

  if (!response.ok) {
    const apiError = payload as Partial<ApiErrorPayload>;
    const error = apiError.error;
    throw new ConsoleApiError(
      error?.message ?? `요청을 처리하지 못했습니다. (HTTP ${response.status})`,
      error?.code ?? 'REQUEST_FAILED',
      error?.requestId,
      error?.diagnostics,
    );
  }

  return payload as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const consoleApi = {
  getStatus: async () => {
    const status = await request<ConsoleStatus>('/api/status');
    csrfToken = status.csrfToken;
    return status;
  },
  getSamples: () => request<readonly ConsoleSample[]>('/api/samples'),
  getSample: (id: string) => request<SourceRequest>(`/api/samples/${encodeURIComponent(id)}`),
  analyze: (source: SourceRequest) =>
    request<AnalysisResponse>('/api/analyze', {
      method: 'POST',
      body: jsonBody(source),
    }),
  getContractDiff: (diff: ContractDiffRequest) =>
    request<ContractDiffResponse>('/api/contract-diffs', {
      method: 'POST',
      body: jsonBody(diff),
    }),
  getSelectionPresets: (sourceScopeId: string, analysisFingerprint: string) => {
    const query = new URLSearchParams({ sourceScopeId, analysisFingerprint });
    return request<readonly SelectionPresetSummary[]>(`/api/selection-presets?${query}`);
  },
  getSelectionPreset: (
    sourceScopeId: string,
    presetId: string,
    analysisFingerprint: string,
    selectionFingerprint: string,
  ) => {
    const query = new URLSearchParams({ analysisFingerprint, selectionFingerprint });
    return request<SelectionPresetDetail>(
      `/api/selection-presets/${encodeURIComponent(sourceScopeId)}/${encodeURIComponent(presetId)}?${query}`,
    );
  },
  createSelectionPreset: (preset: SelectionPresetRequest) =>
    request<SelectionPresetSaveResponse>('/api/selection-presets', {
      method: 'POST',
      body: jsonBody(preset),
    }),
  reviewSelectionPreset: (
    sourceScopeId: string,
    presetId: string,
    review: SelectionPresetReviewRequest,
  ) =>
    request<SelectionPresetReviewResponse>(
      `/api/selection-presets/${encodeURIComponent(sourceScopeId)}/${encodeURIComponent(presetId)}/review`,
      { method: 'POST', body: jsonBody(review) },
    ),
  deleteSelectionPreset: (sourceScopeId: string, presetId: string) =>
    request<{ readonly deleted: true }>(
      `/api/selection-presets/${encodeURIComponent(sourceScopeId)}/${encodeURIComponent(presetId)}`,
      { method: 'DELETE' },
    ),
  getRegistrations: () => request<readonly RegistrationSummary[]>('/api/registrations'),
  createRegistration: (registration: RegistrationRequest) =>
    request<RegistrationDetail>('/api/registrations', {
      method: 'POST',
      body: jsonBody(registration),
    }),
  getRegistration: (registrationId: string) =>
    request<RegistrationDetail>(`/api/registrations/${encodeURIComponent(registrationId)}`),
  createConnection: (registrationId: string, connection: ConnectionRequest) =>
    request<ConnectionResponse>(
      `/api/registrations/${encodeURIComponent(registrationId)}/connections`,
      {
        method: 'POST',
        body: jsonBody(connection),
      },
    ),
};
