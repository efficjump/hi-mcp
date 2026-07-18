// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AnalysisResponse,
  ConnectionResponse,
  ConsoleSample,
  ConsoleStatus,
  ContractDiffResponse,
  RegistrationDetail,
  SelectionPresetDetail,
  SelectionPresetSummary,
  SelectionPresetReviewResponse,
  SourceRequest,
} from '../shared/contracts.js';
import { App } from './App.js';
import { ConsoleApiError, consoleApi } from './api.js';

const sourceRequest: SourceRequest = {
  source: 'openapi: 3.1.0',
  filename: 'petstore.json',
  sourceType: 'auto',
};

const status: ConsoleStatus = {
  application: { name: 'HiMCP', version: '0.1.0' },
  runtime: { mode: 'local', host: '127.0.0.1', dataDirectory: '/tmp/hi-mcp-test' },
  adapters: ['openapi', 'http-manifest'],
  limits: {
    maxSourceBytes: 10 * 1_024 * 1_024,
    maxOperationSelectionItems: 100_000,
    maxSelectionPresetsPerSource: 64,
    maxSelectionPresetNameBytes: 256,
  },
  csrfToken: 'test-csrf-token',
};

const samples: readonly ConsoleSample[] = [
  {
    id: 'sample-openapi',
    name: '동적 OpenAPI 예제',
    filename: 'sample-openapi.yaml',
    sourceType: 'openapi',
  },
  {
    id: 'sample-manifest',
    name: '동적 HTTP manifest 예제',
    filename: 'sample-manifest.yaml',
    sourceType: 'http-manifest',
  },
];

const analysis: AnalysisResponse = {
  adapterId: 'openapi',
  sourceScopeId: 'selection_scope_test',
  analysisFingerprint: `sha256:${'d'.repeat(64)}`,
  document: {
    sourceId: 'petstore.json',
    sourceKind: 'openapi',
    sourceVersion: '3.1.0',
    title: 'Petstore API',
    version: '1.0.0',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    operationCount: 1,
    serverOrigins: ['https://api.example.com', 'http://127.0.0.1:9000'],
    authSchemeCount: 1,
  },
  operations: [
    {
      id: 'get-pet',
      operationId: 'getPet',
      method: 'GET',
      path: '/pets/{petId}',
      summary: '반려동물 조회',
      tags: ['pets'],
      authRequired: true,
      authSchemes: ['apiKey'],
    },
  ],
  diagnostics: [],
};

const selectionAnalysis: AnalysisResponse = {
  ...analysis,
  analysisFingerprint: `sha256:${'e'.repeat(64)}`,
  document: {
    ...analysis.document,
    operationCount: 4,
  },
  operations: [
    analysis.operations[0]!,
    {
      id: 'list-pets',
      operationId: 'listPets',
      method: 'GET',
      path: '/pets',
      summary: '반려동물 목록',
      description: '등록된 반려동물 목록을 조회합니다.',
      tags: ['pets', 'catalog'],
      authRequired: true,
      authSchemes: ['apiKey'],
    },
    {
      id: 'create-pet',
      operationId: 'createPet',
      method: 'POST',
      path: '/pets',
      summary: '반려동물 등록',
      description: '새 반려동물을 등록합니다.',
      tags: ['pets', 'write'],
      authRequired: true,
      authSchemes: ['apiKey'],
    },
    {
      id: 'delete-order',
      operationId: 'deleteOrder',
      method: 'DELETE',
      path: '/orders/{orderId}',
      summary: '주문 삭제',
      description: '주문을 삭제합니다.',
      tags: ['orders', 'admin'],
      authRequired: true,
      authSchemes: ['apiKey'],
    },
  ],
};

const exactSelectionPreset: SelectionPresetSummary & { readonly compatibility: 'exact' } = {
  id: 'selection_preset_exact',
  sourceScopeId: analysis.sourceScopeId,
  name: '조회 도구',
  adapterId: analysis.adapterId,
  sourceKind: analysis.document.sourceKind,
  analysisFingerprint: selectionAnalysis.analysisFingerprint,
  documentFingerprint: selectionAnalysis.document.fingerprint,
  sourceOperationCount: selectionAnalysis.operations.length,
  includedOperationCount: 2,
  selectionFingerprint: `sha256:${'b'.repeat(64)}`,
  createdAt: '2026-07-15T01:00:00.000Z',
  compatibility: 'exact',
};

