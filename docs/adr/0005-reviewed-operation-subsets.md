# ADR 0005: Reviewed operation subsets

- Status: Accepted
- Date: 2026-07-15

## Context

An API contract can contain many operations, while an MCP host may need only a small reviewed subset. Registering every operation increases the tool-choice surface and can carry unrelated origins and credential contracts into the connection profile. A browser-only hide/show control would not establish a security boundary because a modified client could still submit arbitrary capability-shaped data or reuse an analysis after the source changed.

Subset releases must remain deterministic. In particular, MCP tool names that receive collision suffixes cannot change merely because a neighboring operation was excluded, and selection request order cannot change release identity. Source-grounded verification must still compare retained capabilities with the complete normalized source document.

## Decision

The compile pipeline accepts an optional allowlist of normalized `operation.id` values. The CLI omits it and therefore retains every operation. The local web registration contract requires both a non-empty allowlist and a reviewed analysis fingerprint.

The pipeline performs the following sequence:

1. Select and run the source adapter, producing the complete `NormalizedApiDocument`.
2. Compute a review fingerprint from the adapter ID, document fingerprint, and the sorted operation ID/fingerprint pairs.
3. Reject a supplied review fingerprint that does not match the current analysis.
4. Reject duplicate source IDs and empty, duplicate, malformed, or unknown requested IDs.
5. Compile the complete deterministic baseline so collision-safe tool names are stable across subsets.
6. Retain baseline capability/provenance pairs whose exact source operation IDs are allowlisted.
7. Run optional semantic compilation only for retained capabilities.
8. Create and source-verify a new content-addressed release with retained capability and compilation evidence only.

Operation authentication metadata contains only the schemes referenced by that operation's alternatives. Consequently, origins, credential bindings, environment-variable requirements, profiles, and runtime tools are derived from the selected release without residue from excluded operations.

The web client defaults to all operations selected and derives search, method, and tag controls from analysis data. It preserves the underlying selection while filtering, submits IDs in normalized analysis order, blocks an empty selection, and discards stale asynchronous analysis results. These controls improve review but are not trusted; the server performs the authoritative checks above.

## Consequences

- A user can publish a narrowly scoped MCP server without editing the source contract.
- The same source and logical subset produce the same release ID regardless of checkbox or request order and wall-clock time.
- Retained capability fingerprints and collision-safe tool names match an all-operation baseline.
- Excluded operations do not appear in `tools/list`, execution policy, origins, credentials, or compilation evidence.
- Every distinct subset is a distinct content-addressed release and can have its own connection profile.
- Registration must normalize the source again, adding bounded work but preventing stale-review and client-trust failures.
- The complete normalized document remains the grounding authority; selection does not create a synthetic truncated source document.

## Rejected alternatives

### Hide tools only in the browser or runtime

This leaves excluded capabilities and their policy material in persisted artifacts and trusts a presentation-layer decision. It was rejected.

### Filter operations before deterministic baseline compilation

This can change collision resolution and tool names when the subset changes. It was rejected in favor of compiling the full baseline and filtering paired results afterward.

### Persist selection as an unverified release extension

The release capability list and filtered compilation evidence already encode the selected contract canonically. A separate client-authored extension would duplicate authority without improving verification. It was rejected.
