# ADR 0007: Compare verified release contracts and re-review stale preset intersections

- Status: Accepted
- Date: 2026-07-16

## Context

Exact selection presets intentionally become stale when the normalized analysis changes. That prevents a filter rule or newly added operation from silently expanding a release, but a stale label alone does not help an operator understand a revision or recover the still-relevant part of an older selection.

The preset store cannot provide a full historical contract diff. Its privacy boundary deliberately excludes raw source, schemas, destinations, and authentication contracts. Expanding it into a second contract archive would duplicate verified release storage and expose more source-derived material. Capability fingerprints also cannot be used directly as an operation-change signal because they include document-level provenance: an unrelated document change can refingerprint an otherwise unchanged capability.

A stored release may contain only a reviewed operation subset. Therefore an operation present in a current document but absent from the release is not necessarily new to the API; it can have been deliberately excluded from the older release.

## Decision

### Compare a verified release with a fresh deterministic baseline

Add a shared contract-diff function used by the CLI and loopback console. Its baseline is a release that has passed the existing release verifier. Its current side is a freshly normalized document compiled through the complete deterministic baseline before any new selection is applied.

Match capabilities only by exact normalized operation ID. Classify differences in these areas:

- executable destination targets;
- authentication contract;
- enforced risk fields;
- HTTP request binding;
- response status/media/schema contract;
- MCP input and output schemas;
- non-assertive JSON Schema annotations;
- tool name, title, description, and intent metadata.

Do not use capability or document fingerprints as the change classification. Exclude wall-clock values, release/compiler identity, document-level provenance fingerprints, and descriptive annotations on execution bindings from executable comparisons. Deterministically fingerprint the resulting diff material so repeated comparisons of the same contracts are identical.

Classify destination, authentication, or enforced risk changes as `security-review`; executable/schema-assertion changes and removals as `breaking`; capabilities absent from the baseline release as `additive`; and semantic or schema-annotation-only differences as `metadata-review`. Standard JSON Schema annotations are projected out only along schema-valued keywords, so object data inside `const`, `enum`, or defaults is never rewritten as though it were a schema. Report additive results as relative to the release, not as proof that an operation did not exist in the historical source.

The CLI exposes `diff <release> <source>`, JSON output, and configurable CI failure thresholds. The console accepts a managed registration ID plus the transient current source and exact reviewed analysis fingerprint. Comparison never changes operation selection or writes a new artifact.

### Re-review stale presets without applying them

Keep the preset schema and storage boundary unchanged. Add a separate re-review operation that accepts:

- the current transient source;
- its exact reviewed analysis fingerprint;
- the source scope and preset ID;
- the selection fingerprint from the listed preset snapshot.

The server reanalyzes the source, recomputes and matches its discovery scope, verifies the current analysis fingerprint, loads the exact private preset record, and verifies the selection fingerprint. It returns three bounded sets: saved IDs still present, saved IDs missing, and current IDs not in the saved selection.

The client verifies that the present and unselected sets form an exact disjoint partition of current operation IDs and that missing IDs are not current. It first presents this result as a preview. Loading the intersection into browser selection requires a second explicit action. It excludes every current operation that was not in the old allowlist, including newly introduced operations, and does not infer operation renames or equivalence. Final registration continues to reanalyze the source and validate the exact current allowlist.

## Consequences

- Operators can distinguish security, compatibility, additive, and descriptive changes before replacing a release.
- CI can enforce a deterministic failure policy without parsing human output.
- Stale presets become recoverable review aids without becoming mutable policy or silently broadening authority.
- Presets still do not store source documents, schemas, destinations, or authentication contracts.
- Full historical comparison requires a stored release. A stale preset alone can only recover exact-ID candidates.
- Semantic enrichment in an older release can appear as tool-metadata or schema-annotation change against the current deterministic baseline; executable and security classifications remain field-specific.
- An additive result against a subset release may be a previously excluded operation rather than a newly authored operation.

## Rejected alternatives

### Persist normalized operations inside every preset

This would enable self-contained historical diffs but duplicate release content and violate the preset store's minimal metadata boundary. Verified releases remain the contract archive.

### Apply the stale-ID intersection immediately

Even an identical operation ID can refer to a changed contract. Automatic application would hide the review step. The intersection is previewed and then loaded only through a separate operator action.

### Use capability fingerprints as the diff

Capability provenance contains a document fingerprint, so an unrelated document revision can change every capability fingerprint. Explicit field comparison avoids that false positive.

### Match renamed operations heuristically

Method/path/name similarity cannot prove authority-preserving equivalence and could transfer an old approval to a different operation. Only exact normalized IDs become re-review candidates.
