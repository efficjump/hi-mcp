import { types as utilTypes } from 'node:util';

import { parseDocument } from 'yaml';

import { normalizeDiagnosticNamespace, SourceDiagnosticCollector } from './diagnostics.js';
import type { BoundedSourceOptions, ParsedSourceDocument, SourceDocumentInput } from './types.js';

const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_INPUT_NODES = 100_000;
const DEFAULT_MAX_OBJECT_DEPTH = 256;
const DEFAULT_MAX_YAML_ALIASES = 100;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function configuredLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  collector: SourceDiagnosticCollector,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  collector.add({
    code: 'INVALID_SAFETY_LIMIT',
    severity: 'error',
    message: `${name} must be a positive safe integer`,
    recoverable: false,
    details: { option: name, value: String(value) },
  });
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface SanitizationBudget {
  readonly maxBytes: number;
  readonly maxNodes: number;
  bytes: number;
  nodes: number;
  byteLimitReported: boolean;
  nodeLimitReported: boolean;
}

function isProxyValue(value: unknown): boolean {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    utilTypes.isProxy(value)
  );
}

function reportNodeLimit(
  budget: SanitizationBudget,
  pointer: string,
  collector: SourceDiagnosticCollector,
): void {
  if (budget.nodeLimitReported) return;
  budget.nodeLimitReported = true;
  collector.add({
    code: 'INPUT_NODE_LIMIT',
    severity: 'error',
    message: `Input exceeds the configured node limit of ${budget.maxNodes}`,
    pointer,
    recoverable: false,
  });
}

function consumeNode(
  budget: SanitizationBudget,
  pointer: string,
  collector: SourceDiagnosticCollector,
): boolean {
  if (budget.nodes >= budget.maxNodes) {
    reportNodeLimit(budget, pointer, collector);
    return false;
  }
  budget.nodes += 1;
  return true;
}

function consumeString(
  value: string,
  budget: SanitizationBudget,
  pointer: string,
  collector: SourceDiagnosticCollector,
): boolean {
  budget.bytes += Buffer.byteLength(value, 'utf8');
  if (budget.bytes <= budget.maxBytes) return true;
  if (!budget.byteLimitReported) {
    budget.byteLimitReported = true;
    collector.add({
      code: 'INPUT_TOO_LARGE',
      severity: 'error',
      message: `Input exceeds the configured limit of ${budget.maxBytes} bytes`,
      pointer,
      recoverable: false,
    });
  }
  return false;
}

function inspectionMustStop(budget: SanitizationBudget): boolean {
  return budget.byteLimitReported || budget.nodeLimitReported;
}

