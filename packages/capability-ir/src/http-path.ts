import { isWellFormedUnicode } from './wire-text.js';

export type HttpOperationPathIssueCode =
  | 'LEADING_SLASH_REQUIRED'
  | 'INVALID_UNICODE'
  | 'CONTROL_CHARACTER'
  | 'URL_COMPONENT_DELIMITER'
  | 'BACKSLASH'
  | 'MALFORMED_PERCENT_ENCODING'
  | 'ENCODED_PATH_SEPARATOR'
  | 'DOT_SEGMENT';

export interface HttpOperationPathIssue {
  readonly code: HttpOperationPathIssueCode;
  readonly message: string;
  readonly segmentIndex?: number;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const HEX_DIGIT = /^[0-9A-Fa-f]$/u;
const PERCENT_TRIPLET = /%[0-9A-Fa-f]{2}/u;

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    const high = value[index + 1];
    const low = value[index + 2];
    if (high === undefined || low === undefined || !HEX_DIGIT.test(high) || !HEX_DIGIT.test(low)) {
      return true;
    }
    index += 2;
  }
  return false;
}

function hasPercentTriplet(value: string): boolean {
  return PERCENT_TRIPLET.test(value);
}

function decodePercentLayer(value: string): {
  readonly decoded: string;
  readonly validUtf8: boolean;
} {
  if (!hasMalformedPercentEncoding(value)) {
    try {
      return { decoded: decodeURIComponent(value), validUtf8: true };
    } catch {
      return { decoded: value, validUtf8: false };
    }
  }
  // An outer `%25` can reveal a literal percent next to another encoded byte. Decode complete
  // triplets individually so tolerant upstream decoders cannot hide an encoded separator behind
  // that literal percent.
  return {
    decoded: value.replace(/%([0-9A-Fa-f]{2})/gu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
    validUtf8: true,
  };
}

function unsafeDecodedSegment(value: string, segmentIndex: number): HttpOperationPathIssue | null {
  if (CONTROL_CHARACTER.test(value)) {
    return {
      code: 'CONTROL_CHARACTER',
      message: 'HTTP operation paths cannot contain encoded C0 control or DEL characters.',
      segmentIndex,
    };
  }
  if (value.includes('/') || value.includes('\\')) {
    return {
      code: 'ENCODED_PATH_SEPARATOR',
      message: 'HTTP operation path segments cannot contain encoded slash or backslash separators.',
      segmentIndex,
    };
  }
  if (value === '.' || value === '..') {
    return {
      code: 'DOT_SEGMENT',
      message: 'HTTP operation paths cannot contain literal or repeatedly encoded dot segments.',
      segmentIndex,
    };
  }
  return null;
}

/**
 * Validates an operation path before it is assigned to WHATWG URL.pathname.
 *
 * Every path segment is decoded repeatedly so double-encoded separators and dot segments cannot
 * be normalized into a different upstream path. A decoded standalone percent sign remains valid
 * (for example `%25`), while malformed encoding in the original path is rejected.
 */
export function validateHttpOperationPath(path: string): HttpOperationPathIssue | null {
  if (!path.startsWith('/')) {
    return {
      code: 'LEADING_SLASH_REQUIRED',
      message: 'HTTP operation paths must start with a slash.',
    };
  }
  if (!isWellFormedUnicode(path)) {
    return {
      code: 'INVALID_UNICODE',
      message: 'HTTP operation paths cannot contain unpaired Unicode surrogates.',
    };
  }
  if (CONTROL_CHARACTER.test(path)) {
    return {
      code: 'CONTROL_CHARACTER',
      message: 'HTTP operation paths cannot contain C0 control or DEL characters.',
    };
  }
  if (path.includes('?') || path.includes('#')) {
    return {
      code: 'URL_COMPONENT_DELIMITER',
      message: 'HTTP operation paths cannot contain query or fragment delimiters.',
    };
  }
  if (path.includes('\\')) {
    return {
      code: 'BACKSLASH',
      message: 'HTTP operation paths cannot contain backslashes.',
    };
  }
  if (hasMalformedPercentEncoding(path)) {
    return {
      code: 'MALFORMED_PERCENT_ENCODING',
      message: 'HTTP operation paths must use complete hexadecimal percent encoding.',
    };
  }

  const segments = path.split('/');
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    let current = segments[segmentIndex] as string;
    const initialIssue = unsafeDecodedSegment(current, segmentIndex);
    if (initialIssue !== null) return initialIssue;

    while (hasPercentTriplet(current)) {
      const { decoded, validUtf8 } = decodePercentLayer(current);
      if (!validUtf8) {
        return {
          code: 'MALFORMED_PERCENT_ENCODING',
          message: 'HTTP operation path percent encoding must decode as valid UTF-8.',
          segmentIndex,
        };
      }
      const decodedIssue = unsafeDecodedSegment(decoded, segmentIndex);
      if (decodedIssue !== null) return decodedIssue;
      if (decoded === current) break;
      current = decoded;
    }
  }

  return null;
}

export function isSafeHttpOperationPath(path: string): boolean {
  return validateHttpOperationPath(path) === null;
}

/** Returns the first segment that becomes `.` or `..` under one or more percent-decode passes. */
export function repeatedlyDecodedDotSegmentIndex(path: string): number | undefined {
  const segments = path.split('/');
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    let current = segments[segmentIndex] as string;
    if (current === '.' || current === '..') return segmentIndex;

    while (hasPercentTriplet(current)) {
      const { decoded } = decodePercentLayer(current);
      if (decoded === '.' || decoded === '..') return segmentIndex;
      if (decoded === current) break;
      current = decoded;
    }
  }
  return undefined;
}
