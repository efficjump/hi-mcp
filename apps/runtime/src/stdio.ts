import { constants as bufferConstants } from 'node:buffer';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

import { createReleaseServer } from './server.js';
import type { ReleaseRuntime } from './runtime.js';

export const DEFAULT_MAX_STDIO_MESSAGE_BYTES = 1024 * 1024;

export interface BoundedStdioServerTransportOptions {
  readonly maxMessageBytes?: number;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export interface ServeStdioOptions {
  readonly maxMessageBytes?: number;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export class StdioMessageTooLargeError extends RangeError {
  readonly maxMessageBytes: number;
  readonly observedAtLeastBytes: number;

  constructor(maxMessageBytes: number, observedAtLeastBytes: number) {
    super(`Inbound MCP message exceeds the configured ${maxMessageBytes}-byte limit.`);
    this.name = 'StdioMessageTooLargeError';
    this.maxMessageBytes = maxMessageBytes;
    this.observedAtLeastBytes = observedAtLeastBytes;
  }
}

function validatedMessageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_STDIO_MESSAGE_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > bufferConstants.MAX_STRING_LENGTH) {
    throw new RangeError(
      `maxMessageBytes must be a positive safe integer no greater than ${bufferConstants.MAX_STRING_LENGTH}.`,
    );
  }
  return limit;
}

/**
 * MCP-compatible JSON-lines stdio transport with a byte limit enforced before UTF-8 decoding and
 * JSON parsing. Oversized lines are discarded through their newline, then the stream can recover.
 */
export class BoundedStdioServerTransport implements Transport {
  readonly #stdin: Readable;
  readonly #stdout: Writable;
  readonly #maxMessageBytes: number;
  #chunks: Buffer[] = [];
  #bufferedBytes = 0;
  #discardingOversizedLine = false;
  #started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(options: BoundedStdioServerTransportOptions = {}) {
    this.#stdin = options.stdin ?? process.stdin;
    this.#stdout = options.stdout ?? process.stdout;
    this.#maxMessageBytes = validatedMessageLimit(options.maxMessageBytes);
  }

  readonly #onData = (value: Buffer | string): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.#consume(chunk);
  };

  readonly #onError = (error: Error): void => {
    this.onerror?.(error);
  };

  async start(): Promise<void> {
    if (this.#started) throw new Error('BoundedStdioServerTransport is already started.');
    this.#started = true;
    this.#stdin.on('data', this.#onData);
    this.#stdin.on('error', this.#onError);
  }

  #clearLine(): void {
    this.#chunks = [];
    this.#bufferedBytes = 0;
  }

  #append(segment: Buffer): boolean {
    if (segment.length === 0) return true;
    const observedBytes = this.#bufferedBytes + segment.length;
    if (observedBytes > this.#maxMessageBytes) {
      this.#clearLine();
      this.onerror?.(new StdioMessageTooLargeError(this.#maxMessageBytes, observedBytes));
      return false;
    }
    // Copy partial stream data so a small pending line never retains a much larger source chunk.
    this.#chunks.push(Buffer.from(segment));
    this.#bufferedBytes = observedBytes;
    return true;
  }

  #emitLine(): void {
    const line = Buffer.concat(this.#chunks, this.#bufferedBytes);
    this.#clearLine();
    const content = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    try {
      this.onmessage?.(deserializeMessage(content.toString('utf8')));
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;

      if (this.#discardingOversizedLine) {
        if (newline === -1) return;
        this.#discardingOversizedLine = false;
        offset = newline + 1;
        continue;
      }

      if (!this.#append(chunk.subarray(offset, end))) {
        if (newline === -1) {
          this.#discardingOversizedLine = true;
          return;
        }
        offset = newline + 1;
        continue;
      }

      if (newline === -1) return;
      this.#emitLine();
      offset = newline + 1;
    }
  }

  async close(): Promise<void> {
    this.#stdin.off('data', this.#onData);
    this.#stdin.off('error', this.#onError);
    if (this.#stdin.listenerCount('data') === 0) this.#stdin.pause();
    this.#clearLine();
    this.#discardingOversizedLine = false;
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const serialized = serializeMessage(message);
    if (this.#stdout.write(serialized)) return;
    await new Promise<void>((resolve) => {
      this.#stdout.once('drain', resolve);
    });
  }
}

export async function serveStdio(
  runtime: ReleaseRuntime,
  version: string,
  options: ServeStdioOptions = {},
): Promise<void> {
  const server = createReleaseServer(runtime, { version });
  const transport = new BoundedStdioServerTransport(options);
  await server.connect(transport);
}
