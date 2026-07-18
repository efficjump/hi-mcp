import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { BoundedStdioServerTransport, StdioMessageTooLargeError } from './stdio.js';

describe('BoundedStdioServerTransport', () => {
  it('enforces the byte limit before parsing and recovers at the next JSON line', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new BoundedStdioServerTransport({
      stdin,
      stdout,
      maxMessageBytes: 64,
    });
    const onerror = vi.fn();
    const onmessage = vi.fn();
    transport.onerror = onerror;
    transport.onmessage = onmessage;
    await transport.start();

    try {
      stdin.write(Buffer.alloc(40, 0x61));
      stdin.write(Buffer.alloc(40, 0x62));
      stdin.write('\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

      expect(onerror).toHaveBeenCalledTimes(1);
      expect(onerror.mock.calls[0]?.[0]).toBeInstanceOf(StdioMessageTooLargeError);
      expect(onmessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
    } finally {
      await transport.close();
    }
  });
});
