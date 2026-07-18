# ADR 0001: Use a versioned Capability IR as the system boundary

- Status: Accepted
- Date: 2026-07-14

## Context

Generating a separate MCP server implementation for every API tightly couples contract parsing, tool semantics, transport behavior, and request execution. That makes it difficult to inspect what a model changed, reuse safety policy across sources, or validate a generated server without executing its source code.

HiMCP needs a common representation that can support multiple source formats, optional semantic enrichment, deterministic verification, more than one MCP transport, and reproducible artifacts.

## Decision

Define a schema-versioned Capability IR in `@hi-mcp/capability-ir` and make it the contract between adapters, compilers, verifiers, and runtimes.

The first version contains three related representations:

- normalized API documents and operations retain source fidelity and provenance;
- capabilities describe agent semantics, JSON Schema contracts, authentication metadata, conservative risk, and a deterministic execution plan;
- releases package capabilities, source identities, compiler metadata, diagnostics, and stable compilation evidence.

Canonical JSON serialization and SHA-256 fingerprints provide content identity. Stable IDs derive from fingerprints. Wall-clock timestamps and provider request IDs remain useful provenance but do not affect release identity.

Adapters emit normalized operations rather than MCP-specific objects. Runtimes consume verified capabilities rather than an original source document. New execution kinds require coordinated IR, verifier, and runtime support.

The HTTP execution portion of the first IR version records source-authoritative parameter style/content metadata, alternate request-body selectors, and success-response status/media contracts. Its accepted boundary is intentionally executable rather than merely descriptive:

- input paths and API-key parameter names exclude prototype-sensitive segments;
- operation paths and static URL-bound names exclude invalid Unicode and URL-normalization-sensitive delimiters, separators, encodings, and dot segments;
- source server templates retain provenance while executable resolved URLs use canonical WHATWG serialization;
- request and response media values use strict HTTP media syntax;
- success-response contracts contain only exact 2xx codes, `2XX`, or `default`;
- alternate request bodies share one input path and one selector contract.

The deterministic compiler can narrow source schemas when the wire representation requires a stricter domain. Base64 request bodies receive the shared canonical padded RFC 4648 constraint. Raw headers receive the HTTP field-value ByteString constraint, while URL-oriented parameter strings, form entries, and scalar text bodies receive the well-formed-Unicode constraint. JSON header content remains arbitrary JSON and is rendered as ASCII JSON escapes instead of being narrowed to Latin-1 source values. The verifier must prove that these constraints, media matching, and authentication targets fit the implemented runtime domain before the IR is executable.

## Consequences

Positive:

- Generated behavior is reviewable data instead of opaque generated code.
- Source adapters and MCP protocol versions can evolve independently.
- The same verifier and execution policy can cover every source adapter.
- Content-addressed artifacts support caching, diffs, and future attestations.
- Tests can target each boundary with fixtures.
- A source adapter may preserve a broad source schema while the generated MCP input schema safely narrows values that cannot be represented on the wire.

Costs and risks:

- IR evolution requires an explicit compatibility and migration policy.
- The representation must be expressive enough for new sources without becoming a generic code-execution format.
- A fingerprint proves content integrity, not publisher identity; signing remains separate.
- Unsupported API features must become diagnostics rather than ad hoc runtime behavior.
- Expanding a serializer or media-matching rule requires an IR-compatible contract, an independent verifier proof, and matching runtime behavior.

## Alternatives considered

### Generate TypeScript MCP servers directly

This provides flexibility but expands the review surface to arbitrary code and makes deterministic comparison difficult. Rejected as the primary artifact; code generation may still be an optional consumer of verified IR later.

### Expose OpenAPI operations directly at runtime

This removes an intermediate format but couples the runtime to OpenAPI semantics, prevents source-neutral adapters, and blurs compile-time review with run-time parsing. Rejected.

### Use MCP tool schemas as the only IR

MCP tool definitions do not contain enough source provenance, HTTP binding, authentication, risk authority, or release identity for deterministic execution. Rejected.

## Follow-up

- Define compatibility guarantees before `1.0`.
- Add release diff and migration tooling.
- Add cryptographic attestation without changing content identity semantics.
