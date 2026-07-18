import type { SourceAdapter } from '@hi-mcp/source-adapter-core';

import { adaptOpenApi } from './adapter.js';
import { parseOpenApi } from './parse.js';
import type { OpenApiAdapterOptions } from './types.js';

export const openApiSourceAdapter: SourceAdapter = {
  id: 'openapi',
  probe(input, rawOptions = {}) {
    const options = rawOptions as OpenApiAdapterOptions;
    const parsed = parseOpenApi(input.value, {
      ...options,
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
    });
    const version = parsed.document?.['openapi'];
    return {
      confidence: typeof version === 'string' && /^3\./.test(version) ? 1 : 0,
      reason:
        typeof version === 'string' && /^3\./.test(version)
          ? 'OpenAPI 3.x marker is present.'
          : 'OpenAPI 3.x marker is absent.',
    };
  },
  adapt(input, rawOptions = {}) {
    const options = rawOptions as OpenApiAdapterOptions;
    const result = adaptOpenApi(input.value, {
      ...options,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
    });
    return {
      adapterId: 'openapi',
      document: result.document,
      diagnostics: result.diagnostics,
      hasErrors: result.hasErrors,
    };
  },
};
