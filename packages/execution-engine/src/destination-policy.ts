import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { ExecutionEngineError } from './errors.js';
import type {
  DestinationPolicy,
  DestinationPolicyContext,
  DnsAddress,
  DnsResolver,
  HostAllowRule,
} from './types.js';

const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_IPV4.addSubnet(network, prefix, 'ipv4');
}

const BLOCKED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_IPV6.addSubnet(network, prefix, 'ipv6');
}

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function effectivePort(url: URL): number {
  if (url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function hostnameMatches(rule: HostAllowRule, hostname: string): boolean {
  const expected = normalizedHostname(rule.hostname);
  return (
    hostname === expected || (rule.includeSubdomains === true && hostname.endsWith(`.${expected}`))
  );
}

export function assertHostAllowed(url: URL, allowedHosts: readonly HostAllowRule[]): void {
  const hostname = normalizedHostname(url.hostname);
  const port = effectivePort(url);
  const matched = allowedHosts.some((rule) => {
    if (!hostnameMatches(rule, hostname)) {
      return false;
    }

    const ports = rule.ports ?? [url.protocol === 'https:' ? 443 : 80];
    return ports.includes(port);
  });

  if (!matched) {
    throw new ExecutionEngineError({
      code: 'DESTINATION_BLOCKED',
      message: 'The destination host is not present in the execution allowlist.',
      details: { hostname, port },
    });
  }
}

function mappedIpv4(address: string): string | undefined {
  const withoutZone = address.split('%', 1)[0] ?? address;
  if (isIP(withoutZone) !== 6) {
    return undefined;
  }

  let canonical: string;
  try {
    // WHATWG parsing collapses every legal expanded, compressed, and embedded-dotted spelling to
    // one hexadecimal IPv6 form before the mapped prefix is interpreted.
    const hostname = new URL(`http://[${withoutZone}]/`).hostname;
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
      return undefined;
    }
    canonical = hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }

  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (match === null) {
    return undefined;
  }

  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);

  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isPublicAddress(address: string): boolean {
  const withoutZone = address.split('%', 1)[0] ?? address;
  const mapped = mappedIpv4(withoutZone);
  if (mapped !== undefined) {
    return !BLOCKED_IPV4.check(mapped, 'ipv4');
  }

  const family = isIP(withoutZone);
  if (family === 4) {
    return !BLOCKED_IPV4.check(withoutZone, 'ipv4');
  }
  if (family === 6) {
    return !BLOCKED_IPV6.check(withoutZone, 'ipv6');
  }
  return false;
}

export const defaultDnsResolver: DnsResolver = async (hostname) => {
  const literal = normalizedHostname(hostname);
  const family = isIP(literal);
  if (family === 4 || family === 6) {
    return [{ address: literal, family }];
  }

  const addresses = await lookup(literal, { all: true, verbatim: true });
  return addresses.map(({ address, family: resolvedFamily }) => ({
    address,
    family: resolvedFamily,
  })) as readonly DnsAddress[];
};

export class PublicDestinationPolicy implements DestinationPolicy {
  assertAllowed(context: DestinationPolicyContext): void {
    const { url, addresses, allowInsecureHttp } = context;
    if (url.username !== '' || url.password !== '') {
      throw new ExecutionEngineError({
        code: 'DESTINATION_BLOCKED',
        message: 'Credentials are not permitted in an execution destination URL.',
      });
    }

    if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
      throw new ExecutionEngineError({
        code: 'DESTINATION_BLOCKED',
        message: 'The execution destination must use HTTPS.',
        details: { protocol: url.protocol },
      });
    }

    const hostname = normalizedHostname(url.hostname);
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      throw new ExecutionEngineError({
        code: 'DESTINATION_BLOCKED',
        message: 'Local hostnames are blocked by the default destination policy.',
        details: { hostname },
      });
    }

    if (addresses.length === 0) {
      throw new ExecutionEngineError({
        code: 'DESTINATION_BLOCKED',
        message: 'The destination did not resolve to an address.',
        details: { hostname },
      });
    }

    const blocked = addresses.find(({ address }) => !isPublicAddress(address));
    if (blocked !== undefined) {
      throw new ExecutionEngineError({
        code: 'DESTINATION_BLOCKED',
        message: 'The destination resolved to a non-public address.',
        details: { hostname, addressFamily: blocked.family },
      });
    }
  }
}

export function inferredHostAllowlist(url: URL): readonly HostAllowRule[] {
  return [
    {
      hostname: normalizedHostname(url.hostname),
      ports: [effectivePort(url)],
    },
  ];
}
