import {
  isCanonicalPaddedBase64,
  isHttpFieldName,
  isHttpHeaderValue,
  isTransportControlledCredentialHeader,
  isWellFormedUnicode,
  repeatedlyDecodedDotSegmentIndex,
  validateHttpOperationPath,
} from '@hi-mcp/capability-ir';

import { ExecutionEngineError } from './errors.js';
import type {
  ExecutableHttpCapability,
  HttpMethod,
  JsonObject,
  JsonValue,
  ParameterBinding,
  RequestBodyBinding,
  ServerTarget,
} from './types.js';

const FORBIDDEN_BOUND_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
]);

export interface BoundHttpRequest {
  readonly url: URL;
  readonly method: HttpMethod;
  readonly headers: Headers;
  readonly body?: BodyInit;
  readonly requestBodyBinding?: RequestBodyBinding;
  readonly requestBodyValue?: JsonValue;
  readonly serverIndex: number;
}

interface LocatedValue {
  readonly found: boolean;
  readonly value?: JsonValue;
}

export function getValueAtPath(root: JsonValue, path: readonly string[]): LocatedValue {
  let current: JsonValue | undefined = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      return { found: false };
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      if (!Object.hasOwn(current, segment)) {
        return { found: false };
      }
      current = current[segment];
    }

    if (current === undefined) {
      return { found: false };
    }
  }

  return current === undefined ? { found: false } : { found: true, value: current };
}

function scalar(value: JsonValue): string {
  if (value !== null && typeof value === 'object') {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A structured value cannot be serialized as a scalar parameter.',
    });
  }
  return value === null ? 'null' : String(value);
}

