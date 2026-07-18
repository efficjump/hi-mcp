import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createSourceAdapterRegistry } from '@hi-mcp/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AnalysisResponse,
  ConnectionResponse,
  ConsoleStatus,
  ContractDiffResponse,
  RegistrationRequest,
  RegistrationDetail,
  SelectionPresetDetail,
  SelectionPresetSaveResponse,
  SelectionPresetSummary,
  SelectionPresetReviewResponse,
  SourceRequest,
} from '../shared/contracts.js';
import { createConsoleServer, type RunningConsoleServer } from './index.js';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const examplePath = join(repositoryRoot, 'examples/weather-api/http-manifest.yaml');

describe('local web console API', () => {
  let dataDirectory: string;
  let running: RunningConsoleServer;
  let status: ConsoleStatus;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'hi-mcp-web-'));
    const clientDirectory = join(dataDirectory, 'client');
    await mkdir(clientDirectory);
    await writeFile(
      join(clientDirectory, 'index.html'),
      '<!doctype html><title>HiMCP test</title>',
    );
    const server = await createConsoleServer({
      port: 0,
      dataDirectory,
      cliEntryPath: '/opt/hi-mcp/bin.js',
      serveClient: true,
      clientDirectory,
    });
    running = await server.listen();
    const response = await fetch(`${running.origin}/api/status`);
    expect(response.status).toBe(200);
    status = (await response.json()) as ConsoleStatus;
  });

  afterEach(async () => {
    await running.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${running.origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: running.origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-HiMCP-CSRF': status.csrfToken,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  async function sourceRequest(): Promise<SourceRequest> {
    return {
      source: `${await readFile(examplePath, 'utf8')}\n# raw-source-marker-not-persisted\n`,
      filename: 'weather-api.yaml',
      sourceType: 'auto',
    };
  }

  function leastPrivilegeSourceRequest(): SourceRequest {
    return {
      filename: 'least-privilege-api.yaml',
      sourceType: 'http-manifest',
      source: `
schemaVersion: '1.0'
kind: http
id: least-privilege-api
title: Least privilege API
servers:
  - url: https://fallback.example.test/v1
securitySchemes:
  alphaKey:
    type: apiKey
    location: header
    parameterName: X-Alpha-Key
  betaKey:
    type: apiKey
    location: query
    parameterName: beta_token
security: []
operations:
  - id: alphaRead
    method: GET
    path: /alpha
    servers:
      - url: https://alpha.example.test/v1
    security:
      - - scheme: alphaKey
          scopes: []
    successResponses:
      - statusCode: '200'
        contentType: application/json
        schema:
          type: object
  - id: betaRead
    method: GET
    path: /beta
    servers:
      - url: https://beta.example.test/v1
    security:
      - - scheme: betaKey
          scopes: []
    successResponses:
      - statusCode: '200'
        contentType: application/json
        schema:
          type: object
`.trimStart(),
    };
  }

  async function analyzeSourceRequest(source: SourceRequest): Promise<AnalysisResponse> {
    const response = await post('/api/analyze', source);
    expect(response.status).toBe(200);
    return (await response.json()) as AnalysisResponse;
  }

  async function registrationRequest(
    suppliedSource?: SourceRequest,
    includedOperationIds?: readonly string[],
  ): Promise<RegistrationRequest> {
    const source = suppliedSource ?? (await sourceRequest());
    const analysis = await analyzeSourceRequest(source);
    return {
      ...source,
      reviewedAnalysisFingerprint: analysis.analysisFingerprint,
      includedOperationIds:
        includedOperationIds ?? analysis.operations.map((operation) => operation.id),
    };
  }

  async function register(request?: RegistrationRequest): Promise<RegistrationDetail> {
    const response = await post('/api/registrations', request ?? (await registrationRequest()));
    expect(response.status).toBe(201);
    return (await response.json()) as RegistrationDetail;
  }

  it('reports the runtime catalogue and loads repository samples dynamically', async () => {
    expect(status.runtime.mode).toBe('local');
    expect(status.adapters).toEqual(createSourceAdapterRegistry().list());
    expect(status.csrfToken.length).toBeGreaterThan(32);

    const samplesResponse = await fetch(`${running.origin}/api/samples`);
    const samples = (await samplesResponse.json()) as readonly { id: string; filename: string }[];
    expect(samples.some(({ filename }) => filename === 'http-manifest.yaml')).toBe(true);
    const selected = samples.find(({ filename }) => filename === 'http-manifest.yaml')!;
    const sampleResponse = await fetch(`${running.origin}/api/samples/${selected.id}`);
    const sample = (await sampleResponse.json()) as SourceRequest;
    expect(sample.source).toContain('Weather API without OpenAPI');
    expect(sample.sourceType).toBe('auto');
  });

  it('skips symbolic links without hiding later catalogue samples', async () => {
    const examplesDirectory = join(dataDirectory, 'isolated-examples');
    const isolatedDataDirectory = join(dataDirectory, 'isolated-data');
    await mkdir(examplesDirectory);
    await symlink(examplePath, join(examplesDirectory, '00-skipped.yaml'));
    await writeFile(join(examplesDirectory, '01-valid.yaml'), await readFile(examplePath, 'utf8'));
    const isolated = await createConsoleServer({
      port: 0,
      dataDirectory: isolatedDataDirectory,
      examplesDirectory,
      cliEntryPath: '/opt/hi-mcp/bin.js',
      serveClient: false,
    });
    const isolatedRunning = await isolated.listen();
    try {
      const response = await fetch(`${isolatedRunning.origin}/api/samples`);
      expect(response.status).toBe(200);
      const samples = (await response.json()) as readonly { filename: string }[];
      expect(samples).toEqual([
        { filename: '01-valid.yaml', id: expect.any(String), name: '01-valid', sourceType: 'auto' },
      ]);
    } finally {
      await isolatedRunning.close();
    }
  });

  it('attaches development HMR to the loopback console listener', async () => {
    const activeHandles = (): Set<NetServer> =>
      new Set(
        (process as typeof process & { readonly _getActiveHandles: () => readonly unknown[] })
          ._getActiveHandles()
          .filter((handle): handle is NetServer => handle instanceof NetServer && handle.listening),
      );
    const before = activeHandles();
    const developmentServer = await createConsoleServer({
      port: 0,
      dataDirectory: join(dataDirectory, 'development-data'),
      examplesDirectory: join(repositoryRoot, 'examples'),
      cliEntryPath: '/opt/hi-mcp/bin.js',
      development: true,
      serveClient: true,
    });
    const developmentRunning = await developmentServer.listen();
    try {
      const added = [...activeHandles()].filter((handle) => !before.has(handle));
      expect(added).toHaveLength(1);
      expect(added[0]?.address()).toMatchObject({
        address: '127.0.0.1',
        port: Number(new URL(developmentRunning.origin).port),
      });
      const response = await fetch(developmentRunning.origin);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('/@vite/client');
    } finally {
      await developmentRunning.close();
    }
  });

  it('serves the client shell with the local security policy', async () => {
    const response = await fetch(`${running.origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('HiMCP test');

    const guideResponse = await fetch(`${running.origin}/guide`);
    expect(guideResponse.status).toBe(200);
    expect(guideResponse.headers.get('content-type')).toContain('text/html');
    expect(guideResponse.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(await guideResponse.text()).toContain('HiMCP test');
  });

  it('analyzes and registers a source without persisting the raw document', async () => {
    const source = await sourceRequest();
    const analysisResponse = await post('/api/analyze', source);
    expect(analysisResponse.status).toBe(200);
    const analysis = (await analysisResponse.json()) as {
      adapterId: string;
      document: { operationCount: number; serverOrigins: string[] };
    };
    expect(analysis.adapterId).toBe('http-manifest');
    expect(analysis.document.operationCount).toBe(2);
    expect(analysis.document.serverOrigins).toEqual(['https://weather.example.com']);

    const detail = await register();
    expect(detail.registration.capabilityCount).toBe(2);
    expect(detail.registration.sourceOperationCount).toBe(2);
    expect(detail.registration.origins).toEqual(['https://weather.example.com']);
    expect(detail.registration.credentialBindings).toHaveLength(1);
    expect(detail.capabilities.some(({ risk }) => risk.requiresConfirmation)).toBe(true);

    const releaseDirectory = join(dataDirectory, 'releases', detail.registration.id);
    expect((await stat(releaseDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(releaseDirectory, 'release.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(releaseDirectory, 'metadata.json'))).mode & 0o777).toBe(0o600);
    const persisted = `${await readFile(join(releaseDirectory, 'release.json'), 'utf8')}\n${await readFile(join(releaseDirectory, 'metadata.json'), 'utf8')}`;
    expect(persisted).not.toContain('raw-source-marker-not-persisted');

    const repeated = await register();
    expect(repeated.registration.id).toBe(detail.registration.id);
  });

  it('creates deterministic content-addressed releases for exact operation subsets', async () => {
    const reviewed = await registrationRequest();
    const [firstOperationId, secondOperationId] = reviewed.includedOperationIds;
    expect(firstOperationId).toBeDefined();
    expect(secondOperationId).toBeDefined();

    const firstRequest = { ...reviewed, includedOperationIds: [firstOperationId!] };
    const first = await register(firstRequest);
    const repeatedFirst = await register(firstRequest);
    const second = await register({ ...reviewed, includedOperationIds: [secondOperationId!] });
    const all = await register(reviewed);
    const reversedAll = await register({
      ...reviewed,
      includedOperationIds: [...reviewed.includedOperationIds].reverse(),
    });

    expect(first.registration.capabilityCount).toBe(1);
    expect(first.registration.sourceOperationCount).toBe(2);
    expect(first.capabilities.map(({ id }) => id)).toEqual([firstOperationId]);
    expect(repeatedFirst.registration.id).toBe(first.registration.id);
    expect(repeatedFirst.registration.fingerprint).toBe(first.registration.fingerprint);
    expect(second.registration.id).not.toBe(first.registration.id);
    expect(all.registration.id).not.toBe(first.registration.id);
    expect(reversedAll.registration.id).toBe(all.registration.id);
    expect(reversedAll.registration.fingerprint).toBe(all.registration.fingerprint);

    const [firstRelease, allRelease] = (await Promise.all([
      fetch(`${running.origin}${first.artifactUrls.release}`).then((response) => response.json()),
      fetch(`${running.origin}${all.artifactUrls.release}`).then((response) => response.json()),
    ])) as Array<{
      fingerprint: string;
      capabilities: Array<{ id: string; fingerprint: string }>;
    }>;
    expect(firstRelease!.capabilities).toHaveLength(1);
    expect(firstRelease!.fingerprint).toBe(first.registration.fingerprint);
    expect(allRelease!.capabilities.find(({ id }) => id === firstOperationId)?.fingerprint).toBe(
      firstRelease!.capabilities[0]?.fingerprint,
    );
  });

  it('creates, lists, stales, and securely deletes exact selection presets', async () => {
    const source = await sourceRequest();
    const analysis = await analyzeSourceRequest(source);
    const includedOperationId = analysis.operations[0]!.id;
    const presetRequest = {
      ...source,
      name: 'Read tools',
      reviewedAnalysisFingerprint: analysis.analysisFingerprint,
      includedOperationIds: [includedOperationId],
    };

    const createdResponse = await post('/api/selection-presets', presetRequest);
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as SelectionPresetSaveResponse;
    expect(created.created).toBe(true);
    expect(created.preset).toMatchObject({
      sourceScopeId: analysis.sourceScopeId,
      name: 'Read tools',
      analysisFingerprint: analysis.analysisFingerprint,
      documentFingerprint: analysis.document.fingerprint,
      sourceOperationCount: analysis.operations.length,
      includedOperationCount: 1,
      compatibility: 'exact',
    });
    expect(created.preset).not.toHaveProperty('includedOperationIds');
    expect(created.preset).not.toHaveProperty('recordFingerprint');
    expect(created.preset).not.toHaveProperty('schemaVersion');

    const repeatedResponse = await post('/api/selection-presets', presetRequest);
    expect(repeatedResponse.status).toBe(200);
    expect((await repeatedResponse.json()) as SelectionPresetSaveResponse).toMatchObject({
      created: false,
      preset: { id: created.preset.id },
    });
    const conflictingResponse = await post('/api/selection-presets', {
      ...presetRequest,
      includedOperationIds: [analysis.operations[1]!.id],
    });
    expect(conflictingResponse.status).toBe(409);
    expect(((await conflictingResponse.json()) as { error: { code: string } }).error.code).toBe(
      'SELECTION_PRESET_CONFLICT',
    );

    const exactQuery = new URLSearchParams({
      sourceScopeId: analysis.sourceScopeId,
      analysisFingerprint: analysis.analysisFingerprint,
    });
    const exact = (await fetch(`${running.origin}/api/selection-presets?${exactQuery}`).then(
      (response) => response.json(),
    )) as readonly SelectionPresetSummary[];
    expect(exact).toEqual([
      expect.objectContaining({ id: created.preset.id, compatibility: 'exact' }),
    ]);
    expect(exact[0]).toMatchObject({ includedOperationCount: 1 });
    expect(exact[0]).not.toHaveProperty('includedOperationIds');

    const detailQuery = new URLSearchParams({
      analysisFingerprint: analysis.analysisFingerprint,
      selectionFingerprint: created.preset.selectionFingerprint,
    });
    const detailResponse = await fetch(
      `${running.origin}/api/selection-presets/${analysis.sourceScopeId}/${created.preset.id}?${detailQuery}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as SelectionPresetDetail;
    expect(detail).toMatchObject({
      id: created.preset.id,
      includedOperationCount: 1,
      includedOperationIds: [includedOperationId],
      compatibility: 'exact',
    });

    const changedSelectionQuery = new URLSearchParams({
      analysisFingerprint: analysis.analysisFingerprint,
      selectionFingerprint: `sha256:${'f'.repeat(64)}`,
    });
    const changedSelectionResponse = await fetch(
      `${running.origin}/api/selection-presets/${analysis.sourceScopeId}/${created.preset.id}?${changedSelectionQuery}`,
    );
    expect(changedSelectionResponse.status).toBe(409);
    expect(
      ((await changedSelectionResponse.json()) as { error: { code: string } }).error.code,
    ).toBe('SELECTION_PRESET_CHANGED');
    const missingSelectionFingerprintResponse = await fetch(
      `${running.origin}/api/selection-presets/${analysis.sourceScopeId}/${created.preset.id}?analysisFingerprint=${encodeURIComponent(analysis.analysisFingerprint)}`,
    );
    expect(missingSelectionFingerprintResponse.status).toBe(400);

    const revisedSource = {
      ...source,
      source: source.source.replace("version: '2026-07'", "version: '2026-08'"),
    };
    const revisedAnalysis = await analyzeSourceRequest(revisedSource);
    expect(revisedAnalysis.sourceScopeId).toBe(analysis.sourceScopeId);
    expect(revisedAnalysis.analysisFingerprint).not.toBe(analysis.analysisFingerprint);
    const staleQuery = new URLSearchParams({
      sourceScopeId: revisedAnalysis.sourceScopeId,
      analysisFingerprint: revisedAnalysis.analysisFingerprint,
    });
    const stale = (await fetch(`${running.origin}/api/selection-presets?${staleQuery}`).then(
      (response) => response.json(),
    )) as readonly SelectionPresetSummary[];
    expect(stale).toEqual([
      expect.objectContaining({ id: created.preset.id, compatibility: 'stale' }),
    ]);
    expect(stale[0]).not.toHaveProperty('includedOperationIds');

    const staleDetailQuery = new URLSearchParams({
      analysisFingerprint: revisedAnalysis.analysisFingerprint,
      selectionFingerprint: created.preset.selectionFingerprint,
    });
    const staleDetailResponse = await fetch(
      `${running.origin}/api/selection-presets/${revisedAnalysis.sourceScopeId}/${created.preset.id}?${staleDetailQuery}`,
    );
    expect(staleDetailResponse.status).toBe(409);
    expect(((await staleDetailResponse.json()) as { error: { code: string } }).error.code).toBe(
      'SELECTION_PRESET_STALE',
    );

    const reviewResponse = await post(
      `/api/selection-presets/${revisedAnalysis.sourceScopeId}/${created.preset.id}/review`,
      {
        ...revisedSource,
        reviewedAnalysisFingerprint: revisedAnalysis.analysisFingerprint,
        selectionFingerprint: created.preset.selectionFingerprint,
      },
    );
    expect(reviewResponse.status).toBe(200);
    expect((await reviewResponse.json()) as SelectionPresetReviewResponse).toMatchObject({
      preset: {
        id: created.preset.id,
        previousAnalysisFingerprint: analysis.analysisFingerprint,
      },
      currentAnalysisFingerprint: revisedAnalysis.analysisFingerprint,
      candidateOperationIds: [includedOperationId],
      missingOperationIds: [],
      unselectedCurrentOperationIds: [analysis.operations[1]!.id],
    });
    const changedReviewResponse = await post(
      `/api/selection-presets/${revisedAnalysis.sourceScopeId}/${created.preset.id}/review`,
      {
        ...revisedSource,
        reviewedAnalysisFingerprint: revisedAnalysis.analysisFingerprint,
        selectionFingerprint: `sha256:${'f'.repeat(64)}`,
      },
    );
    expect(changedReviewResponse.status).toBe(409);
    expect(((await changedReviewResponse.json()) as { error: { code: string } }).error.code).toBe(
      'SELECTION_PRESET_CHANGED',
    );

    const unrelatedTitleAnalysis = await analyzeSourceRequest({
      ...source,
      source: source.source.replace(
        'Weather API without OpenAPI',
        'Another API using the same filename',
      ),
    });
    expect(unrelatedTitleAnalysis.sourceScopeId).not.toBe(analysis.sourceScopeId);
    const unrelatedOriginAnalysis = await analyzeSourceRequest({
      ...source,
      source: source.source.replace('weather.example.com', 'other-weather.example.com'),
    });
    expect(unrelatedOriginAnalysis.sourceScopeId).not.toBe(analysis.sourceScopeId);

    const staleSave = await post('/api/selection-presets', {
      ...presetRequest,
      source: revisedSource.source,
    });
    expect(staleSave.status).toBe(409);
    expect(((await staleSave.json()) as { error: { code: string } }).error.code).toBe(
      'ANALYSIS_STALE',
    );

    const presetPath = join(
      dataDirectory,
      'selection-presets',
      created.preset.sourceScopeId,
      created.preset.id,
      'preset.json',
    );
    const persisted = await readFile(presetPath, 'utf8');
    expect(persisted).not.toContain('raw-source-marker-not-persisted');
    expect(persisted).not.toContain('weather.example.com');
    expect(persisted).not.toContain('apiKey');

    const deletePath = `/api/selection-presets/${created.preset.sourceScopeId}/${created.preset.id}`;
    const missingCsrf = await fetch(`${running.origin}${deletePath}`, {
      method: 'DELETE',
      headers: { Origin: running.origin, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(missingCsrf.status).toBe(403);
    const deleted = await fetch(`${running.origin}${deletePath}`, {
      method: 'DELETE',
      headers: {
        Origin: running.origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-HiMCP-CSRF': status.csrfToken,
      },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    const deletedDetailResponse = await fetch(
      `${running.origin}/api/selection-presets/${analysis.sourceScopeId}/${created.preset.id}?${detailQuery}`,
    );
    expect(deletedDetailResponse.status).toBe(404);
    expect(
      (await fetch(`${running.origin}/api/selection-presets?${staleQuery}`).then((response) =>
        response.json(),
      )) as readonly SelectionPresetSummary[],
    ).toEqual([]);
  });

  it('compares a stored verified release with a freshly reviewed source contract', async () => {
    const source = await sourceRequest();
    const baseline = await register(await registrationRequest(source));
    const revisedSource: SourceRequest = {
      ...source,
      source: `${source.source
        .replace('https://weather.example.com/v1', 'https://weather-v2.example.com/v2')
        .replace(
          'Returns current conditions for a city.',
          'Returns current conditions from the revised service.',
        )}\n  - id: healthCheck\n    method: GET\n    path: /health\n    successResponses:\n      - statusCode: '204'\n`,
    };
    const revisedAnalysis = await analyzeSourceRequest(revisedSource);

    const response = await post('/api/contract-diffs', {
      ...revisedSource,
      baselineRegistrationId: baseline.registration.id,
      reviewedAnalysisFingerprint: revisedAnalysis.analysisFingerprint,
    });

    expect(response.status).toBe(200);
    const diff = (await response.json()) as ContractDiffResponse;
    expect(diff.baseline.releaseId).toBe(baseline.registration.id);
    expect(diff.current.documentFingerprint).toBe(revisedAnalysis.document.fingerprint);
    expect(diff.summary).toEqual({
      added: 1,
      removed: 0,
      changed: 2,
      unchanged: 0,
      securityReview: 2,
      breaking: 0,
      metadataReview: 0,
    });
    expect(diff.operations.find(({ after }) => after?.name === 'getCurrentWeather')).toMatchObject({
      impact: 'security-review',
      areas: expect.arrayContaining(['destination', 'tool-metadata']),
    });

    const staleResponse = await post('/api/contract-diffs', {
      ...revisedSource,
      baselineRegistrationId: baseline.registration.id,
      reviewedAnalysisFingerprint: `sha256:${'0'.repeat(64)}`,
    });
    expect(staleResponse.status).toBe(409);
    expect(((await staleResponse.json()) as { error: { code: string } }).error.code).toBe(
      'ANALYSIS_STALE',
    );
  });

  it('rejects missing, empty, duplicate, malformed, and unknown operation selections', async () => {
    const reviewed = await registrationRequest();
    const selectedId = reviewed.includedOperationIds[0]!;
    const requestShapeFailures: readonly Readonly<{
      body: unknown;
      label: string;
    }>[] = [
      {
        label: 'missing selection',
        body: {
          source: reviewed.source,
          filename: reviewed.filename,
          sourceType: reviewed.sourceType,
        },
      },
      {
        label: 'empty selection',
        body: { ...reviewed, includedOperationIds: [] },
      },
      {
        label: 'duplicate selection',
        body: { ...reviewed, includedOperationIds: [selectedId, selectedId] },
      },
      {
        label: 'malformed selection',
        body: { ...reviewed, includedOperationIds: ['NOT A NORMALIZED ID'] },
      },
    ];

    for (const failure of requestShapeFailures) {
      const response = await post('/api/registrations', failure.body);
      expect(response.status, failure.label).toBe(400);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code, failure.label).toBe('REQUEST_INVALID');
    }

    const unknown = await post('/api/registrations', {
      ...reviewed,
      includedOperationIds: ['operation_unknown'],
    });
    expect(unknown.status).toBe(422);
    const unknownPayload = (await unknown.json()) as {
      error: { code: string; diagnostics?: readonly { code: string }[] };
    };
    expect(unknownPayload.error.code).toBe('OPERATION_SELECTION_INVALID');
    expect(unknownPayload.error.diagnostics?.map(({ code }) => code)).toContain(
      'SELECTION.OPERATION_NOT_FOUND',
    );

    const registrations = (await fetch(`${running.origin}/api/registrations`).then((response) =>
      response.json(),
    )) as readonly RegistrationDetail['registration'][];
    expect(registrations).toEqual([]);
  });

  it('rejects a stale reviewed analysis before persisting a release', async () => {
    const reviewed = await registrationRequest();
    const response = await post('/api/registrations', {
      ...reviewed,
      source: reviewed.source.replace(
        'Weather API without OpenAPI',
        'Weather API changed after review',
      ),
    });

    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      error: { code: string; diagnostics?: readonly { code: string }[] };
    };
    expect(payload.error.code).toBe('ANALYSIS_STALE');
    expect(payload.error.diagnostics?.map(({ code }) => code)).toContain(
      'SELECTION.ANALYSIS_FINGERPRINT_MISMATCH',
    );
    const registrations = (await fetch(`${running.origin}/api/registrations`).then((result) =>
      result.json(),
    )) as readonly unknown[];
    expect(registrations).toEqual([]);
  });

  it('derives origins and credentials only from included operations', async () => {
    const source = leastPrivilegeSourceRequest();
    const analysis = await analyzeSourceRequest(source);
    const alphaOperation = analysis.operations.find(
      ({ operationId }) => operationId === 'alphaRead',
    );
    expect(alphaOperation).toBeDefined();

    const all = await register(await registrationRequest(source));
    const subset = await register(await registrationRequest(source, [alphaOperation!.id]));

    expect(all.registration.origins).toEqual([
      'https://alpha.example.test',
      'https://beta.example.test',
    ]);
    expect(all.registration.credentialBindings.map(({ scheme }) => scheme)).toEqual([
      'alphaKey',
      'betaKey',
    ]);
    expect(subset.registration.capabilityCount).toBe(1);
    expect(subset.registration.sourceOperationCount).toBe(2);
    expect(subset.registration.origins).toEqual(['https://alpha.example.test']);
    expect(subset.registration.credentialBindings.map(({ scheme }) => scheme)).toEqual([
      'alphaKey',
    ]);
    expect(subset.capabilities).toHaveLength(1);
    expect(subset.capabilities[0]).toMatchObject({
      id: alphaOperation!.id,
      authRequired: true,
      authSchemes: ['alphaKey'],
      servers: ['https://alpha.example.test/v1'],
    });

    const betaBinding = all.registration.credentialBindings.find(
      ({ scheme }) => scheme === 'betaKey',
    )!;
    const rejectedExcludedBinding = await post(
      `/api/registrations/${subset.registration.id}/connections`,
      {
        displayName: 'Alpha tools',
        approvedOrigins: subset.registration.origins,
        allowInsecureHttp: false,
        confirmation: 'per-call',
        credentialEnvironment: {
          [betaBinding.environmentVariable]: 'BETA_RUNTIME_TOKEN',
        },
      },
    );
    expect(rejectedExcludedBinding.status).toBe(422);
    const rejectedPayload = (await rejectedExcludedBinding.json()) as {
      error: { code: string };
    };
    expect(rejectedPayload.error.code).toBe('CREDENTIAL_BINDING_INVALID');

    const alphaBinding = subset.registration.credentialBindings[0]!;
    const connectionResponse = await post(
      `/api/registrations/${subset.registration.id}/connections`,
      {
        displayName: 'Alpha tools',
        approvedOrigins: subset.registration.origins,
        allowInsecureHttp: false,
        confirmation: 'per-call',
        credentialEnvironment: {
          [alphaBinding.environmentVariable]: 'ALPHA_RUNTIME_TOKEN',
        },
      },
    );
    expect(connectionResponse.status).toBe(201);
    const connection = (await connectionResponse.json()) as ConnectionResponse;
    expect(connection.requiredEnvironmentVariables).toEqual(['ALPHA_RUNTIME_TOKEN']);

    const releaseText = await fetch(`${running.origin}${subset.artifactUrls.release}`).then(
      (response) => response.text(),
    );
    expect(releaseText).toContain('https://alpha.example.test/v1');
    expect(releaseText).not.toContain('https://beta.example.test');
    expect(releaseText).not.toContain('betaKey');

    const profilePath = join(
      dataDirectory,
      'releases',
      subset.registration.id,
      'connections',
      connection.profile.id,
      'profile.json',
    );
    const profileText = await readFile(profilePath, 'utf8');
    expect(profileText).toContain('https://alpha.example.test');
    expect(profileText).toContain('ALPHA_RUNTIME_TOKEN');
    expect(profileText).not.toContain('https://beta.example.test');
    expect(profileText).not.toContain('betaKey');
    expect(profileText).not.toContain(betaBinding.environmentVariable);
  });

  it('requires every release origin and stores only credential environment names', async () => {
    const detail = await register();
    const binding = detail.registration.credentialBindings[0]!;
    const incomplete = await post(`/api/registrations/${detail.registration.id}/connections`, {
      displayName: 'Weather tools',
      approvedOrigins: ['https://unrelated.example.com'],
      allowInsecureHttp: false,
      confirmation: 'per-call',
      credentialEnvironment: {},
    });
    expect(incomplete.status).toBe(422);

    const response = await post(`/api/registrations/${detail.registration.id}/connections`, {
      displayName: 'Weather tools',
      description: 'Reviewed local MCP connection',
      approvedOrigins: detail.registration.origins,
      allowInsecureHttp: false,
      confirmation: 'per-call',
      credentialEnvironment: {
        [binding.environmentVariable]: 'WEATHER_API_TOKEN',
      },
    });
    expect(response.status).toBe(201);
    const connection = (await response.json()) as ConnectionResponse;
    expect(connection.requiredEnvironmentVariables).toEqual(['WEATHER_API_TOKEN']);
    const descriptorText = JSON.stringify(connection.descriptor);
    expect(descriptorText).not.toContain('credential');
    expect(descriptorText).not.toContain('WEATHER_API_TOKEN');
    expect(descriptorText).toContain('/opt/hi-mcp/bin.js');

    const profilePath = join(
      dataDirectory,
      'releases',
      detail.registration.id,
      'connections',
      connection.profile.id,
      'profile.json',
    );
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    const profile = await readFile(profilePath, 'utf8');
    expect(profile).toContain('WEATHER_API_TOKEN');
    expect(profile).not.toContain('plain-secret-value');

    const invalidNameAttempt = await post(
      `/api/registrations/${detail.registration.id}/connections`,
      {
        displayName: 'Invalid environment variable',
        approvedOrigins: detail.registration.origins,
        allowInsecureHttp: false,
        confirmation: 'per-call',
        credentialEnvironment: {
          [binding.environmentVariable]: 'plain-secret-value',
        },
      },
    );
    expect(invalidNameAttempt.status).toBe(400);
  });

  it('rejects DNS rebinding, cross-origin, missing CSRF, and unknown request fields', async () => {
    const hostileHost = await new Promise<number>((resolveStatus, rejectStatus) => {
      const url = new URL('/api/status', running.origin);
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { Host: 'attacker.example' },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolveStatus(response.statusCode ?? 0));
        },
      );
      request.once('error', rejectStatus);
      request.end();
    });
    expect(hostileHost).toBe(403);

    const source = await sourceRequest();
    const crossOrigin = await post('/api/analyze', source, { Origin: 'https://attacker.example' });
    expect(crossOrigin.status).toBe(403);
    const missingCsrf = await post('/api/analyze', source, { 'X-HiMCP-CSRF': '' });
    expect(missingCsrf.status).toBe(403);
    const unknownField = await post('/api/analyze', { ...source, arbitraryCommand: 'run-me' });
    expect(unknownField.status).toBe(400);
  });

  it('requires an explicit opt-in for every reviewed HTTP origin', async () => {
    const source = await sourceRequest();
    const insecureSource = {
      ...source,
      source: source.source.replace('https://weather.example.com', 'http://weather.example.com'),
    };
    const response = await post('/api/registrations', await registrationRequest(insecureSource));
    expect(response.status).toBe(201);
    const detail = (await response.json()) as RegistrationDetail;
    const binding = detail.registration.credentialBindings[0]!;
    const policy = {
      displayName: 'HTTP weather tools',
      approvedOrigins: detail.registration.origins,
      confirmation: 'per-call',
      credentialEnvironment: { [binding.environmentVariable]: 'WEATHER_HTTP_TOKEN' },
    };
    const denied = await post(`/api/registrations/${detail.registration.id}/connections`, {
      ...policy,
      allowInsecureHttp: false,
    });
    expect(denied.status).toBe(422);
    const approved = await post(`/api/registrations/${detail.registration.id}/connections`, {
      ...policy,
      allowInsecureHttp: true,
    });
    expect(approved.status).toBe(201);
  });

  it('rejects a persisted release after content-addressed identity tampering', async () => {
    const detail = await register();
    const releasePath = join(dataDirectory, 'releases', detail.registration.id, 'release.json');
    const releaseText = await readFile(releasePath, 'utf8');
    await writeFile(releasePath, releaseText.replace('Get current weather', 'Changed title'), {
      mode: 0o600,
    });
    const response = await fetch(`${running.origin}/api/registrations/${detail.registration.id}`);
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('RELEASE_INVALID');
  });

  it('rejects registration metadata whose content fingerprint no longer matches', async () => {
    const detail = await register();
    const metadataPath = join(dataDirectory, 'releases', detail.registration.id, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    metadata['title'] = 'Changed metadata title';
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

    const response = await fetch(`${running.origin}/api/registrations/${detail.registration.id}`);
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('METADATA_INVALID');
  });

  it('rejects a persisted artifact that has been hard-linked', async () => {
    const detail = await register();
    const releaseDirectory = join(dataDirectory, 'releases', detail.registration.id);
    const releasePath = join(releaseDirectory, 'release.json');
    await link(releasePath, join(releaseDirectory, 'release-alias.json'));

    const response = await fetch(`${running.origin}/api/registrations/${detail.registration.id}`);
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('ARTIFACT_INVALID');
  });
});
