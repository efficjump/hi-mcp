import { describe, expect, it } from 'vitest';

import { adaptOpenApi } from '../src/index.js';

const COMPLETE_DOCUMENT = `
openapi: 3.1.0
info:
  title: Pet Service
  version: 2.0.0
  description: Example contract
servers:
  - url: https://{region}.api.example.test/v2
    variables:
      region:
        default: kr
        enum: [kr, us]
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
      bearerFormat: JWT
    unusedKey:
      type: apiKey
      in: header
      name: X-Unused-Key
  schemas:
    Pet:
      type: object
      required: [id]
      properties:
        id: { type: string }
        name: { type: string }
    PetInput:
      type: object
      required: [name]
      properties:
        name: { type: string }
  parameters:
    TraceId:
      name: x-trace-id
      in: header
      schema: { type: string }
security:
  - bearer: [pets:read]
paths:
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: false
        schema: { type: string }
      - $ref: '#/components/parameters/TraceId'
    get:
      operationId: getPet
      summary: Get a pet
      tags: [pets]
      parameters:
        - name: includeHistory
          in: query
          schema: { type: boolean }
        - name: session
          in: cookie
          schema: { type: string }
      responses:
        '200':
          description: A pet
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
    put:
      operationId: replacePet
      security: []
      requestBody:
        required: true
        description: Replacement data
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PetInput'
          application/merge-patch+json:
            schema:
              type: object
      responses:
        '200':
          description: Replaced pet
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
`;