function asciiJsonText(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A JSON parameter could not be serialized.',
    });
  }
  return serialized.replace(/[^\u0020-\u007e]/gu, (character) => {
    let escaped = '';
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`;
    }
    return escaped;
  });
}

function encodeBindingComponent(value: string): string {
  if (!isWellFormedUnicode(value)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A bound HTTP value contains an unpaired Unicode surrogate.',
    });
  }
  return encodeURIComponent(value);
}

function assertWellFormedWireValue(value: JsonValue): void {
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value)) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A bound HTTP value contains an unpaired Unicode surrogate.',
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertWellFormedWireValue);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (!isWellFormedUnicode(key)) {
        throw new ExecutionEngineError({
          code: 'BINDING_FAILED',
          message: 'A bound HTTP object key contains an unpaired Unicode surrogate.',
        });
      }
      assertWellFormedWireValue(child);
    }
  }
}

function serializeParameterContent(binding: ParameterBinding, value: JsonValue): string {
  const contentType = binding.contentType;
  if (contentType === undefined) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'Parameter content serialization requires a declared media type.',
    });
  }
  const essence = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (essence === 'application/json' || essence.endsWith('+json')) {
    const serialized = binding.location === 'header' ? asciiJsonText(value) : JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } else if (essence.startsWith('text/')) {
    const serialized = scalar(value);
    if (!isWellFormedUnicode(serialized)) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A text parameter contains an unpaired Unicode surrogate.',
      });
    }
    return serialized;
  }
  throw new ExecutionEngineError({
    code: 'BINDING_FAILED',
    message: `Parameter media type ${contentType} has no deterministic wire serializer.`,
    details: { parameter: binding.name, contentType },
  });
}

function sortedEntries(value: JsonObject): readonly [string, JsonValue][] {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function encoded(value: JsonValue): string {
  return encodeBindingComponent(scalar(value));
}

function serializeSimple(value: JsonValue, explode: boolean): string {
  if (Array.isArray(value)) {
    return value.map(encoded).join(',');
  }
  if (value !== null && typeof value === 'object') {
    return sortedEntries(value)
      .flatMap(([key, item]) =>
        explode
          ? [`${encodeBindingComponent(key)}=${encoded(item)}`]
          : [encodeBindingComponent(key), encoded(item)],
      )
      .join(',');
  }
  return encoded(value);
}

function serializePath(binding: ParameterBinding, value: JsonValue): string {
  const style = binding.style ?? 'simple';
  const explode = binding.explode ?? false;
  if (style === 'simple') {
    return serializeSimple(value, explode);
  }

  if (style === 'label') {
    if (Array.isArray(value)) {
      return `.${value.map(encoded).join(explode ? '.' : ',')}`;
    }
    if (value !== null && typeof value === 'object') {
      const entries = sortedEntries(value);
      return `.${entries
        .flatMap(([key, item]) =>
          explode
            ? [`${encodeBindingComponent(key)}=${encoded(item)}`]
            : [encodeBindingComponent(key), encoded(item)],
        )
        .join(explode ? '.' : ',')}`;
    }
    return `.${encoded(value)}`;
  }

  if (style === 'matrix') {
    const name = encodeBindingComponent(binding.name);
    if (Array.isArray(value)) {
      return explode
        ? value.map((item) => `;${name}=${encoded(item)}`).join('')
        : `;${name}=${value.map(encoded).join(',')}`;
    }
    if (value !== null && typeof value === 'object') {
      const entries = sortedEntries(value);
      return explode
        ? entries.map(([key, item]) => `;${encodeBindingComponent(key)}=${encoded(item)}`).join('')
        : `;${name}=${entries
            .flatMap(([key, item]) => [encodeBindingComponent(key), encoded(item)])
            .join(',')}`;
    }
    return `;${name}=${encoded(value)}`;
  }

  throw new ExecutionEngineError({
    code: 'BINDING_FAILED',
    message: 'The compiled path parameter uses an unsupported serialization style.',
    details: { parameter: binding.name, style },
  });
}

function appendQuery(url: URL, binding: ParameterBinding, value: JsonValue): void {
  assertWellFormedWireValue(value);
  const style = binding.style ?? 'form';
  const explode = binding.explode ?? true;
  if (style === 'deepObject') {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A deepObject query parameter requires an object value.',
        details: { parameter: binding.name },
      });
    }
    for (const [key, item] of sortedEntries(value)) {
      url.searchParams.append(`${binding.name}[${key}]`, scalar(item));
    }
    return;
  }

  if (Array.isArray(value)) {
    if (style === 'spaceDelimited' || style === 'pipeDelimited') {
      const delimiter = style === 'spaceDelimited' ? ' ' : '|';
      url.searchParams.append(binding.name, value.map(scalar).join(delimiter));
      return;
    }
    if (explode) {
      for (const item of value) {
        url.searchParams.append(binding.name, scalar(item));
      }
      return;
    }
    url.searchParams.append(binding.name, value.map(scalar).join(','));
    return;
  }

  if (value !== null && typeof value === 'object') {
    const entries = sortedEntries(value);
    if (explode) {
      for (const [key, item] of entries) {
        url.searchParams.append(key, scalar(item));
      }
      return;
    }
    url.searchParams.append(
      binding.name,
      entries.flatMap(([key, item]) => [key, scalar(item)]).join(','),
    );
    return;
  }

  url.searchParams.append(binding.name, scalar(value));
}

function assertBindableHeader(name: string, value: string): void {
  const normalized = name.trim().toLowerCase();
  if (FORBIDDEN_BOUND_HEADERS.has(normalized)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A sensitive or transport-controlled header cannot be bound from tool input.',
      details: { header: normalized },
    });
  }
  if (!isHttpFieldName(name) || !isHttpHeaderValue(value)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The compiled header binding produced an invalid header.',
      details: { header: normalized },
    });
  }
}

function serializeHeader(binding: ParameterBinding, value: JsonValue): string {
  return decodeURIComponent(serializeSimple(value, binding.explode ?? false));
}

function resolveServerVariable(
  value: string | { readonly default?: string } | undefined,
): string | undefined {
  return typeof value === 'string' ? value : value?.default;
}

export function resolveServerUrl(server: ServerTarget): URL {
  if (
    !isWellFormedUnicode(server.template) ||
    (server.resolvedUrl !== undefined && !isWellFormedUnicode(server.resolvedUrl)) ||
    Object.entries(server.variables ?? {}).some(
      ([name, variable]) =>
        !isWellFormedUnicode(name) ||
        !isWellFormedUnicode(variable.default) ||
        variable.enum?.some((value) => !isWellFormedUnicode(value)) === true,
    )
  ) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The selected server target contains an unpaired Unicode surrogate.',
    });
  }
  let rawUrl = server.resolvedUrl ?? server.template;
  rawUrl = rawUrl.replaceAll(/\{([^{}]+)\}/g, (placeholder: string, variableName: string) => {
    const value = resolveServerVariable(server.variables?.[variableName]);
    return value === undefined ? placeholder : encodeBindingComponent(value);
  });

  if (/\{[^{}]+\}/.test(rawUrl)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The selected server URL has unresolved variables.',
    });
  }
  if (!isWellFormedUnicode(rawUrl)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The resolved server URL contains an unpaired Unicode surrogate.',
    });
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The selected server URL is invalid.',
      cause,
    });
  }
  if (server.resolvedUrl !== undefined && url.toString() !== server.resolvedUrl) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The selected resolved server URL is not in canonical WHATWG form.',
    });
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'Server URLs cannot contain a query string or fragment.',
    });
  }
  return url;
}

function joinPath(basePath: string, operationPath: string): string {
  const base = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const operation = operationPath.replace(/^\//, '');
  return `${base}/${operation}` || '/';
}

function canonicalPathBoundary(pathname: string): string {
  if (pathname === '/') return '/';
  const withoutTrailingSlashes = pathname.replace(/\/+$/u, '');
  return withoutTrailingSlashes.length === 0 ? '/' : withoutTrailingSlashes;
}

function pathIsWithinBase(basePathname: string, candidatePathname: string): boolean {
  const boundary = canonicalPathBoundary(basePathname);
  return (
    boundary === '/' ||
    candidatePathname === boundary ||
    candidatePathname.startsWith(`${boundary}/`)
  );
}

function assertSafeOperationPath(path: string): void {
  const issue = validateHttpOperationPath(path);
  if (issue === null) return;
  throw new ExecutionEngineError({
    code: 'BINDING_FAILED',
    message: issue.message,
    details: {
      reason: issue.code,
      ...(issue.segmentIndex === undefined ? {} : { segmentIndex: issue.segmentIndex }),
    },
  });
}

function formBody(value: JsonValue): URLSearchParams {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A form request body requires an object value.',
    });
  }

  const params = new URLSearchParams();
  for (const [key, item] of sortedEntries(value)) {
    if (!isWellFormedUnicode(key)) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A form field name contains an unpaired Unicode surrogate.',
      });
    }
    if (Array.isArray(item)) {
      for (const element of item) {
        const serialized = scalar(element);
        if (!isWellFormedUnicode(serialized)) {
          throw new ExecutionEngineError({
            code: 'BINDING_FAILED',
            message: 'A form field value contains an unpaired Unicode surrogate.',
          });
        }
        params.append(key, serialized);
      }
    } else {
      const serialized = scalar(item);
      if (!isWellFormedUnicode(serialized)) {
        throw new ExecutionEngineError({
          code: 'BINDING_FAILED',
          message: 'A form field value contains an unpaired Unicode surrogate.',
        });
      }
      params.append(key, serialized);
    }
  }
  return params;
}

function serializeRequestBody(
  binding: RequestBodyBinding,
  value: JsonValue,
): { readonly body: BodyInit; readonly contentType: string } {
  const contentType = binding.contentType.split(';', 1)[0]?.trim().toLowerCase();
  const serialization =
    binding.serialization ??
    (contentType === 'application/json' || contentType?.endsWith('+json') === true
      ? 'json'
      : contentType === 'application/x-www-form-urlencoded'
        ? 'form'
        : contentType?.startsWith('text/') === true
          ? 'text'
          : undefined);
  if (serialization === 'json') {
    return { body: JSON.stringify(value), contentType: binding.contentType };
  }
  if (serialization === 'form') {
    return { body: formBody(value), contentType: binding.contentType };
  }
  if (serialization === 'text') {
    const text = scalar(value);
    if (!isWellFormedUnicode(text)) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A text request body contains an unpaired Unicode surrogate.',
      });
    }
    return { body: text, contentType: binding.contentType };
  }
  if (serialization === 'base64') {
    if (typeof value !== 'string' || !isCanonicalPaddedBase64(value)) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A base64 request body must use canonical padded base64 text.',
      });
    }
    const decoded = Buffer.from(value, 'base64');
    return { body: decoded, contentType: binding.contentType };
  }
  throw new ExecutionEngineError({
    code: 'BINDING_FAILED',
    message: 'The compiled request body requires an explicit supported serialization.',
    details: {
      contentType: binding.contentType,
      ...(binding.serialization === undefined ? {} : { serialization: binding.serialization }),
    },
  });
}

function selectRequestBody(
  bindings: readonly RequestBodyBinding[],
  input: JsonValue,
  matchesSchema?: (schema: RequestBodyBinding['schema'], value: JsonValue) => boolean,
): { readonly binding: RequestBodyBinding; readonly value: JsonValue } | undefined {
  const groups = new Map<
    string,
    { readonly inputPath: readonly string[]; readonly bindings: RequestBodyBinding[] }
  >();
  for (const binding of bindings) {
    const key = JSON.stringify(binding.inputPath);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { inputPath: binding.inputPath, bindings: [binding] });
    } else {
      existing.bindings.push(binding);
    }
  }

  const candidates: Array<{ readonly binding: RequestBodyBinding; readonly value: JsonValue }> = [];
  for (const group of groups.values()) {
    const located = getValueAtPath(input, group.inputPath);
    const selectorPaths = new Map<string, readonly string[]>();
    for (const binding of group.bindings) {
      if (binding.contentTypeInputPath !== undefined) {
        selectorPaths.set(
          JSON.stringify(binding.contentTypeInputPath),
          binding.contentTypeInputPath,
        );
      }
    }
    if (
      selectorPaths.size > 1 ||
      (selectorPaths.size === 1 &&
        group.bindings.some((binding) => binding.contentTypeInputPath === undefined))
    ) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message:
          'The compiled request body representations use inconsistent content-type selectors.',
        details: { inputPath: [...group.inputPath] },
      });
    }

    const selectorPath = [...selectorPaths.values()][0];
    const selected =
      selectorPath === undefined ? { found: false as const } : getValueAtPath(input, selectorPath);
    if (!located.found || located.value === undefined) {
      if (selected.found && selected.value !== undefined) {
        throw new ExecutionEngineError({
          code: 'BINDING_FAILED',
          message: 'A request content-type selector was supplied without its request body.',
          details: { inputPath: [...group.inputPath], selectorPath: [...selectorPath!] },
        });
      }
      continue;
    }

    if (selectorPath === undefined) {
      candidates.push(
        ...group.bindings.map((binding) => ({ binding, value: located.value as JsonValue })),
      );
      continue;
    }
    if (!selected.found || selected.value === undefined) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A request body with multiple representations requires a content-type selector.',
        details: { inputPath: [...group.inputPath], selectorPath: [...selectorPath] },
      });
    }
    if (typeof selected.value !== 'string') {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'The request content-type selector must be a string.',
        details: { selectorPath: [...selectorPath] },
      });
    }
    const matchingRepresentations = group.bindings.filter(
      (binding) => binding.contentType === selected.value,
    );
    if (matchingRepresentations.length !== 1) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message:
          matchingRepresentations.length === 0
            ? 'The requested content type is not a declared request body representation.'
            : 'The requested content type identifies multiple request body representations.',
        details: {
          selectorPath: [...selectorPath],
          selectedContentType: selected.value,
          contentTypes: group.bindings.map(({ contentType }) => contentType),
        },
      });
    }
    candidates.push({ binding: matchingRepresentations[0]!, value: located.value });
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    const matching =
      matchesSchema === undefined
        ? candidates
        : candidates.filter(({ binding, value }) => matchesSchema(binding.schema, value));
    if (matching.length === 1) {
      return matching[0];
    }
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message:
        matching.length === 0
          ? 'The request body does not match any declared media-type schema.'
          : 'The request body matches multiple media types and cannot be selected unambiguously.',
      details: {
        contentTypes: (matching.length === 0 ? candidates : matching).map(
          ({ binding }) => binding.contentType,
        ),
      },
    });
  }

  const required = bindings.find((binding) => binding.required);
  if (required !== undefined) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A required request body value is missing.',
      details: { inputPath: [...required.inputPath] },
    });
  }
  return undefined;
}

export function bindHttpRequest(
  capability: ExecutableHttpCapability,
  input: JsonValue,
  serverIndex = 0,
  matchesRequestBodySchema?: (schema: RequestBodyBinding['schema'], value: JsonValue) => boolean,
): BoundHttpRequest {
  const execution = capability.execution;
  const method = execution.method.toUpperCase() as HttpMethod;
  const server = execution.servers[serverIndex];
  if (server === undefined) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The requested server target does not exist in the compiled execution plan.',
      details: { serverIndex },
    });
  }

  const url = resolveServerUrl(server);
  const basePathname = url.pathname;
  let operationPath = execution.pathTemplate;
  assertSafeOperationPath(operationPath);
  const headers = new Headers();
  const cookies: string[] = [];

  for (const binding of execution.parameterBindings) {
    if (
      (binding.location === 'path' || binding.location === 'query') &&
      !isWellFormedUnicode(binding.name)
    ) {
      throw new ExecutionEngineError({
        code: 'BINDING_FAILED',
        message: 'A compiled path or query parameter name contains an unpaired Unicode surrogate.',
        details: { location: binding.location },
      });
    }
    const located = getValueAtPath(input, binding.inputPath);
    if (!located.found || located.value === undefined) {
      if (binding.required) {
        throw new ExecutionEngineError({
          code: 'BINDING_FAILED',
          message: 'A required execution parameter is missing.',
          details: {
            location: binding.location,
            parameter: binding.name,
            inputPath: [...binding.inputPath],
          },
        });
      }
      continue;
    }

    const contentValue =
      binding.contentType === undefined
        ? undefined
        : serializeParameterContent(binding, located.value);

    if (binding.location === 'path') {
      const placeholder = `{${binding.name}}`;
      if (!operationPath.includes(placeholder)) {
        throw new ExecutionEngineError({
          code: 'BINDING_FAILED',
          message: 'A compiled path binding has no matching path-template placeholder.',
          details: { parameter: binding.name },
        });
      }
      operationPath = operationPath.replaceAll(
        placeholder,
        contentValue === undefined
          ? serializePath(binding, located.value)
          : encodeBindingComponent(contentValue),
      );
    } else if (binding.location === 'query') {
      if (contentValue === undefined) appendQuery(url, binding, located.value);
      else url.searchParams.append(binding.name, contentValue);
    } else if (binding.location === 'header') {
      const serialized = contentValue ?? serializeHeader(binding, located.value);
      assertBindableHeader(binding.name, serialized);
      headers.set(binding.name, serialized);
    } else {
      const serialized = contentValue ?? scalar(located.value);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(binding.name)) {
        throw new ExecutionEngineError({
          code: 'BINDING_FAILED',
          message: 'The compiled cookie binding produced an invalid cookie parameter.',
          details: { parameter: binding.name },
        });
      }
      cookies.push(`${encodeBindingComponent(binding.name)}=${encodeBindingComponent(serialized)}`);
    }
  }

  if (/\{[^{}]+\}/.test(operationPath)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The operation path has unresolved parameters after binding.',
    });
  }
  const dotSegmentIndex = repeatedlyDecodedDotSegmentIndex(operationPath);
  if (dotSegmentIndex !== undefined) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'A bound path parameter would create a literal or repeatedly encoded dot segment.',
      details: { segmentIndex: dotSegmentIndex },
    });
  }
  const candidatePathname = joinPath(basePathname, operationPath);
  const candidateUrl = new URL(url);
  candidateUrl.pathname = candidatePathname;
  if (!pathIsWithinBase(basePathname, candidateUrl.pathname)) {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The bound operation path would escape the compiled server base path.',
      details: { basePathname, candidatePathname: candidateUrl.pathname },
    });
  }
  url.pathname = candidateUrl.pathname;
  if (cookies.length > 0) {
    headers.set('cookie', cookies.join('; '));
  }

  const acceptedContentTypes = [
    ...new Set(
      execution.successResponses
        .map((response: (typeof execution.successResponses)[number]) => response.contentType)
        .filter(
          (contentType: string | undefined): contentType is string => contentType !== undefined,
        ),
    ),
  ];
  if (acceptedContentTypes.length > 0) {
    headers.set('accept', acceptedContentTypes.join(', '));
  }

  const selectedBody = selectRequestBody(execution.requestBodies, input, matchesRequestBodySchema);
  if (selectedBody === undefined) {
    return { url, method, headers, serverIndex };
  }
  if (method === 'GET' || method === 'HEAD') {
    throw new ExecutionEngineError({
      code: 'BINDING_FAILED',
      message: 'The compiled execution attempts to attach a body to a GET or HEAD request.',
    });
  }

  const serializedBody = serializeRequestBody(selectedBody.binding, selectedBody.value);
  headers.set('content-type', serializedBody.contentType);
  return {
    url,
    method,
    headers,
    body: serializedBody.body,
    requestBodyBinding: selectedBody.binding,
    requestBodyValue: selectedBody.value,
    serverIndex,
  };
}

export function assertCredentialHeader(name: string, value: string): void {
  const normalized = name.trim().toLowerCase();
  if (
    isTransportControlledCredentialHeader(normalized) ||
    !isHttpFieldName(name) ||
    !isHttpHeaderValue(value)
  ) {
    throw new ExecutionEngineError({
      code: 'CREDENTIAL_RESOLUTION_FAILED',
      message: 'The credential provider returned an invalid HTTP header.',
    });
  }
}

export function credentialCookie(name: string, value: string): string {
  if (
    !isHttpFieldName(name) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !isWellFormedUnicode(value)
  ) {
    throw new ExecutionEngineError({
      code: 'CREDENTIAL_RESOLUTION_FAILED',
      message: 'The credential provider returned an invalid HTTP cookie.',
    });
  }
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}
