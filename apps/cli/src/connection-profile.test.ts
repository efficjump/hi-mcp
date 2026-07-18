import {
  CapabilitySchema,
  ReleaseSchema,
  fingerprint,
  stableId,
  type Release,
  type SecuritySchemeMetadata,
} from '@hi-mcp/capability-ir';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CredentialBindingSchema,
  createConnectionProfile,
  deriveCredentialBindings,
  exportMcpServersDescriptor,
  parseConnectionProfile,
  verifyConnectionProfile,
  verifyConnectionProfileRelease,
  type CredentialBinding,
} from './connection-profile.js';

const touchedEnvironmentVariables = new Set<string>();

afterEach(() => {
  for (const name of touchedEnvironmentVariables) delete process.env[name];
  touchedEnvironmentVariables.clear();
});

function exampleRelease(origin = 'https://api.example.com'): Release {
  const documentFingerprint = fingerprint({ fixture: 'connection-profile' });
  const schemes: Record<string, SecuritySchemeMetadata> = {
    ApiKey: {
      name: 'ApiKey',
      type: 'apiKey',
      location: 'header',
      parameterName: 'X-API-Key',
    },
    BearerAuth: {
      name: 'BearerAuth',
      type: 'http',
      scheme: 'bearer',
    },
    CookieAuth: {
      name: 'CookieAuth',
      type: 'apiKey',
      location: 'cookie',
      parameterName: 'session',
    },
    UnusedKey: {
      name: 'UnusedKey',
      type: 'apiKey',
      location: 'query',
      parameterName: 'unused_key',
    },
  };
  const capabilityMaterial = {
    schemaVersion: '1.0' as const,
    id: stableId('capability', 'GET', '/items'),
    name: 'listItems',
    title: 'List items',
    description: 'Returns items from an example API.',
    intent: {
      useWhen: ['Items are needed.'],
      avoidWhen: [],
      examples: [],
      tags: ['items'],
    },
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    auth: {
      required: true,
      alternatives: [
        [{ scheme: 'ApiKey', scopes: [] }],
        [{ scheme: 'BearerAuth', scopes: [] }],
        [{ scheme: 'CookieAuth', scopes: [] }],
      ],
      schemes,
    },
    risk: {
      level: 'read' as const,
      sideEffect: 'none' as const,
      idempotency: 'idempotent' as const,
      requiresConfirmation: false,
      rationale: [],
    },
    execution: {
      kind: 'http' as const,
      method: 'GET' as const,
      pathTemplate: '/items',
      servers: [{ template: origin, resolvedUrl: new URL(origin).toString() }],
      parameterBindings: [],
      requestBodies: [],
      successResponses: [
        {
          statusCode: '200',
          contentType: 'application/json',
          schema: { type: 'object' },
        },
      ],
    },
    provenance: {
      sourceKind: 'openapi',
      sourceId: 'fixture',
      documentFingerprint,
      pointer: '/paths/~1items/get',
      operationId: 'listItems',
    },
  };
  const normalizedCapability = CapabilitySchema.parse({
    ...capabilityMaterial,
    fingerprint: fingerprint({ placeholder: true }),
  });
  const { fingerprint: _placeholderFingerprint, ...normalizedCapabilityMaterial } =
    normalizedCapability;
  const capability = CapabilitySchema.parse({
    ...normalizedCapabilityMaterial,
    fingerprint: fingerprint(normalizedCapabilityMaterial),
  });
  const releaseMaterial = {
    schemaVersion: '1.0' as const,
    sequence: 0,
    compiler: { name: '@hi-mcp/cli', version: 'test' },
    sources: [
      {
        sourceId: 'fixture',
        sourceKind: 'openapi-3.1.0',
        fingerprint: documentFingerprint,
      },
    ],
    capabilities: [capability],
    diagnostics: [],
  };
  const releaseFingerprint = fingerprint(releaseMaterial);
  return ReleaseSchema.parse({
    ...releaseMaterial,
    id: stableId('release', releaseFingerprint),
    createdAt: '2026-07-14T00:00:00.000Z',
    fingerprint: releaseFingerprint,
  });
}

function createExampleProfile() {
  return createConnectionProfile({
    displayName: 'Example API',
    description: 'Local connection configuration for the example API.',
    release: exampleRelease(),
    releasePath: '/workspace/example.release.json',
  });
}

