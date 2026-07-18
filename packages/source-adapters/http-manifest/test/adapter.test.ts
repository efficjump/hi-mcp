import { describe, expect, it } from 'vitest';

import { adaptHttpManifest, httpManifestSourceAdapter } from '../src/index.js';

const manifest = `
schemaVersion: "1.0"
kind: http
id: weather-service
title: Weather Service
version: "2026-07"
servers:
  - url: https://weather.example.test/v1
securitySchemes:
  token:
    type: apiKey
    location: header
    parameterName: X-Weather-Key
  unusedToken:
    type: apiKey
    location: header
    parameterName: X-Unused-Key
security:
  - - scheme: token
      scopes: []
operations:
  - id: current-weather
    method: GET
    path: /weather/{city}
    summary: Read current weather
    parameters:
      - in: path
        name: city
        schema:
          type: string
      - in: query
        name: units
        schema:
          type: string
          enum: [metric, imperial]
    successResponses:
      - statusCode: "200"
        contentType: application/json
        schema:
          type: object
          properties:
            temperature:
              type: number
`;

describe('adaptHttpManifest', () => {
  it('normalizes an API without requiring OpenAPI', () => {
    const result = adaptHttpManifest(manifest);

    expect(result.hasErrors).toBe(false);
    expect(result.document).toMatchObject({
      sourceKind: 'http-manifest',
      sourceVersion: '1.0',
      sourceId: 'weather-service',
      title: 'Weather Service',
    });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      operationId: 'current-weather',
      method: 'GET',
      path: '/weather/{city}',
      auth: { required: true },
      parameters: [
        { location: 'path', inputPath: ['path', 'city'], required: true },
        { location: 'query', inputPath: ['query', 'units'], required: false },
      ],
    });
    expect(Object.keys(result.document?.securitySchemes ?? {})).toEqual(['token', 'unusedToken']);
    expect(Object.keys(result.operations[0]?.auth.schemes ?? {})).toEqual(['token']);
  });

  it('resolves root and operation-relative servers against the caller base URL', () => {
    const relative = manifest.replace('https://weather.example.test/v1', '/weather/v1').replace(
      '    summary: Read current weather',
      `    summary: Read current weather
    servers:
      - url: ./regional`,
    );
    const result = adaptHttpManifest(relative, {
      baseUrl: 'https://gateway.example.test/root/',
    });

    expect(result.hasErrors).toBe(false);
    expect(result.document?.servers[0]).toMatchObject({
      template: '/weather/v1',
      resolvedUrl: 'https://gateway.example.test/weather/v1',
    });
    expect(result.operations[0]?.servers[0]).toMatchObject({
      template: './regional',
      resolvedUrl: 'https://gateway.example.test/root/regional',
    });
  });

  it('honors SourceInput identity over adapter option and manifest defaults', async () => {
    const result = await httpManifestSourceAdapter.adapt(
      {
        value: manifest,
        location: 'renamed.yaml',
        sourceId: 'caller-source',
        sourceUri: 'file:///renamed.yaml',
      },
      { sourceId: 'option-source' },
    );

    expect(result.document).toMatchObject({
      sourceId: 'caller-source',
      sourceUri: 'file:///renamed.yaml',
    });
    expect(result.document?.operations[0]?.provenance).toMatchObject({
      sourceId: 'caller-source',
      sourceUri: 'file:///renamed.yaml',
    });
  });

  it('supports an explicit confirmation-gated risk override', () => {
    const nonconforming = manifest.replace(
      '    summary: Read current weather',
      `    summary: Read current weather
    risk:
      level: write
      sideEffect: definite
      idempotency: non-idempotent
      requiresConfirmation: true
      rationale: [Upstream GET mutates an audit cursor]`,
    );
    const result = adaptHttpManifest(nonconforming);

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.risk).toMatchObject({
      level: 'write',
      requiresConfirmation: true,
    });
  });

  it('supports canonical HTTP extension methods with authoritative risk', () => {
    const extension = manifest.replace('    method: GET', '    method: PROPFIND').replace(
      '    summary: Read current weather',
      `    summary: Read current weather
    risk:
      level: read
      sideEffect: none
      idempotency: idempotent
      requiresConfirmation: false
      rationale: [WebDAV property lookup]`,
    );
    const result = adaptHttpManifest(extension);

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]).toMatchObject({
      method: 'PROPFIND',
      risk: { level: 'read', requiresConfirmation: false },
    });
  });

  it('preserves explicit wire serialization for nonstandard HTTP media types', () => {
    const soapManifest = `
schemaVersion: "1.0"
kind: http
id: soap-gateway
title: SOAP Gateway
servers:
  - url: https://soap.example.test
operations:
  - id: invoke
    method: POST
    path: /service
    requestBodies:
      - contentType: application/soap+xml
        serialization: text
        required: true
        schema:
          type: string
    successResponses:
      - statusCode: "200"
        contentType: application/soap+xml
        schema:
          type: string
`;
    const result = adaptHttpManifest(soapManifest);

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.requestBodies[0]).toMatchObject({
      contentType: 'application/soap+xml',
      serialization: 'text',
    });
  });

  it('allows alternate request media types to share one exact input path', () => {
    const multiMediaManifest = `
schemaVersion: "1.0"
kind: http
id: multi-media
title: Multi-media API
servers:
  - url: https://media.example.test
operations:
  - id: create-item
    method: POST
    path: /items
    requestBodies:
      - contentType: application/json
        inputPath: [payload]
        required: true
        schema:
          type: object
      - contentType: text/plain
        serialization: text
        inputPath: [payload]
        required: true
        schema:
          type: string
    successResponses:
      - statusCode: "204"
`;
    const result = adaptHttpManifest(multiMediaManifest);

    expect(result.hasErrors).toBe(false);
    expect(
      result.operations[0]?.requestBodies.map(({ inputPath, contentTypeInputPath }) => ({
        inputPath,
        contentTypeInputPath,
      })),
    ).toEqual([
      { inputPath: ['payload'], contentTypeInputPath: ['payloadContentType'] },
      { inputPath: ['payload'], contentTypeInputPath: ['payloadContentType'] },
    ]);
  });

  it('derives a deterministic collision-free selector path from the body input path', () => {
    const collision = `
schemaVersion: "1.0"
kind: http
id: selector-collision
title: Selector collision API
servers:
  - url: https://media.example.test
operations:
  - id: submit
    method: POST
    path: /submit
    parameters:
      - in: query
        name: format
        inputPath: [payloadContentType]
        schema:
          type: string
    requestBodies:
      - contentType: application/graphql
        serialization: text
        inputPath: [payload]
        schema: { type: string }
      - contentType: text/plain
        serialization: text
        inputPath: [payload]
        schema: { type: string }
    successResponses:
      - statusCode: "204"
`;
    const result = adaptHttpManifest(collision);

    expect(result.hasErrors).toBe(false);
    expect(
      result.operations[0]?.requestBodies.map(({ contentTypeInputPath }) => contentTypeInputPath),
    ).toEqual([['payloadContentType2'], ['payloadContentType2']]);
  });

  it('allows one exact input path to feed multiple distinct HTTP targets', () => {
    const sharedInputManifest = `
schemaVersion: "1.0"
kind: http
id: shared-input
title: Shared Input API
servers:
  - url: https://shared.example.test
operations:
  - id: lookup
    method: GET
    path: /items
    parameters:
      - in: query
        name: queryValue
        inputPath: [shared]
        schema:
          type: string
      - in: header
        name: X-Shared-Value
        inputPath: [shared]
        schema:
          type: string
    successResponses:
      - statusCode: "204"
`;
    const result = adaptHttpManifest(sharedInputManifest);

    expect(result.hasErrors).toBe(false);
    expect(result.operations[0]?.parameters.map(({ inputPath }) => inputPath)).toEqual([
      ['shared'],
      ['shared'],
    ]);
  });

  it('fails closed when parameter and request body input paths have a strict-prefix collision', () => {
    const collidingManifest = `
schemaVersion: "1.0"
kind: http
id: colliding-inputs
title: Colliding Inputs API
servers:
  - url: https://collision.example.test
operations:
  - id: create-item
    method: POST
    path: /items
    parameters:
      - in: query
        name: payload
        inputPath: [payload]
        schema:
          type: string
    requestBodies:
      - contentType: application/json
        inputPath: [payload, child]
        schema:
          type: object
    successResponses:
      - statusCode: "204"
`;
    const result = adaptHttpManifest(collidingManifest);

    expect(result.document).toBeNull();
    expect(result.operations).toHaveLength(0);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'HTTP_MANIFEST.INPUT_PATH_COLLISION',
    );
  });

  it('fails closed when parameters duplicate one normalized HTTP target', () => {
    const duplicateTargetManifest = `
schemaVersion: "1.0"
kind: http
id: duplicate-target
title: Duplicate Target API
servers:
  - url: https://duplicate.example.test
operations:
  - id: lookup
    method: GET
    path: /items
    parameters:
      - in: header
        name: X-Trace-Id
        inputPath: [first]
        schema:
          type: string
      - in: header
        name: x-trace-id
        inputPath: [second]
        schema:
          type: string
    successResponses:
      - statusCode: "204"
`;
    const result = adaptHttpManifest(duplicateTargetManifest);

    expect(result.document).toBeNull();
    expect(result.operations).toHaveLength(0);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'HTTP_MANIFEST.DUPLICATE_PARAMETER_TARGET',
    );
  });

  it('fails closed for duplicate operation identities', () => {
    const duplicate = manifest.replace(
      '  - id: current-weather',
      `  - id: current-weather
    method: GET
    path: /duplicate
    successResponses:
      - statusCode: "200"
  - id: current-weather`,
    );
    const result = adaptHttpManifest(duplicate);

    expect(result.document).toBeNull();
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'HTTP_MANIFEST.DUPLICATE_OPERATION_ID',
    );
  });

  it('rejects non-2xx entries from the success response collection', () => {
    const result = adaptHttpManifest(manifest.replace('statusCode: "200"', 'statusCode: "404"'));

    expect(result.hasErrors).toBe(true);
    expect(result.operations).toEqual([]);
  });

  it('rejects decoder-sensitive operation paths while preserving Unicode encoding', () => {
    for (const unsafePath of [
      '/%252e%252e/admin',
      '/safe\\..\\admin',
      '/items?fixed=true',
      `/items/${String.fromCharCode(0xd800)}`,
    ]) {
      const result = adaptHttpManifest(
        manifest.replace('path: /weather/{city}', `path: ${JSON.stringify(unsafePath)}`),
      );
      expect(result.document, unsafePath).toBeNull();
      expect(
        result.diagnostics.map(({ code }) => code),
        unsafePath,
      ).toContain('HTTP_MANIFEST.INVALID_SCHEMA');
    }

    const unicode = adaptHttpManifest(
      manifest.replace('path: /weather/{city}', 'path: /caf%C3%A9/{city}'),
    );
    expect(unicode.hasErrors).toBe(false);
    expect(unicode.operations[0]?.path).toBe('/caf%C3%A9/{city}');
  });

  it('canonicalizes executable absolute server URLs while preserving the source template', () => {
    const result = adaptHttpManifest(
      manifest.replace(
        'https://weather.example.test/v1',
        'https://weather.example.test/v1/%2e%2e/canonical',
      ),
    );

    expect(result.hasErrors).toBe(false);
    expect(result.document?.servers[0]).toMatchObject({
      template: 'https://weather.example.test/v1/%2e%2e/canonical',
      resolvedUrl: 'https://weather.example.test/canonical',
    });
  });

  it('advertises exact source detection markers', async () => {
    await expect(
      httpManifestSourceAdapter.probe({ value: manifest, location: 'weather.yaml' }),
    ).resolves.toMatchObject({ confidence: 1 });
    await expect(
      httpManifestSourceAdapter.probe({ value: '{"openapi":"3.1.0"}', location: 'api.json' }),
    ).resolves.toMatchObject({ confidence: 0 });
    await expect(
      httpManifestSourceAdapter.probe(
        { value: manifest, location: 'weather.yaml' },
        { maxInputBytes: 16 },
      ),
    ).resolves.toMatchObject({ confidence: 0 });
  });
});
