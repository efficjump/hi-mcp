import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fingerprint, stableId } from '@hi-mcp/capability-ir';
import { z } from 'zod';

import { HttpError } from './http-error.js';

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const ADAPTER_OR_SOURCE_KIND = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SOURCE_SCOPE_ID = /^selection_scope_[a-f0-9]{24}$/;
const PRESET_ID = /^selection_preset_[a-f0-9]{24}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface SelectionPresetStoreLimits {
  readonly maxPresetsPerSource: number;
  readonly maxPresetNameBytes: number;
  readonly maxIdentifierBytes: number;
  readonly maxIncludedOperationIds: number;
  readonly maxArtifactBytes: number;
}

export const DEFAULT_SELECTION_PRESET_STORE_LIMITS: SelectionPresetStoreLimits = Object.freeze({
  maxPresetsPerSource: 64,
  maxPresetNameBytes: 256,
  maxIdentifierBytes: 1_024,
  maxIncludedOperationIds: 100_000,
  maxArtifactBytes: 8 * 1_024 * 1_024,
});

export interface SelectionPresetStoreOptions {
  /** Console data root. Presets are placed below its selection-presets directory. */
  readonly rootDirectory: string;
  readonly limits?: Partial<SelectionPresetStoreLimits>;
  readonly now?: () => Date;
}

export interface CreateSelectionPresetInput {
  /** Used only to derive the scope ID and never persisted. */
  readonly sourceScopeKey: string;
  readonly name: string;
  readonly adapterId: string;
  readonly sourceKind: string;
  readonly analysisFingerprint: string;
  readonly documentFingerprint: string;
  readonly sourceOperationCount: number;
  readonly includedOperationIds: readonly string[];
}

export interface SelectionPresetRecord {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly sourceScopeId: string;
  readonly name: string;
  readonly adapterId: string;
  readonly sourceKind: string;
  readonly analysisFingerprint: string;
  readonly documentFingerprint: string;
  readonly sourceOperationCount: number;
  readonly includedOperationIds: readonly string[];
  readonly selectionFingerprint: string;
  readonly createdAt: string;
  readonly recordFingerprint: string;
}

export interface SelectionPresetListRecord {
  readonly id: string;
  readonly sourceScopeId: string;
  readonly name: string;
  readonly adapterId: string;
  readonly sourceKind: string;
  readonly analysisFingerprint: string;
  readonly documentFingerprint: string;
  readonly sourceOperationCount: number;
  readonly includedOperationCount: number;
  readonly selectionFingerprint: string;
  readonly createdAt: string;
  readonly compatibility: 'exact' | 'stale';
}

export interface CreateSelectionPresetResult {
  readonly preset: SelectionPresetRecord;
  readonly created: boolean;
}