const exactSelectionPresetDetail: SelectionPresetDetail = {
  ...exactSelectionPreset,
  includedOperationIds: ['get-pet', 'list-pets'],
};

const staleSelectionPreset: SelectionPresetSummary = {
  ...exactSelectionPreset,
  id: 'selection_preset_stale',
  name: '이전 선택',
  analysisFingerprint: `sha256:${'c'.repeat(64)}`,
  createdAt: '2026-07-14T01:00:00.000Z',
  compatibility: 'stale',
};

const staleSelectionPresetReview: SelectionPresetReviewResponse = {
  preset: {
    id: staleSelectionPreset.id,
    name: staleSelectionPreset.name,
    previousAnalysisFingerprint: staleSelectionPreset.analysisFingerprint,
    selectionFingerprint: staleSelectionPreset.selectionFingerprint,
  },
  currentAnalysisFingerprint: selectionAnalysis.analysisFingerprint,
  candidateOperationIds: ['get-pet'],
  missingOperationIds: ['removed-operation'],
  unselectedCurrentOperationIds: ['list-pets', 'create-pet', 'delete-order'],
};

const registration: RegistrationDetail = {
  registration: {
    id: 'registration-petstore',
    title: 'Petstore API',
    sourceKind: 'openapi',
    sourceVersion: '3.1.0',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    createdAt: '2026-07-15T03:00:00.000Z',
    sourceFilename: 'petstore.json',
    capabilityCount: 1,
    sourceOperationCount: 1,
    origins: ['https://api.example.com', 'http://127.0.0.1:9000'],
    credentialBindings: [
      {
        scheme: 'apiKey',
        location: 'header',
        parameterName: 'X-API-Key',
        environmentVariable: 'PETSTORE_API_KEY',
      },
    ],
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
  },
  capabilities: [
    {
      id: 'capability-get-pet',
      name: 'get_pet',
      title: '반려동물 조회',
      description: 'ID로 반려동물을 조회합니다.',
      method: 'GET',
      path: '/pets/{petId}',
      servers: ['https://api.example.com', 'http://127.0.0.1:9000'],
      authRequired: true,
      authSchemes: ['apiKey'],
      risk: { level: 'read', sideEffect: 'none', requiresConfirmation: false },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      provenance: { source: 'petstore.json' },
    },
  ],
  diagnostics: [],
  artifactUrls: { release: '/api/artifacts/release.json' },
};

const contractDiff: ContractDiffResponse = {
  schemaVersion: '1.0',
  baseline: {
    releaseId: registration.registration.id,
    releaseFingerprint: registration.registration.fingerprint,
    capabilityCount: 1,
  },
  current: {
    documentFingerprint: selectionAnalysis.document.fingerprint,
    operationCount: selectionAnalysis.operations.length,
  },
  summary: {
    added: 1,
    removed: 0,
    changed: 1,
    unchanged: 2,
    securityReview: 1,
    breaking: 0,
    metadataReview: 0,
  },
  operations: [
    {
      operationId: 'get-pet',
      kind: 'changed',
      impact: 'security-review',
      areas: ['destination', 'authentication'],
      after: {
        id: 'get-pet',
        name: 'getPet',
        title: '반려동물 조회',
        description: 'ID로 반려동물을 조회합니다.',
        method: 'GET',
        path: '/pets/{petId}',
        origins: ['https://api-v2.example.com'],
        authRequired: true,
        authSchemes: ['apiKey'],
        risk: {
          level: 'read',
          sideEffect: 'none',
          idempotency: 'idempotent',
          requiresConfirmation: false,
        },
      },
    },
    {
      operationId: 'create-pet',
      kind: 'added',
      impact: 'additive',
      areas: [],
      after: {
        id: 'create-pet',
        name: 'createPet',
        description: '새 반려동물을 등록합니다.',
        method: 'POST',
        path: '/pets',
        origins: ['https://api-v2.example.com'],
        authRequired: true,
        authSchemes: ['apiKey'],
        risk: {
          level: 'write',
          sideEffect: 'definite',
          idempotency: 'non-idempotent',
          requiresConfirmation: true,
        },
      },
    },
  ],
  fingerprint: `sha256:${'9'.repeat(64)}`,
};

