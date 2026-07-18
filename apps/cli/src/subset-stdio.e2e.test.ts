import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import { ReleaseRuntime, serveStdio } from '@hi-mcp/runtime';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';
import { compileSource } from './pipeline.js';

const fixtureLocation = new URL(
  '../../../examples/weather-api/http-manifest.yaml',
  import.meta.url,
);

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: Readonly<{
    code: number;
    message: string;
  }>;
}

class JsonLinesMcpPeer {
  readonly #input: PassThrough;
  readonly #output: PassThrough;
  readonly #pending = new Map<
    number,
    Readonly<{
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
    }>
  >();
  #buffer = '';

  constructor(input: PassThrough, output: PassThrough) {
    this.#input = input;
    this.#output = output;
    output.on('data', this.#onData);
    output.on('error', this.#onError);
  }

  readonly #onData = (chunk: Buffer | string): void => {
    this.#buffer += chunk.toString();
    while (true) {
      const newlineIndex = this.#buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = this.#buffer.slice(0, newlineIndex).trimEnd();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch (error) {
        this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const pending = this.#pending.get(response.id);
      if (pending === undefined) continue;
      this.#pending.delete(response.id);
      pending.resolve(response);
    }
  };

  readonly #onError = (error: Error): void => {
    this.#rejectPending(error);
  };

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  request(id: number, method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    if (this.#pending.has(id)) throw new Error(`Duplicate JSON-RPC request id: ${id}`);
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: unknown = {}): void {
    this.#input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.#rejectPending(new Error('The stdio MCP peer was closed.'));
    this.#output.off('data', this.#onData);
    this.#output.off('error', this.#onError);
    this.#input.end();
    this.#output.destroy();
  }
}

describe('reviewed operation subset through stdio MCP', () => {
  it('lists only included tools and rejects an excluded tool before execution', async () => {
    const source = await readFile(fixtureLocation, 'utf8');
    const config = (await loadConfig()).config;
    const reviewed = await compileSource({
      source,
      location: fixtureLocation.pathname,
      sourceType: 'http-manifest',
      config,
      semantic: false,
      sequence: 0,
    });
    const includedOperation = reviewed.document.operations.find(
      ({ operationId }) => operationId === 'getCurrentWeather',
    );
    const excludedOperation = reviewed.document.operations.find(
      ({ operationId }) => operationId === 'createWeatherAlert',
    );
    expect(includedOperation).toBeDefined();
    expect(excludedOperation).toBeDefined();
    if (includedOperation === undefined || excludedOperation === undefined) {
      throw new Error('The weather fixture must contain both reviewed operations.');
    }

    const includedCapability = reviewed.release.capabilities.find(
      ({ id }) => id === includedOperation.id,
    );
    const excludedCapability = reviewed.release.capabilities.find(
      ({ id }) => id === excludedOperation.id,
    );
    expect(includedCapability).toBeDefined();
    expect(excludedCapability).toBeDefined();
    if (includedCapability === undefined || excludedCapability === undefined) {
      throw new Error('The reviewed release must contain both weather capabilities.');
    }

    const selected = await compileSource({
      source,
      location: fixtureLocation.pathname,
      sourceType: 'http-manifest',
      config,
      semantic: false,
      sequence: 0,
      includedOperationIds: [includedOperation.id],
      reviewedAnalysisFingerprint: reviewed.analysisFingerprint,
    });
    expect(selected.release.capabilities.map(({ name }) => name)).toEqual([
      includedCapability.name,
    ]);

    const execute = vi.fn(() => {
      throw new Error('The excluded tool must never reach API execution.');
    });
    const runtime = new ReleaseRuntime(selected.release, {
      executor: { execute },
      policy: { trustCompiledHosts: true },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const peer = new JsonLinesMcpPeer(stdin, stdout);

    try {
      await serveStdio(runtime, '1.0.0-test', { stdin, stdout });

      await expect(
        peer.request(1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'subset-e2e-client', version: '1.0.0' },
        }),
      ).resolves.toMatchObject({
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
        },
      });
      peer.notify('notifications/initialized');

      const listed = await peer.request(2, 'tools/list');
      expect(listed.error).toBeUndefined();
      expect(listed.result).toMatchObject({
        tools: [expect.objectContaining({ name: includedCapability.name })],
      });
      expect(JSON.stringify(listed.result)).not.toContain(excludedCapability.name);

      await expect(
        peer.request(3, 'tools/call', {
          name: excludedCapability.name,
          arguments: {},
        }),
      ).resolves.toMatchObject({
        error: {
          code: -32602,
          message: expect.stringContaining(`Unknown capability: ${excludedCapability.name}`),
        },
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });
});
