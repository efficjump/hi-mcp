# Security policy

## Supported versions

HiMCP is under active development. Security fixes are applied to the latest release until a stable support policy is published.

## Reporting a vulnerability

Do not include secrets, working exploits, or affected user data in a public issue. Submit a [private security advisory](https://github.com/efficjump/hi-mcp/security/advisories/new) with a minimal reproduction and the affected version or commit. If private reporting is unavailable, do not publish sensitive details; open a public issue containing only a request for a private contact channel.

## Security boundaries

HiMCP assumes API descriptions, external references, semantic model output, browser-supplied operation selections, MCP arguments, and upstream API responses can be malicious. The runtime must execute only a verified release and must not expose a generic HTTP, shell, or code-execution tool.

The local console treats operation selection as a compiler input constraint, not a client-side display preference. Registration recomputes the normalized document, checks the reviewed analysis fingerprint, requires exact known operation IDs, and creates a new content-addressed release from only those capabilities. Origin and credential policy must be derived from that subset; excluded operations and their unreferenced authentication schemes must not survive in the release or connection profile.

Selection presets preserve that boundary. They store an immutable exact operation-ID allowlist for one source scope and analysis fingerprint, never a dynamic rule that could auto-include a future operation. Preset creation reanalyzes the transient source and uses the same selection verifier as registration. A stale preset discovered in the same source scope cannot be applied directly. Its mutation-protected re-review flow verifies the transient current source, scope, current analysis fingerprint, and saved selection fingerprint before returning exact-ID candidates; loading those candidates is a second explicit action and excludes every current operation absent from the saved selection. Preset records under `.himcp/console/selection-presets/<scope>/<preset>/preset.json` exclude raw source text, schemas, origins, authentication contracts, and credential names or values, though operation IDs can still reveal API structure.

Contract comparison never treats a fingerprint difference as proof of an executable change. It compares explicit fields between a re-verified stored release and a fresh deterministic baseline, requires the current reviewed analysis fingerprint, and does not persist source or diff data or mutate selection. Additive results are relative to the baseline release, which may itself be a subset.

The local console requires loopback Host validation and exact same-origin plus its per-process CSRF token for every mutation, including preset `DELETE`. Managed preset directories and files are owner-only; creation and deletion use atomic renames, and reads reject symbolic links, hard-linked files, oversized records, and invalid fingerprints or schemas. This is a single-operating-system-user boundary, not protection from another process already running with that user's privileges, and it is not a remote or multi-tenant authorization system.

Credentials are supplied by a credential provider at execution time. They must never be embedded in a Capability IR document, compiler prompt, generated release, test fixture, or diagnostic output.

The initial release is intended for local development and evaluation. Review generated capabilities and destination policies before connecting it to production APIs.
