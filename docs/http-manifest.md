# Registering an HTTP API without OpenAPI

HiMCP's HTTP manifest is a strict, declarative contract for APIs that do not publish OpenAPI. It describes executable HTTP behavior; credential values remain outside the manifest, release, connection profile, and MCP launcher descriptor.

Use the manifest when an API can be represented as HTTP requests and bounded JSON or UTF-8 responses. REST endpoints, GraphQL over HTTP, and SOAP/XML over HTTP fit this model. Native gRPC, arbitrary SDK calls, multipart requests, streaming, and binary responses require a future execution driver or manifest extension.

## Minimal manifest

```yaml
schemaVersion: '1.0'
kind: http
id: customer-api
title: Customer API
servers:
  - url: https://api.example.com/v1

operations:
  - id: getCustomer
    method: GET
    path: /customers/{customerId}
    parameters:
      - in: path
        name: customerId
        schema:
          type: string
          minLength: 1
    successResponses:
      - statusCode: '200'
        contentType: application/json
        schema:
          type: object
          required: [id]
          properties:
            id:
              type: string
```

Register and source-ground the result with the same adapter registry used for OpenAPI:

```bash
node apps/cli/dist/bin.js analyze api.http.yaml --source-type auto
node apps/cli/dist/bin.js register api.http.yaml \
  --source-type http-manifest \
  --output api.release.json
node apps/cli/dist/bin.js validate api.release.json \
  --source api.http.yaml \
  --source-type http-manifest
```

`auto` succeeds only when one registered adapter has a unique winning probe. An unknown or ambiguous source fails closed instead of being guessed.

## Servers and operations

The root `servers` array is required. An operation can replace it with its own non-empty `servers` array. Each server contains a URL and an optional description. Absolute HTTPS URLs are recommended. A relative URL is resolved only when the compiler configuration supplies an explicit `compile.baseUrl`; unresolved or non-HTTP targets fail verification.

Each operation requires:

- a stable `id`;
- an HTTP `method` and slash-prefixed `path`;
- at least one `successResponses` entry whose status is an exact 2xx code, a `2XX` class, or `default`.

Operation IDs and method/path pairs must be unique. HiMCP derives stable operation, capability, and release identities from canonical source content rather than array position or a local checkout path. MCP tool names are normalized from operation IDs; if different IDs normalize to the same name, the compiler adds a stable operation-derived suffix instead of relying on declaration order.

An operation path must start with `/` and remain structurally identical when assigned to a WHATWG URL. C0/DEL characters, unpaired Unicode surrogates, `?`, `#`, backslashes, malformed or invalid-UTF-8 percent encoding, encoded slash or backslash separators, and literal or repeatedly percent-encoded `.`/`..` segments are rejected. Path/query parameter names, query API-key names, server URLs, and server-variable names and values also require well-formed Unicode. Bound path and fallback server-variable values are percent-encoded normally; after binding, the runtime rejects any value that becomes a dot segment and confirms that the final pathname remains below the selected server's base path.

The source `url` remains in the server target's `template` for provenance. Its executable `resolvedUrl` is stored using `new URL(...).toString()`, and verification rejects a non-canonical resolved URL so later WHATWG parsing cannot silently rewrite the recorded endpoint.

`method` accepts a canonical uppercase HTTP token, including registered extension methods such as `PROPFIND`. Extension methods without authoritative `risk` metadata compile as unknown, confirmation-required operations. The stock fetch boundary always rejects `CONNECT`, `TRACE`, and `TRACK` because Node's HTTP transport cannot execute them safely and consistently.

## Parameters and input paths

Parameters support `path`, `query`, `header`, and `cookie` locations. When `inputPath` is omitted, the MCP argument path is `[location, name]`. For example, the manifest above produces input shaped like this:

```json
{
  "path": {
    "customerId": "cus_123"
  }
}
```

An explicit path can make a tool contract more natural:

```yaml
parameters:
  - in: query
    name: q
    inputPath: [searchText]
    required: true
    schema:
      type: string
```

Input paths within one operation cannot overlap as a strict prefix, such as `[payload]` and `[payload, child]`. Parameter targets cannot be declared twice. These cases fail during adaptation so invalid normalized data never reaches the baseline compiler.

Every path segment is non-empty and rejects the prototype-sensitive names `__proto__`, `prototype`, and `constructor`. The same names are rejected when used as API-key parameter names. Runtime argument lookup uses own-property checks, and credential maps do not inherit from ordinary object prototypes.

Serialization metadata is source-authoritative. Only styles implemented by the HTTP engine are accepted by deterministic verification: `simple`, `label`, and `matrix` for path parameters; `form`, `spaceDelimited`, `pipeDelimited`, and `deepObject` for query parameters; `simple` for headers; and `form` for cookies. Style-based serialization accepts only values whose schema proves they are a scalar, a scalar array, or a closed shallow object with scalar property values. `deepObject` is narrower: it requires a closed shallow object with scalar property values. Cookie parameters are scalar-only. Unconstrained objects, nested arrays or objects, and open-ended additional properties fail verification instead of being stringified implicitly.