const connection: ConnectionResponse = {
  profile: {
    id: 'profile-petstore',
    displayName: 'Petstore API',
    fingerprint: `sha256:${'c'.repeat(64)}`,
    confirmation: 'per-call',
  },
  descriptor: {
    mcpServers: {
      petstore: {
        command: 'hi-mcp',
        args: ['run', '--profile', '/tmp/profile-petstore.json'],
      },
    },
  },
  requiredEnvironmentVariables: ['PETSTORE_API_KEY'],
  artifactUrls: {
    profile: '/api/artifacts/profile.json',
    descriptor: '/api/artifacts/descriptor.json',
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function mockConsoleApi() {
  const getStatus = vi.spyOn(consoleApi, 'getStatus').mockResolvedValue(status);
  const getSamples = vi.spyOn(consoleApi, 'getSamples').mockResolvedValue([]);
  const getSample = vi.spyOn(consoleApi, 'getSample').mockResolvedValue(sourceRequest);
  const analyzeSource = vi.spyOn(consoleApi, 'analyze').mockResolvedValue(analysis);
  const getContractDiff = vi.spyOn(consoleApi, 'getContractDiff').mockResolvedValue(contractDiff);
  const getSelectionPresets = vi.spyOn(consoleApi, 'getSelectionPresets').mockResolvedValue([]);
  const getSelectionPreset = vi
    .spyOn(consoleApi, 'getSelectionPreset')
    .mockResolvedValue(exactSelectionPresetDetail);
  const createSelectionPreset = vi
    .spyOn(consoleApi, 'createSelectionPreset')
    .mockResolvedValue({ preset: exactSelectionPreset, created: true });
  const reviewSelectionPreset = vi
    .spyOn(consoleApi, 'reviewSelectionPreset')
    .mockResolvedValue(staleSelectionPresetReview);
  const deleteSelectionPreset = vi
    .spyOn(consoleApi, 'deleteSelectionPreset')
    .mockResolvedValue({ deleted: true });
  const getRegistrations = vi.spyOn(consoleApi, 'getRegistrations').mockResolvedValue([]);
  const createRegistration = vi
    .spyOn(consoleApi, 'createRegistration')
    .mockResolvedValue(registration);
  const getRegistration = vi.spyOn(consoleApi, 'getRegistration').mockResolvedValue(registration);
  const createConnection = vi.spyOn(consoleApi, 'createConnection').mockResolvedValue(connection);

  return {
    getStatus,
    getSamples,
    getSample,
    analyzeSource,
    getContractDiff,
    getSelectionPresets,
    getSelectionPreset,
    createSelectionPreset,
    reviewSelectionPreset,
    deleteSelectionPreset,
    getRegistrations,
    createRegistration,
    getRegistration,
    createConnection,
  };
}

async function renderReadyApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText('로컬 런타임 연결됨');
  return user;
}

async function enterSourceAndAnalyze(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText('표시 파일명'));
  await user.type(screen.getByLabelText('표시 파일명'), sourceRequest.filename);
  await user.type(screen.getByLabelText('JSON 또는 YAML API source'), sourceRequest.source);
  await user.click(screen.getByRole('button', { name: 'API 분석' }));
}

