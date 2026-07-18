import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { SemanticModelProvider } from '@hi-mcp/semantic-compiler';
import type { SemanticProviderConfig } from './config.js';

export interface ProviderLoadFailure {
  readonly module: string;
  readonly code: string;
  readonly message: string;
}

export interface ProviderLoadResult {
  readonly providers: readonly SemanticModelProvider[];
  readonly failures: readonly ProviderLoadFailure[];
}

type ProviderFactory = (
  settings: Readonly<Record<string, unknown>>,
) => SemanticModelProvider | Promise<SemanticModelProvider>;

type ModuleImporter = (specifier: string) => Promise<unknown>;

export interface ProviderLoaderOptions {
  readonly configLocation?: string;
  readonly importer?: ModuleImporter;
}

const defaultImporter: ModuleImporter = async (specifier) => import(specifier) as Promise<unknown>;

const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;

class SafeProviderLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeProviderLoadError';
  }
}

function providerFactory(moduleValue: unknown, exportName: string): ProviderFactory {
  if (typeof moduleValue !== 'object' || moduleValue === null) {
    throw new SafeProviderLoadError('Provider module must export an object namespace.');
  }

  const candidate = (moduleValue as Record<string, unknown>)[exportName];
  if (typeof candidate !== 'function') {
    throw new SafeProviderLoadError(`Provider module does not export a ${exportName} factory.`);
  }

  return candidate as ProviderFactory;
}

function assertSemanticProvider(value: unknown): asserts value is SemanticModelProvider {
  if (typeof value !== 'object' || value === null) {
    throw new SafeProviderLoadError('Provider factory must return an object.');
  }

  const candidate = value as Partial<SemanticModelProvider>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    typeof candidate.listModels !== 'function' ||
    typeof candidate.generateStructured !== 'function'
  ) {
    throw new SafeProviderLoadError(
      'Provider must define id, listModels(), and generateStructured() members.',
    );
  }
}

function contentFingerprint(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function assertIntegrity(location: string, expected: string): Promise<void> {
  const actual = contentFingerprint(await readFile(location));
  if (actual !== expected) {
    throw new SafeProviderLoadError(
      `Provider module integrity mismatch: expected ${expected}, received ${actual}.`,
    );
  }
}

async function trustedModuleSpecifier(
  configuration: SemanticProviderConfig,
  configLocation: string | undefined,
): Promise<string> {
  const requested = configuration.module;
  if (URL_SCHEME.test(requested)) {
    throw new SafeProviderLoadError('Provider module URL schemes are not allowed.');
  }

  const local = isAbsolute(requested) || requested.startsWith('.');
  if (local) {
    if (!configuration.allowLocal) {
      throw new SafeProviderLoadError('Local provider modules require allowLocal: true.');
    }
    if (configuration.integrity === undefined) {
      throw new SafeProviderLoadError(
        'Local provider modules require an explicit sha256 integrity value.',
      );
    }
    if (configLocation === undefined) {
      throw new SafeProviderLoadError(
        'Local provider modules require an explicit configuration location.',
      );
    }
    const location = isAbsolute(requested)
      ? requested
      : resolve(dirname(configLocation), requested);
    await assertIntegrity(location, configuration.integrity);
    return pathToFileURL(location).href;
  }

  if (configuration.allowLocal) {
    throw new SafeProviderLoadError(
      'allowLocal is valid only for relative or absolute filesystem modules.',
    );
  }
  if (configLocation === undefined) return requested;

  const resolved = createRequire(configLocation).resolve(requested);
  if (configuration.integrity !== undefined) {
    await assertIntegrity(resolved, configuration.integrity);
  }
  return pathToFileURL(resolved).href;
}

export async function loadSemanticProviders(
  configurations: readonly SemanticProviderConfig[],
  options: ProviderLoaderOptions = {},
): Promise<ProviderLoadResult> {
  const importer = options.importer ?? defaultImporter;
  const providers: SemanticModelProvider[] = [];
  const failures: ProviderLoadFailure[] = [];

  for (const configuration of configurations) {
    if (!configuration.enabled) continue;

    let stage = 'configuration';
    try {
      const specifier = await trustedModuleSpecifier(configuration, options.configLocation);
      stage = 'import';
      const moduleValue = await importer(specifier);
      stage = 'contract';
      const factory = providerFactory(moduleValue, configuration.export);
      stage = 'initialization';
      const provider = await factory(configuration.settings);
      stage = 'contract';
      assertSemanticProvider(provider);

      if (providers.some(({ id }) => id === provider.id)) {
        throw new SafeProviderLoadError(`Duplicate provider id: ${provider.id}`);
      }
      providers.push(provider);
    } catch (error) {
      failures.push({
        module: configuration.module,
        code: `PROVIDER_${stage.toUpperCase()}_FAILED`,
        message:
          error instanceof SafeProviderLoadError
            ? error.message
            : `Provider ${stage} failed; inspect the trusted provider process for details.`,
      });
    }
  }

  return { providers, failures };
}