const CreateSelectionPresetInputSchema = z
  .object({
    sourceScopeKey: z.string().min(1),
    name: z.string().min(1),
    adapterId: z.string().min(1).max(128).regex(ADAPTER_OR_SOURCE_KIND),
    sourceKind: z.string().min(1).max(128).regex(ADAPTER_OR_SOURCE_KIND),
    analysisFingerprint: z.string().regex(FINGERPRINT),
    documentFingerprint: z.string().regex(FINGERPRINT),
    sourceOperationCount: z.number().int().positive(),
    includedOperationIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const SelectionPresetRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().regex(PRESET_ID),
    sourceScopeId: z.string().regex(SOURCE_SCOPE_ID),
    name: z.string().min(1),
    adapterId: z.string().min(1).max(128).regex(ADAPTER_OR_SOURCE_KIND),
    sourceKind: z.string().min(1).max(128).regex(ADAPTER_OR_SOURCE_KIND),
    analysisFingerprint: z.string().regex(FINGERPRINT),
    documentFingerprint: z.string().regex(FINGERPRINT),
    sourceOperationCount: z.number().int().positive(),
    includedOperationIds: z.array(z.string().min(1)).min(1),
    selectionFingerprint: z.string().regex(FINGERPRINT),
    createdAt: z.string().datetime({ offset: true }),
    recordFingerprint: z.string().regex(FINGERPRINT),
  })
  .strict()
  .superRefine((record, context) => {
    if (normalizePresetName(record.name) !== record.name) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Preset name is not normalized.',
      });
    }
    if (hasUnsafeText(record.name)) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Preset name contains a control character.',
      });
    }
    if (!isStrictlySortedAndUnique(record.includedOperationIds)) {
      context.addIssue({
        code: 'custom',
        path: ['includedOperationIds'],
        message: 'Operation IDs must be sorted and unique.',
      });
    }
    if (record.includedOperationIds.length > record.sourceOperationCount) {
      context.addIssue({
        code: 'custom',
        path: ['includedOperationIds'],
        message: 'The selection exceeds the source operation count.',
      });
    }
    if (
      record.selectionFingerprint !==
      selectionPresetSelectionFingerprint(
        record.analysisFingerprint,
        record.sourceOperationCount,
        record.includedOperationIds,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selectionFingerprint'],
        message: 'Selection fingerprint does not match the preset contents.',
      });
    }
    if (
      record.id !== selectionPresetId(record.sourceScopeId, record.analysisFingerprint, record.name)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Preset ID does not match the preset identity.',
      });
    }
    const { recordFingerprint, ...material } = record;
    if (recordFingerprint !== fingerprint(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordFingerprint'],
        message: 'Record fingerprint does not match the preset contents.',
      });
    }
  });

function normalizePresetName(value: string): string {
  return value.normalize('NFKC').trim();
}

function hasUnsafeText(value: string): boolean {
  return CONTROL_CHARACTER.test(value) || BIDI_CONTROL.test(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStrictlySortedAndUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareStrings(values[index - 1]!, value) < 0,
  );
}

function assertPositiveLimit(value: number, name: keyof SelectionPresetStoreLimits): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function resolveLimits(
  limits: Partial<SelectionPresetStoreLimits> | undefined,
): SelectionPresetStoreLimits {
  const merged = { ...DEFAULT_SELECTION_PRESET_STORE_LIMITS, ...limits };
  return {
    maxPresetsPerSource: assertPositiveLimit(merged.maxPresetsPerSource, 'maxPresetsPerSource'),
    maxPresetNameBytes: assertPositiveLimit(merged.maxPresetNameBytes, 'maxPresetNameBytes'),
    maxIdentifierBytes: assertPositiveLimit(merged.maxIdentifierBytes, 'maxIdentifierBytes'),
    maxIncludedOperationIds: assertPositiveLimit(
      merged.maxIncludedOperationIds,
      'maxIncludedOperationIds',
    ),
    maxArtifactBytes: assertPositiveLimit(merged.maxArtifactBytes, 'maxArtifactBytes'),
  };
}

function assertFingerprint(value: string, kind: string): void {
  if (!FINGERPRINT.test(value)) {
    throw new HttpError(400, 'SELECTION_PRESET_QUERY_INVALID', `${kind}이(가) 유효하지 않습니다.`);
  }
}

function assertScopeId(value: string): void {
  if (!SOURCE_SCOPE_ID.test(value)) {
    throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
  }
}

function assertPresetId(value: string): void {
  if (!PRESET_ID.test(value)) {
    throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function requireManagedDirectory(path: string, code: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HttpError(409, code, '선택 프리셋 저장소 경계가 유효하지 않습니다.');
  }
}

async function requirePrivateDirectory(path: string, code: string): Promise<void> {
  await requireManagedDirectory(path, code);
  const stat = await lstat(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new HttpError(409, code, '선택 프리셋 저장소 권한이 안전하지 않습니다.');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateJson(path: string, maxArtifactBytes: number): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new HttpError(
        409,
        'SELECTION_PRESET_INVALID',
        '심볼릭 링크 선택 프리셋은 허용되지 않습니다.',
      );
    }
    if (code === 'ENOENT') {
      throw new HttpError(409, 'SELECTION_PRESET_INVALID', '선택 프리셋 파일이 없습니다.');
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= 0 ||
      stat.size > maxArtifactBytes
    ) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_INVALID',
        '저장된 선택 프리셋이 유효하지 않습니다.',
      );
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== buffer.length) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_INVALID',
        '저장된 선택 프리셋을 완전히 읽지 못했습니다.',
      );
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new HttpError(409, 'SELECTION_PRESET_INVALID', '선택 프리셋 JSON이 손상되었습니다.');
    }
    throw error;
  } finally {
    await handle.close();
  }
}