function sanitizeValue(
  value: unknown,
  pointer: string,
  depth: number,
  maxDepth: number,
  collector: SourceDiagnosticCollector,
  ancestors: WeakSet<object>,
  budget: SanitizationBudget,
): unknown {
  if (!consumeNode(budget, pointer, collector)) return undefined;
  if (depth > maxDepth) {
    collector.add({
      code: 'MAX_OBJECT_DEPTH',
      severity: 'error',
      message: `Document exceeds the configured object depth of ${maxDepth}`,
      pointer,
      recoverable: false,
    });
    return undefined;
  }
  if (isProxyValue(value)) {
    collector.add({
      code: 'PROXY_INPUT',
      severity: 'error',
      message: 'Proxy values are executable objects and cannot be accepted as source data',
      pointer,
      recoverable: false,
    });
    return undefined;
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return consumeString(value, budget, pointer, collector) ? value : undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      collector.add({
        code: 'NON_JSON_VALUE',
        severity: 'error',
        message: 'Document contains a non-finite number',
        pointer,
      });
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Array.prototype && prototype !== null) {
      collector.add({
        code: 'NON_PLAIN_ARRAY',
        severity: 'error',
        message: 'Document contains a non-plain array',
        pointer,
        recoverable: false,
      });
      return undefined;
    }
    if (ancestors.has(value)) {
      collector.add({
        code: 'CIRCULAR_INPUT',
        severity: 'error',
        message: 'Input object contains a circular reference',
        pointer,
        recoverable: false,
      });
      return undefined;
    }
    ancestors.add(value);
    try {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        collector.add({
          code: 'UNSAFE_PROPERTY',
          severity: 'error',
          message: 'Input arrays must expose length as a safe data property',
          pointer,
          recoverable: false,
        });
        return undefined;
      }
      const arrayLength = lengthDescriptor.value as number;
      if (arrayLength > budget.maxNodes - budget.nodes) {
        reportNodeLimit(budget, pointer, collector);
        return undefined;
      }
      const output: unknown[] = [];
      for (let index = 0; index < arrayLength; index += 1) {
        const childPointer = `${pointer}/${index}`;
        if (inspectionMustStop(budget)) break;
        if (budget.nodes >= budget.maxNodes) {
          consumeNode(budget, childPointer, collector);
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          collector.add({
            code: 'UNSAFE_PROPERTY',
            severity: 'error',
            message: 'Input arrays must contain only enumerable data properties',
            pointer: childPointer,
            recoverable: false,
          });
          return undefined;
        }
        output.push(
          sanitizeValue(
            descriptor.value,
            childPointer,
            depth + 1,
            maxDepth,
            collector,
            ancestors,
            budget,
          ) ?? null,
        );
        if (inspectionMustStop(budget)) break;
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value)) {
    collector.add({
      code: 'NON_JSON_VALUE',
      severity: 'error',
      message: 'Document must contain only JSON-compatible values',
      pointer,
    });
    return undefined;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    collector.add({
      code: 'NON_PLAIN_OBJECT',
      severity: 'error',
      message: 'Document contains a non-plain object',
      pointer,
    });
    return undefined;
  }

  if (ancestors.has(value)) {
    collector.add({
      code: 'CIRCULAR_INPUT',
      severity: 'error',
      message: 'Input object contains a circular reference',
      pointer,
      recoverable: false,
    });
    return undefined;
  }

  ancestors.add(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  try {
    for (const key in value) {
      const childPointer = `${pointer}/${encodePointerSegment(key)}`;
      if (inspectionMustStop(budget)) break;
      if (budget.nodes >= budget.maxNodes) {
        consumeNode(budget, childPointer, collector);
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (UNSAFE_KEYS.has(key)) {
        collector.add({
          code: 'UNSAFE_OBJECT_KEY',
          severity: 'error',
          message: `Unsafe object key '${key}' was rejected`,
          pointer: childPointer,
          recoverable: false,
        });
        consumeNode(budget, childPointer, collector);
        continue;
      }
      if (!consumeString(key, budget, childPointer, collector)) break;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        collector.add({
          code: 'UNSAFE_PROPERTY',
          severity: 'error',
          message: 'Input objects must contain only enumerable data properties',
          pointer: childPointer,
          recoverable: false,
        });
        consumeNode(budget, childPointer, collector);
        continue;
      }
      const sanitized = sanitizeValue(
        descriptor.value,
        childPointer,
        depth + 1,
        maxDepth,
        collector,
        ancestors,
        budget,
      );
      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
      if (inspectionMustStop(budget)) break;
    }
  } finally {
    ancestors.delete(value);
  }
  return output;
}

export function encodePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodeSource(source: string | Uint8Array): string {
  return typeof source === 'string'
    ? source
    : new TextDecoder('utf-8', { fatal: true }).decode(source);
}

