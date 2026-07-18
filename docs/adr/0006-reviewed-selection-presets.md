# ADR 0006: Persist exact reviewed-selection presets

- Status: Accepted
- Date: 2026-07-15

## Context

Large API contracts make it useful to reuse a reviewed operation subset. A browser-local preference would be easy to lose, unavailable to another browser profile, and disconnected from the console's managed artifact checks. Persisting a search, tag, or method filter would be more dangerous: when the source contract later adds an operation matching that rule, the new operation could become selected without an explicit review.

A saved selection also cannot become an alternative registration authority. Browser state and request bodies are untrusted, the source may have changed since analysis, and operation IDs alone do not prove which normalized contract the user reviewed. The preset must not become a second store for source documents, schemas, destinations, authentication contracts, or credentials.

Large operation lists introduce a separate presentation concern. Rendering every row and storing a full selected-ID set increases browser work, but a rendering optimization must not change the meaning of filtered bulk actions or the operation allowlist sent to the server.

## Decision

### Keep selection state sparse and rendering virtual

Represent client selection with an all-included or all-excluded default, a map containing only exceptions, an operation count, and an incrementally maintained selected count. Replacing selection from a preset chooses the smaller default/exception representation while preserving the normalized analysis order when materializing the registration allowlist.

Precompute searchable operation text for each analysis and defer the interactive query. Render the operation table in a bounded scrolling viewport. Measure real variable row heights, compute a measured virtual layout, and mount the visible window with a viewport-sized overscan. Keep the current roving keyboard-focus target mounted when it falls outside that window. Expose complete table row counts and indices to accessibility APIs. If resize observation is unavailable, render the complete list as a functional fallback.

Virtualization is presentation only. Individual toggles update the shared sparse selection, and filtered bulk actions receive every operation ID in the complete filtered result rather than the rendered range.

### Store exact immutable allowlists

Persist a preset as a sorted, non-empty, duplicate-free list of normalized operation IDs tied to:

- a non-authoritative discovery scope derived from adapter ID, source kind, normalized display filename and title, plus canonical document-level server origins;
- the exact reviewed analysis fingerprint and document fingerprint;
- the source operation count;
- a normalized operator-supplied name;
- selection and record fingerprints.

Do not persist filter expressions or infer equivalent operation IDs. A new or changed analysis therefore never auto-includes an operation. Presets in the same source scope remain discoverable, but only an exact analysis-fingerprint match is applyable; other records are marked stale. A preset identity is derived from scope, analysis fingerprint, and name. Repeating identical content is idempotent, while a different exact selection at that identity is a conflict rather than an overwrite. Deletion is explicit and requires a second UI action.

Keep collection responses and browser collection state bounded. Preset list responses contain metadata, selection fingerprint, and `includedOperationCount`, but omit the full allowlist. When the operator applies an exact preset, the client requests one detail with the analysis and selection fingerprints from the selected summary. The server rejects a stale analysis or changed selection snapshot, and the client consumes the returned IDs directly into sparse selection state without retaining detail records in the collection. Registration still reanalyzes the transient source and is the final authority.

The composite scope is only a lookup hint. Document-level origins are preferred because adding an operation must not normally change lineage; when a document declares no usable root origin, the sorted operation-origin set is a fallback and changes to that set can start a new scope. Changing the display filename, normalized title, or root origin starts a new scope. A routine version or operation change keeps the scope when those identity hints remain stable, so the previous preset is discoverable as stale. Reusing the same composite hints can still surface an unrelated stale record, but it never authorizes application: the exact analysis fingerprint and operation-ID validation remain mandatory, so a discovery collision cannot expand the selected tool set.

Preset creation submits the raw source only transiently with the name, reviewed analysis fingerprint, and included operation IDs. The server reruns source adaptation and calls the shared `reviewOperationSelection` function used by registration before creating any record. The browser cannot directly author adapter identity, document fingerprint, source count, or persisted selection fingerprints.

Store records under the console data root:

```text
.himcp/console/selection-presets/<source-scope-id>/<preset-id>/preset.json
```

The record includes operation IDs and source/analysis identity metadata. It excludes raw source text and source ID, schemas, origins, authentication contracts, credential environment names, and credential values. Operation IDs can still disclose API structure and remain private local metadata.

### Apply the local managed-store boundary

Create the preset root, scope directories, preset directories, and files with owner-only permissions. Write a new record into a private temporary directory, synchronize it, and atomically rename it into the content-derived destination. Before trusting a stored record:

- require allow-listed scope and preset IDs and private non-symlink directories;
- open `preset.json` without following a symbolic link;
- require one hard link, owner-only mode, and configured size/count/identifier limits;
- parse a strict schema and recompute selection, record, and preset identity fingerprints.

Deletion first loads and verifies the record, atomically renames its directory to a tombstone, synchronizes the parent, and then removes the tombstone. All mutation methods, including preset `DELETE`, pass the same loopback Host, exact same-origin, `Sec-Fetch-Site` when present, and per-process CSRF checks.

These controls assume one trusted operating-system user. They prevent browser-supplied path traversal and common link/partial-write hazards, but they do not isolate mutually distrusting local processes running as that user.

## Consequences

- Operators can reuse a reviewed subset without re-entering every checkbox.
- Contract changes remain visible: an old preset becomes stale instead of silently expanding its authority.
- Large allowlists are loaded one at a time instead of accumulating across every listed revision in browser state or one HTTP response.
- Registration and preset creation share one source-grounded selection verifier.
- Virtual rendering reduces mounted operation rows without changing bulk-selection semantics.
- Exact operation IDs and fingerprints consume local storage and can reveal API structure, even though source text and executable policy contracts are excluded.
- The same preset name cannot be used as a mutable pointer within one exact analysis; users must delete it or choose another name to save different content.
- Presets are local managed metadata, not portable signed policy artifacts and not an authorization mechanism.

## Rejected alternatives

### Persist filter rules

A method, tag, text, or inclusion rule can match operations that did not exist during review. It was rejected because a future contract could silently broaden the selected tool set.

### Apply the closest stale preset

Matching by operation name or retaining the intersection would hide contract drift and make the browser an authority for equivalence. It was rejected; stale presets remain visible but cannot be applied.

### Store presets only in browser storage

This would avoid a server store but would not share the managed artifact integrity checks or stable local source scope. It was rejected in favor of owner-only server-managed records.

### Trust the saved IDs without reanalysis

A modified client could attach IDs to the wrong source or reuse an old fingerprint. It was rejected; saving and registration use the same server-side source reanalysis and exact verifier.

### Let virtualization define bulk scope

Applying bulk actions only to mounted rows would make scrolling and overscan change selection semantics. It was rejected; the full filtered result is authoritative.