/** Derives a discovery scope without persisting the raw source ID. */
export function selectionPresetSourceScopeId(
  adapterId: string,
  sourceKind: string,
  sourceScopeKey: string,
): string {
  const normalizedScopeKey = sourceScopeKey.normalize('NFKC').trim();
  if (
    !ADAPTER_OR_SOURCE_KIND.test(adapterId) ||
    !ADAPTER_OR_SOURCE_KIND.test(sourceKind) ||
    normalizedScopeKey.length === 0 ||
    hasUnsafeText(normalizedScopeKey)
  ) {
    throw new TypeError('Selection preset scope input is invalid.');
  }
  return stableId('selection_scope', { adapterId, sourceKind, sourceScopeKey: normalizedScopeKey });
}

export function selectionPresetId(
  sourceScopeId: string,
  analysisFingerprint: string,
  normalizedName: string,
): string {
  if (
    !SOURCE_SCOPE_ID.test(sourceScopeId) ||
    !FINGERPRINT.test(analysisFingerprint) ||
    normalizedName.length === 0 ||
    normalizePresetName(normalizedName) !== normalizedName ||
    hasUnsafeText(normalizedName)
  ) {
    throw new TypeError('Selection preset identity input is invalid.');
  }
  return stableId('selection_preset', sourceScopeId, analysisFingerprint, normalizedName);
}

export function selectionPresetSelectionFingerprint(
  analysisFingerprint: string,
  sourceOperationCount: number,
  includedOperationIds: readonly string[],
): string {
  return fingerprint({ analysisFingerprint, sourceOperationCount, includedOperationIds });
}

function recordIdentityFingerprint(record: SelectionPresetRecord): string {
  const { createdAt: _createdAt, recordFingerprint: _recordFingerprint, ...identity } = record;
  return fingerprint(identity);
}

export class SelectionPresetStore {
  readonly #requestedRoot: string;
  readonly #limits: SelectionPresetStoreLimits;
  readonly #now: () => Date;
  readonly #scopeQueues = new Map<string, Promise<void>>();
  #root: string | undefined;

  constructor(options: SelectionPresetStoreOptions) {
    this.#requestedRoot = resolve(options.rootDirectory);
    this.#limits = resolveLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
  }

