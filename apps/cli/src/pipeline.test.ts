import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { compileSource, reviewOperationSelection, validateRelease } from './pipeline.js';

const fixtureLocation = new URL('../../../examples/customer-support/openapi.yaml', import.meta.url);
const manifestFixtureLocation = new URL(
  '../../../examples/weather-api/http-manifest.yaml',
  import.meta.url,
);

async function fixture() {
  const content = await readFile(fixtureLocation, 'utf8');
  const defaults = (await loadConfig()).config;
  return {
    content,
    config: {
      ...defaults,
      compile: { ...defaults.compile, strict: false },
    },
  };
}

describe('compileSource', () => {
  it('compiles a real OpenAPI source into a reproducible verified release', async () => {
    const { content, config } = await fixture();
    const first = await compileSource({
      source: content,
      location: fixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 3,
      now: () => new Date('2026-07-14T01:00:00.000Z'),
    });
    const second = await compileSource({
      source: content,
      location: '/a-different-clone/renamed-contract.yaml',
      config,
      semantic: false,
      sequence: 3,
      now: () => new Date('2026-07-14T02:00:00.000Z'),
    });

    expect(first.release.capabilities).toHaveLength(4);
    expect(first.release.fingerprint).toBe(second.release.fingerprint);
    expect(first.release.id).toBe(second.release.id);
    expect(first.release.createdAt).not.toBe(second.release.createdAt);
    expect(first.release.sources[0]).not.toHaveProperty('sourceUri');
    expect(first.release.capabilities[0]?.provenance).not.toHaveProperty('sourceUri');
    expect(first.analysisFingerprint).toBe(second.analysisFingerprint);

    const validation = await validateRelease({
      value: first.release,
      source: { content, location: fixtureLocation.pathname },
      config,
    });
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  });

  it('detects release content tampering', async () => {
    const { content, config } = await fixture();
    const compiled = await compileSource({
      source: content,
      location: fixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
    });
    const firstCapability = compiled.release.capabilities[0]!;
    const tampered = {
      ...compiled.release,
      capabilities: [
        { ...firstCapability, description: 'Tampered after verification.' },
        ...compiled.release.capabilities.slice(1),
      ],
    };

    const validation = await validateRelease({ value: tampered, config });

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['RELEASE.FINGERPRINT_MISMATCH', 'IR.FINGERPRINT_MISMATCH']),
    );
  });

  it('auto-detects and compiles an HTTP API registration without OpenAPI', async () => {
    const content = await readFile(manifestFixtureLocation, 'utf8');
    const config = (await loadConfig()).config;
    const compiled = await compileSource({
      source: content,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
      now: () => new Date('2026-07-14T03:00:00.000Z'),
    });

    expect(compiled.document).toMatchObject({
      sourceKind: 'http-manifest',
      sourceVersion: '1.0',
      sourceId: 'weather-api',
    });
    expect(compiled.release.sources).toEqual([
      expect.objectContaining({ sourceKind: 'http-manifest-1.0' }),
    ]);
    expect(compiled.release.capabilities.map(({ name }) => name).sort()).toEqual([
      'createWeatherAlert',
      'getCurrentWeather',
    ]);

    const validation = await validateRelease({
      value: compiled.release,
      source: {
        content,
        location: manifestFixtureLocation.pathname,
        sourceType: 'http-manifest',
      },
      config,
    });
    expect(validation.valid).toBe(true);
  });

  it('compiles only the reviewed operation subset and retains source-grounded verification', async () => {
    const content = await readFile(manifestFixtureLocation, 'utf8');
    const config = (await loadConfig()).config;
    const reviewed = await compileSource({
      source: content,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
      now: () => new Date('2026-07-14T03:00:00.000Z'),
    });
    const includedOperation = reviewed.document.operations.find(
      ({ operationId }) => operationId === 'getCurrentWeather',
    );
    expect(includedOperation).toBeDefined();
    if (includedOperation === undefined) throw new Error('Missing weather operation fixture.');

    const selected = await compileSource({
      source: content,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
      includedOperationIds: [includedOperation.id],
      reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
      now: () => new Date('2026-07-14T04:00:00.000Z'),
    });

    expect(selected.selection).toEqual({
      sourceOperationCount: 2,
      includedOperationIds: [includedOperation.id],
    });
    expect(selected.release.capabilities.map(({ id }) => id)).toEqual([includedOperation.id]);
    expect(selected.release.extensions?.['hi-mcp.compilation']).toHaveLength(1);
    expect(selected.release.fingerprint).not.toBe(reviewed.release.fingerprint);

    const validation = await validateRelease({
      value: selected.release,
      source: {
        content,
        location: manifestFixtureLocation.pathname,
        sourceType: 'http-manifest',
      },
      config,
    });
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  });

  it('rejects empty, duplicate, and unknown operation selections before release creation', async () => {
    const content = await readFile(manifestFixtureLocation, 'utf8');
    const config = (await loadConfig()).config;
    const reviewed = await compileSource({
      source: content,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
    });
    const knownId = reviewed.document.operations[0]?.id;
    expect(knownId).toBeDefined();
    if (knownId === undefined) throw new Error('Missing operation fixture.');

    const cases = [
      { includedOperationIds: [] as readonly string[], code: 'SELECTION.EMPTY' },
      {
        includedOperationIds: [knownId, knownId],
        code: 'SELECTION.DUPLICATE_OPERATION_ID',
      },
      {
        includedOperationIds: ['operation_missing_from_review'],
        code: 'SELECTION.OPERATION_NOT_FOUND',
      },
    ];
    for (const testCase of cases) {
      await expect(
        compileSource({
          source: content,
          location: manifestFixtureLocation.pathname,
          config,
          semantic: false,
          sequence: 0,
          includedOperationIds: testCase.includedOperationIds,
          reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
        }),
      ).rejects.toMatchObject({
        name: 'OperationSelectionError',
        diagnostics: [expect.objectContaining({ code: testCase.code, severity: 'error' })],
      });
    }
  });

  it('exposes the same review validation for non-compiling console artifacts', async () => {
    const content = await readFile(manifestFixtureLocation, 'utf8');
    const config = (await loadConfig()).config;
    const reviewed = await compileSource({
      source: content,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
    });
    const includedOperationId = reviewed.document.operations[0]!.id;

    expect(
      reviewOperationSelection(
        reviewed.adapterId,
        reviewed.document,
        [includedOperationId],
        reviewed.analysisFingerprint,
      ),
    ).toEqual({
      analysisFingerprint: reviewed.analysisFingerprint,
      selection: {
        sourceOperationCount: reviewed.document.operations.length,
        includedOperationIds: [includedOperationId],
      },
    });
    expect(() =>
      reviewOperationSelection(
        reviewed.adapterId,
        reviewed.document,
        [includedOperationId],
        `sha256:${'0'.repeat(64)}`,
      ),
    ).toThrow(expect.objectContaining({ name: 'AnalysisReviewStaleError' }));
  });

  it('rejects a reviewed selection when the normalized source revision changes', async () => {
    const content = await readFile(manifestFixtureLocation, 'utf8');
    const revisedContent = content.replace(
      'Returns current conditions for a city.',
      'Returns newly revised current conditions for a city.',
    );
    expect(revisedContent).not.toBe(content);
    const config = (await loadConfig()).config;
    const reviewed = await compileSource({
      source: content,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
    });
    const revised = await compileSource({
      source: revisedContent,
      location: manifestFixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 0,
    });
    expect(revised.document.operations.map(({ id }) => id)).toEqual(
      reviewed.document.operations.map(({ id }) => id),
    );
    expect(revised.analysisFingerprint).not.toBe(reviewed.analysisFingerprint);

    await expect(
      compileSource({
        source: revisedContent,
        location: manifestFixtureLocation.pathname,
        config,
        semantic: false,
        sequence: 0,
        includedOperationIds: [reviewed.document.operations[0]!.id],
        reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
      }),
    ).rejects.toMatchObject({
      name: 'AnalysisReviewStaleError',
      diagnostics: [
        expect.objectContaining({
          code: 'SELECTION.ANALYSIS_FINGERPRINT_MISMATCH',
          severity: 'error',
        }),
      ],
    });
  });

  it('canonicalizes selection order without changing stable names or release identity', async () => {
    const { content, config } = await fixture();
    const reviewed = await compileSource({
      source: content,
      location: fixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 7,
      now: () => new Date('2026-07-14T05:00:00.000Z'),
    });
    const allIds = reviewed.document.operations.map(({ id }) => id);
    expect(allIds).toHaveLength(4);
    const selectedIds = [allIds[2]!, allIds[0]!];
    const first = await compileSource({
      source: content,
      location: fixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 7,
      includedOperationIds: selectedIds,
      reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
      now: () => new Date('2026-07-14T06:00:00.000Z'),
    });
    const second = await compileSource({
      source: content,
      location: '/another/reviewed-source.yaml',
      config,
      semantic: false,
      sequence: 7,
      includedOperationIds: [...selectedIds].reverse(),
      reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
      now: () => new Date('2026-07-14T07:00:00.000Z'),
    });
    const explicitAll = await compileSource({
      source: content,
      location: fixtureLocation.pathname,
      config,
      semantic: false,
      sequence: 7,
      includedOperationIds: [...allIds].reverse(),
      reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
      now: () => new Date('2026-07-14T08:00:00.000Z'),
    });
    const selectedIdSet = new Set(selectedIds);
    const expectedCapabilities = reviewed.release.capabilities
      .filter(({ id }) => selectedIdSet.has(id))
      .map(({ id, name }) => ({ id, name }));

    expect(first.selection.includedOperationIds).toEqual([...selectedIds].sort());
    expect(first.release.capabilities.map(({ id, name }) => ({ id, name }))).toEqual(
      expectedCapabilities,
    );
    expect(second.release.capabilities.map(({ id, name }) => ({ id, name }))).toEqual(
      expectedCapabilities,
    );
    expect(first.release.fingerprint).toBe(second.release.fingerprint);
    expect(first.release.id).toBe(second.release.id);
    expect(first.release.fingerprint).not.toBe(reviewed.release.fingerprint);
    expect(explicitAll.release.fingerprint).toBe(reviewed.release.fingerprint);
    expect(explicitAll.release.id).toBe(reviewed.release.id);
  });
});
