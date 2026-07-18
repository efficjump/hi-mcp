import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

import type { DnsAddress } from './types.js';

export interface PinnedDispatchResult {
  readonly response: Response;
  dispose(): Promise<void>;
}

function normalizedHostname(value: string): string {
  return value
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function requestedFamily(value: number | string | undefined): 4 | 6 | undefined {
  if (value === 4 || value === 'IPv4') return 4;
  if (value === 6 || value === 'IPv6') return 6;
  return undefined;
}

function lookupError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOTFOUND';
  return error;
}

/** Creates a connector lookup that can never fall back to process or operating-system DNS. */
export function createPinnedLookup(
  expectedHostname: string,
  verifiedAddresses: readonly DnsAddress[],
): LookupFunction {
  const expected = normalizedHostname(expectedHostname);
  const snapshot = verifiedAddresses.map(({ address, family }) => ({ address, family }));

  return (hostname, options, callback): void => {
    const actual = normalizedHostname(hostname);
    const family = requestedFamily(options.family);
    const eligible = snapshot.filter(
      (address) => family === undefined || address.family === family,
    );

    queueMicrotask(() => {
      if (actual !== expected) {
        callback(lookupError('The transport requested an unverified hostname.'), '', 0);
        return;
      }
      if (eligible.length === 0) {
        callback(
          lookupError('No verified destination address matches the requested family.'),
          '',
          0,
        );
        return;
      }
      if (options.all === true) {
        callback(null, eligible);
        return;
      }
      const selected = eligible[0]!;
      callback(null, selected.address, selected.family);
    });
  };
}

/**
 * Dispatches through a one-request agent whose connector is bound to the policy-verified DNS
 * snapshot. The URL hostname remains unchanged, so HTTP Host and TLS SNI/certificate checks still
 * use the source contract hostname.
 */
export async function dispatchWithPinnedDns(
  url: URL,
  init: RequestInit,
  verifiedAddresses: readonly DnsAddress[],
): Promise<PinnedDispatchResult> {
  const dispatcher = new Agent({
    connect: {
      lookup: createPinnedLookup(url.hostname, verifiedAddresses),
    },
    connections: 1,
    pipelining: 0,
  });

  try {
    const response = await undiciFetch(url, {
      ...init,
      dispatcher,
    } as unknown as UndiciRequestInit);
    let disposed = false;
    return {
      response: response as unknown as Response,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await dispatcher.destroy();
      },
    };
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
