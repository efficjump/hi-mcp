import { readFileSync } from 'node:fs';

const metadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

if (typeof metadata['version'] !== 'string' || metadata['version'].length === 0) {
  throw new TypeError('The runtime package metadata does not contain a valid version.');
}

export const RUNTIME_VERSION = metadata['version'];
