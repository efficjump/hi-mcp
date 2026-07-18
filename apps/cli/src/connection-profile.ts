import {
  fingerprint as contentFingerprint,
  isWellFormedUnicode,
  stableId,
  type Release,
} from '@hi-mcp/capability-ir';
import { inspectVerificationInput, verifyRelease } from '@hi-mcp/deterministic-verifier';
import { z } from 'zod';

const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_PATH_LENGTH = 4_096;
const MAX_ORIGINS = 128;
const MAX_CREDENTIAL_BINDINGS = 128;
const MAX_SCHEME_NAME_LENGTH = 128;
const MAX_PARAMETER_NAME_LENGTH = 256;
const MAX_ENVIRONMENT_VARIABLE_LENGTH = 128;
const CREDENTIAL_NAMESPACE_HEX_LENGTH = 24;
const PROFILE_INPUT_LIMITS = Object.freeze({
  maxNodes: 2_048,
  maxDepth: 8,
  maxStringBytes: MAX_PATH_LENGTH,
  maxTotalStringBytes: 1_048_576,
  maxArrayItems: Math.max(MAX_ORIGINS, MAX_CREDENTIAL_BINDINGS),
  maxObjectProperties: 16,
});

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONNECTION_ID_PATTERN = /^connection_[a-f0-9]{24}$/;
const RELEASE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/;
const SECURITY_SCHEME_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QUERY_PARAMETER_NAME_PATTERN = /^[^\u0000-\u0020\u007f]+$/u;
const SAFE_SINGLE_LINE_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_DESCRIPTION_PATTERN = /^[^\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const TRANSPORT_CONTROLLED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
]);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bindingKey(binding: CredentialBinding): string {
  const parameterName =
    binding.location === 'header' ? binding.parameterName.toLowerCase() : binding.parameterName;
  return JSON.stringify([binding.scheme, binding.location, parameterName]);
}

function bindingContractKey(binding: CredentialBinding): string {
  return JSON.stringify([bindingKey(binding), binding.prefix ?? null]);
}

