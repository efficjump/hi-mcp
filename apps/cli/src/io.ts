import { constants as bufferConstants } from 'node:buffer';
import { link, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdin } from 'node:process';

export interface SourceInput {
  readonly content: string;
  readonly location: string;
}

export const DEFAULT_MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
const FILE_READ_CHUNK_BYTES = 64 * 1_024;

export class InputChangedWhileReadingError extends Error {
  constructor(location: string) {
    super(`${location} changed while it was being read.`);
    this.name = 'InputChangedWhileReadingError';
  }
}

function inputTooLarge(location: string, maxBytes: number): RangeError {
  return new RangeError(`${location} exceeds the configured ${maxBytes}-byte input limit.`);
}

function assertValidByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes >= bufferConstants.MAX_LENGTH) {
    throw new TypeError(
      `Input byte limit must be a positive safe integer below ${bufferConstants.MAX_LENGTH}.`,
    );
  }
}

/** Reads through one file descriptor and enforces the byte limit before allocating the full file. */
export async function readUtf8FileBounded(location: string, maxBytes: number): Promise<string> {
  assertValidByteLimit(maxBytes);
  const handle = await open(location, 'r');

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new TypeError(`${location} is not a regular file.`);
    if (before.size > BigInt(maxBytes)) throw inputTooLarge(location, maxBytes);

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
    if (totalBytes > maxBytes) throw inputTooLarge(location, maxBytes);

    const after = await handle.stat({ bigint: true });
    if (
      after.size !== BigInt(totalBytes) ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new InputChangedWhileReadingError(location);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readStandardInput(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw inputTooLarge('stdin', maxBytes);
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function readSourceInput(
  location: string,
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
): Promise<SourceInput> {
  assertValidByteLimit(maxBytes);
  if (location === '-') {
    return {
      content: await readStandardInput(maxBytes),
      location: 'stdin',
    };
  }

  const absoluteLocation = resolve(location);
  const content = await readUtf8FileBounded(absoluteLocation, maxBytes);
  return {
    content,
    location: absoluteLocation,
  };
}

export async function readJsonFile(
  location: string,
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
): Promise<unknown> {
  const input = await readSourceInput(location, maxBytes);
  return JSON.parse(input.content) as unknown;
}

export interface AtomicJsonWriteOptions {
  readonly overwrite?: boolean;
}

export async function writeJsonAtomically(
  location: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<string> {
  const absoluteLocation = resolve(location);
  const directory = dirname(absoluteLocation);
  const temporaryLocation = `${absoluteLocation}.${process.pid}.${crypto.randomUUID()}.tmp`;

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryLocation, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (options.overwrite === true) {
      await rename(temporaryLocation, absoluteLocation);
    } else {
      try {
        await link(temporaryLocation, absoluteLocation);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new TypeError(`Refusing to replace existing file ${absoluteLocation}.`, {
            cause: error,
          });
        }
        throw error;
      }
      await rm(temporaryLocation);
    }
  } catch (error) {
    await rm(temporaryLocation, { force: true });
    throw error;
  }

  return absoluteLocation;
}
