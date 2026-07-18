# ADR 0004: Add a source adapter registry and reviewed connection profiles

- Status: Accepted
- Date: 2026-07-14

## Context

An API-to-MCP project cannot assume that every service publishes OpenAPI. APIs may expose a conventional REST contract, GraphQL or SOAP over HTTP, an incomplete document, or only human-readable integration guidance. Hard-coding more source formats into one parser would couple format detection, normalization, compilation, and runtime behavior. Letting a model generate arbitrary executable adapters would remove the deterministic security boundary.

A verified release also does not answer deployment-specific questions: which exact origins has the operator reviewed, how will the local AI tool launch the MCP process, which secret names will be injected, and whether confirmation-required calls have an approval mechanism. Adding these values directly to a release would mix portable source truth with local policy and could turn a reviewable artifact into a secret-bearing configuration.

## Decision

### Select source behavior through a registry

Define a source-neutral `SourceAdapter` contract with a bounded `probe` and `adapt` operation. Every adapter must produce the shared `NormalizedApiDocument` and structured diagnostics; downstream compilation, semantic enrichment, verification, and execution do not depend on the original format.

The built-in registry contains `openapi` and `http-manifest`. `--source-type auto` runs registered probes and selects only a unique winner above the confidence threshold. Unknown inputs and equal winning confidence fail closed. `--source-type openapi` and `--source-type http-manifest` make selection explicit. Embeddings may add adapters without changing the pipeline.

Keep `compile` as the implementation command and add `register` as its API-registration alias. Both execute the same deterministic compile and verification path; the alias does not create a second artifact format or hidden registry.

The manual HTTP manifest is strict data, not code. It declares servers, operations, parameters, request bodies, 2xx/default success responses, authentication, and optional risk. Parameter content has deterministic serializers for JSON/concrete `+json` values and scalar `text/*`; style-based parameter serializers accept only provably scalar, scalar-array, or closed shallow-object domains. URL-encoded forms are closed shallow objects whose entries are scalars or scalar arrays. Query `allowReserved: true`, nested structured wire values, style/content conflicts, wildcard request media ranges, malformed media syntax, and unsupported encodings fail verification.

Text serializers share explicit compiler, verifier, and runtime contracts. Raw headers require VCHAR or Latin-1 `obs-text` at their edges and accept HTAB/SP only internally, avoiding Fetch whitespace normalization; URL-oriented parameters, form entries, and scalar text bodies require well-formed Unicode. JSON header content preserves arbitrary JSON by escaping non-ASCII UTF-16 units into ASCII JSON text. Cookie components are percent-encoded, and invalid tool or credential text fails with its corresponding typed binding or credential-resolution error before dispatch.

Operation paths use a shared URL-stability rule across the manifest, normalized IR, verifier, and runtime. Invalid Unicode, encoded separators, and repeatedly decoded dot segments fail closed. Path/query names, query API-key targets, and server variables require well-formed Unicode; executable resolved server URLs are canonicalized. The runtime confirms the bound WHATWG pathname remains within the selected server base path.

Supported body serializers are JSON, URL-encoded shallow form, scalar text, and canonical base64 decoded to request bytes. The compiler intersects a base64 body field with a shared canonical padded RFC 4648 schema, and the runtime uses the same predicate before decoding. Alternate request media types must share one body input path and required state. Their source adapter emits one collision-free content-type selector path whose schema enumerates the declared media types; the compiler also ties each selector choice to its body schema and wire domain, and the runtime checks the selector again before choosing a representation. This covers REST, GraphQL over HTTP, explicitly declared SOAP/XML, and opaque HTTP request payloads even when alternate representations have identical schemas.

Response execution accepts only actual 2xx statuses. It chooses the exact status contract before a matching class and then `default`, preferring matching typed media over one untyped fallback inside the selected tier. A runtime content-type allowlist can only narrow that selected source contract; missing-content-type policy cannot bypass a typed-only response. The verifier rejects media intersections within a tier so declaration order cannot select behavior. Multipart requests, custom per-property form encodings, response streaming or binary preservation, native gRPC, WebSockets, SDK-only calls, and non-HTTP transports remain unsupported until a source schema, verifier, and execution driver are designed together.

OpenAPI external references remain disabled in the stock CLI. A library resolver may provide them under bounded sanitization. Nested relative references are scoped to the containing external document URI, and supported recursive external schema graphs are bundled into deterministic local `$defs`. External `$dynamicRef` and `$recursiveRef` targets remain unsupported. Accepted resolver results are fingerprinted as a deterministic scoped-reference-sorted dependency graph and incorporated into the normalized document fingerprint, while the resolver remains trusted for fetching and reproducibility. OpenAPI 3.0 ignores standalone Reference Object and Schema Object `$ref` siblings; OpenAPI 3.1 preserves Schema JSON Schema siblings and Reference Object `summary`/`description`. The adapter also converts OpenAPI 3.0 `nullable` and boolean exclusive-bound keywords into the shared JSON Schema dialect.

