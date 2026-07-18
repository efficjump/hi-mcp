import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  chmod,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  fingerprint as contentFingerprint,
  type NormalizedApiDocument,
  type Release,
} from '@hi-mcp/capability-ir';
import {
  createConnectionProfile,
  deriveApprovedOrigins,
  deriveCredentialBindings,
  exportMcpServersDescriptor,
  parseConnectionProfile,
  verifyConnectionProfileRelease,
  type ConnectionProfile,
  type CredentialBinding,
  type McpServersDescriptor,
} from '@hi-mcp/cli';
import { verifyRelease } from '@hi-mcp/deterministic-verifier';
import { z } from 'zod';

import type {
  CapabilitySummary,
  ConnectionRequest,
  ConnectionResponse,
  ConsoleDiagnostic,
  CredentialBindingView,
  RegistrationDetail,
  RegistrationSummary,
} from '../shared/contracts.js';
import { HttpError } from './http-error.js';

const ARTIFACT_BYTES = 16 * 1_024 * 1024;
const SAFE_ID = /^[a-z][a-z0-9_-]{0,127}$/;
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RegistrationMetadataMaterialSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    adapterId: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    sourceFilename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\u0000-\u001f\u007f\\/]+$/u),
    title: z.string().min(1),
    sourceKind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    sourceVersion: z.string().min(1).optional(),
    sourceOperationCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const RegistrationMetadataSchema = RegistrationMetadataMaterialSchema.extend({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
  .strict()
  .superRefine((metadata, context) => {
    const { fingerprint, ...material } = metadata;
    if (fingerprint !== contentFingerprint(material)) {
      context.addIssue({
        code: 'custom',
        path: ['fingerprint'],
        message: 'Registration metadata fingerprint does not match its contents.',
      });
    }
  });

type RegistrationMetadata = z.infer<typeof RegistrationMetadataSchema>;

export interface ArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly nodePath: string;
  readonly cliEntryPath: string;
}

export interface PersistRegistrationInput {
  readonly sourceFilename: string;
  readonly adapterId: string;
  readonly release: Release;
  readonly document: NormalizedApiDocument;
}

interface LoadedRegistration {
  readonly directory: string;
  readonly releasePath: string;
  readonly release: Release;
  readonly metadata: RegistrationMetadata;
}

function assertSafeId(value: string, kind: string): void {
  if (!SAFE_ID.test(value)) {
    throw new HttpError(404, `${kind.toUpperCase()}_NOT_FOUND`, `${kind}을(를) 찾을 수 없습니다.`);
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
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

async function readPrivateJson(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '아티팩트를 찾을 수 없습니다.');
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new HttpError(409, 'ARTIFACT_INVALID', '심볼릭 링크 아티팩트는 허용되지 않습니다.');
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > ARTIFACT_BYTES) {
      throw new HttpError(409, 'ARTIFACT_INVALID', '저장된 아티팩트가 유효하지 않습니다.');
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== buffer.length) {
      throw new HttpError(409, 'ARTIFACT_INVALID', '저장된 아티팩트를 완전히 읽지 못했습니다.');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '아티팩트를 찾을 수 없습니다.');
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new HttpError(409, 'ARTIFACT_INVALID', '저장된 JSON 아티팩트가 손상되었습니다.');
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function requireManagedDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HttpError(409, 'ARTIFACT_STORE_INVALID', '아티팩트 저장소 경계가 유효하지 않습니다.');
  }
}

function diagnosticCounts(
  diagnostics: readonly ConsoleDiagnostic[],
): RegistrationSummary['diagnosticCounts'] {
  return diagnostics.reduce(
    (counts, item) => ({ ...counts, [item.severity]: counts[item.severity] + 1 }),
    { info: 0, warning: 0, error: 0 },
  );
}

function credentialView(binding: CredentialBinding): CredentialBindingView {
  return {
    scheme: binding.scheme,
    location: binding.location,
    parameterName: binding.parameterName,
    ...(binding.prefix === undefined ? {} : { prefix: binding.prefix }),
    environmentVariable: binding.environmentVariable,
  };
}

