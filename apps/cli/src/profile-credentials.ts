import type {
  CredentialContext,
  CredentialMaterial,
  CredentialProvider,
} from '@hi-mcp/execution-engine';

import {
  parseConnectionProfile,
  type ConnectionProfile,
  type CredentialBinding,
} from './connection-profile.js';

const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1_024;

export interface ProfileCredentialProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function destinationOrigin(context: CredentialContext): string {
  const hostname =
    context.destination.hostname.includes(':') && !context.destination.hostname.startsWith('[')
      ? `[${context.destination.hostname}]`
      : context.destination.hostname;
  const port = context.destination.port === '' ? '' : `:${context.destination.port}`;
  return new URL(`${context.destination.protocol}//${hostname}${port}`).origin;
}

function expectedTarget(
  context: CredentialContext,
  schemeName: string,
): Pick<CredentialBinding, 'location' | 'parameterName' | 'prefix'> | undefined {
  const metadata = context.capability.auth.schemes[schemeName];
  if (metadata === undefined) return undefined;
  if (metadata.type === 'apiKey') {
    if (
      !['header', 'query', 'cookie'].includes(metadata.location ?? '') ||
      metadata.parameterName === undefined
    ) {
      return undefined;
    }
    return {
      location: metadata.location as CredentialBinding['location'],
      parameterName: metadata.parameterName,
    };
  }
  if (metadata.type === 'http') {
    const normalizedScheme = metadata.scheme?.toLowerCase();
    if (normalizedScheme !== 'basic' && normalizedScheme !== 'bearer') return undefined;
    const scheme = `${metadata.scheme?.[0]?.toUpperCase() ?? ''}${metadata.scheme?.slice(1).toLowerCase() ?? ''}`;
    return {
      location: 'header',
      parameterName: 'Authorization',
      prefix: `${scheme} `,
    };
  }
  if (metadata.type === 'oauth2' || metadata.type === 'openIdConnect') {
    const prefix =
      metadata.type === 'oauth2' || metadata.type === 'openIdConnect' ? 'Bearer ' : undefined;
    return {
      location: 'header',
      parameterName: 'Authorization',
      ...(prefix === undefined ? {} : { prefix }),
    };
  }
  return undefined;
}

function readCredentialValue(
  binding: CredentialBinding,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = environment[binding.environmentVariable];
  if (raw === undefined || raw.length === 0) return undefined;
  const value = `${binding.prefix ?? ''}${raw}`;
  if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_VALUE_BYTES) {
    throw new TypeError(`Credential ${binding.scheme} exceeds the runtime byte limit.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new TypeError(`Credential ${binding.scheme} contains invalid control characters.`);
  }
  return value;
}

/** Reads only profile-declared environment variables after destination validation. */
export class ProfileEnvironmentCredentialProvider implements CredentialProvider {
  readonly #profile: ConnectionProfile;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(profile: ConnectionProfile, options: ProfileCredentialProviderOptions = {}) {
    this.#profile = parseConnectionProfile(profile);
    this.#environment = options.environment ?? process.env;
  }

  async resolve(context: CredentialContext): Promise<CredentialMaterial | undefined> {
    if (context.signal?.aborted === true) {
      throw (
        context.signal.reason ?? new DOMException('Credential resolution aborted.', 'AbortError')
      );
    }
    const origin = destinationOrigin(context);
    if (!this.#profile.policy.approvedOrigins.includes(origin)) {
      throw new TypeError('Credential release was refused for an unapproved upstream origin.');
    }

    for (const alternative of context.capability.auth.alternatives) {
      if (alternative.length === 0) return undefined;
      const headers = Object.create(null) as Record<string, string>;
      const query = Object.create(null) as Record<string, string>;
      const cookies = Object.create(null) as Record<string, string>;
      let complete = true;

      for (const requirement of alternative) {
        const expected = expectedTarget(context, requirement.scheme);
        const binding = this.#profile.credentialBindings.find(
          (candidate) =>
            candidate.scheme === requirement.scheme &&
            expected !== undefined &&
            candidate.location === expected.location &&
            (candidate.location === 'header'
              ? candidate.parameterName.toLowerCase() === expected.parameterName.toLowerCase()
              : candidate.parameterName === expected.parameterName) &&
            candidate.prefix === expected.prefix,
        );
        if (binding === undefined) {
          complete = false;
          break;
        }
        const value = readCredentialValue(binding, this.#environment);
        if (value === undefined) {
          complete = false;
          break;
        }
        const target =
          binding.location === 'header' ? headers : binding.location === 'query' ? query : cookies;
        const key =
          binding.location === 'header'
            ? Object.keys(target).find(
                (candidate) => candidate.toLowerCase() === binding.parameterName.toLowerCase(),
              )
            : Object.hasOwn(target, binding.parameterName)
              ? binding.parameterName
              : undefined;
        if (key !== undefined) {
          throw new TypeError('One authentication alternative targets a credential twice.');
        }
        target[binding.parameterName] = value;
      }

      if (complete) {
        return {
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(Object.keys(query).length === 0 ? {} : { query }),
          ...(Object.keys(cookies).length === 0 ? {} : { cookies }),
        };
      }
    }

    if (context.capability.auth.required) {
      throw new TypeError('No complete credential alternative is available in the environment.');
    }
    return undefined;
  }
}
