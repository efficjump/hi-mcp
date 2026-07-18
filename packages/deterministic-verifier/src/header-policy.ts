import { isHttpFieldName } from '@hi-mcp/capability-ir';

/**
 * Headers owned unconditionally by connection routing, framing, or cookie handling must never be
 * sourced from model-controlled tool input. Authentication targets are checked dynamically from
 * each capability's declared schemes instead of reserving conventional application header names.
 * Keep this policy aligned with the execution engine's request binding boundary.
 */
export const FORBIDDEN_TOOL_INPUT_HEADERS = Object.freeze([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
] as const);

const FORBIDDEN_TOOL_INPUT_HEADER_SET: ReadonlySet<string> = new Set(FORBIDDEN_TOOL_INPUT_HEADERS);

export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function isValidHeaderName(name: string): boolean {
  return isHttpFieldName(name);
}

export function isForbiddenToolInputHeader(name: string): boolean {
  return FORBIDDEN_TOOL_INPUT_HEADER_SET.has(normalizeHeaderName(name));
}
