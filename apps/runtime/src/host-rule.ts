import type { HostAllowRule } from '@hi-mcp/execution-engine';

/** Parses one exact hostname[:port] authority into an execution-engine allow rule. */
export function parseAllowedHostRule(value: string): HostAllowRule {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('://') ||
    /[/?#@*]/.test(value)
  ) {
    throw new TypeError('Allowed host must use the exact hostname[:port] authority format.');
  }

  const authorityMatch = value.startsWith('[')
    ? /^\[[^\]]+\](?::(\d+))?$/.exec(value)
    : /^[^:]+(?::(\d+))?$/.exec(value);
  if (authorityMatch === null) throw new TypeError(`Invalid allowed host authority: ${value}`);
  const explicitPort = authorityMatch[1];

  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch (error) {
    throw new TypeError(`Invalid allowed host authority: ${value}`, { cause: error });
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(`Invalid allowed host authority: ${value}`);
  }
  const port = explicitPort === undefined ? undefined : Number(explicitPort);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new TypeError(`Invalid allowed host port: ${value}`);
  }
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    ...(port === undefined ? {} : { ports: [port] }),
  };
}
