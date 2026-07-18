import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fingerprint } from '@hi-mcp/capability-ir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SelectionPresetStore,
  selectionPresetId,
  selectionPresetSelectionFingerprint,
  selectionPresetSourceScopeId,
  type CreateSelectionPresetInput,
} from './selection-preset-store.js';

const ANALYSIS_A = fingerprint({ analysis: 'a' });
const ANALYSIS_B = fingerprint({ analysis: 'b' });
const DOCUMENT = fingerprint({ document: 'weather' });

function input(overrides: Partial<CreateSelectionPresetInput> = {}): CreateSelectionPresetInput {
  return {
    sourceScopeKey: 'weather-api.yaml',
    name: 'Read operations',
    adapterId: 'http-manifest',
    sourceKind: 'http-manifest',
    analysisFingerprint: ANALYSIS_A,
    documentFingerprint: DOCUMENT,
    sourceOperationCount: 3,
    includedOperationIds: ['operation_c', 'operation_a'],
    ...overrides,
  };
}

describe('SelectionPresetStore', () => {
  let rootDirectory: string;

  beforeEach(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), 'hi-mcp-selection-presets-'));
  });

  afterEach(async () => {
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it('persists only a normalized deterministic exact allowlist with private permissions', async () => {
    const store = new SelectionPresetStore({
      rootDirectory,
      now: () => new Date('2026-07-15T03:04:05.000Z'),
    });
    await store.initialize();

    const result = await store.create(
      input({
        name: '  Ｒｅａｄ operations  ',
        includedOperationIds: ['operation_c', 'operation_a'],
      }),
    );

    expect(result.created).toBe(true);
    expect(result.preset.name).toBe('Read operations');
    expect(result.preset.includedOperationIds).toEqual(['operation_a', 'operation_c']);
    expect(result.preset.sourceScopeId).toBe(
      selectionPresetSourceScopeId('http-manifest', 'http-manifest', 'weather-api.yaml'),
    );
    expect(result.preset.id).toBe(
      selectionPresetId(result.preset.sourceScopeId, ANALYSIS_A, 'Read operations'),
    );
    expect(result.preset.selectionFingerprint).toBe(
      selectionPresetSelectionFingerprint(ANALYSIS_A, 3, ['operation_a', 'operation_c']),
    );
    expect(Object.keys(result.preset).sort()).toEqual(
      [
        'adapterId',
        'analysisFingerprint',
        'createdAt',
        'documentFingerprint',
        'id',
        'includedOperationIds',
        'name',
        'recordFingerprint',
        'schemaVersion',
        'selectionFingerprint',
        'sourceKind',
        'sourceOperationCount',
        'sourceScopeId',
      ].sort(),
    );

    const scopeDirectory = join(rootDirectory, 'selection-presets', result.preset.sourceScopeId);
    const presetDirectory = join(scopeDirectory, result.preset.id);
    const presetPath = join(presetDirectory, 'preset.json');
    expect((await stat(rootDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(rootDirectory, 'selection-presets'))).mode & 0o777).toBe(0o700);
    expect((await stat(scopeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(presetDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(presetPath)).mode & 0o777).toBe(0o600);

    const persisted = JSON.parse(await readFile(presetPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toEqual(result.preset);
    expect(JSON.stringify(persisted)).not.toContain('weather-api.yaml');
    expect(JSON.stringify(persisted)).not.toContain('rawSource');
    expect(JSON.stringify(persisted)).not.toContain('credential');
  });

  it('returns the existing immutable record idempotently and rejects name collisions', async () => {
    let now = new Date('2026-07-15T00:00:00.000Z');
    const store = new SelectionPresetStore({ rootDirectory, now: () => now });
    await store.initialize();

    const first = await store.create(input());
    now = new Date('2026-07-15T01:00:00.000Z');
    const repeated = await store.create(
      input({ includedOperationIds: ['operation_a', 'operation_c'] }),
    );
    expect(repeated).toEqual({ preset: first.preset, created: false });

    await expect(
      store.create(input({ includedOperationIds: ['operation_b'] })),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SELECTION_PRESET_CONFLICT',
    });
  });

  it('lists exact and stale revisions only within the requested source scope', async () => {
    let hour = 0;
    const store = new SelectionPresetStore({
      rootDirectory,
      now: () => new Date(`2026-07-15T0${hour++}:00:00.000Z`),
    });
    await store.initialize();
    const stale = await store.create(input({ name: 'Old revision' }));
    const exact = await store.create(
      input({ name: 'Current revision', analysisFingerprint: ANALYSIS_B }),
    );
    await store.create(input({ sourceScopeKey: 'another-api.yaml', name: 'Other source' }));

    const listed = await store.list(stale.preset.sourceScopeId, ANALYSIS_B);
    expect(listed.map(({ id, compatibility }) => ({ id, compatibility }))).toEqual([
      { id: exact.preset.id, compatibility: 'exact' },
      { id: stale.preset.id, compatibility: 'stale' },
    ]);
    expect(listed.map(({ includedOperationCount }) => includedOperationCount)).toEqual([2, 2]);
    expect(listed.every((preset) => !('includedOperationIds' in preset))).toBe(true);
    await expect(
      store.getExact(
        exact.preset.sourceScopeId,
        exact.preset.id,
        exact.preset.analysisFingerprint,
        exact.preset.selectionFingerprint,
      ),
    ).resolves.toEqual(exact.preset);
    await expect(
      store.getExact(
        exact.preset.sourceScopeId,
        exact.preset.id,
        ANALYSIS_A,
        exact.preset.selectionFingerprint,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'SELECTION_PRESET_STALE' });
    await expect(
      store.getExact(
        exact.preset.sourceScopeId,
        exact.preset.id,
        exact.preset.analysisFingerprint,
        fingerprint({ selection: 'changed' }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'SELECTION_PRESET_CHANGED' });
    await expect(
      store.getForReview(
        stale.preset.sourceScopeId,
        stale.preset.id,
        stale.preset.selectionFingerprint,
      ),
    ).resolves.toEqual(stale.preset);
    await expect(
      store.getForReview(
        stale.preset.sourceScopeId,
        stale.preset.id,
        fingerprint({ selection: 'changed-for-review' }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'SELECTION_PRESET_CHANGED' });
    expect(
      await store.list(
        selectionPresetSourceScopeId('http-manifest', 'http-manifest', 'unknown-api'),
        ANALYSIS_B,
      ),
    ).toEqual([]);
  });

  it('keeps list metadata bounded and loads one large exact allowlist only on demand', async () => {
    const store = new SelectionPresetStore({ rootDirectory });
    await store.initialize();
    const operationIds = Array.from(
      { length: 10_000 },
      (_, index) => `operation_${String(index).padStart(5, '0')}`,
    );
    const created = await store.create(
      input({
        sourceOperationCount: operationIds.length,
        includedOperationIds: operationIds,
      }),
    );

    const listed = await store.list(created.preset.sourceScopeId, ANALYSIS_A);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ includedOperationCount: operationIds.length });
    expect(JSON.stringify(listed)).not.toContain('operation_00000');
    expect(Buffer.byteLength(JSON.stringify(listed), 'utf8')).toBeLessThan(2_048);

    const detail = await store.getExact(
      created.preset.sourceScopeId,
      created.preset.id,
      created.preset.analysisFingerprint,
      created.preset.selectionFingerprint,
    );
    expect(detail.includedOperationIds).toHaveLength(operationIds.length);
  });

  it('serializes concurrent creates so the configurable per-source limit is exact', async () => {
    const store = new SelectionPresetStore({
      rootDirectory,
      limits: { maxPresetsPerSource: 1 },
    });
    await store.initialize();

    const settled = await Promise.allSettled([
      store.create(input({ name: 'First' })),
      store.create(input({ name: 'Second' })),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'SELECTION_PRESET_LIMIT_REACHED' },
    });
  });

  it.each([
    ['control character', 'Unsafe\nname'],
    ['bidi control', 'Unsafe\u202ename'],
    ['empty after normalization', '　'],
  ])('rejects a %s in the normalized display name', async (_case, name) => {
    const store = new SelectionPresetStore({ rootDirectory });
    await store.initialize();
    await expect(store.create(input({ name }))).rejects.toMatchObject({ status: 422 });
  });

  it('enforces configurable UTF-8, identifier, item-count and artifact limits', async () => {
    const nameStore = new SelectionPresetStore({
      rootDirectory,
      limits: { maxPresetNameBytes: 4 },
    });
    await nameStore.initialize();
    await expect(nameStore.create(input({ name: '가나다' }))).rejects.toMatchObject({
      status: 422,
      code: 'SELECTION_PRESET_NAME_INVALID',
    });

    const identifierRoot = await mkdtemp(join(tmpdir(), 'hi-mcp-selection-preset-id-'));
    try {
      const identifierStore = new SelectionPresetStore({
        rootDirectory: identifierRoot,
        limits: { maxIdentifierBytes: 4 },
      });
      await identifierStore.initialize();
      await expect(identifierStore.create(input())).rejects.toMatchObject({
        status: 422,
        code: 'SELECTION_PRESET_INVALID',
      });
    } finally {
      await rm(identifierRoot, { recursive: true, force: true });
    }

    const itemRoot = await mkdtemp(join(tmpdir(), 'hi-mcp-selection-preset-items-'));
    try {
      const itemStore = new SelectionPresetStore({
        rootDirectory: itemRoot,
        limits: { maxIncludedOperationIds: 1 },
      });
      await itemStore.initialize();
      await expect(itemStore.create(input())).rejects.toMatchObject({
        status: 422,
        code: 'SELECTION_PRESET_LIMIT_EXCEEDED',
      });
    } finally {
      await rm(itemRoot, { recursive: true, force: true });
    }

    const artifactRoot = await mkdtemp(join(tmpdir(), 'hi-mcp-selection-preset-artifact-'));
    try {
      const artifactStore = new SelectionPresetStore({
        rootDirectory: artifactRoot,
        limits: { maxArtifactBytes: 64 },
      });
      await artifactStore.initialize();
      await expect(artifactStore.create(input())).rejects.toMatchObject({
        status: 422,
        code: 'SELECTION_PRESET_LIMIT_EXCEEDED',
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('rejects duplicate exact IDs and unexpected fields such as raw source material', async () => {
    const store = new SelectionPresetStore({ rootDirectory });
    await store.initialize();
    await expect(
      store.create(input({ includedOperationIds: ['operation_a', 'operation_a'] })),
    ).rejects.toMatchObject({ status: 422, code: 'SELECTION_PRESET_INVALID' });
    await expect(
      store.create({ ...input(), rawSource: 'secret' } as CreateSelectionPresetInput),
    ).rejects.toMatchObject({ status: 422, code: 'SELECTION_PRESET_INVALID' });
  });

  it.each(['symlink', 'hardlink', 'oversize', 'public-mode', 'fingerprint'])(
    'rejects a tampered %s artifact before deletion',
    async (tamper) => {
      const store = new SelectionPresetStore({
        rootDirectory,
        limits: { maxArtifactBytes: 2_048 },
      });
      await store.initialize();
      const created = await store.create(input());
      const presetPath = join(
        rootDirectory,
        'selection-presets',
        created.preset.sourceScopeId,
        created.preset.id,
        'preset.json',
      );
      const auxiliary = join(rootDirectory, `tamper-${tamper}`);

      if (tamper === 'symlink') {
        await rename(presetPath, auxiliary);
        await symlink(auxiliary, presetPath);
      } else if (tamper === 'hardlink') {
        await link(presetPath, auxiliary);
      } else if (tamper === 'oversize') {
        await writeFile(presetPath, 'x'.repeat(2_049), { mode: 0o600 });
      } else if (tamper === 'public-mode') {
        await chmod(presetPath, 0o644);
      } else {
        const record = JSON.parse(await readFile(presetPath, 'utf8')) as Record<string, unknown>;
        record['name'] = 'Tampered';
        await writeFile(presetPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      }

      await expect(
        store.getExact(
          created.preset.sourceScopeId,
          created.preset.id,
          created.preset.analysisFingerprint,
          created.preset.selectionFingerprint,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'SELECTION_PRESET_INVALID' });
      await expect(
        store.delete(created.preset.sourceScopeId, created.preset.id),
      ).rejects.toMatchObject({ status: 409, code: 'SELECTION_PRESET_INVALID' });

      if (tamper === 'hardlink') await unlink(auxiliary);
      expect((await lstat(presetPath)).isFile() || (await lstat(presetPath)).isSymbolicLink()).toBe(
        true,
      );
    },
  );

  it('deletes through a scope-bound atomic path and reports typed not-found errors', async () => {
    const store = new SelectionPresetStore({ rootDirectory });
    await store.initialize();
    const created = await store.create(input());

    await expect(store.delete(created.preset.sourceScopeId, created.preset.id)).resolves.toBe(true);
    await expect(
      store.delete(created.preset.sourceScopeId, created.preset.id),
    ).rejects.toMatchObject({
      status: 404,
      code: 'SELECTION_PRESET_NOT_FOUND',
    });
    await expect(store.delete('../escape', created.preset.id)).rejects.toMatchObject({
      status: 404,
      code: 'SELECTION_PRESET_NOT_FOUND',
    });
  });
});
