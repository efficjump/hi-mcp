import { DiagnosticCollector } from './diagnostics.js';
import { encodePointerSegment } from './parse.js';

const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Converts the OpenAPI 3.0 Schema Object dialect into JSON Schema 2020-12 semantics. */
export function normalizeOpenApiSchemaDialect(
  schema: unknown,
  openapiVersion: string,
  collector: DiagnosticCollector,
  pointer: string,
): unknown {
  if (!/^3\.0(?:\.|$)/.test(openapiVersion)) {
    return schema;
  }

  const visit = (value: unknown, currentPointer: string): unknown => {
    if (typeof value === 'boolean' || !isRecord(value)) {
      return value;
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      if (key === 'nullable') {
        continue;
      }
      const child = value[key];
      const childPointer = `${currentPointer}/${encodePointerSegment(key)}`;
      if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(child)) {
        output[key] = child.map((entry, index) => visit(entry, `${childPointer}/${index}`));
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(child)) {
        output[key] = Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((name) => [
              name,
              visit(child[name], `${childPointer}/${encodePointerSegment(name)}`),
            ]),
        );
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        output[key] = visit(child, childPointer);
      } else {
        output[key] = child;
      }
    }

    const nullable = value['nullable'];
    if (nullable !== undefined && typeof nullable !== 'boolean') {
      collector.add({
        code: 'OPENAPI30.INVALID_NULLABLE',
        severity: 'error',
        message: 'OpenAPI 3.0 nullable must be a boolean',
        pointer: `${currentPointer}/nullable`,
      });
    } else if (nullable === true) {
      const type = value['type'];
      if (typeof type === 'string') {
        output['type'] = type === 'null' ? 'null' : [type, 'null'];
      } else if (type !== undefined) {
        collector.add({
          code: 'OPENAPI30.INVALID_SCHEMA_TYPE',
          severity: 'error',
          message: 'OpenAPI 3.0 schema type must be a string',
          pointer: `${currentPointer}/type`,
        });
      }
    }

    for (const [exclusiveKeyword, inclusiveKeyword] of [
      ['exclusiveMinimum', 'minimum'],
      ['exclusiveMaximum', 'maximum'],
    ] as const) {
      const exclusive = value[exclusiveKeyword];
      if (exclusive === undefined) {
        continue;
      }
      if (typeof exclusive !== 'boolean') {
        collector.add({
          code: 'OPENAPI30.INVALID_EXCLUSIVE_BOUND',
          severity: 'error',
          message: `OpenAPI 3.0 ${exclusiveKeyword} must be a boolean`,
          pointer: `${currentPointer}/${exclusiveKeyword}`,
        });
        continue;
      }
      delete output[exclusiveKeyword];
      if (!exclusive) {
        continue;
      }
      const inclusive = value[inclusiveKeyword];
      if (typeof inclusive !== 'number' || !Number.isFinite(inclusive)) {
        collector.add({
          code: 'OPENAPI30.EXCLUSIVE_BOUND_WITHOUT_LIMIT',
          severity: 'error',
          message: `OpenAPI 3.0 ${exclusiveKeyword}: true requires a finite ${inclusiveKeyword}`,
          pointer: `${currentPointer}/${exclusiveKeyword}`,
        });
        continue;
      }
      delete output[inclusiveKeyword];
      output[exclusiveKeyword] = inclusive;
    }

    return output;
  };

  return visit(schema, pointer);
}
