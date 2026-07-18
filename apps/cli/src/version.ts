import { readFileSync } from 'node:fs';

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
}

function readPackageMetadata(): PackageMetadata {
  const location = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(location, 'utf8')) as PackageMetadata;
}

const packageMetadata = readPackageMetadata();

if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0) {
  throw new TypeError('The CLI package metadata does not contain a valid version.');
}

if (typeof packageMetadata.name !== 'string' || packageMetadata.name.length === 0) {
  throw new TypeError('The CLI package metadata does not contain a valid name.');
}

export const CLI_PACKAGE_NAME = packageMetadata.name;
export const CLI_VERSION = packageMetadata.version;