  get limits(): SelectionPresetStoreLimits {
    return this.#limits;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#requestedRoot, { recursive: true, mode: 0o700 });
    await requireManagedDirectory(this.#requestedRoot, 'SELECTION_PRESET_STORE_INVALID');
    await chmod(this.#requestedRoot, 0o700);
    this.#root = await realpath(this.#requestedRoot);

    let created = false;
    try {
      await mkdir(this.presetsDirectory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await requireManagedDirectory(this.presetsDirectory, 'SELECTION_PRESET_STORE_INVALID');
    await chmod(this.presetsDirectory, 0o700);
    if (created) await syncDirectory(this.root);
  }

  async create(inputValue: CreateSelectionPresetInput): Promise<CreateSelectionPresetResult> {
    const parsed = CreateSelectionPresetInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      throw new HttpError(422, 'SELECTION_PRESET_INVALID', '선택 프리셋 입력이 유효하지 않습니다.');
    }
    const input = parsed.data;
    if (hasUnsafeText(input.name)) {
      throw new HttpError(
        422,
        'SELECTION_PRESET_NAME_INVALID',
        '선택 프리셋 이름에 제어 문자를 사용할 수 없습니다.',
      );
    }
    const name = normalizePresetName(input.name);
    if (
      name.length === 0 ||
      hasUnsafeText(name) ||
      byteLength(name) > this.#limits.maxPresetNameBytes
    ) {
      throw new HttpError(
        422,
        'SELECTION_PRESET_NAME_INVALID',
        '선택 프리셋 이름이 비어 있거나 허용된 크기를 초과했습니다.',
      );
    }
    if (
      byteLength(input.sourceScopeKey) > this.#limits.maxIdentifierBytes ||
      hasUnsafeText(input.sourceScopeKey) ||
      input.includedOperationIds.some(
        (id) => byteLength(id) > this.#limits.maxIdentifierBytes || hasUnsafeText(id),
      )
    ) {
      throw new HttpError(
        422,
        'SELECTION_PRESET_INVALID',
        '선택 프리셋 식별자가 유효하지 않습니다.',
      );
    }
    if (input.includedOperationIds.length > this.#limits.maxIncludedOperationIds) {
      throw new HttpError(
        422,
        'SELECTION_PRESET_LIMIT_EXCEEDED',
        '선택한 작업 수가 프리셋 저장 한도를 초과했습니다.',
      );
    }
    const includedOperationIds = [...input.includedOperationIds].sort(compareStrings);
    if (
      new Set(includedOperationIds).size !== includedOperationIds.length ||
      includedOperationIds.length > input.sourceOperationCount
    ) {
      throw new HttpError(
        422,
        'SELECTION_PRESET_INVALID',
        '선택 프리셋 작업 목록이 유효하지 않습니다.',
      );
    }

    const sourceScopeId = selectionPresetSourceScopeId(
      input.adapterId,
      input.sourceKind,
      input.sourceScopeKey,
    );
    const id = selectionPresetId(sourceScopeId, input.analysisFingerprint, name);
    const selectionFingerprint = selectionPresetSelectionFingerprint(
      input.analysisFingerprint,
      input.sourceOperationCount,
      includedOperationIds,
    );
    const createdAt = this.#now().toISOString();
    const material = {
      schemaVersion: '1.0' as const,
      id,
      sourceScopeId,
      name,
      adapterId: input.adapterId,
      sourceKind: input.sourceKind,
      analysisFingerprint: input.analysisFingerprint,
      documentFingerprint: input.documentFingerprint,
      sourceOperationCount: input.sourceOperationCount,
      includedOperationIds,
      selectionFingerprint,
      createdAt,
    };
    const candidate = SelectionPresetRecordSchema.parse({
      ...material,
      recordFingerprint: fingerprint(material),
    });
    this.assertRecordLimits(candidate);

    return this.withScopeLock(sourceScopeId, async () => {
      const scopeDirectory = await this.ensureScopeDirectory(sourceScopeId);
      const destination = join(scopeDirectory, id);
      const existing = await this.loadIfPresent(sourceScopeId, id);
      if (existing !== undefined) return this.resolveExisting(candidate, existing);

      const entries = await readdir(scopeDirectory, { withFileTypes: true });
      const count = entries.filter((entry) => PRESET_ID.test(entry.name)).length;
      if (count >= this.#limits.maxPresetsPerSource) {
        throw new HttpError(
          409,
          'SELECTION_PRESET_LIMIT_REACHED',
          '이 API 원본에 저장할 수 있는 선택 프리셋 수를 초과했습니다.',
        );
      }

      const temporary = await mkdtemp(join(scopeDirectory, '.preset-'));
      await chmod(temporary, 0o700);
      await requirePrivateDirectory(temporary, 'SELECTION_PRESET_STORE_INVALID');
      try {
        const serialized = json(candidate);
        if (byteLength(serialized) > this.#limits.maxArtifactBytes) {
          throw new HttpError(
            422,
            'SELECTION_PRESET_LIMIT_EXCEEDED',
            '선택 프리셋 아티팩트가 저장 한도를 초과했습니다.',
          );
        }
        await writePrivateFile(join(temporary, 'preset.json'), serialized);
        await syncDirectory(temporary);
        try {
          await rename(temporary, destination);
          await syncDirectory(scopeDirectory);
          return { preset: candidate, created: true };
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
          }
          const raced = await this.load(sourceScopeId, id);
          return this.resolveExisting(candidate, raced);
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  async list(
    sourceScopeId: string,
    currentAnalysisFingerprint: string,
  ): Promise<readonly SelectionPresetListRecord[]> {
    assertScopeId(sourceScopeId);
    assertFingerprint(currentAnalysisFingerprint, '분석 fingerprint');
    const scopeDirectory = this.scopeDirectory(sourceScopeId);
    try {
      await requirePrivateDirectory(scopeDirectory, 'SELECTION_PRESET_STORE_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = await readdir(scopeDirectory, { withFileTypes: true });
    const presets: SelectionPresetListRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PRESET_ID.test(entry.name)) continue;
      try {
        const preset = await this.load(sourceScopeId, entry.name);
        presets.push({
          id: preset.id,
          sourceScopeId: preset.sourceScopeId,
          name: preset.name,
          adapterId: preset.adapterId,
          sourceKind: preset.sourceKind,
          analysisFingerprint: preset.analysisFingerprint,
          documentFingerprint: preset.documentFingerprint,
          sourceOperationCount: preset.sourceOperationCount,
          includedOperationCount: preset.includedOperationIds.length,
          selectionFingerprint: preset.selectionFingerprint,
          createdAt: preset.createdAt,
          compatibility:
            preset.analysisFingerprint === currentAnalysisFingerprint ? 'exact' : 'stale',
        });
      } catch (error) {
        if (error instanceof HttpError) continue;
        throw error;
      }
    }
    return presets.sort(
      (left, right) =>
        compareStrings(right.createdAt, left.createdAt) || compareStrings(left.id, right.id),
    );
  }

  async getExact(
    sourceScopeId: string,
    presetId: string,
    expectedAnalysisFingerprint: string,
    expectedSelectionFingerprint: string,
  ): Promise<SelectionPresetRecord> {
    assertScopeId(sourceScopeId);
    assertPresetId(presetId);
    assertFingerprint(expectedAnalysisFingerprint, '분석 fingerprint');
    assertFingerprint(expectedSelectionFingerprint, '선택 fingerprint');
    try {
      await requirePrivateDirectory(
        this.scopeDirectory(sourceScopeId),
        'SELECTION_PRESET_STORE_INVALID',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
      }
      throw error;
    }
    const preset = await this.load(sourceScopeId, presetId);
    if (preset.analysisFingerprint !== expectedAnalysisFingerprint) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_STALE',
        '이 선택 프리셋은 현재 분석에 적용할 수 없습니다.',
      );
    }
    if (preset.selectionFingerprint !== expectedSelectionFingerprint) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_CHANGED',
        '선택 프리셋 목록을 새로고침한 뒤 다시 적용하세요.',
      );
    }
    return preset;
  }

  /** Loads one verified snapshot for explicit review against a newer source revision. */
  async getForReview(
    sourceScopeId: string,
    presetId: string,
    expectedSelectionFingerprint: string,
  ): Promise<SelectionPresetRecord> {
    assertScopeId(sourceScopeId);
    assertPresetId(presetId);
    assertFingerprint(expectedSelectionFingerprint, '선택 fingerprint');
    try {
      await requirePrivateDirectory(
        this.scopeDirectory(sourceScopeId),
        'SELECTION_PRESET_STORE_INVALID',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
      }
      throw error;
    }
    const preset = await this.load(sourceScopeId, presetId);
    if (preset.selectionFingerprint !== expectedSelectionFingerprint) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_CHANGED',
        '선택 프리셋 목록을 새로고침한 뒤 다시 검토하세요.',
      );
    }
    return preset;
  }

  async delete(sourceScopeId: string, presetId: string): Promise<boolean> {
    assertScopeId(sourceScopeId);
    assertPresetId(presetId);
    return this.withScopeLock(sourceScopeId, async () => {
      const scopeDirectory = this.scopeDirectory(sourceScopeId);
      try {
        await requirePrivateDirectory(scopeDirectory, 'SELECTION_PRESET_STORE_INVALID');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
        }
        throw error;
      }
      await this.load(sourceScopeId, presetId);
      const destination = join(scopeDirectory, presetId);
      const tombstone = join(scopeDirectory, `.deleting-${randomUUID()}`);
      try {
        await rename(destination, tombstone);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
        }
        throw error;
      }
      await syncDirectory(scopeDirectory);
      await rm(tombstone, { recursive: true, force: false });
      await syncDirectory(scopeDirectory);
      return true;
    });
  }

  private get root(): string {
    if (this.#root === undefined) throw new Error('Selection preset store is not initialized.');
    return this.#root;
  }

  private get presetsDirectory(): string {
    return join(this.root, 'selection-presets');
  }

  private scopeDirectory(sourceScopeId: string): string {
    assertScopeId(sourceScopeId);
    return join(this.presetsDirectory, sourceScopeId);
  }

  private async ensureScopeDirectory(sourceScopeId: string): Promise<string> {
    const directory = this.scopeDirectory(sourceScopeId);
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await requirePrivateDirectory(directory, 'SELECTION_PRESET_STORE_INVALID');
    if (created) await syncDirectory(this.presetsDirectory);
    return directory;
  }

  private async loadIfPresent(
    sourceScopeId: string,
    presetId: string,
  ): Promise<SelectionPresetRecord | undefined> {
    try {
      return await this.load(sourceScopeId, presetId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async load(sourceScopeId: string, presetId: string): Promise<SelectionPresetRecord> {
    const scopeDirectory = this.scopeDirectory(sourceScopeId);
    const directory = join(scopeDirectory, presetId);
    assertPresetId(presetId);
    try {
      await requirePrivateDirectory(directory, 'SELECTION_PRESET_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'SELECTION_PRESET_NOT_FOUND', '선택 프리셋을 찾을 수 없습니다.');
      }
      throw error;
    }
    const parsed = SelectionPresetRecordSchema.safeParse(
      await readPrivateJson(join(directory, 'preset.json'), this.#limits.maxArtifactBytes),
    );
    if (!parsed.success) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_INVALID',
        '저장된 선택 프리셋이 유효하지 않습니다.',
      );
    }
    this.assertRecordLimits(parsed.data);
    if (parsed.data.sourceScopeId !== sourceScopeId || parsed.data.id !== presetId) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_ID_MISMATCH',
        '선택 프리셋 저장 경로와 ID가 일치하지 않습니다.',
      );
    }
    return parsed.data;
  }

  private assertRecordLimits(record: SelectionPresetRecord): void {
    if (
      byteLength(record.name) > this.#limits.maxPresetNameBytes ||
      record.includedOperationIds.length > this.#limits.maxIncludedOperationIds ||
      record.includedOperationIds.some(
        (id) => byteLength(id) > this.#limits.maxIdentifierBytes || hasUnsafeText(id),
      )
    ) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_INVALID',
        '저장된 선택 프리셋이 현재 저장 한도를 초과했습니다.',
      );
    }
  }

  private resolveExisting(
    candidate: SelectionPresetRecord,
    existing: SelectionPresetRecord,
  ): CreateSelectionPresetResult {
    if (recordIdentityFingerprint(candidate) !== recordIdentityFingerprint(existing)) {
      throw new HttpError(
        409,
        'SELECTION_PRESET_CONFLICT',
        '같은 이름의 선택 프리셋에 다른 작업 선택이 이미 저장되어 있습니다.',
      );
    }
    return { preset: existing, created: false };
  }

  private async withScopeLock<T>(sourceScopeId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#scopeQueues.get(sourceScopeId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.#scopeQueues.set(sourceScopeId, queued);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release?.();
      if (this.#scopeQueues.get(sourceScopeId) === queued) this.#scopeQueues.delete(sourceScopeId);
    }
  }
}