function addDuplicateAndOrderIssues<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
  context: z.core.$RefinementCtx<T[]>,
): void {
  const seen = new Map<string, number>();
  let previousKey: string | undefined;

  values.forEach((value, index) => {
    const key = keyFor(value);
    const previousIndex = seen.get(key);
    if (previousIndex !== undefined) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate entry; first declared at index ${previousIndex}.`,
        path: [index],
      });
    } else {
      seen.set(key, index);
    }
    if (previousKey !== undefined && compareText(previousKey, key) > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Entries must be in canonical ascending order.',
        path: [index],
      });
    }
    previousKey = key;
  });
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Approved origins must be absolute HTTP or HTTPS origins.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('Approved origins must use HTTP or HTTPS.');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError(
      'Approved origins cannot include credentials, paths, queries, or fragments.',
    );
  }
  return parsed.origin;
}

const SafePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(SAFE_SINGLE_LINE_PATTERN, 'Path contains unsafe control characters.');

const ApprovedOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    try {
      if (canonicalOrigin(value) !== value) {
        context.addIssue({
          code: 'custom',
          message: 'Origin must use its canonical URL representation.',
        });
      }
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid approved origin.',
      });
    }
  });

export const CredentialBindingSchema = z
  .object({
    scheme: z
      .string()
      .min(1)
      .max(MAX_SCHEME_NAME_LENGTH)
      .regex(SECURITY_SCHEME_NAME_PATTERN, 'Credential scheme name is unsafe.'),
    location: z.enum(['header', 'query', 'cookie']),
    parameterName: z.string().min(1).max(MAX_PARAMETER_NAME_LENGTH),
    prefix: z
      .string()
      .max(64)
      .regex(SAFE_SINGLE_LINE_PATTERN, 'Credential prefix contains unsafe control characters.')
      .optional(),
    environmentVariable: z
      .string()
      .min(1)
      .max(MAX_ENVIRONMENT_VARIABLE_LENGTH)
      .regex(ENVIRONMENT_VARIABLE_PATTERN, 'Environment variable name is unsafe.'),
  })
  .strict()
  .superRefine((binding, context) => {
    const pattern =
      binding.location === 'query' ? QUERY_PARAMETER_NAME_PATTERN : HTTP_HEADER_NAME_PATTERN;
    if (!pattern.test(binding.parameterName)) {
      context.addIssue({
        code: 'custom',
        message: `Unsafe ${binding.location} credential parameter name.`,
        path: ['parameterName'],
      });
    }
    if (binding.location === 'query' && !isWellFormedUnicode(binding.parameterName)) {
      context.addIssue({
        code: 'custom',
        message: 'Query credential parameter names cannot contain unpaired Unicode surrogates.',
        path: ['parameterName'],
      });
    }
    if (UNSAFE_OBJECT_KEYS.has(binding.parameterName)) {
      context.addIssue({
        code: 'custom',
        message: 'Credential parameter names cannot use prototype-sensitive object keys.',
        path: ['parameterName'],
      });
    }
    if (
      binding.location === 'header' &&
      TRANSPORT_CONTROLLED_HEADERS.has(binding.parameterName.toLowerCase())
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Credential binding targets a transport-controlled header.',
        path: ['parameterName'],
      });
    }
  });

const ConnectionPolicySchema = z
  .object({
    approvedOrigins: z
      .array(ApprovedOriginSchema)
      .min(1)
      .max(MAX_ORIGINS)
      .superRefine((origins, context) =>
        addDuplicateAndOrderIssues(origins, (origin) => origin, context),
      ),
    allowInsecureHttp: z.boolean().default(false),
    confirmation: z.enum(['per-call', 'process']).default('per-call'),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      !policy.allowInsecureHttp &&
      policy.approvedOrigins.some((origin) => origin.startsWith('http://'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'HTTP origins require allowInsecureHttp to be explicitly enabled.',
        path: ['approvedOrigins'],
      });
    }
    if (
      policy.allowInsecureHttp &&
      !policy.approvedOrigins.some((origin) => origin.startsWith('http://'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'allowInsecureHttp can be enabled only for an explicitly approved HTTP origin.',
        path: ['allowInsecureHttp'],
      });
    }
  });

const ConnectionProfileMaterialShape = {
  schemaVersion: z.literal('1.0'),
  displayName: z
    .string()
    .min(1)
    .max(MAX_DISPLAY_NAME_LENGTH)
    .regex(SAFE_SINGLE_LINE_PATTERN, 'Display name contains unsafe control characters.'),
  description: z
    .string()
    .min(1)
    .max(MAX_DESCRIPTION_LENGTH)
    .regex(SAFE_DESCRIPTION_PATTERN, 'Description contains unsafe control characters.')
    .optional(),
  release: z
    .object({
      path: SafePathSchema,
      id: z.string().regex(RELEASE_ID_PATTERN),
      fingerprint: z.string().regex(FINGERPRINT_PATTERN),
    })
    .strict(),
  runtime: z.object({ transport: z.literal('stdio') }).strict(),
  policy: ConnectionPolicySchema,
  credentialBindings: z
    .array(CredentialBindingSchema)
    .max(MAX_CREDENTIAL_BINDINGS)
    .superRefine((bindings, context) => addDuplicateAndOrderIssues(bindings, bindingKey, context)),
} as const;

export const ConnectionProfileMaterialSchema = z.object(ConnectionProfileMaterialShape).strict();

export const ConnectionProfileSchema = z
  .object({
    ...ConnectionProfileMaterialShape,
    id: z.string().regex(CONNECTION_ID_PATTERN),
    fingerprint: z.string().regex(FINGERPRINT_PATTERN),
  })
  .strict()
  .superRefine((profile, context) => {
    const { id: declaredId, fingerprint: declaredFingerprint, ...material } = profile;
    const actualFingerprint = contentFingerprint(material);
    if (declaredFingerprint !== actualFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Connection profile fingerprint does not match its canonical content.',
        path: ['fingerprint'],
      });
    }

    const expectedId = stableId('connection', actualFingerprint);
    if (declaredId !== expectedId) {
      context.addIssue({
        code: 'custom',
        message: 'Connection profile id does not match its canonical content.',
        path: ['id'],
      });
    }
  });

export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;
export type ConnectionProfileMaterial = z.infer<typeof ConnectionProfileMaterialSchema>;
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

export interface CreateConnectionProfileInput {
  readonly displayName: string;
  readonly description?: string;
  readonly release: Release;
  readonly releasePath: string;
  readonly approvedOrigins?: readonly string[];
  readonly allowInsecureHttp?: boolean;
  readonly confirmation?: 'per-call' | 'process';
  readonly credentialBindings?: readonly CredentialBinding[];
}

export interface McpLauncher {
  readonly nodePath: string;
  readonly cliEntryPath: string;
  readonly profilePath: string;
}

export interface McpServersDescriptor {
  readonly mcpServers: Readonly<
    Record<
      string,
      Readonly<{
        command: string;
        args: readonly [string, 'serve-profile', string];
      }>
    >
  >;
}

function environmentVariableForScheme(scheme: string, releaseFingerprint: string): string {
  const stem =
    scheme
      .toUpperCase()
      .replaceAll(/[^A-Z0-9_]/g, '_')
      .slice(0, 80) || 'SCHEME';
  const suffix = contentFingerprint({ releaseFingerprint, scheme })
    .slice('sha256:'.length, 'sha256:'.length + CREDENTIAL_NAMESPACE_HEX_LENGTH)
    .toUpperCase();
  return `HIMCP_CREDENTIAL_${stem}_${suffix}`;
}

function bindingFromScheme(
  schemeName: string,
  metadata: Release['capabilities'][number]['auth']['schemes'][string],
  releaseFingerprint: string,
): CredentialBinding | undefined {
  let location: CredentialBinding['location'];
  let parameterName: string;

  if (metadata.type === 'apiKey') {
    if (
      !['header', 'query', 'cookie'].includes(metadata.location ?? '') ||
      metadata.parameterName === undefined
    ) {
      return undefined;
    }
    location = metadata.location as CredentialBinding['location'];
    parameterName = metadata.parameterName;
  } else if (metadata.type === 'http') {
    const normalizedScheme = metadata.scheme?.toLowerCase();
    if (normalizedScheme !== 'basic' && normalizedScheme !== 'bearer') return undefined;
    location = 'header';
    parameterName = 'Authorization';
  } else if (metadata.type === 'oauth2' || metadata.type === 'openIdConnect') {
    location = 'header';
    parameterName = 'Authorization';
  } else {
    return undefined;
  }

  return CredentialBindingSchema.parse({
    scheme: schemeName,
    location,
    parameterName,
    ...(metadata.type === 'http' && metadata.scheme !== undefined
      ? {
          prefix: `${metadata.scheme[0]?.toUpperCase() ?? ''}${metadata.scheme.slice(1).toLowerCase()} `,
        }
      : metadata.type === 'oauth2' || metadata.type === 'openIdConnect'
        ? { prefix: 'Bearer ' }
        : {}),
    environmentVariable: environmentVariableForScheme(schemeName, releaseFingerprint),
  });
}

function hasCompleteCredentialAlternative(
  release: Release,
  capability: Release['capabilities'][number],
  bindings: readonly CredentialBinding[],
): boolean {
  const available = new Set(bindings.map(bindingContractKey));
  return capability.auth.alternatives.some((alternative) => {
    if (alternative.length === 0) return false;
    const occupiedTargets = new Set<string>();
    return alternative.every((requirement) => {
      const metadata = capability.auth.schemes[requirement.scheme];
      if (metadata === undefined) return false;
      const expected = bindingFromScheme(requirement.scheme, metadata, release.fingerprint);
      if (expected === undefined || !available.has(bindingContractKey(expected))) return false;
      const target = bindingKey(expected);
      if (occupiedTargets.has(target)) return false;
      occupiedTargets.add(target);
      return true;
    });
  });
}

function assertRequiredCredentialCoverage(
  release: Release,
  bindings: readonly CredentialBinding[],
): void {
  const unsupported = release.capabilities.find(
    (capability) =>
      capability.auth.required && !hasCompleteCredentialAlternative(release, capability, bindings),
  );
  if (unsupported !== undefined) {
    throw new TypeError(
      `Capability ${unsupported.name} has no complete static environment credential alternative supported by the stock profile provider.`,
    );
  }
}

/** Derives only header/query bindings that can be represented without reading a secret. */
export function deriveCredentialBindings(releaseInput: Release): readonly CredentialBinding[] {
  const verification = verifyRelease(releaseInput);
  if (!verification.valid || verification.release === undefined) {
    throw new TypeError(
      `Cannot derive credential bindings from an invalid release (${verification.errors
        .map(({ code }) => code)
        .join(', ')}).`,
    );
  }

  const bindings = new Map<string, CredentialBinding>();
  for (const capability of verification.release.capabilities) {
    for (const alternative of capability.auth.alternatives) {
      for (const requirement of alternative) {
        const metadata = capability.auth.schemes[requirement.scheme];
        if (metadata === undefined) continue;
        const binding = bindingFromScheme(
          requirement.scheme,
          metadata,
          verification.release.fingerprint,
        );
        if (binding === undefined) continue;

        const key = bindingKey(binding);
        const current = bindings.get(key);
        if (current !== undefined && bindingContractKey(current) !== bindingContractKey(binding)) {
          throw new TypeError(`Conflicting credential metadata for scheme ${requirement.scheme}.`);
        }
        bindings.set(key, binding);
      }
    }
  }

  return [...bindings.values()].sort((left, right) =>
    compareText(bindingKey(left), bindingKey(right)),
  );
}

export function deriveApprovedOrigins(release: Release): readonly string[] {
  const origins = new Set<string>();
  for (const capability of release.capabilities) {
    for (const server of capability.execution.servers) {
      const serverUrl = server.resolvedUrl ?? server.template;
      origins.add(canonicalOrigin(new URL(serverUrl).origin));
    }
  }
  return [...origins].sort(compareText);
}

function normalizeOrigins(origins: readonly string[]): readonly string[] {
  const normalized = origins.map(canonicalOrigin);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new TypeError('Approved origins must not contain duplicates.');
  }
  return normalized.sort(compareText);
}

function normalizeBindings(
  bindings: readonly CredentialBinding[],
  release: Release,
): readonly CredentialBinding[] {
  const parsed = bindings.map((binding) => CredentialBindingSchema.parse(binding));
  const keys = parsed.map(bindingKey);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('Credential bindings must not contain duplicates.');
  }
  const expectedContracts = new Set(
    deriveCredentialBindings(release).map((binding) => bindingContractKey(binding)),
  );
  const unexpected = parsed.find((binding) => !expectedContracts.has(bindingContractKey(binding)));
  if (unexpected !== undefined) {
    throw new TypeError(
      `Credential binding for scheme ${unexpected.scheme} does not match the verified release contract.`,
    );
  }
  return parsed.sort((left, right) => compareText(bindingKey(left), bindingKey(right)));
}

export interface VerifiedConnectionProfileRelease {
  readonly profile: ConnectionProfile;
  readonly release: Release;
}

/** Verifies the cross-artifact identity, origins, and credential contracts used at runtime. */
export function verifyConnectionProfileRelease(
  profileInput: ConnectionProfile,
  releaseInput: Release,
): VerifiedConnectionProfileRelease {
  const profile = parseConnectionProfile(profileInput);
  const verification = verifyRelease(releaseInput);
  if (!verification.valid || verification.release === undefined) {
    throw new TypeError('Connection profile references an invalid release.');
  }
  const release = verification.release;
  if (profile.release.id !== release.id || profile.release.fingerprint !== release.fingerprint) {
    throw new TypeError('Connection profile release identity does not match the loaded release.');
  }

  const releaseOrigins = new Set(deriveApprovedOrigins(release));
  const unexpectedOrigin = profile.policy.approvedOrigins.find(
    (origin) => !releaseOrigins.has(origin),
  );
  if (unexpectedOrigin !== undefined) {
    throw new TypeError(`Approved origin ${unexpectedOrigin} is not present in the release.`);
  }

  const expectedContracts = new Set(
    deriveCredentialBindings(release).map((binding) => bindingContractKey(binding)),
  );
  const unexpectedBinding = profile.credentialBindings.find(
    (binding) => !expectedContracts.has(bindingContractKey(binding)),
  );
  if (unexpectedBinding !== undefined) {
    throw new TypeError(
      `Credential binding for scheme ${unexpectedBinding.scheme} does not match the release.`,
    );
  }
  assertRequiredCredentialCoverage(release, profile.credentialBindings);
  return { profile, release };
}

/** Creates a deterministic profile whose identity covers every persisted configuration field. */
export function createConnectionProfile(input: CreateConnectionProfileInput): ConnectionProfile {
  const releaseVerification = verifyRelease(input.release);
  if (!releaseVerification.valid || releaseVerification.release === undefined) {
    throw new TypeError(
      `Cannot create a connection profile for an invalid release (${releaseVerification.errors
        .map(({ code }) => code)
        .join(', ')}).`,
    );
  }
  const release = releaseVerification.release;
  const credentialBindings =
    input.credentialBindings === undefined
      ? deriveCredentialBindings(release)
      : normalizeBindings(input.credentialBindings, release);
  assertRequiredCredentialCoverage(release, credentialBindings);
  const material = ConnectionProfileMaterialSchema.parse({
    schemaVersion: '1.0',
    displayName: input.displayName,
    ...(input.description === undefined ? {} : { description: input.description }),
    release: {
      path: input.releasePath,
      id: release.id,
      fingerprint: release.fingerprint,
    },
    runtime: { transport: 'stdio' },
    policy: {
      approvedOrigins:
        input.approvedOrigins === undefined
          ? deriveApprovedOrigins(release)
          : normalizeOrigins(input.approvedOrigins),
      allowInsecureHttp: input.allowInsecureHttp ?? false,
      confirmation: input.confirmation ?? 'per-call',
    },
    credentialBindings,
  });
  const profileFingerprint = contentFingerprint(material);
  return ConnectionProfileSchema.parse({
    ...material,
    id: stableId('connection', profileFingerprint),
    fingerprint: profileFingerprint,
  });
}

/** Parses schema and content identity together, rejecting unknown or modified fields. */
export function parseConnectionProfile(input: unknown): ConnectionProfile {
  const result = verifyConnectionProfile(input);
  if (!result.success) throw result.error;
  return result.data;
}

/** Non-throwing counterpart to parseConnectionProfile. */
export function verifyConnectionProfile(input: unknown) {
  const inputFailure = inspectVerificationInput(input, PROFILE_INPUT_LIMITS);
  if (inputFailure !== null) {
    // Feed a primitive sentinel to Zod so callers receive the same safe-parse result shape
    // without exposing the rejected object to recursive property access.
    return ConnectionProfileSchema.safeParse(Symbol(inputFailure.message));
  }
  return ConnectionProfileSchema.safeParse(input);
}

const McpLauncherSchema = z
  .object({
    nodePath: SafePathSchema,
    cliEntryPath: SafePathSchema,
    profilePath: SafePathSchema,
  })
  .strict();

/** Emits shell-free MCP host configuration that starts only the profile command. */
export function exportMcpServersDescriptor(
  profileInput: ConnectionProfile,
  launcherInput: McpLauncher,
): McpServersDescriptor {
  const profile = parseConnectionProfile(profileInput);
  const launcher = McpLauncherSchema.parse(launcherInput);
  return {
    mcpServers: {
      [profile.id]: {
        command: launcher.nodePath,
        args: [launcher.cliEntryPath, 'serve-profile', launcher.profilePath],
      },
    },
  };
}
