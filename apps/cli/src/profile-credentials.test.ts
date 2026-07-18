import { describe, expect, it } from 'vitest';

import { createConnectionProfile } from './connection-profile.js';
import { ProfileEnvironmentCredentialProvider } from './profile-credentials.js';
import { exampleReleaseForConnectionTest } from './test-fixtures/connection-release.js';

describe('ProfileEnvironmentCredentialProvider', () => {
  it('chooses a complete auth alternative and prefixes HTTP authorization values', async () => {
    const release = exampleReleaseForConnectionTest();
    const profile = createConnectionProfile({
      displayName: 'Credential provider',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const apiKey = profile.credentialBindings.find(({ scheme }) => scheme === 'ApiKey')!;
    const bearer = profile.credentialBindings.find(({ scheme }) => scheme === 'BearerAuth')!;
    const provider = new ProfileEnvironmentCredentialProvider(profile, {
      environment: {
        [bearer.environmentVariable]: 'token-value',
      },
    });

    const material = await provider.resolve({
      capability: release.capabilities[0]!,
      destination: { protocol: 'https:', hostname: 'api.example.com', port: '' },
    });

    expect(material).toEqual({ headers: { Authorization: 'Bearer token-value' } });
    expect(Object.getPrototypeOf(material?.headers)).toBeNull();
    expect(apiKey.environmentVariable).not.toBe(bearer.environmentVariable);
  });

  it('does not release credentials to another origin', async () => {
    const release = exampleReleaseForConnectionTest();
    const profile = createConnectionProfile({
      displayName: 'Origin scoped',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const provider = new ProfileEnvironmentCredentialProvider(profile, { environment: {} });

    await expect(
      provider.resolve({
        capability: release.capabilities[0]!,
        destination: { protocol: 'https:', hostname: 'evil.example.com', port: '' },
      }),
    ).rejects.toThrow(/unapproved upstream origin/);
  });

  it('combines every requirement in an AND group across header and query targets', async () => {
    const release = exampleReleaseForConnectionTest({
      alternatives: [
        [
          { scheme: 'ApiKey', scopes: [] },
          { scheme: 'QueryKey', scopes: [] },
        ],
      ],
    });
    const profile = createConnectionProfile({
      displayName: 'Combined credentials',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const header = profile.credentialBindings.find(({ scheme }) => scheme === 'ApiKey')!;
    const query = profile.credentialBindings.find(({ scheme }) => scheme === 'QueryKey')!;
    const provider = new ProfileEnvironmentCredentialProvider(profile, {
      environment: {
        [header.environmentVariable]: 'header-value',
        [query.environmentVariable]: 'query-value',
      },
    });

    await expect(
      provider.resolve({
        capability: release.capabilities[0]!,
        destination: { protocol: 'https:', hostname: 'api.example.com', port: '' },
      }),
    ).resolves.toEqual({
      headers: { 'X-API-Key': 'header-value' },
      query: { access_key: 'query-value' },
    });
  });

  it('derives and resolves cookie API-key authentication without exposing its value', async () => {
    const release = exampleReleaseForConnectionTest({
      alternatives: [[{ scheme: 'CookieAuth', scopes: [] }]],
      schemes: {
        CookieAuth: {
          name: 'CookieAuth',
          type: 'apiKey',
          location: 'cookie',
          parameterName: 'session',
        },
      },
    });
    const profile = createConnectionProfile({
      displayName: 'Cookie credentials',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const binding = profile.credentialBindings[0]!;
    const provider = new ProfileEnvironmentCredentialProvider(profile, {
      environment: { [binding.environmentVariable]: 'signed-cookie-value' },
    });

    await expect(
      provider.resolve({
        capability: release.capabilities[0]!,
        destination: { protocol: 'https:', hostname: 'api.example.com', port: '' },
      }),
    ).resolves.toEqual({ cookies: { session: 'signed-cookie-value' } });
    expect(JSON.stringify(profile)).not.toContain('signed-cookie-value');
  });

  it('fails closed when a required alternative is incomplete', async () => {
    const release = exampleReleaseForConnectionTest({
      alternatives: [
        [
          { scheme: 'ApiKey', scopes: [] },
          { scheme: 'QueryKey', scopes: [] },
        ],
      ],
    });
    const profile = createConnectionProfile({
      displayName: 'Incomplete credentials',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const header = profile.credentialBindings.find(({ scheme }) => scheme === 'ApiKey')!;
    const provider = new ProfileEnvironmentCredentialProvider(profile, {
      environment: { [header.environmentVariable]: 'header-value' },
    });

    await expect(
      provider.resolve({
        capability: release.capabilities[0]!,
        destination: { protocol: 'https:', hostname: 'api.example.com', port: '' },
      }),
    ).rejects.toThrow(/No complete credential alternative/);
  });

  it('returns no material for optional authentication when no credential exists', async () => {
    const release = exampleReleaseForConnectionTest({ required: false, alternatives: [[]] });
    const profile = createConnectionProfile({
      displayName: 'Optional credentials',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const provider = new ProfileEnvironmentCredentialProvider(profile, { environment: {} });

    await expect(
      provider.resolve({
        capability: release.capabilities[0]!,
        destination: { protocol: 'https:', hostname: 'api.example.com', port: '' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects oversized and line-breaking environment credential values', async () => {
    const release = exampleReleaseForConnectionTest();
    const profile = createConnectionProfile({
      displayName: 'Bounded credentials',
      release,
      releasePath: '/tmp/release.json',
      approvedOrigins: ['https://api.example.com'],
    });
    const apiKey = profile.credentialBindings.find(({ scheme }) => scheme === 'ApiKey')!;

    for (const invalidValue of ['value\r\ninjected: true', 'x'.repeat(16 * 1_024 + 1)]) {
      const provider = new ProfileEnvironmentCredentialProvider(profile, {
        environment: { [apiKey.environmentVariable]: invalidValue },
      });
      await expect(
        provider.resolve({
          capability: release.capabilities[0]!,
          destination: { protocol: 'https:', hostname: 'api.example.com', port: '' },
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects required challenge-based HTTP auth that a static environment token cannot satisfy', () => {
    const release = exampleReleaseForConnectionTest({
      alternatives: [[{ scheme: 'DigestAuth', scopes: [] }]],
      schemes: {
        DigestAuth: {
          name: 'DigestAuth',
          type: 'http',
          scheme: 'digest',
        },
      },
    });

    expect(() =>
      createConnectionProfile({
        displayName: 'Unsupported Digest auth',
        release,
        releasePath: '/tmp/release.json',
        approvedOrigins: ['https://api.example.com'],
      }),
    ).toThrow(/no complete static environment credential alternative/);
  });
});