describe('ConnectionProfile', () => {
  it('creates a deterministic content-addressed profile with derived origins and credentials', () => {
    const release = exampleRelease();
    const first = createConnectionProfile({
      displayName: 'Example API',
      release,
      releasePath: '/workspace/example.release.json',
    });
    const second = createConnectionProfile({
      displayName: 'Example API',
      release,
      releasePath: '/workspace/example.release.json',
    });

    expect(first).toEqual(second);
    expect(first.id).toMatch(/^connection_[a-f0-9]{24}$/);
    expect(first.policy).toEqual({
      approvedOrigins: ['https://api.example.com'],
      allowInsecureHttp: false,
      confirmation: 'per-call',
    });
    expect(first.runtime).toEqual({ transport: 'stdio' });
    expect(first.release).toEqual({
      path: '/workspace/example.release.json',
      id: release.id,
      fingerprint: release.fingerprint,
    });
    expect(first.credentialBindings.map(({ scheme }) => scheme)).toEqual([
      'ApiKey',
      'BearerAuth',
      'CookieAuth',
    ]);
    expect(first.credentialBindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ scheme: 'UnusedKey' })]),
    );
    expect(parseConnectionProfile(first)).toEqual(first);
  });

  it('never reads or serializes values from credential environment variables', () => {
    const release = exampleRelease();
    const bindings = deriveCredentialBindings(release);
    for (const binding of bindings) {
      touchedEnvironmentVariables.add(binding.environmentVariable);
      process.env[binding.environmentVariable] = `secret-for-${binding.scheme}`;
    }

    const profile = createConnectionProfile({
      displayName: 'Credential isolation',
      release,
      releasePath: 'fixture.release.json',
    });
    const serialized = JSON.stringify(profile);

    expect(profile.credentialBindings).toEqual(bindings);
    expect(serialized).not.toContain('secret-for-');
    expect(profile.credentialBindings.every((binding) => 'value' in binding === false)).toBe(true);
  });

  it('names default credential environments by release identity as well as scheme', () => {
    const first = deriveCredentialBindings(exampleRelease('https://api.example.com'));
    const second = deriveCredentialBindings(exampleRelease('https://other.example.com'));
    const firstNames = first.map(({ environmentVariable }) => environmentVariable);
    const secondNames = second.map(({ environmentVariable }) => environmentVariable);

    expect(first.map(({ scheme }) => scheme)).toEqual(second.map(({ scheme }) => scheme));
    expect(firstNames).not.toEqual(secondNames);
    expect(new Set([...firstNames, ...secondNames]).size).toBe(
      firstNames.length + secondNames.length,
    );
    for (const name of [...firstNames, ...secondNames]) {
      expect(name).toMatch(/^HIMCP_CREDENTIAL_[A-Z0-9_]+_[A-F0-9]{24}$/);
      expect(name.length).toBeLessThanOrEqual(128);
    }
  });

  it('includes every persisted material field in identity and detects modification', () => {
    const baseline = createExampleProfile();
    const renamed = createConnectionProfile({
      displayName: 'Renamed API',
      ...(baseline.description === undefined ? {} : { description: baseline.description }),
      release: exampleRelease(),
      releasePath: baseline.release.path,
    });
    const moved = createConnectionProfile({
      displayName: baseline.displayName,
      ...(baseline.description === undefined ? {} : { description: baseline.description }),
      release: exampleRelease(),
      releasePath: '/another/example.release.json',
    });

    expect(renamed.fingerprint).not.toBe(baseline.fingerprint);
    expect(moved.fingerprint).not.toBe(baseline.fingerprint);
    expect(
      verifyConnectionProfile({ ...baseline, displayName: 'Modified after creation' }).success,
    ).toBe(false);
    expect(baseline).not.toHaveProperty('createdAt');
  });

  it('canonicalizes input ordering while rejecting duplicate origins and bindings', () => {
    const release = exampleRelease();
    const firstBinding: CredentialBinding = {
      scheme: 'ApiKey',
      location: 'header',
      parameterName: 'X-API-Key',
      environmentVariable: 'PRIMARY_KEY',
    };
    const secondBinding: CredentialBinding = {
      scheme: 'BearerAuth',
      location: 'header',
      parameterName: 'Authorization',
      prefix: 'Bearer ',
      environmentVariable: 'BEARER_TOKEN',
    };
    const first = createConnectionProfile({
      displayName: 'Canonical profile',
      release,
      releasePath: 'fixture.release.json',
      approvedOrigins: ['https://z.example.com', 'https://a.example.com'],
      credentialBindings: [secondBinding, firstBinding],
    });
    const second = createConnectionProfile({
      displayName: 'Canonical profile',
      release,
      releasePath: 'fixture.release.json',
      approvedOrigins: ['https://a.example.com', 'https://z.example.com'],
      credentialBindings: [firstBinding, secondBinding],
    });

    expect(first).toEqual(second);
    expect(() =>
      createConnectionProfile({
        displayName: 'Duplicate origins',
        release,
        releasePath: 'fixture.release.json',
        approvedOrigins: ['https://EXAMPLE.com', 'https://example.com/'],
      }),
    ).toThrow(/duplicates/i);
    expect(() =>
      createConnectionProfile({
        displayName: 'Duplicate bindings',
        release,
        releasePath: 'fixture.release.json',
        credentialBindings: [firstBinding, firstBinding],
      }),
    ).toThrow(/duplicates/i);
  });

  it('rejects unknown, unbounded, insecure, and unsafe profile data', () => {
    const profile = createExampleProfile();
    let accessorInvoked = false;
    const accessorInput = { ...profile };
    Object.defineProperty(accessorInput, 'displayName', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return 'Unsafe getter';
      },
    });

    expect(verifyConnectionProfile({ ...profile, unknown: true }).success).toBe(false);
    expect(verifyConnectionProfile(accessorInput).success).toBe(false);
    expect(accessorInvoked).toBe(false);
    expect(verifyConnectionProfile({ ...profile, displayName: 'x'.repeat(129) }).success).toBe(
      false,
    );
    expect(
      verifyConnectionProfile({
        ...profile,
        policy: {
          ...profile.policy,
          approvedOrigins: Array.from(
            { length: 129 },
            (_, index) => `https://${String(index).padStart(3, '0')}.example.com`,
          ),
        },
      }).success,
    ).toBe(false);
    expect(() =>
      createConnectionProfile({
        displayName: 'HTTP profile',
        release: exampleRelease('http://api.example.com'),
        releasePath: 'fixture.release.json',
      }),
    ).toThrow(/allowInsecureHttp/);
    expect(() =>
      createConnectionProfile({
        displayName: 'Unsafe environment name',
        release: exampleRelease(),
        releasePath: 'fixture.release.json',
        credentialBindings: [
          {
            scheme: 'ApiKey',
            location: 'header',
            parameterName: 'X-API-Key',
            environmentVariable: 'API_KEY=value',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createConnectionProfile({
        displayName: 'Unsafe header name',
        release: exampleRelease(),
        releasePath: 'fixture.release.json',
        credentialBindings: [
          {
            scheme: 'ApiKey',
            location: 'header',
            parameterName: 'Bad Header',
            environmentVariable: 'API_KEY',
          },
        ],
      }),
    ).toThrow();
    for (const parameterName of ['__proto__', 'prototype', 'constructor']) {
      expect(
        CredentialBindingSchema.safeParse({
          scheme: 'ApiKey',
          location: 'query',
          parameterName,
          environmentVariable: 'API_KEY',
        }).success,
      ).toBe(false);
    }
  });

  it('requires explicit opt-in for HTTP profiles', () => {
    const profile = createConnectionProfile({
      displayName: 'Development API',
      release: exampleRelease('http://api.example.com'),
      releasePath: 'fixture.release.json',
      allowInsecureHttp: true,
      confirmation: 'process',
    });

    expect(profile.policy.allowInsecureHttp).toBe(true);
    expect(profile.policy.confirmation).toBe('process');
    expect(() =>
      createConnectionProfile({
        displayName: 'Unnecessary HTTP permission',
        release: exampleRelease(),
        releasePath: 'fixture.release.json',
        allowInsecureHttp: true,
      }),
    ).toThrow(/explicitly approved HTTP origin/);
  });

  it('cross-verifies release identity, origins, and credential contracts', () => {
    const release = exampleRelease();
    const profile = createConnectionProfile({
      displayName: 'Cross artifact verification',
      release,
      releasePath: 'fixture.release.json',
    });

    expect(verifyConnectionProfileRelease(profile, release)).toEqual({ profile, release });
    expect(() =>
      verifyConnectionProfileRelease(profile, exampleRelease('https://other.example.com')),
    ).toThrow(/identity does not match/);

    const unrelatedOrigin = createConnectionProfile({
      displayName: 'Unrelated origin',
      release,
      releasePath: 'fixture.release.json',
      approvedOrigins: ['https://unrelated.example.com'],
    });
    expect(() => verifyConnectionProfileRelease(unrelatedOrigin, release)).toThrow(
      /not present in the release/,
    );
  });

  it('rejects transport-controlled and release-unrelated credential bindings', () => {
    const release = exampleRelease();
    expect(() =>
      createConnectionProfile({
        displayName: 'Transport header',
        release,
        releasePath: 'fixture.release.json',
        credentialBindings: [
          {
            scheme: 'ApiKey',
            location: 'header',
            parameterName: 'Host',
            environmentVariable: 'API_KEY',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createConnectionProfile({
        displayName: 'Unrelated credential',
        release,
        releasePath: 'fixture.release.json',
        credentialBindings: [
          {
            scheme: 'UnknownScheme',
            location: 'query',
            parameterName: 'token',
            environmentVariable: 'API_KEY',
          },
        ],
      }),
    ).toThrow(/does not match the verified release contract/);
  });

  it('exports a shell-free MCP descriptor containing only serve-profile invocation', () => {
    const profile = createExampleProfile();
    const descriptor = exportMcpServersDescriptor(profile, {
      nodePath: '/usr/local/bin/node',
      cliEntryPath: '/workspace/hi-mcp/apps/cli/dist/index.js',
      profilePath: '/workspace/profiles/example.connection.json',
    });

    expect(descriptor).toEqual({
      mcpServers: {
        [profile.id]: {
          command: '/usr/local/bin/node',
          args: [
            '/workspace/hi-mcp/apps/cli/dist/index.js',
            'serve-profile',
            '/workspace/profiles/example.connection.json',
          ],
        },
      },
    });
    expect(JSON.stringify(descriptor)).not.toContain('--allow-host');
    expect(JSON.stringify(descriptor)).not.toContain('secret');
  });
});