describe('local console client', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('renders the source-first review workflow without browser-only render failures', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('API를 검토 가능한 MCP 도구로 연결하세요');
    expect(markup).toContain('API source 등록');
    expect(markup).toContain('비밀값을 넣지 마세요');
    expect(markup).not.toContain('pricing');
  });

  it('supports direct guide entry and renders runtime capabilities from API responses', async () => {
    window.history.replaceState({}, '', '/guide');
    const api = mockConsoleApi();
    api.getSamples.mockResolvedValue(samples);
    const user = userEvent.setup();

    render(<App />);

    const heading = await screen.findByRole('heading', {
      name: 'API 계약에서 필요한 도구만 안전하게 연결하세요',
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    expect(window.location.pathname).toBe('/guide');
    expect(document.title).toBe('사용 가이드 · HiMCP');
    expect(screen.getByRole('link', { name: '사용 가이드' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: '콘솔' }).getAttribute('aria-current')).toBeNull();
    const adapterList = screen.getByRole('list', { name: '사용 가능한 source adapters' });
    expect(within(adapterList).getByText('openapi')).toBeTruthy();
    expect(within(adapterList).getByText('http-manifest')).toBeTruthy();
    expect(screen.getByText('10.0 MiB')).toBeTruthy();
    expect(
      within(screen.getByText('Examples').closest('div') as HTMLElement).getByText('2'),
    ).toBeTruthy();
    expect(screen.getByText('v0.1.0')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'API 연결 단계' }).children).toHaveLength(5);

    await user.click(screen.getByRole('button', { name: /동적 OpenAPI 예제.*openapi/ }));
    await screen.findByRole('heading', { name: 'API source 등록' });
    expect(api.getSample).toHaveBeenCalledWith('sample-openapi');
    await waitFor(() =>
      expect(screen.getByLabelText('JSON 또는 YAML API source')).toHaveProperty(
        'value',
        sourceRequest.source,
      ),
    );
  });

  it('keeps an in-progress source while navigating through the guide and browser history', async () => {
    mockConsoleApi();
    const user = await renderReadyApp();
    const editor = screen.getByLabelText('JSON 또는 YAML API source');
    await user.type(editor, sourceRequest.source);

    await user.click(screen.getByRole('link', { name: '사용 가이드' }));
    await screen.findByRole('heading', {
      name: 'API 계약에서 필요한 도구만 안전하게 연결하세요',
    });
    expect(window.location.pathname).toBe('/guide');
    expect(screen.getByRole('button', { name: /진행 중인 작업으로 돌아가기/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /진행 중인 작업으로 돌아가기/ }));
    await screen.findByRole('heading', { name: 'API source 등록' });
    expect(window.location.pathname).toBe('/');
    expect(screen.getByLabelText('JSON 또는 YAML API source')).toHaveProperty(
      'value',
      sourceRequest.source,
    );

    window.history.replaceState({}, '', '/guide');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', {
      name: 'API 계약에서 필요한 도구만 안전하게 연결하세요',
    });
    expect(screen.getByRole('link', { name: '사용 가이드' }).getAttribute('aria-current')).toBe(
      'page',
    );

    await user.click(screen.getByRole('link', { name: 'HiMCP 콘솔' }));
    await screen.findByRole('heading', { name: 'API source 등록' });
    expect(screen.getByLabelText('JSON 또는 YAML API source')).toHaveProperty(
      'value',
      sourceRequest.source,
    );
  });

  it('keeps the static guide available when runtime status loading fails', async () => {
    window.history.replaceState({}, '', '/guide');
    const api = mockConsoleApi();
    api.getStatus.mockRejectedValueOnce(new Error('runtime unavailable'));

    render(<App />);

    expect(
      await screen.findByRole('heading', {
        name: 'API 계약에서 필요한 도구만 안전하게 연결하세요',
      }),
    ).toBeTruthy();
    expect(screen.getByText('어떤 API를 등록할 수 있나요?')).toBeTruthy();
    expect(screen.getByText('Adapter registry를 확인하고 있습니다.')).toBeTruthy();
    expect(screen.getByText('자주 확인하는 문제')).toBeTruthy();
  });

  it('completes analyze, registration, exact-origin review, HTTP approval, and export', async () => {
    const api = mockConsoleApi();
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    const analysisHeading = await screen.findByRole('heading', { name: '분석 결과' });
    await waitFor(() => expect(document.activeElement).toBe(analysisHeading));
    expect(api.analyzeSource).toHaveBeenCalledWith(sourceRequest);

    await user.click(screen.getByRole('button', { name: /검증하고 등록/ }));
    await screen.findByRole('heading', { name: '실행 계약 검토' });
    expect(api.createRegistration).toHaveBeenCalledWith({
      ...sourceRequest,
      reviewedAnalysisFingerprint: analysis.analysisFingerprint,
      includedOperationIds: ['get-pet'],
    });
    expect(screen.getByRole('tab', { name: /반려동물 조회/ }).getAttribute('aria-selected')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: /연결 정책 만들기/ }));
    await screen.findByRole('heading', { name: '연결 정책 만들기' });

    const createButton = screen.getByRole('button', { name: /MCP 연결 생성/ });
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    expect(api.createConnection).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('checkbox', { name: /https:\/\/api\.example\.com.*TLS 연결/ }),
    );
    expect((createButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(
      screen.getByRole('checkbox', { name: /http:\/\/127\.0\.0\.1:9000.*평문 HTTP 연결/ }),
    );
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    expect(api.createConnection).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('checkbox', { name: /평문 HTTP 위험을 이해하고 허용합니다/ }),
    );
    expect((createButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(createButton);
    await screen.findByRole('heading', { name: 'MCP 연결 설정이 준비되었습니다' });

    expect(api.createConnection).toHaveBeenCalledTimes(1);
    expect(api.createConnection).toHaveBeenCalledWith('registration-petstore', {
      displayName: 'Petstore API',
      approvedOrigins: ['https://api.example.com', 'http://127.0.0.1:9000'],
      allowInsecureHttp: true,
      confirmation: 'per-call',
      credentialEnvironment: { PETSTORE_API_KEY: 'PETSTORE_API_KEY' },
    });
    expect(screen.getByText('profile-petstore')).toBeTruthy();
    expect(screen.getByText('PETSTORE_API_KEY')).toBeTruthy();
    expect(
      within(screen.getByText('mcpServers.json').closest('.code-panel') as HTMLElement).getByText(
        /"mcpServers"/,
      ),
    ).toBeTruthy();
  });

  it('selects every operation by default and submits chosen IDs in analysis order', async () => {
    const api = mockConsoleApi();
    api.analyzeSource.mockResolvedValue(selectionAnalysis);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    await screen.findByRole('heading', { name: '분석 결과' });

    const operationCheckboxes = screen.getAllByRole('checkbox', {
      name: /MCP 도구 포함$/,
    });
    expect(operationCheckboxes).toHaveLength(selectionAnalysis.operations.length);
    expect(operationCheckboxes.every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(
      true,
    );
    expect(document.querySelector('output')?.textContent).toContain('4 / 4개 선택');

    const firstOperation = screen.getByRole('checkbox', {
      name: /반려동물 조회 GET \/pets\/\{petId\} MCP 도구 포함/,
    });
    const excludedOperation = screen.getByRole('checkbox', {
      name: /반려동물 목록 GET \/pets MCP 도구 포함/,
    });

    // Removing and adding the first ID changes Set insertion order. The request must still follow
    // the authoritative analysis order.
    await user.click(firstOperation);
    await user.click(firstOperation);
    await user.click(excludedOperation);

    expect((excludedOperation as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('output')?.textContent).toContain('3 / 4개 선택');

    await user.click(screen.getByRole('button', { name: /선택한 3개 검증하고 등록/ }));
    await screen.findByRole('heading', { name: '실행 계약 검토' });

    expect(api.createRegistration).toHaveBeenCalledWith({
      ...sourceRequest,
      reviewedAnalysisFingerprint: selectionAnalysis.analysisFingerprint,
      includedOperationIds: ['get-pet', 'create-pet', 'delete-order'],
    });
  });

  it('blocks registration when every operation is excluded', async () => {
    const api = mockConsoleApi();
    api.analyzeSource.mockResolvedValue(selectionAnalysis);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    await screen.findByRole('heading', { name: '분석 결과' });
    await user.click(screen.getByRole('button', { name: '전체 해제' }));

    expect(
      screen
        .getAllByRole('checkbox', { name: /MCP 도구 포함$/ })
        .every((checkbox) => !(checkbox as HTMLInputElement).checked),
    ).toBe(true);
    expect(document.querySelector('output')?.textContent).toContain('0 / 4개 선택');
    expect(screen.getByText('최소 1개 operation을 선택하세요.')).toBeTruthy();

    const registerButton = screen.getByRole('button', {
      name: /선택한 0개 검증하고 등록/,
    });
    expect((registerButton as HTMLButtonElement).disabled).toBe(true);
    expect(registerButton.getAttribute('aria-describedby')).toBe('operation-selection-help');

    await user.click(registerButton);
    expect(api.createRegistration).not.toHaveBeenCalled();
  });

  it('bulk-selects dynamic Method, Tag, and search results without losing hidden choices', async () => {
    const api = mockConsoleApi();
    api.analyzeSource.mockResolvedValue(selectionAnalysis);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    await screen.findByRole('heading', { name: '분석 결과' });
    await user.click(screen.getByRole('button', { name: '전체 해제' }));

    const methodFilter = screen.getByRole('combobox', { name: 'HTTP Method 필터' });
    const tagFilter = screen.getByRole('combobox', { name: 'Tag 필터' });
    const query = screen.getByRole('textbox', { name: 'Operation 검색' });

    expect(within(methodFilter).getByRole('option', { name: 'GET' })).toBeTruthy();
    expect(within(methodFilter).getByRole('option', { name: 'POST' })).toBeTruthy();
    expect(within(methodFilter).getByRole('option', { name: 'DELETE' })).toBeTruthy();
    expect(within(tagFilter).getByRole('option', { name: 'pets' })).toBeTruthy();
    expect(within(tagFilter).getByRole('option', { name: 'admin' })).toBeTruthy();

    await user.type(query, 'delete-order');
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox', { name: /MCP 도구 포함$/ })).toHaveLength(1),
    );
    expect(screen.getByRole('checkbox', { name: /주문 삭제/ })).toBeTruthy();
    await user.clear(query);

    await user.selectOptions(methodFilter, 'GET');
    expect(screen.getAllByRole('checkbox', { name: /MCP 도구 포함$/ })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '현재 결과 선택' }));
    expect(document.querySelector('output')?.textContent).toContain('2 / 4개 선택');

    await user.selectOptions(methodFilter, '');
    await user.selectOptions(tagFilter, 'pets');
    await user.type(query, '목록');
    expect(screen.getAllByRole('checkbox', { name: /MCP 도구 포함$/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '현재 결과 해제' }));
    expect(document.querySelector('output')?.textContent).toContain('1 / 4개 선택');

    await user.clear(query);
    await user.selectOptions(methodFilter, 'POST');
    await user.click(screen.getByRole('button', { name: '현재 결과 선택' }));
    expect(document.querySelector('output')?.textContent).toContain('2 / 4개 선택');

    await user.selectOptions(methodFilter, '');
    await user.selectOptions(tagFilter, 'admin');
    await user.click(screen.getByRole('button', { name: '현재 결과 선택' }));
    expect(document.querySelector('output')?.textContent).toContain('3 / 4개 선택');

    await user.selectOptions(tagFilter, '');
    expect(
      (
        screen.getByRole('checkbox', {
          name: /반려동물 조회 GET \/pets\/\{petId\} MCP 도구 포함/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole('checkbox', {
          name: /반려동물 목록 GET \/pets MCP 도구 포함/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole('checkbox', {
          name: /반려동물 등록 POST \/pets MCP 도구 포함/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole('checkbox', {
          name: /주문 삭제 DELETE \/orders\/\{orderId\} MCP 도구 포함/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    await user.selectOptions(screen.getByRole('combobox', { name: '포함 상태 필터' }), 'excluded');
    expect(screen.getAllByRole('checkbox', { name: /MCP 도구 포함$/ })).toHaveLength(1);
    expect(
      screen.getByRole('checkbox', {
        name: /반려동물 목록 GET \/pets MCP 도구 포함/,
      }),
    ).toBeTruthy();
  });

  it('applies, undoes, saves, and explicitly deletes revision-bound selection presets', async () => {
    const api = mockConsoleApi();
    api.analyzeSource.mockResolvedValue(selectionAnalysis);
    api.getSelectionPresets.mockResolvedValue([exactSelectionPreset, staleSelectionPreset]);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    await screen.findByRole('heading', { name: '분석 결과' });
    await waitFor(() =>
      expect(api.getSelectionPresets).toHaveBeenCalledWith(
        selectionAnalysis.sourceScopeId,
        selectionAnalysis.analysisFingerprint,
      ),
    );

    const presetSelect = screen.getByRole('combobox', { name: '저장된 선택 프리셋' });
    expect(within(presetSelect).getByRole('option', { name: /조회 도구 · 2개/ })).toBeTruthy();
    expect(within(presetSelect).getByRole('option', { name: /이전 선택 · stale/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '전체 해제' }));
    await user.click(screen.getByRole('button', { name: '적용' }));
    await waitFor(() =>
      expect(api.getSelectionPreset).toHaveBeenCalledWith(
        selectionAnalysis.sourceScopeId,
        exactSelectionPreset.id,
        selectionAnalysis.analysisFingerprint,
        exactSelectionPreset.selectionFingerprint,
      ),
    );
    await screen.findByText('“조회 도구” 프리셋을 적용했습니다.');
    expect(document.querySelector('output')?.textContent).toContain('2 / 4개 선택');

    await user.click(screen.getByRole('button', { name: '적용 취소' }));
    expect(document.querySelector('output')?.textContent).toContain('0 / 4개 선택');
    await user.click(screen.getByRole('button', { name: '적용' }));
    await screen.findByText('“조회 도구” 프리셋을 적용했습니다.');

    await user.type(screen.getByRole('textbox', { name: '새 선택 프리셋 이름' }), '새 범위');
    await user.click(screen.getByRole('button', { name: '현재 선택 저장' }));
    await waitFor(() =>
      expect(api.createSelectionPreset).toHaveBeenCalledWith({
        ...sourceRequest,
        name: '새 범위',
        reviewedAnalysisFingerprint: selectionAnalysis.analysisFingerprint,
        includedOperationIds: ['get-pet', 'list-pets'],
      }),
    );

    await user.selectOptions(presetSelect, staleSelectionPreset.id);
    expect(screen.getByText('선택한 프리셋은 이전 분석에 속해 적용할 수 없습니다.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '재검토' }));
    await screen.findByText('이전 선택을 현재 계약에서 다시 검토');
    expect(api.reviewSelectionPreset).toHaveBeenCalledWith(
      selectionAnalysis.sourceScopeId,
      staleSelectionPreset.id,
      {
        ...sourceRequest,
        reviewedAnalysisFingerprint: selectionAnalysis.analysisFingerprint,
        selectionFingerprint: staleSelectionPreset.selectionFingerprint,
      },
    );
    expect(screen.getByText(/같은 ID로 남은 1개만 후보/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '재검토 후보 1개 불러오기' }));
    expect(document.querySelector('output')?.textContent).toContain('1 / 4개 선택');
    expect(screen.getByText(/이전에 선택하지 않은 현재 operation은 제외했습니다/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '선택한 프리셋 삭제' }));
    await user.click(screen.getByRole('button', { name: '선택한 프리셋 삭제 확인' }));
    await waitFor(() =>
      expect(api.deleteSelectionPreset).toHaveBeenCalledWith(
        selectionAnalysis.sourceScopeId,
        staleSelectionPreset.id,
      ),
    );
  });

  it('compares the current analysis with a selected stored release without changing selection', async () => {
    const api = mockConsoleApi();
    api.analyzeSource.mockResolvedValue(selectionAnalysis);
    api.getRegistrations.mockResolvedValue([registration.registration]);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    await screen.findByRole('heading', { name: '저장된 release와 계약 비교' });
    await user.click(screen.getByRole('button', { name: '변경 비교' }));

    expect(await screen.findAllByText('보안 재검토')).toHaveLength(2);
    expect(api.getContractDiff).toHaveBeenCalledWith({
      ...sourceRequest,
      baselineRegistrationId: registration.registration.id,
      reviewedAnalysisFingerprint: selectionAnalysis.analysisFingerprint,
    });
    expect(screen.getByText('실행 목적지 · 인증')).toBeTruthy();
    expect(screen.getByText('기준 release에 없으며 자동 선택하지 않습니다.')).toBeTruthy();
    expect(document.querySelector('output')?.textContent).toContain('4 / 4개 선택');
  });

  it('lazy-loads one preset detail without overwriting selection on a mismatched snapshot', async () => {
    const api = mockConsoleApi();
    const pendingDetail = deferred<SelectionPresetDetail>();
    api.analyzeSource.mockResolvedValue(selectionAnalysis);
    api.getSelectionPresets.mockResolvedValue([exactSelectionPreset]);
    api.getSelectionPreset.mockReturnValueOnce(pendingDetail.promise);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    await screen.findByRole('heading', { name: '분석 결과' });
    await user.click(screen.getByRole('button', { name: '적용' }));
    await waitFor(() => expect(api.getSelectionPreset).toHaveBeenCalledTimes(1));

    expect(document.querySelector('output')?.textContent).toContain('4 / 4개 선택');
    expect((screen.getByRole('button', { name: '전체 해제' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Source 수정' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /선택한 4개 검증하고 등록/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      pendingDetail.resolve({
        ...exactSelectionPresetDetail,
        selectionFingerprint: `sha256:${'f'.repeat(64)}`,
      });
      await pendingDetail.promise;
    });

    await screen.findByText('선택 프리셋 상세가 현재 분석 및 목록 snapshot과 일치하지 않습니다.');
    expect(document.querySelector('output')?.textContent).toContain('4 / 4개 선택');
    expect(screen.queryByRole('button', { name: '적용 취소' })).toBeNull();
  });

  it('discards an analyze response when the source changes while the request is pending', async () => {
    const api = mockConsoleApi();
    const pendingAnalysis = deferred<AnalysisResponse>();
    api.analyzeSource.mockReturnValueOnce(pendingAnalysis.promise);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);
    expect(api.analyzeSource).toHaveBeenCalledWith(sourceRequest);

    const editor = screen.getByLabelText('JSON 또는 YAML API source');
    const changedSuffix = '\ninfo:\n  title: changed while analyzing';
    await user.type(editor, changedSuffix);

    await act(async () => {
      pendingAnalysis.resolve(analysis);
      await pendingAnalysis.promise;
    });

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'API 분석' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.getByRole('heading', { name: 'API source 등록' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '분석 결과' })).toBeNull();
    expect(screen.queryByText('정규화된 operations')).toBeNull();
    expect(editor).toHaveProperty('value', `${sourceRequest.source}${changedSuffix}`);
  });

  it('blocks oversized source text and exposes the reason to assistive technology', async () => {
    const api = mockConsoleApi();
    api.getStatus.mockResolvedValue({
      ...status,
      limits: { ...status.limits, maxSourceBytes: 8 },
    });
    const user = await renderReadyApp();

    const editor = screen.getByLabelText('JSON 또는 YAML API source');
    await user.type(editor, sourceRequest.source);

    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/제한 초과/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'API 분석' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(api.analyzeSource).not.toHaveBeenCalled();
  });

  it('keeps the source editable and recovers when analysis succeeds after an API error', async () => {
    const api = mockConsoleApi();
    api.analyzeSource
      .mockRejectedValueOnce(
        new ConsoleApiError('계약을 해석하지 못했습니다.', 'SOURCE_INVALID', 'request-123', [
          {
            code: 'OPENAPI_PARSE_FAILED',
            severity: 'error',
            message: 'OpenAPI 문법을 확인하세요.',
            location: { line: 2 },
          },
        ]),
      )
      .mockResolvedValueOnce(analysis);
    const user = await renderReadyApp();

    await enterSourceAndAnalyze(user);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('계약을 해석하지 못했습니다.');
    expect(alert.textContent).toContain('SOURCE_INVALID');
    expect(alert.textContent).toContain('request request-123');
    expect(alert.textContent).toContain('OPENAPI_PARSE_FAILED');
    expect(screen.getByLabelText('JSON 또는 YAML API source')).toHaveProperty(
      'value',
      sourceRequest.source,
    );
    expect(screen.getByRole('heading', { name: 'API source 등록' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'API 분석' }));
    await screen.findByRole('heading', { name: '분석 결과' });

    expect(api.analyzeSource).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(screen.getByText('Petstore API')).toBeTruthy());
  });
});
