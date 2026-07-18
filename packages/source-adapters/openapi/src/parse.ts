import { encodePointerSegment, parseSourceDocument } from '@hi-mcp/source-adapter-core';

import type { OpenApiAdapterOptions, OpenApiParseResult, OpenApiSource } from './types.js';

export { encodePointerSegment };

/** OpenAPI-compatible diagnostic wrapper around the shared bounded source parser. */
export function parseOpenApi(
  source: OpenApiSource,
  options: OpenApiAdapterOptions = {},
): OpenApiParseResult {
  return parseSourceDocument(source, {
    diagnosticNamespace: 'OPENAPI',
    ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
    ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }),
    ...(options.maxInputNodes === undefined ? {} : { maxInputNodes: options.maxInputNodes }),
    ...(options.maxObjectDepth === undefined ? {} : { maxObjectDepth: options.maxObjectDepth }),
    ...(options.maxYamlAliases === undefined ? {} : { maxYamlAliases: options.maxYamlAliases }),
  });
}