The compiler also intersects these source schemas with a destination-specific text constraint. A raw header string must begin and end with VCHAR or Latin-1 `obs-text`; HTAB/SP are permitted only internally because Fetch trims them at the edges. String values and property names used by style-based path, query, and cookie serialization must be well-formed Unicode and cannot contain a lone UTF-16 surrogate. The verifier proves the generated MCP schema carries the matching constraint, and runtime binding applies the paired predicate before dispatch. Cookie names and values are percent-encoded as components, so `;`, `=`, whitespace, or another delimiter in a tool value cannot create a second cookie.

A parameter can use `contentType` instead of `style` and `explode`:

```yaml
parameters:
  - in: query
    name: filter
    contentType: application/json
    schema:
      type: object
      additionalProperties: false
      properties:
        active:
          type: boolean
```

`application/json` and concrete media types ending in `+json` serialize the complete JSON value. Concrete `text/*` parameter content accepts scalar values only. Wildcard or other parameter media types, and any combination of `contentType` with `style` or `explode`, fail verification. Query `allowReserved: true` also fails closed because emitting reserved delimiters without encoding could change the URL structure; `allowReserved: false` follows normal encoding.

JSON content in a header is not reduced to the raw-header scalar domain. It preserves the complete JSON value, serializes it with JSON semantics, and converts every non-ASCII UTF-16 unit to an ASCII `\uXXXX` escape before validating the resulting field value. Supplementary characters therefore use their two JSON surrogate escapes without placing non-ByteString characters on the HTTP wire.

## Request bodies

Each request body declares its media type, schema, input path, and whether it is required. The default input path is `[body]`.

```yaml
requestBodies:
  - contentType: application/json
    required: true
    schema:
      type: object
      additionalProperties: false
      required: [message]
      properties:
        message:
          type: string
```

Wire serialization is inferred only for formats with an unambiguous built-in mapping:

| Media type or declaration                                  | Serialization                         |
| ---------------------------------------------------------- | ------------------------------------- |
| `application/json` or a concrete subtype ending in `+json` | JSON                                  |
| `application/x-www-form-urlencoded`                        | form                                  |
| a concrete `text/*` media type                             | UTF-8 text                            |
| any concrete media type with `serialization: text`         | scalar UTF-8 text, including XML      |
| any concrete media type with `serialization: base64`       | canonical padded base64 decoded bytes |

Request `contentType` values must be concrete syntactically valid HTTP media types; wildcard ranges and control characters are rejected. Nonstandard media types must declare `serialization` explicitly. `form` requires a closed shallow object whose entries are scalars or scalar arrays, and `text` requires a scalar-only schema. Multipart metadata and per-property OpenAPI `encoding` rules are not implemented by this manifest version.

For form bodies, the generated MCP schema constrains every field name and string entry to well-formed Unicode. The same constraint is added to the string branch of a scalar text body. Runtime form/text serialization checks the same condition and raises `BINDING_FAILED` for a lone surrogate instead of allowing URL or Fetch conversion to replace it silently.

For `serialization: base64`, the source schema may be a general string schema. The deterministic compiler intersects the generated MCP input field with the shared canonical padded RFC 4648 base64 constraint, including valid padding and zero pad bits. The verifier proves that the resulting wire input admits only canonical base64, and the runtime checks the same predicate before decoding. Unpadded, over-padded, whitespace-containing, or non-canonical inputs therefore fail before request dispatch.

Multiple request media types represent alternatives for the same HTTP body, so they must share one `inputPath` and one `required` state. The adapter creates a collision-free selector beside that input path: `[body]` becomes `[bodyContentType]`, and `[payload]` becomes `[payloadContentType]`. A manifest can set the same explicit `contentTypeInputPath` on every representation when another tool-input shape is preferred.

```yaml
requestBodies:
  - contentType: application/graphql
    serialization: text
    inputPath: [body]
    required: true
    schema:
      type: string
  - contentType: text/plain
    serialization: text
    inputPath: [body]
    required: true
    schema:
      type: string
```

The generated MCP input requires both values:

```json
{
  "body": "query { viewer { id } }",
  "bodyContentType": "application/graphql"
}
```

The selector is constrained to the declared media types and is checked again during HTTP binding. This remains deterministic when two representations have identical JSON Schemas; missing, unknown, duplicate, or inconsistent selectors fail closed. A selector without its body is also rejected.

The generated input schema ties each selector value to the corresponding body schema and serializer domain. Choosing a JSON representation cannot validate against a text representation merely because both alternatives share the same body path.

