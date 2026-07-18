import { constants as bufferConstants } from 'node:buffer';
import { open } from 'node:fs/promises';

export const DEFAULT_MAX_RELEASE_BYTES = 16 * 1024 * 1024;

const FILE_READ_CHUNK_BYTES = 64 * 1024;

export interface ReadReleaseFileOptions {
  readonly maxBytes?: number;
}

export class ReleaseFileTooLargeError extends RangeError {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(maxBytes: number, observedBytes: number) {
    super(`Release file exceeds the configured ${maxBytes}-byte limit.`);
    this.name = 'ReleaseFileTooLargeError';
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

export class ReleaseFileChangedError extends Error {
  constructor() {
    super('Release file changed while it was being read.');
    this.name = 'ReleaseFileChangedError';
  }
}

export class InvalidReleaseJsonError extends SyntaxError {
  constructor(options?: ErrorOptions) {
    super('Release file is not valid JSON.', options);
    this.name = 'InvalidReleaseJsonError';
  }
}

function validatedMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MAX_RELEASE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes >= bufferConstants.MAX_LENGTH) {
    throw new RangeError(
      `maxBytes must be a positive safe integer below ${bufferConstants.MAX_LENGTH}.`,
    );
  }
  return maxBytes;
}

/** Reads at most maxBytes + 1 and rejects files that change during the bounded read. */
export async function readReleaseFile(
  location: string,
  options: ReadReleaseFileOptions = {},
): Promise<unknown> {
  const maxBytes = validatedMaxBytes(options.maxBytes);
  const handle = await open(location, 'r');

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new TypeError('Release location must be a regular file.');
    if (before.size > BigInt(maxBytes)) {
      throw new ReleaseFileTooLargeError(maxBytes, Number(before.size));
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const remaining = maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) {
      throw new ReleaseFileTooLargeError(maxBytes, totalBytes);
    }

    const after = await handle.stat({ bigint: true });
    if (
      after.size !== BigInt(totalBytes) ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new ReleaseFileChangedError();
    }

    const source = Buffer.concat(chunks, totalBytes).toString('utf8');
    try {
      return JSON.parse(source) as unknown;
    } catch (error) {
      throw new InvalidReleaseJsonError({ cause: error });
    }
  } finally {
    await handle.close();
  }
}