describe('adaptOpenApi', () => {
  it('normalizes operations, bindings, auth, schemas, servers, and provenance', () => {
    const result = adaptOpenApi(COMPLETE_DOCUMENT, {
      sourceId: 'pet-service',
      sourceUri: 'git://contracts/pets.yaml',
    });

    expect(result.hasErrors).toBe(false);
    expect(result.document?.openapiVersion).toBe('3.1.0');
    expect(result.document?.servers[0]?.resolvedUrl).toBe('https://kr.api.example.test/v2');
    expect(result.operations).toHaveLength(2);

    const getPet = result.operations.find(({ operationId }) => operationId === 'getPet');
    expect(getPet?.parameters.map(({ location, name }) => `${location}:${name}`)).toEqual([
      'cookie:session',
      'header:x-trace-id',
      'path:petId',
      'query:includeHistory',
    ]);
    expect(getPet?.parameters.find(({ name }) => name === 'petId')?.required).toBe(true);
    expect(getPet?.auth.required).toBe(true);
    expect(getPet?.auth.alternatives[0]?.[0]).toEqual({
      scheme: 'bearer',
      scopes: ['pets:read'],
    });
    expect(Object.keys(result.document?.securitySchemes ?? {})).toEqual(['bearer', 'unusedKey']);
    expect(Object.keys(getPet?.auth.schemes ?? {})).toEqual(['bearer']);
    expect(getPet?.successResponses[0]?.schema).toMatchObject({
      $ref: '#/$defs/openapi:Pet',
      $defs: { 'openapi:Pet': { type: 'object', required: ['id'] } },
    });
    expect(getPet?.provenance).toMatchObject({
      sourceKind: 'openapi',
      sourceId: 'pet-service',
      sourceUri: 'git://contracts/pets.yaml',
      pointer: '/paths/~1pets~1{petId}/get',
    });

    const replace = result.operations.find(({ operationId }) => operationId === 'replacePet');
    expect(replace?.requestBodies.map(({ contentType }) => contentType)).toEqual([
      'application/json',
      'application/merge-patch+json',
    ]);
    expect(replace?.requestBodies.map(({ contentTypeInputPath }) => contentTypeInputPath)).toEqual([
      ['bodyContentType'],
      ['bodyContentType'],
    ]);
    expect(replace?.auth).toMatchObject({ required: false, alternatives: [] });
    expect(replace?.auth.schemes).toEqual({});
  });

  it('applies operation parameter overrides by location and name', () => {
    const result = adaptOpenApi({
      openapi: '3.0.3',
      info: { title: 'Override' },
      paths: {
        '/items': {
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
          get: {
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 20 } }],
            responses: { '204': { description: 'No content' } },
          },
        },
      },
    });

    expect(result.operations[0]?.parameters).toHaveLength(1);
    expect(result.operations[0]?.parameters[0]?.schema).toMatchObject({ maximum: 20 });
  });

  it('converts OpenAPI 3.0 nullable and exclusive bounds to JSON Schema 2020-12', () => {
    const result = adaptOpenApi({
      openapi: '3.0.3',
      info: { title: 'OpenAPI 3.0 schema dialect' },
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/measurements': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        value: {
                          type: 'number',
                          nullable: true,
                          minimum: 0,
                          exclusiveMinimum: true,
                          maximum: 100,
                          exclusiveMaximum: false,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.successResponses[0]?.schema).toEqual({
      type: ['object', 'null'],
      properties: {
        value: {
          type: ['number', 'null'],
          exclusiveMinimum: 0,
          maximum: 100,
        },
      },
    });
  });

  it('fails closed when request media encoding cannot be represented by the runtime IR', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Encoded form' },
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/search': {
          post: {
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: { tags: { type: 'array', items: { type: 'string' } } },
                  },
                  encoding: { tags: { style: 'form', explode: false } },
                },
              },
            },
            responses: { '204': { description: 'ok' } },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OPENAPI.REQUEST_BODY_ENCODING_UNSUPPORTED',
          severity: 'error',
          location: expect.objectContaining({
            pointer:
              '/paths/~1search/post/requestBody/content/application~1x-www-form-urlencoded/encoding',
          }),
        }),
      ]),
    );
  });

  it('resolves relative server URLs against an explicit base URL', () => {
    const result = adaptOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'Relative server' },
        servers: [{ url: '/service/v1' }],
        paths: {},
      },
      { baseUrl: 'https://gateway.example.test/root/' },
    );

    expect(result.document?.servers[0]).toMatchObject({
      template: '/service/v1',
      resolvedUrl: 'https://gateway.example.test/service/v1',
      provenancePointer: '/servers/0',
    });
  });

  it('keeps normalized operation identities unique when operationId values collide', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Names' },
      paths: {
        '/one': { get: { operationId: 'sameName', responses: { '200': { description: 'ok' } } } },
        '/two': { get: { operationId: 'sameName', responses: { '200': { description: 'ok' } } } },
      },
    });

    expect(result.operations.map(({ operationId }) => operationId)).toEqual([
      'sameName',
      'sameName',
    ]);
    expect(new Set(result.operations.map(({ id }) => id)).size).toBe(2);
  });

  it('preserves default alongside exact success responses for uncovered 2xx statuses', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Fallback responses' },
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'exact',
                content: { 'application/json': { schema: { const: 'exact' } } },
              },
              default: {
                description: 'fallback',
                content: { 'application/json': { schema: { const: 'fallback' } } },
              },
            },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.successResponses.map(({ statusCode }) => statusCode)).toEqual([
      '200',
      'default',
    ]);
  });

  it('reports an error when an operation has no 2xx or default response contract', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Missing success' },
      paths: {
        '/items': {
          get: {
            responses: { '404': { description: 'not found' } },
          },
        },
      },
    });

    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OPENAPI.SUCCESS_RESPONSE_MISSING',
          severity: 'error',
        }),
      ]),
    );
  });

  it('rejects decoder-sensitive path keys while preserving Unicode encoding and templates', () => {
    for (const unsafePath of [
      '/%252e%252e/admin',
      '/safe\\..\\admin',
      '/items?fixed=true',
      `/items/${String.fromCharCode(0xd800)}`,
    ]) {
      const result = adaptOpenApi({
        openapi: '3.1.0',
        info: { title: 'Path safety' },
        paths: {
          [unsafePath]: {
            get: { responses: { '200': { description: 'ok' } } },
          },
        },
      });
      expect(result.hasErrors, unsafePath).toBe(true);
      expect(result.operations, unsafePath).toEqual([]);
      expect(result.diagnostics, unsafePath).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'OPENAPI.INVALID_PATH_TEMPLATE', severity: 'error' }),
        ]),
      );
    }

    const unicode = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Unicode path' },
      paths: {
        '/caf%C3%A9/{name}': {
          get: {
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    expect(unicode.hasErrors).toBe(false);
    expect(unicode.operations[0]?.path).toBe('/caf%C3%A9/{name}');
  });

  it('canonicalizes executable absolute servers while preserving their source templates', () => {
    const result = adaptOpenApi({
      openapi: '3.1.0',
      info: { title: 'Canonical server' },
      servers: [{ url: 'https://api.example.test/v1/%2e%2e/canonical' }],
      paths: {
        '/items': {
          get: { responses: { '200': { description: 'ok' } } },
        },
      },
    });

    expect(result.hasErrors).toBe(false);
    expect(result.document?.servers[0]).toMatchObject({
      template: 'https://api.example.test/v1/%2e%2e/canonical',
      resolvedUrl: 'https://api.example.test/canonical',
    });
  });
});