export function parseSourceDocument(
  source: SourceDocumentInput,
  options: BoundedSourceOptions = {},
): ParsedSourceDocument {
  const collector = new SourceDiagnosticCollector(
    normalizeDiagnosticNamespace(options.diagnosticNamespace),
    options.sourceUri,
  );
  const maxInputBytes = configuredLimit(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    'maxInputBytes',
    collector,
  );
  const maxObjectDepth = configuredLimit(
    options.maxObjectDepth,
    DEFAULT_MAX_OBJECT_DEPTH,
    'maxObjectDepth',
    collector,
  );
  const maxInputNodes = configuredLimit(
    options.maxInputNodes,
    DEFAULT_MAX_INPUT_NODES,
    'maxInputNodes',
    collector,
  );
  const maxYamlAliases = configuredLimit(
    options.maxYamlAliases,
    DEFAULT_MAX_YAML_ALIASES,
    'maxYamlAliases',
    collector,
  );
  let raw: unknown;
  let format: ParsedSourceDocument['format'];

  if (isProxyValue(source)) {
    collector.add({
      code: 'PROXY_INPUT',
      severity: 'error',
      message: 'Proxy values are executable objects and cannot be accepted as source data',
      pointer: '',
      recoverable: false,
    });
    return { document: null, format: 'object', diagnostics: collector.all(), hasErrors: true };
  }

  if (typeof source === 'string' || source instanceof Uint8Array) {
    let text: string;
    try {
      text = decodeSource(source);
    } catch (error) {
      collector.add({
        code: 'INVALID_UTF8',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Input is not valid UTF-8',
        recoverable: false,
      });
      return { document: null, format: null, diagnostics: collector.all(), hasErrors: true };
    }

    if (Buffer.byteLength(text, 'utf8') > maxInputBytes) {
      collector.add({
        code: 'INPUT_TOO_LARGE',
        severity: 'error',
        message: `Input exceeds the configured limit of ${maxInputBytes} bytes`,
        recoverable: false,
      });
      return { document: null, format: null, diagnostics: collector.all(), hasErrors: true };
    }
    if (text.trim().length === 0) {
      collector.add({
        code: 'EMPTY_INPUT',
        severity: 'error',
        message: 'Source input is empty',
        recoverable: false,
      });
      return { document: null, format: null, diagnostics: collector.all(), hasErrors: true };
    }

    const first = text.trimStart()[0];
    if (first === '{' || first === '[') {
      format = 'json';
      try {
        raw = JSON.parse(text) as unknown;
      } catch (error) {
        collector.add({
          code: 'INVALID_JSON',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Invalid JSON input',
          recoverable: false,
        });
        return { document: null, format, diagnostics: collector.all(), hasErrors: true };
      }
    } else {
      format = 'yaml';
      const yamlDocument = parseDocument(text, { prettyErrors: true, strict: true });
      for (const error of yamlDocument.errors) {
        collector.add({
          code: 'INVALID_YAML',
          severity: 'error',
          message: error.message,
          recoverable: false,
        });
      }
      for (const warning of yamlDocument.warnings) {
        collector.add({
          code: 'YAML_WARNING',
          severity: 'warning',
          message: warning.message,
        });
      }
      if (yamlDocument.errors.length > 0) {
        return { document: null, format, diagnostics: collector.all(), hasErrors: true };
      }
      try {
        raw = yamlDocument.toJS({
          maxAliasCount: maxYamlAliases,
        }) as unknown;
      } catch (error) {
        collector.add({
          code: 'YAML_ALIAS_LIMIT',
          severity: 'error',
          message: error instanceof Error ? error.message : 'YAML alias expansion failed',
          recoverable: false,
        });
        return { document: null, format, diagnostics: collector.all(), hasErrors: true };
      }
    }
  } else {
    raw = source;
    format = 'object';
  }

  let sanitized: unknown;
  try {
    sanitized = sanitizeValue(raw, '', 0, maxObjectDepth, collector, new WeakSet<object>(), {
      maxBytes: maxInputBytes,
      maxNodes: maxInputNodes,
      bytes: 0,
      nodes: 0,
      byteLimitReported: false,
      nodeLimitReported: false,
    });
  } catch {
    collector.add({
      code: 'UNSAFE_INPUT',
      severity: 'error',
      message: 'Source input could not be safely inspected as plain data',
      pointer: '',
      recoverable: false,
    });
    sanitized = undefined;
  }
  if (!isRecord(sanitized)) {
    collector.add({
      code: 'INVALID_ROOT',
      severity: 'error',
      message: 'Source document root must be an object',
      pointer: '',
      recoverable: false,
    });
    return { document: null, format, diagnostics: collector.all(), hasErrors: true };
  }
  if (collector.hasErrors()) {
    return { document: null, format, diagnostics: collector.all(), hasErrors: true };
  }

  return {
    document: sanitized,
    format,
    diagnostics: collector.all(),
    hasErrors: collector.hasErrors(),
  };
}