function capabilityView(capability: Release['capabilities'][number]): CapabilitySummary {
  return {
    id: capability.id,
    name: capability.name,
    title: capability.title ?? capability.name,
    description: capability.description,
    method: capability.execution.method,
    path: capability.execution.pathTemplate,
    servers: capability.execution.servers.map((server) => server.resolvedUrl ?? server.template),
    authRequired: capability.auth.required,
    authSchemes: Object.keys(capability.auth.schemes).sort(),
    risk: {
      level: capability.risk.level,
      sideEffect: capability.risk.sideEffect,
      requiresConfirmation: capability.risk.requiresConfirmation,
    },
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    provenance: capability.provenance,
  };
}

function registrationSummary(loaded: LoadedRegistration): RegistrationSummary {
  const diagnostics = loaded.release.diagnostics as readonly ConsoleDiagnostic[];
  return {
    id: loaded.release.id,
    title: loaded.metadata.title,
    sourceKind: loaded.metadata.sourceKind,
    ...(loaded.metadata.sourceVersion === undefined
      ? {}
      : { sourceVersion: loaded.metadata.sourceVersion }),
    fingerprint: loaded.release.fingerprint,
    createdAt: loaded.release.createdAt,
    sourceFilename: loaded.metadata.sourceFilename,
    capabilityCount: loaded.release.capabilities.length,
    sourceOperationCount:
      loaded.metadata.sourceOperationCount ?? loaded.release.capabilities.length,
    origins: deriveApprovedOrigins(loaded.release),
    credentialBindings: deriveCredentialBindings(loaded.release).map(credentialView),
    diagnosticCounts: diagnosticCounts(diagnostics),
  };
}

export class ArtifactStore {
  readonly #requestedRoot: string;
  readonly #nodePath: string;
  readonly #cliEntryPath: string;
  #root: string | undefined;