GraphQL over HTTP can use a JSON body or `application/graphql` with `serialization: text`. SOAP can use `application/soap+xml` with `serialization: text`:

```yaml
requestBodies:
  - contentType: application/soap+xml
    serialization: text
    required: true
    schema:
      type: string
```

## Authentication metadata

Authentication declares where a runtime credential belongs, never its value.

```yaml
securitySchemes:
  serviceKey:
    type: apiKey
    location: header
    parameterName: X-Service-Key
  bearerToken:
    type: http
    scheme: bearer

security:
  - - scheme: serviceKey
      scopes: []
  - - scheme: bearerToken
      scopes: []
```

The outer `security` array is OR and each inner array is AND. The example accepts either the API key or the bearer token. An operation can override root security.

Credential injection targets are derived from the declared scheme at verification time. Two required schemes cannot claim the same normalized header, query, or cookie target, and an MCP-controlled parameter cannot claim a target used by authentication. API-key header and cookie names must be valid HTTP tokens. Routing and framing headers (`Host`, `Connection`, `Content-Length`, and `Transfer-Encoding`) cannot be API-key header targets. Header target comparisons are case-insensitive. Conventional names such as `X-API-Key` remain available for ordinary tool input when no authentication scheme owns that target.

Runtime credential material is checked independently of MCP arguments. Credential headers must fit the same raw field-value domain without edge whitespace, credential query names and values must be well-formed Unicode, and credential cookies reject control characters or lone surrogates before component encoding. A violation is reported as `CREDENTIAL_RESOLUTION_FAILED`, not a generic upstream or parsing failure.

The stock connection profile can resolve these static environment-backed forms:

- API keys in a header, query parameter, or cookie;
- HTTP Basic or Bearer material;
- an already-issued OAuth 2.0 or OpenID Connect bearer token.

Digest challenges, HMAC request signing, OAuth token refresh, mTLS, and custom schemes need a purpose-built `CredentialProvider`. If a required capability has no complete authentication alternative supported by the stock profile, profile creation is rejected.

Create a reviewed connection without placing the secret in an artifact:

```bash
node apps/cli/dist/bin.js connection create api.release.json \
  --name 'Customer API' \
  --approve-origin https://api.example.com \
  --credential-env serviceKey=CUSTOMER_API_KEY \
  --output api.connection.json

node apps/cli/dist/bin.js connection export api.connection.json \
  --output mcp.json

CUSTOMER_API_KEY='resolved-at-process-start' \
  node apps/cli/dist/bin.js serve-profile api.connection.json
```

The connection profile stores the environment variable name, exact approved origins, and release identity. It does not store the environment value. The generated default names are scoped by the release fingerprint and scheme so credentials from unrelated APIs cannot be confused.

## Risk and confirmation

When `risk` is omitted, the deterministic compiler derives a conservative contract from the HTTP method. A nonconforming endpoint can provide stricter authoritative metadata, such as a side-effecting GET, but a write or destructive override must require confirmation.

```yaml
risk:
  level: write
  sideEffect: definite
  idempotency: non-idempotent
  requiresConfirmation: true
  rationale:
    - The upstream GET advances a server-side cursor.
```

The runtime enforces `requiresConfirmation`; MCP annotations alone are not the security boundary. A profile defaults to the safe `per-call` state. The current stdio profile has no interactive callback, so confirmation-required calls remain blocked unless the operator explicitly creates the profile with `--approve-confirmation-required`, which grants coarse process-wide approval.

## Output and current limits

Success responses describe expected status/media/schema contracts. The manifest accepts only exact 2xx codes such as `200`, one-digit class ranges such as `2XX`, and `default`. Runtime success is always restricted to the actual 200-299 status range, so a `default` contract can describe a previously unspecified 2xx response but never turns a 4xx or 5xx response into success.

For an actual status, selection uses the first non-empty tier in this order: exact status, matching class, then `default`. Within that tier, a matching typed media contract is preferred over a single untyped fallback. Supported response media contracts are concrete media types, `*/*`, `type/*`, `type/*+suffix`, and `*/*+suffix`; parameters must use valid HTTP media syntax. Contracts whose media ranges overlap inside the same status tier are rejected because declaration order would otherwise affect execution. Overlap across different status tiers is valid because status precedence is explicit.

Bodies are bounded, decoded as UTF-8 JSON or text, complexity-checked, and schema-validated against the selected response and capability output contracts. Binary response preservation and arbitrary content encodings/codecs are not implemented.

The `1.0` manifest intentionally has no opaque code hook. Unsupported behavior becomes a diagnostic instead of generated or dynamically evaluated code. Current gaps include multipart upload, streaming, binary response preservation, arbitrary response codecs, WebSocket protocols, native gRPC, and SDK-only APIs. New protocols should be added as a coordinated source schema, deterministic verifier, and execution driver rather than as unverified model output.
