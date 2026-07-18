# ADR 0003: Start with a local MCP stdio runtime

- Status: Accepted
- Date: 2026-07-14

## Context

The first runtime must demonstrate that verified Capability IR can become usable MCP tools without adding a remote control plane, tenant identity, session authorization, deployment service, or public network endpoint. The project is intended for local evaluation and embedding before remote operation.

The runtime also needs a clear boundary between protocol transport, release verification, API execution policy, credentials, and human approval. Stdio solves only the transport problem; it must not imply that the local process has broad network or secret authority.

## Decision

Provide a low-level MCP server backed by `ReleaseRuntime` and expose it through stdio.

At startup, the runtime applies centralized release verification, rejects duplicate tool names, and converts object-root capability schemas to MCP tool definitions. At call time it bounds and inspects arguments, gates every capability marked `requiresConfirmation`, delegates to the policy-enforced HTTP engine, and returns structured content when the output is an object. Unknown tools become MCP invalid-parameter errors; execution failures return sanitized tool errors.

Embeddings can provide an authoritative per-call confirmation callback. The low-level `serve` command exposes only the coarse `--allow-confirmation-required` switch and requires explicit `--allow-host` destination policy unless the operator selects the development-only `--trust-compiled-hosts` escape hatch.

The connection workflow introduced in [ADR 0004](0004-source-adapter-registry-and-connection-profiles.md) reuses the same stdio runtime through `serve-profile`. It verifies a content-addressed profile and referenced release, applies exact approved origins, and installs an environment-name-bound credential provider for supported static authentication. The profile stores no credential values.

The default profile confirmation state is `per-call`. Because the stock stdio command has no interactive callback, confirmation-required calls remain blocked in that state. `--approve-confirmation-required` records coarse process-wide approval; it is not per-call or user-specific consent.

The CLI validates the release before either serving path, and `ReleaseRuntime` verifies it again at its own trust boundary. Release/profile files and inbound stdio-message sizes are bounded before recursive parsing. Stdio is reserved for MCP protocol messages; diagnostics and operational output belong on stderr or an injected trace sink.

The low-level `serve` command does not load upstream credentials. `serve-profile` resolves only profile-declared environment variables after destination validation and supports static API key, Basic, Bearer, and already-issued OAuth/OpenID bearer material. Custom signing, mTLS, token lifecycle management, and principal-aware authorization remain embedding responsibilities.

## Consequences

Positive:

- The initial runtime has a small inbound network attack surface and uses the MCP host's process boundary.
- Local MCP hosts can launch a verified profile with a direct executable and argument array.
- Protocol mapping stays separate from source adaptation, capability compilation, connection review, and HTTP execution.
- Supported protected APIs can use the stock profile flow without putting secrets in release or launcher artifacts.
- Advanced credential and approval policies remain explicit injectable interfaces.

Costs and risks:

- There is no remote MCP access, multi-tenant authorization, or horizontal scaling.
- The local host and operating-system user are the caller authorization boundary.
- A long-lived stdio process needs external supervision and correct stderr/stdout separation.
- Stock confirmation opt-in is process-wide; interactive per-call approval requires an embedding.
- Environment-backed credentials are static process inputs, not acquisition, rotation, refresh, or request-signing services.
- Unsupported authentication requires an embedding with an appropriate credential provider and transport policy.

## Alternatives considered

### Start with Streamable HTTP

This would simplify remote access but requires a complete authentication, authorization, origin, session, rate-limit, and deployment threat model. Deferred until those controls can be designed together.

### Generate a bespoke MCP server per API

This duplicates runtime policy and makes release validation less meaningful. Rejected in favor of one generic runtime over verified IR.

### Put credential values in flags, releases, profiles, or launcher descriptors

Flags can leak through process inspection and shell history, while persistent artifacts are designed for review and sharing. Rejected. Profiles hold only environment-variable names and verified binding metadata; values enter through the process environment or an embedding immediately before dispatch.

### Treat MCP annotations as approval enforcement

Client annotations are advisory and cannot establish that a user approved a particular call. Rejected. The verified `requiresConfirmation` contract is enforced inside `ReleaseRuntime`.

## Follow-up

- Design a remote profile with authenticated principals and per-capability authorization.
- Add a stock interactive approval channel without mixing prompts into MCP stdout.
- Add process isolation and deployment guidance for production use.
- Add credential-provider integrations for authentication that cannot be represented as static HTTP material.
