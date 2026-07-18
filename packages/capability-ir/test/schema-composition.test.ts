import { describe, expect, it } from 'vitest';

import {
  SchemaCompositionRegistry,
  embeddedSchemaDefinitionKey,
  rebaseSchemaResource,
  schemaNeedsResourceBoundary,
  type JsonSchema,
} from '../src/index.js';

const recursiveSchema: JsonSchema = {
  $id: 'urn:hi-mcp:schema_fixture',
  $ref: '#/$defs/Node',
  $defs: {
    Node: {
      type: 'object',
      properties: { child: { $ref: '#/$defs/Node' } },
    },
  },
};

describe('schema composition', () => {
  it('rebases standalone local references under a deterministic host definition', () => {
    const key = embeddedSchemaDefinitionKey(recursiveSchema);
    const rebased = rebaseSchemaResource(recursiveSchema, key);

    expect(rebased).toMatchObject({
      $ref: `#/$defs/${key}/$defs/Node`,
      $defs: {
        Node: {
          properties: { child: { $ref: `#/$defs/${key}/$defs/Node` } },
        },
      },
    });
    expect((rebased as Record<string, unknown>)['$id']).toBeUndefined();
    expect(recursiveSchema).toHaveProperty('$id', 'urn:hi-mcp:schema_fixture');
  });

  it('deduplicates identical boundary schemas without flattening them', () => {
    const registry = new SchemaCompositionRegistry();
    const first = registry.embed(recursiveSchema);
    const second = registry.embed(recursiveSchema);

    expect(first).toEqual(second);
    expect(Object.keys(registry.definitions())).toHaveLength(1);
  });

  it('leaves simple inline schemas inline', () => {
    const registry = new SchemaCompositionRegistry();
    const schema: JsonSchema = { type: 'string', minLength: 1 };

    expect(schemaNeedsResourceBoundary(schema)).toBe(false);
    expect(registry.embed(schema)).toEqual(schema);
    expect(registry.definitions()).toEqual({});
  });

  it('namespaces root anchors while preserving nested resource scope', () => {
    const schema: JsonSchema = {
      $id: 'urn:root',
      $anchor: 'node',
      type: 'object',
      properties: {
        self: { $ref: '#node' },
        nested: {
          $id: 'urn:nested',
          $anchor: 'node',
          $ref: '#node',
        },
      },
    };
    const rebased = rebaseSchemaResource(schema, 'boundary');

    expect(rebased).toMatchObject({
      $anchor: 'boundary_node',
      properties: {
        self: { $ref: '#boundary_node' },
        nested: { $id: 'urn:nested', $anchor: 'node', $ref: '#node' },
      },
    });
  });
});