  constructor(options: ArtifactStoreOptions) {
    this.#requestedRoot = resolve(options.rootDirectory);
    this.#nodePath = options.nodePath;
    this.#cliEntryPath = options.cliEntryPath;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#requestedRoot, { recursive: true, mode: 0o700 });
    await requireManagedDirectory(this.#requestedRoot);
    await chmod(this.#requestedRoot, 0o700);
    this.#root = await realpath(this.#requestedRoot);
    await mkdir(this.releasesDirectory, { recursive: true, mode: 0o700 });
    await requireManagedDirectory(this.releasesDirectory);
    await chmod(this.releasesDirectory, 0o700);
  }

  get displayDirectory(): string {
    return this.#requestedRoot;
  }

  private get root(): string {
    if (this.#root === undefined) throw new Error('Artifact store has not been initialized.');
    return this.#root;
  }

  private get releasesDirectory(): string {
    return join(this.root, 'releases');
  }

  private releaseDirectory(id: string): string {
    assertSafeId(id, 'release');
    return join(this.releasesDirectory, id);
  }

  async persistRegistration(input: PersistRegistrationInput): Promise<RegistrationDetail> {
    const verification = verifyRelease(input.release, { sourceDocuments: [input.document] });
    if (!verification.valid || verification.release === undefined) {
      throw new HttpError(
        422,
        'RELEASE_INVALID',
        '검증된 release를 만들지 못했습니다.',
        verification.diagnostics as readonly ConsoleDiagnostic[],
      );
    }
    const release = verification.release;
    const metadataMaterial = RegistrationMetadataMaterialSchema.parse({
      schemaVersion: '1.0',
      adapterId: input.adapterId,
      sourceFilename: input.sourceFilename,
      title: input.document.title,
      sourceKind: input.document.sourceKind,
      ...(input.document.sourceVersion === undefined
        ? {}
        : { sourceVersion: input.document.sourceVersion }),
      sourceOperationCount: input.document.operations.length,
    });
    const metadata = RegistrationMetadataSchema.parse({
      ...metadataMaterial,
      fingerprint: contentFingerprint(metadataMaterial),
    });
    const destination = this.releaseDirectory(release.id);
    const temporary = await mkdtemp(join(this.releasesDirectory, '.registration-'));
    await requireManagedDirectory(temporary);
    try {
      await writePrivateFile(join(temporary, 'release.json'), json(release));
      await writePrivateFile(join(temporary, 'metadata.json'), json(metadata));
      await mkdir(join(temporary, 'connections'), { mode: 0o700 });
      await syncDirectory(temporary);
      try {
        await rename(temporary, destination);
        await syncDirectory(this.releasesDirectory);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }
        const existing = await this.loadRegistration(release.id);
        if (existing.release.fingerprint !== release.fingerprint) {
          throw new HttpError(
            409,
            'RELEASE_COLLISION',
            '동일한 release ID에 다른 내용이 존재합니다.',
          );
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return this.getRegistration(release.id);
  }

  async listRegistrations(): Promise<readonly RegistrationSummary[]> {
    const entries = await readdir(this.releasesDirectory, { withFileTypes: true });
    const summaries: RegistrationSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_ID.test(entry.name)) continue;
      try {
        summaries.push(registrationSummary(await this.loadRegistration(entry.name)));
      } catch (error) {
        if (error instanceof HttpError) continue;
        throw error;
      }
    }
    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRegistration(id: string): Promise<RegistrationDetail> {
    const loaded = await this.loadRegistration(id);
    return {
      registration: registrationSummary(loaded),
      capabilities: loaded.release.capabilities.map(capabilityView),
      diagnostics: loaded.release.diagnostics as readonly ConsoleDiagnostic[],
      artifactUrls: { release: `/api/registrations/${encodeURIComponent(id)}/release.json` },
    };
  }

  async getReleaseArtifact(id: string): Promise<Release> {
    return (await this.loadRegistration(id)).release;
  }

  async createConnection(id: string, request: ConnectionRequest): Promise<ConnectionResponse> {
    const loaded = await this.loadRegistration(id);
    const expectedOrigins = deriveApprovedOrigins(loaded.release);
    const supplied = [...request.approvedOrigins];
    if (
      supplied.length !== expectedOrigins.length ||
      new Set(supplied).size !== supplied.length ||
      expectedOrigins.some((origin) => !supplied.includes(origin))
    ) {
      throw new HttpError(
        422,
        'ORIGIN_REVIEW_INCOMPLETE',
        'Release에서 파생된 모든 실행 origin을 각각 승인해야 합니다.',
      );
    }

    const derivedBindings = deriveCredentialBindings(loaded.release);
    const allowedOverrideKeys = new Set(derivedBindings.map((item) => item.environmentVariable));
    const unknownOverride = Object.keys(request.credentialEnvironment).find(
      (key) => !allowedOverrideKeys.has(key),
    );
    if (unknownOverride !== undefined) {
      throw new HttpError(422, 'CREDENTIAL_BINDING_INVALID', '알 수 없는 credential 항목입니다.');
    }
    const bindings = derivedBindings.map((binding) => {
      const environmentVariable =
        request.credentialEnvironment[binding.environmentVariable] ?? binding.environmentVariable;
      if (!ENVIRONMENT_VARIABLE.test(environmentVariable) || environmentVariable.length > 128) {
        throw new HttpError(
          422,
          'ENVIRONMENT_VARIABLE_INVALID',
          'Credential binding에는 유효한 환경 변수 이름 형식만 사용할 수 있습니다.',
        );
      }
      return { ...binding, environmentVariable };
    });

    const releasePath = relative(
      join(loaded.directory, 'connections', 'placeholder'),
      loaded.releasePath,
    );
    let profile: ConnectionProfile;
    try {
      profile = createConnectionProfile({
        displayName: request.displayName,
        ...(request.description === undefined || request.description === ''
          ? {}
          : { description: request.description }),
        release: loaded.release,
        releasePath,
        approvedOrigins: supplied,
        allowInsecureHttp: request.allowInsecureHttp,
        confirmation: request.confirmation,
        credentialBindings: bindings,
      });
      verifyConnectionProfileRelease(profile, loaded.release);
    } catch {
      throw new HttpError(
        422,
        'CONNECTION_POLICY_INVALID',
        'Origin, 인증 또는 확인 정책이 검증된 release 계약과 일치하지 않습니다.',
      );
    }

    const connectionsDirectory = join(loaded.directory, 'connections');
    await requireManagedDirectory(connectionsDirectory);
    const destination = join(connectionsDirectory, profile.id);
    const temporary = await mkdtemp(join(connectionsDirectory, '.connection-'));
    await requireManagedDirectory(temporary);
    const finalProfilePath = join(destination, 'profile.json');
    const descriptor = exportMcpServersDescriptor(profile, {
      nodePath: this.#nodePath,
      cliEntryPath: this.#cliEntryPath,
      profilePath: finalProfilePath,
    });
    try {
      await writePrivateFile(join(temporary, 'profile.json'), json(profile));
      await writePrivateFile(join(temporary, 'mcp.json'), json(descriptor));
      await syncDirectory(temporary);
      try {
        await rename(temporary, destination);
        await syncDirectory(connectionsDirectory);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }
        const existing = await this.loadConnection(loaded, profile.id);
        if (existing.profile.fingerprint !== profile.fingerprint) {
          throw new HttpError(
            409,
            'CONNECTION_COLLISION',
            '동일한 connection ID에 다른 내용이 존재합니다.',
          );
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return this.connectionResponse(id, profile, descriptor);
  }

  async getConnectionArtifact(
    releaseId: string,
    connectionId: string,
    kind: 'profile' | 'descriptor',
  ): Promise<ConnectionProfile | McpServersDescriptor> {
    const loaded = await this.loadRegistration(releaseId);
    const connection = await this.loadConnection(loaded, connectionId);
    return kind === 'profile' ? connection.profile : connection.descriptor;
  }

  private connectionResponse(
    releaseId: string,
    profile: ConnectionProfile,
    descriptor: McpServersDescriptor,
  ): ConnectionResponse {
    const base = `/api/registrations/${encodeURIComponent(releaseId)}/connections/${encodeURIComponent(profile.id)}`;
    return {
      profile: {
        id: profile.id,
        displayName: profile.displayName,
        fingerprint: profile.fingerprint,
        confirmation: profile.policy.confirmation,
      },
      descriptor,
      requiredEnvironmentVariables: [
        ...new Set(profile.credentialBindings.map((item) => item.environmentVariable)),
      ].sort(),
      artifactUrls: { profile: `${base}/profile.json`, descriptor: `${base}/mcp.json` },
    };
  }

  private async loadRegistration(id: string): Promise<LoadedRegistration> {
    const directory = this.releaseDirectory(id);
    try {
      await requireManagedDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'RELEASE_NOT_FOUND', '등록된 API를 찾을 수 없습니다.');
      }
      throw error;
    }
    const releasePath = join(directory, 'release.json');
    const releaseInput = await readPrivateJson(releasePath);
    const verification = verifyRelease(releaseInput);
    if (!verification.valid || verification.release === undefined) {
      throw new HttpError(409, 'RELEASE_INVALID', '저장된 release 검증에 실패했습니다.');
    }
    if (verification.release.id !== id) {
      throw new HttpError(
        409,
        'RELEASE_ID_MISMATCH',
        '저장 경로와 release ID가 일치하지 않습니다.',
      );
    }
    const metadata = RegistrationMetadataSchema.safeParse(
      await readPrivateJson(join(directory, 'metadata.json')),
    );
    if (!metadata.success) {
      throw new HttpError(409, 'METADATA_INVALID', '등록 메타데이터가 유효하지 않습니다.');
    }
    return { directory, releasePath, release: verification.release, metadata: metadata.data };
  }

  private async loadConnection(
    registration: LoadedRegistration,
    connectionId: string,
  ): Promise<{ readonly profile: ConnectionProfile; readonly descriptor: McpServersDescriptor }> {
    assertSafeId(connectionId, 'connection');
    const directory = join(registration.directory, 'connections', connectionId);
    try {
      await requireManagedDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'Connection profile을 찾을 수 없습니다.');
      }
      throw error;
    }
    let profile: ConnectionProfile;
    let descriptor: McpServersDescriptor;
    let expected: McpServersDescriptor;
    try {
      profile = parseConnectionProfile(await readPrivateJson(join(directory, 'profile.json')));
      if (profile.id !== connectionId) {
        throw new HttpError(
          409,
          'CONNECTION_ID_MISMATCH',
          '저장 경로와 connection ID가 일치하지 않습니다.',
        );
      }
      verifyConnectionProfileRelease(profile, registration.release);
      descriptor = (await readPrivateJson(join(directory, 'mcp.json'))) as McpServersDescriptor;
      expected = exportMcpServersDescriptor(profile, {
        nodePath: this.#nodePath,
        cliEntryPath: this.#cliEntryPath,
        profilePath: join(directory, 'profile.json'),
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'CONNECTION_INVALID', '저장된 connection 검증에 실패했습니다.');
    }
    if (JSON.stringify(descriptor) !== JSON.stringify(expected)) {
      throw new HttpError(409, 'DESCRIPTOR_INVALID', '저장된 MCP descriptor 검증에 실패했습니다.');
    }
    return { profile, descriptor };
  }
}
