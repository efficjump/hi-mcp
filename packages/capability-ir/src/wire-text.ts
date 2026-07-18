import type { JsonSchema } from './schemas.js';

/**
 * ECMAScript-Unicode pattern that excludes lone UTF-16 surrogate code units while preserving
 * valid supplementary characters. JSON Schema validators compile patterns with the `u` flag.
 */
export const WELL_FORMED_UNICODE_PATTERN = '^[^\\uD800-\\uDFFF]*$';

/**
 * HTTP field values are restricted to ByteString field-content: VCHAR/obs-text at the edges and
 * HTAB/SP only inside the value. Fetch trims leading and trailing HTTP whitespace, so rejecting it
 * here preserves opaque header and credential bytes instead of silently changing them.
 */
export const HTTP_HEADER_VALUE_PATTERN =
  '^(?:|[\\u0021-\\u007E\\u0080-\\u00FF]|[\\u0021-\\u007E\\u0080-\\u00FF][\\u0009\\u0020-\\u007E\\u0080-\\u00FF]*[\\u0021-\\u007E\\u0080-\\u00FF])$';

const HTTP_FIELD_NAME_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TRANSPORT_CONTROLLED_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

/** True when a name is an RFC HTTP token suitable for a field or cookie name. */
export function isHttpFieldName(value: string): boolean {
  return HTTP_FIELD_NAME_REGEXP.test(value);
}

/** Headers whose routing/framing semantics cannot safely be controlled by a credential scheme. */
export function isTransportControlledCredentialHeader(value: string): boolean {
  return TRANSPORT_CONTROLLED_CREDENTIAL_HEADERS.has(value.toLowerCase());
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isHttpHeaderValue(value: string): boolean {
  if (
    value.length > 0 &&
    (value[0] === ' ' ||
      value[0] === '\t' ||
      value[value.length - 1] === ' ' ||
      value[value.length - 1] === '\t')
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit > 0xff || (codeUnit !== 0x09 && (codeUnit < 0x20 || codeUnit === 0x7f))) {
      return false;
    }
  }
  return true;
}

export function scalarTextWireSchema(pattern: string): JsonSchema {
  return { type: ['null', 'boolean', 'number', 'string'], pattern };
}

export function shallowParameterTextWireSchema(pattern: string): JsonSchema {
  const scalar = scalarTextWireSchema(pattern);
  return {
    anyOf: [
      scalar,
      { type: 'array', items: scalar },
      {
        type: 'object',
        propertyNames: { type: 'string', pattern },
        patternProperties: { '.*': scalar },
        additionalProperties: false,
      },
    ],
  };
}

export function formTextWireSchema(pattern = WELL_FORMED_UNICODE_PATTERN): JsonSchema {
  const scalar = scalarTextWireSchema(pattern);
  return {
    type: 'object',
    propertyNames: { type: 'string', pattern },
    patternProperties: {
      '.*': {
        anyOf: [scalar, { type: 'array', items: scalar }],
      },
    },
    additionalProperties: false,
  };
}
