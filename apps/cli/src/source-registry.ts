import { httpManifestSourceAdapter } from '@hi-mcp/http-manifest-adapter';
import { openApiSourceAdapter } from '@hi-mcp/openapi-adapter';
import {
  SourceAdapterRegistry,
  type SourceAdapter,
  type SourceAdapterResult,
} from '@hi-mcp/source-adapter-core';

import type { HiMcpConfig } from './config.js';

export interface AdaptRegisteredSourceOptions {
  readonly source: string;
  readonly location: string;
  readonly sourceType?: string;
  readonly config: HiMcpConfig;
  readonly additionalAdapters?: readonly SourceAdapter[];
}

export function createSourceAdapterRegistry(
  additionalAdapters: readonly SourceAdapter[] = [],
): SourceAdapterRegistry {
  return new SourceAdapterRegistry([
    openApiSourceAdapter,
    httpManifestSourceAdapter,
    ...additionalAdapters,
  ]);
}

export async function adaptRegisteredSource(
  options: AdaptRegisteredSourceOptions,
): Promise<SourceAdapterResult> {
  const registry = createSourceAdapterRegistry(options.additionalAdapters);
  return registry.adapt(
    {
      value: options.source,
      location: options.location,
    },
    options.sourceType ?? 'auto',
    {
      ...(options.config.compile.baseUrl === undefined
        ? {}
        : { baseUrl: options.config.compile.baseUrl }),
    },
  );
}