Input-path segments and API-key parameter names exclude prototype-sensitive keys. Header and cookie API-key names must also be valid HTTP tokens, and routing/framing headers cannot be credential targets. Authentication targets are derived from the schemes and cannot collide with another credential scheme or MCP-controlled parameter target. Operation IDs still determine the preferred MCP tool name, but collisions after normalization receive stable operation-derived suffixes rather than depending on source order.

### Separate connection review from the release

Add a content-addressed connection profile that references a persistent release by path, ID, and fingerprint. The profile records every exact canonical release origin, plain-HTTP policy, confirmation mode, and credential binding metadata. It stores environment-variable names, never credential values.

`connection create` verifies the release and requires the operator to approve every and only its derived origins. It derives environment names from release identity and scheme, while allowing an explicit `<scheme=ENV_NAME>` name override. Profile creation fails if a required capability has no complete authentication alternative representable by the stock static broker.

The broker supports API keys in headers, query parameters, or cookies; HTTP Basic and Bearer material; and already-issued OAuth 2.0 or OpenID Connect bearer tokens. Digest challenges, HMAC or custom request signing, mTLS, OAuth acquisition and refresh, discovery, and other dynamic authentication require an embedding.

`connection export` verifies the profile and release and emits a product-neutral `mcpServers` descriptor. It uses a direct executable and argument array to launch `dist/bin.js serve-profile <absolute-profile-path>`, with no shell and no inline environment values.

`serve-profile` verifies both artifacts again. It selects the first compiled server for each capability, checks that server's exact origin against the profile, supplies only that origin to execution policy, and resolves only profile-declared environment names after destination validation. Existing public-DNS, DNS-pinning, redirect, URL-credential, and insecure-HTTP controls still apply.

Profiles default to `per-call` confirmation. The stock stdio command has no interactive callback, so confirmation-required calls remain blocked in that state. `--approve-confirmation-required` records coarse `process` approval and must not be described as per-call consent.

Release, profile, and launcher writes are atomic, owner-only, and refuse existing destinations unless `--force` is explicit. Even with force, protected source/release/profile path aliases cannot be overwritten by a downstream artifact.

## Consequences

Positive:

- New source formats can be added behind one normalization contract without modifying MCP or HTTP runtime code.
- Automatic detection is dynamic but deterministic and ambiguity-safe.
- APIs without OpenAPI can be registered without executable generated glue.
- Common OpenAPI 3.0 schema semantics and nested resolver graphs reach one self-contained runtime schema dialect.
- Source/release identity remains portable while destination, credential-name, and confirmation review remain local.
- AI tools receive a shell-free launcher descriptor and the secret store remains outside HiMCP artifacts.
- Unsupported required authentication fails during profile creation rather than during an ambiguous production call.

Costs and risks:

- An adapter is trusted to normalize source semantics correctly even though its output is schema-checked and deterministically verified.
- A manual manifest requires the author to describe the HTTP contract accurately; HiMCP cannot prove the upstream implementation matches it.
- Some valid OpenAPI serialization and media contracts are deliberately rejected when the current HTTP engine cannot reproduce them without ambiguity.
- The phrase “any API” is bounded by installed source adapters and execution drivers. The current built-in execution driver is HTTP-only.
- Exact origin approval does not replace upstream authorization, path review, or independent egress control.
- Environment values are visible to the launched process and are static; rotation and lifecycle are external responsibilities.
- The first-server selection and process-wide confirmation opt-in are intentionally limited stock policies.

## Alternatives considered

### Keep OpenAPI as the only source

This would preserve a smaller surface but exclude services without a usable OpenAPI contract and encourage one-off generated servers. Rejected in favor of a source-neutral normalization boundary.

### Ask a model to infer and execute arbitrary integration code

This could appear to cover more APIs, but it would let untrusted descriptions or model output define network and credential behavior. Rejected. Models may improve bounded semantics only; executable behavior must come from an adapter, verified IR, and an implemented driver.

### Choose the highest-confidence adapter even when tied

Stable adapter ordering would make a tie reproducible but not correct. Rejected because silent format misclassification changes executable meaning. Ambiguity requires explicit operator selection.

### Store origins and credentials in the release

Origins vary by deployment and credentials are secrets. Combining them would reduce release portability and increase accidental disclosure. Rejected in favor of a separate profile that stores exact policy and secret names only.

### Export shell commands with inline environment assignments

This is convenient for copy/paste but risks quoting errors, shell injection, process-history disclosure, and product-specific behavior. Rejected in favor of a shell-free command/argument descriptor and external secret injection.

## Follow-up

- Define a compatibility policy for third-party adapter IDs and adapter packages.
- Add reviewed execution drivers only with corresponding IR and verifier changes.
- Add interactive per-call approval without contaminating MCP stdio.
- Add optional signing or attestation for releases and connection profiles.
- Design principal-aware credential integrations for signing, mTLS, and OAuth lifecycle management.
