import { describe, expect, it } from 'vitest';

import { adaptOpenApi } from '../src/index.js';

function codes(result: ReturnType<typeof adaptOpenApi>): string[] {
  return result.diagnostics.map(({ code }) => code);
}

describe('OpenAPI reference safety', () => {
  it('resolves escaped internal JSON Pointer segments', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Pointer' },
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Paged~1Pets' } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          'Paged/Pets': { type: 'array', items: { type: 'string' } },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.successResponses[0]?.schema).toEqual({
      $ref: '#/$defs/openapi:Paged~1Pets',
      $id: expect.stringMatching(/^urn:hi-mcp:schema_/),
      $defs: {
        'openapi:Paged/Pets': { type: 'array', items: { type: 'string' } },
      },
    });
  });

  it('diagnoses cycles and preserves a recursive reference boundary', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Recursive' },
      paths: {
        '/nodes': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Node' } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: { child: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    });

    expect(codes(result)).toContain('OPENAPI.REF_CYCLE');
    expect(result.operations[0]?.successResponses[0]?.schema).toMatchObject({
      $ref: '#/$defs/openapi:Node',
      $id: expect.stringMatching(/^urn:hi-mcp:schema_/),
      $defs: {
        'openapi:Node': {
          properties: { child: { $ref: '#/$defs/openapi:Node' } },
        },
      },
    });
  });

  it('rejects external references by default', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'External' },
      paths: {
        '/pets': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': { schema: { $ref: 'https://example.test/pet.json' } },
                },
              },
            },
          },
        },
      },
    });

    expect(codes(result)).toContain('OPENAPI.EXTERNAL_REF_REJECTED');
    expect(result.hasErrors).toBe(true);
  });

  it('allows an explicit caller-controlled external resolver', () => {
    const requested: string[] = [];
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'External' },
        paths: {
          '/pets': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { $ref: 'contract:pet' } },
                  },
                },
              },
            },
          },
        },
      },
      {
        externalRefResolver(reference) {
          requested.push(reference);
          return { type: 'object', properties: { id: { type: 'string' } } };
        },
      },
    );

    expect(result.hasErrors).toBe(false);
    expect(requested).toContain('contract:pet');
    const schema = result.operations[0]?.successResponses[0]?.schema;
    expect(schema).toMatchObject({
      $ref: expect.stringMatching(/^#\/\$defs\/external_/),
      $defs: expect.any(Object),
    });
    expect(Object.values((schema as { $defs: Record<string, unknown> }).$defs)).toContainEqual(
      expect.objectContaining({ type: 'object' }),
    );
  });

  it('caches external dependencies and includes their content in the source fingerprint', () => {
    const source = {
      openapi: '3.1.0',
      info: { title: 'External identity' },
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: 'contract:item' } } },
              },
            },
          },
        },
      },
    };
    const adaptWithType = (type: 'string' | 'integer') => {
      let calls = 0;
      const result = adaptOpenApi(source, {
        externalRefResolver: () => {
          calls += 1;
          return { type };
        },
      });
      return { calls, result };
    };

    const first = adaptWithType('string');
    const repeated = adaptWithType('string');
    const changed = adaptWithType('integer');

    expect(first.calls).toBe(1);
    expect(repeated.calls).toBe(1);
    expect(changed.calls).toBe(1);
    expect(first.result.hasErrors).toBe(false);
    expect(first.result.document?.documentFingerprint).toBe(
      repeated.result.document?.documentFingerprint,
    );
    expect(first.result.document?.documentFingerprint).not.toBe(
      changed.result.document?.documentFingerprint,
    );
  });

  it('audits every repeated reference sibling while fetching each shared target once', () => {
    const source = {
      openapi: '3.1.0',
      info: { title: 'External sibling identity' },
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/a': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      $ref: 'contract:base',
                      allOf: [{ $ref: 'contract:a' }],
                    },
                  },
                },
              },
            },
          },
        },
        '/b': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      $ref: 'contract:base',
                      allOf: [{ $ref: 'contract:b' }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const adaptWithLeafType = (leafType: 'string' | 'integer') => {
      const calls = new Map<string, number>();
      const result = adaptOpenApi(source, {
        externalRefResolver(reference) {
          calls.set(reference, (calls.get(reference) ?? 0) + 1);
          if (reference === 'contract:base') return { type: 'object' };
          if (reference === 'contract:a') return { type: 'boolean' };
          if (reference === 'contract:b') return { type: leafType };
          return undefined;
        },
      });
      return { calls, result };
    };

    const stringLeaf = adaptWithLeafType('string');
    const integerLeaf = adaptWithLeafType('integer');

    expect(stringLeaf.result.hasErrors).toBe(false);
    expect(integerLeaf.result.hasErrors).toBe(false);
    expect(Object.fromEntries(stringLeaf.calls)).toEqual({
      'contract:a': 1,
      'contract:b': 1,
      'contract:base': 1,
    });
    expect(Object.fromEntries(integerLeaf.calls)).toEqual({
      'contract:a': 1,
      'contract:b': 1,
      'contract:base': 1,
    });
    expect(JSON.stringify(stringLeaf.result.operations[1]?.successResponses[0]?.schema)).toContain(
      '"type":"string"',
    );
    expect(JSON.stringify(integerLeaf.result.operations[1]?.successResponses[0]?.schema)).toContain(
      '"type":"integer"',
    );
    expect(stringLeaf.result.document?.documentFingerprint).not.toBe(
      integerLeaf.result.document?.documentFingerprint,
    );
  });

  it('scopes nested relative references to each containing external document', () => {
    const calls: Array<{
      readonly reference: string;
      readonly sourceUri?: string;
      readonly resolvedReference: string;
    }> = [];
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Nested external contexts' },
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/a': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { $ref: 'https://schemas.example.test/a/schema.json' },
                    },
                  },
                },
              },
            },
          },
          '/b': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { $ref: 'https://schemas.example.test/b/schema.json' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        sourceUri: 'https://contracts.example.test/openapi.json',
        externalRefResolver(reference, context) {
          calls.push({ reference, ...context });
          if (reference.endsWith('/schema.json')) {
            return { allOf: [{ $ref: './common.json' }] };
          }
          if (reference === './common.json') {
            return { const: context.resolvedReference };
          }
          return undefined;
        },
      },
    );

    expect(result.hasErrors).toBe(false);
    expect(calls).toEqual([
      {
        reference: 'https://schemas.example.test/a/schema.json',
        sourceUri: 'https://contracts.example.test/openapi.json',
        resolvedReference: 'https://schemas.example.test/a/schema.json',
        usagePointer: '/paths/~1a/get/responses/200/content/application~1json/schema',
      },
      {
        reference: './common.json',
        sourceUri: 'https://schemas.example.test/a/schema.json',
        resolvedReference: 'https://schemas.example.test/a/common.json',
        usagePointer: '/paths/~1a/get/responses/200/content/application~1json/schema/allOf/0',
      },
      {
        reference: 'https://schemas.example.test/b/schema.json',
        sourceUri: 'https://contracts.example.test/openapi.json',
        resolvedReference: 'https://schemas.example.test/b/schema.json',
        usagePointer: '/paths/~1b/get/responses/200/content/application~1json/schema',
      },
      {
        reference: './common.json',
        sourceUri: 'https://schemas.example.test/b/schema.json',
        resolvedReference: 'https://schemas.example.test/b/common.json',
        usagePointer: '/paths/~1b/get/responses/200/content/application~1json/schema/allOf/0',
      },
    ]);
    const schemas = result.operations.map((operation) =>
      JSON.stringify(operation.successResponses[0]?.schema),
    );
    expect(schemas[0]).toContain('https://schemas.example.test/a/common.json');
    expect(schemas[0]).not.toContain('https://schemas.example.test/b/common.json');
    expect(schemas[1]).toContain('https://schemas.example.test/b/common.json');
    expect(schemas[1]).not.toContain('https://schemas.example.test/a/common.json');
  });

  it('preserves the containing URI through a chain of external reference objects', () => {
    const calls: Array<[string, string | undefined, string]> = [];
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Chained external context' },
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/value': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: { $ref: 'https://schemas.example.test/root/entry.json' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        sourceUri: 'https://contracts.example.test/openapi.json',
        externalRefResolver(reference, context) {
          calls.push([reference, context.sourceUri, context.resolvedReference]);
          if (reference.endsWith('/entry.json')) return { $ref: './schema.json' };
          if (reference === './schema.json') return { allOf: [{ $ref: './common.json' }] };
          if (reference === './common.json') return { const: context.resolvedReference };
          return undefined;
        },
      },
    );

    expect(result.hasErrors).toBe(false);
    expect(calls).toEqual([
      [
        'https://schemas.example.test/root/entry.json',
        'https://contracts.example.test/openapi.json',
        'https://schemas.example.test/root/entry.json',
      ],
      [
        './schema.json',
        'https://schemas.example.test/root/entry.json',
        'https://schemas.example.test/root/schema.json',
      ],
      [
        './common.json',
        'https://schemas.example.test/root/schema.json',
        'https://schemas.example.test/root/common.json',
      ],
    ]);
    expect(JSON.stringify(result.operations[0]?.successResponses[0]?.schema)).toContain(
      'https://schemas.example.test/root/common.json',
    );
  });

  it('bundles a recursive external schema into a self-contained local definition', () => {
    let calls = 0;
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Recursive external schema' },
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/nodes': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { $ref: 'contract:node' } },
                  },
                },
              },
            },
          },
        },
      },
      {
        externalRefResolver() {
          calls += 1;
          return {
            type: 'object',
            properties: { child: { $ref: 'contract:node' } },
          };
        },
      },
    );

    expect(calls).toBe(1);
    expect(result.hasErrors).toBe(false);
    const schema = result.operations[0]?.successResponses[0]?.schema as {
      readonly $ref: string;
      readonly $defs: Record<string, unknown>;
    };
    const key = schema.$ref.slice('#/$defs/'.length);
    expect(schema.$ref).toMatch(/^#\/\$defs\/external_/);
    expect(schema.$defs[key]).toMatchObject({
      type: 'object',
      properties: { child: { $ref: schema.$ref } },
    });
    expect(JSON.stringify(schema)).not.toContain('contract:node');
  });

  it('rejects external dynamic references instead of emitting an unverifiable schema', () => {
    let calls = 0;
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'External dynamic reference' },
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/nodes': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { $dynamicRef: 'contract:node' } },
                  },
                },
              },
            },
          },
        },
      },
      {
        externalRefResolver() {
          calls += 1;
          return { type: 'string' };
        },
      },
    );

    expect(calls).toBe(0);
    expect(result.hasErrors).toBe(true);
    expect(codes(result)).toContain('OPENAPI.EXTERNAL_DYNAMIC_REF_UNSUPPORTED');
    expect(result.operations[0]?.successResponses[0]?.schema).toBe(false);
  });

  it('does not admit a resolver result that appears only after dependency audit', () => {
    let calls = 0;
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Unstable external dependency' },
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/items': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { $ref: 'contract:unstable' } },
                  },
                },
              },
            },
          },
        },
      },
      {
        externalRefResolver() {
          calls += 1;
          return calls === 1 ? undefined : { type: 'string' };
        },
      },
    );

    expect(calls).toBe(1);
    expect(result.hasErrors).toBe(true);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'OPENAPI.EXTERNAL_REF_NOT_FOUND',
        'OPENAPI.EXTERNAL_REF_DISCOVERED_AFTER_AUDIT',
      ]),
    );
  });

  it('rejects circular object graphs returned by an external resolver without throwing', () => {
    const circular: Record<string, unknown> = { type: 'object' };
    circular['properties'] = { child: circular };
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Circular external' },
        paths: {
          '/items': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: 'contract:circular' } } },
                },
              },
            },
          },
        },
      },
      { externalRefResolver: () => circular },
    );

    expect(codes(result)).toContain('OPENAPI.CIRCULAR_EXTERNAL_VALUE');
    expect(result.hasErrors).toBe(true);
  });

  it('bounds an acyclic doubling reference DAG with a document-global node budget', () => {
    const definitions: Record<string, unknown> = { S0: { type: 'string' } };
    for (let index = 1; index <= 16; index += 1) {
      definitions[`S${index}`] = {
        allOf: [
          { $ref: `#/x-definitions/S${index - 1}` },
          { $ref: `#/x-definitions/S${index - 1}` },
        ],
      };
    }

    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Doubling DAG' },
        components: { schemas: {} },
        'x-definitions': definitions,
        paths: {
          '/value': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { $ref: '#/x-definitions/S16' } },
                  },
                },
              },
            },
          },
        },
      },
      { maxResolvedNodes: 300 },
    );

    expect(codes(result)).toContain('OPENAPI.RESOLUTION_BUDGET_EXCEEDED');
    expect(result.hasErrors).toBe(true);
  });

  it('rejects overly deep and non-plain external resolver values', () => {
    const deep: Record<string, unknown> = { type: 'object' };
    let cursor = deep;
    for (let index = 0; index < 30; index += 1) {
      const next: Record<string, unknown> = {};
      cursor['properties'] = next;
      cursor = next;
    }

    const source = {
      openapi: '3.1.0',
      info: { title: 'External validation' },
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: 'contract:value' } } },
              },
            },
          },
        },
      },
    };
    const deepResult = adaptOpenApi(source, {
      maxObjectDepth: 20,
      externalRefResolver: () => deep,
    });
    const dateResult = adaptOpenApi(source, {
      externalRefResolver: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(codes(deepResult)).toContain('OPENAPI.EXTERNAL_VALUE_DEPTH_EXCEEDED');
    expect(codes(dateResult)).toContain('OPENAPI.INVALID_EXTERNAL_VALUE');
  });

  it('rejects unsafe keys and accessor properties from external resolvers', () => {
    const unsafe = JSON.parse('{"type":"object","__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    Object.defineProperty(unsafe, 'secret', {
      enumerable: true,
      get() {
        throw new Error('must not execute');
      },
    });
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Unsafe external' },
        paths: {
          '/items': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: 'contract:unsafe' } } },
                },
              },
            },
          },
        },
      },
      { externalRefResolver: () => unsafe },
    );

    expect(codes(result)).toContain('OPENAPI.EXTERNAL_UNSAFE_OBJECT_KEY');
    expect(codes(result)).toContain('OPENAPI.INVALID_EXTERNAL_VALUE');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects Proxy values from external resolvers without invoking reflection traps', () => {
    let trapCalls = 0;
    const proxy = new Proxy(
      { type: 'string' },
      {
        getPrototypeOf(target) {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Proxy external' },
        paths: {
          '/items': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: 'contract:proxy' } } },
                },
              },
            },
          },
        },
      },
      { externalRefResolver: () => proxy },
    );

    expect(codes(result)).toContain('OPENAPI.INVALID_EXTERNAL_VALUE');
    expect(result.hasErrors).toBe(true);
    expect(trapCalls).toBe(0);
  });

  it('ignores OpenAPI 3.0 Reference Object siblings across executable contract objects', () => {
    const result = adaptOpenApi({
      openapi: '3.0.3',
      info: { title: 'OpenAPI 3.0 reference siblings' },
      servers: [{ url: 'https://api.example.test' }],
      components: {
        parameters: {
          BaseParameter: { name: 'id', in: 'query', schema: { type: 'integer' } },
        },
        requestBodies: {
          BaseBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'integer' } } },
          },
        },
        responses: {
          BaseResponse: {
            description: 'base response',
            content: { 'application/json': { schema: { type: 'integer' } } },
          },
        },
      },
      paths: {
        '/items': {
          post: {
            parameters: [
              {
                $ref: '#/components/parameters/BaseParameter',
                schema: { type: 'string' },
                'x-ignored': { $ref: 'contract:must-not-be-audited' },
              },
            ],
            requestBody: {
              $ref: '#/components/requestBodies/BaseBody',
              required: false,
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
            responses: {
              '200': {
                $ref: '#/components/responses/BaseResponse',
                description: 'ignored response sibling',
                content: { 'text/plain': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(codes(result)).not.toContain('OPENAPI.EXTERNAL_REF_REJECTED');
    expect(result.operations[0]?.parameters[0]?.schema).toEqual({ type: 'integer' });
    expect(result.operations[0]?.requestBodies).toEqual([
      expect.objectContaining({
        contentType: 'application/json',
        required: true,
        schema: { type: 'integer' },
      }),
    ]);
    expect(result.operations[0]?.successResponses).toEqual([
      expect.objectContaining({
        contentType: 'application/json',
        description: 'base response',
        schema: { type: 'integer' },
      }),
    ]);
  });

  it('ignores Schema $ref siblings in OpenAPI 3.0', () => {
    const result = adaptOpenApi({
      openapi: '3.0.3',
      info: { title: 'OpenAPI 3.0 schema reference siblings' },
      components: { schemas: { BaseValue: { type: 'integer' } } },
      paths: {
        '/items': {
          get: {
            parameters: [
              {
                name: 'value',
                in: 'query',
                schema: {
                  $ref: '#/components/schemas/BaseValue',
                  type: 'string',
                  allOf: [{ $ref: 'contract:must-not-be-audited' }],
                },
              },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(codes(result)).not.toContain('OPENAPI.EXTERNAL_REF_REJECTED');
    expect(result.operations[0]?.parameters[0]?.schema).toMatchObject({
      $ref: '#/$defs/openapi:BaseValue',
      $defs: { 'openapi:BaseValue': { type: 'integer' } },
    });
    expect(result.operations[0]?.parameters[0]?.schema).not.toHaveProperty('type');
    expect(result.operations[0]?.parameters[0]?.schema).not.toHaveProperty('allOf');
  });

  it('preserves OpenAPI 3.1 Schema siblings and allowed Reference Object descriptions', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'OpenAPI 3.1 reference siblings' },
      components: {
        schemas: { BaseValue: { type: 'integer' } },
        responses: {
          BaseResponse: {
            description: 'base response',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
      paths: {
        '/items': {
          get: {
            parameters: [
              {
                name: 'value',
                in: 'query',
                schema: { $ref: '#/components/schemas/BaseValue', type: 'string' },
              },
            ],
            responses: {
              '200': {
                $ref: '#/components/responses/BaseResponse',
                description: 'usage-specific response',
              },
            },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.parameters[0]?.schema).toMatchObject({
      $ref: '#/$defs/openapi:BaseValue',
      type: 'string',
      $defs: { 'openapi:BaseValue': { type: 'integer' } },
    });
    expect(result.operations[0]?.successResponses[0]?.description).toBe('usage-specific response');
  });

  it('reports missing and malformed internal pointers', () => {
    const makeResult = (reference: string) =>
      adaptOpenApi({
        openapi: '3.1.0',
        info: { title: 'Invalid pointer' },
        paths: {
          '/items': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: reference } } },
                },
              },
            },
          },
        },
      });

    expect(codes(makeResult('#/components/schemas/Missing'))).toContain('OPENAPI.REF_NOT_FOUND');
    expect(codes(makeResult('#not-a-pointer'))).toContain('OPENAPI.INVALID_REF_POINTER');
    expect(codes(makeResult('#/components/~2invalid'))).toContain('OPENAPI.INVALID_REF_POINTER');
  });
});
