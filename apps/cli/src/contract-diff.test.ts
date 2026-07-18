import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { loadConfig } from './config.js';
import { compareReleaseToDocument } from './contract-diff.js';
import { analyzeSource, compileSource } from './pipeline.js';

const fixtureLocation = new URL('../../../examples/customer-support/openapi.yaml', import.meta.url);

async function compiledFixture() {
  const source = await readFile(fixtureLocation, 'utf8');
  const defaults = (await loadConfig()).config;
  const config = { ...defaults, compile: { ...defaults.compile, strict: false } };
  const compiled = await compileSource({
    source,
    location: fixtureLocation.pathname,
    config,
    semantic: false,
    sequence: 0,
    now: () => new Date('2026-07-16T00:00:00.000Z'),
  });
  return { source, config, compiled };
}

describe('compareReleaseToDocument', () => {
  it('treats the same executable and semantic contract as unchanged', async () => {
    const { compiled } = await compiledFixture();

    const diff = compareReleaseToDocument(compiled.release, compiled.document);

    expect(diff.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 4,
      securityReview: 0,
      breaking: 0,
      metadataReview: 0,
    });
    expect(
      diff.operations.every(({ kind, impact }) => kind === 'unchanged' && impact === 'none'),
    ).toBe(true);
    expect(
      diff.operations.every(
        (operation) => operation.before === undefined && operation.after === undefined,
      ),
    ).toBe(true);
  });

  it('classifies destination, schema, metadata, added, and removed changes deterministically', async () => {
    const { source, config, compiled } = await compiledFixture();
    const revised = parse(source) as {
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, unknown>>;
    };
    revised.servers[0]!.url = 'https://api-v2.example.com/v2';
    const customerSearch = revised.paths['/customers']?.['get'] as {
      description: string;
      parameters: Array<{ schema: Record<string, unknown> }>;
    };
    customerSearch.description = 'Searches the revised customer directory.';
    customerSearch.parameters[0]!.schema['minLength'] = 2;
    delete revised.paths['/tickets/{ticketId}'];
    revised.paths['/health'] = {
      get: {
        operationId: 'healthCheck',
        summary: 'Check health',
        responses: { '204': { description: 'Healthy' } },
      },
    };
    const analysis = await analyzeSource(
      stringify(revised),
      fixtureLocation.pathname,
      config,
      'openapi',
    );
    expect(analysis.adapter.hasErrors).toBe(false);
    expect(analysis.adapter.document).not.toBeNull();
    if (analysis.adapter.document === null) throw new Error('Expected a revised document.');

    const first = compareReleaseToDocument(compiled.release, analysis.adapter.document);
    const second = compareReleaseToDocument(compiled.release, analysis.adapter.document);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.summary).toEqual({
      added: 1,
      removed: 1,
      changed: 3,
      unchanged: 0,
      securityReview: 3,
      breaking: 1,
      metadataReview: 0,
    });
    expect(first.operations.find(({ kind }) => kind === 'added')).toMatchObject({
      impact: 'additive',
      after: { name: 'healthCheck', method: 'GET', path: '/health' },
    });
    expect(first.operations.find(({ kind }) => kind === 'removed')).toMatchObject({
      impact: 'breaking',
      before: { name: 'deleteTicket', method: 'DELETE', path: '/tickets/{ticketId}' },
    });
    expect(first.operations.find(({ after }) => after?.name === 'searchCustomers')).toMatchObject({
      kind: 'changed',
      impact: 'security-review',
      areas: expect.arrayContaining(['destination', 'input-schema', 'tool-metadata']),
    });
  });

  it('separates non-assertive schema annotations from breaking schema changes', async () => {
    const { source, config, compiled } = await compiledFixture();
    const revised = parse(source) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const customerSearch = revised.paths['/customers']?.['get'] as {
      parameters: Array<{ schema: Record<string, unknown> }>;
    };
    customerSearch.parameters[0]!.schema['description'] = 'Revised query guidance.';
    const analysis = await analyzeSource(
      stringify(revised),
      fixtureLocation.pathname,
      config,
      'openapi',
    );
    if (analysis.adapter.document === null) throw new Error('Expected an annotated document.');

    const diff = compareReleaseToDocument(compiled.release, analysis.adapter.document);

    expect(diff.summary).toMatchObject({ changed: 1, unchanged: 3, metadataReview: 1 });
    expect(diff.operations.find(({ after }) => after?.name === 'searchCustomers')).toMatchObject({
      kind: 'changed',
      impact: 'metadata-review',
      areas: ['schema-annotations'],
    });
  });
});
