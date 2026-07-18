# ADR 0002: Separate semantic proposals from deterministic execution

- Status: Accepted
- Date: 2026-07-14

## Context

API contracts often have descriptions that are technically correct but poor for agent tool selection. A language model can improve names, intent guidance, examples, and field descriptions. The same model is not a reliable authority for endpoint selection, authentication, side effects, or request bindings.

A design that either excludes models entirely or lets them generate the full tool contract loses useful semantics or accepts unnecessary execution risk. Binding the compiler to one provider or model would also make the project brittle and difficult to evaluate.

## Decision

Split compilation into three explicit stages:

1. Build a deterministic baseline from the normalized operation.
2. Optionally request a schema-constrained semantic proposal through a provider-neutral interface and dynamic model router.
3. Apply only permitted fields and deterministically verify the result against both source operation and baseline.

The proposal schema intentionally has no execution, authentication, output-contract, provenance, or authoritative risk fields. It is bound to the baseline capability fingerprint. Risk predictions are observations only.

Provider modules discover current model descriptors. The router filters and ranks them using operator constraints and published capabilities, context, quality, cost, latency, and availability. Configuration may explicitly allowlist providers or models, but core compiler code does not select one by name.

Deterministic compilation is the CLI default. Provider modules are imported only after an operator explicitly supplies `--semantic` and a configuration path with an enabled provider. A semantic failure falls back per capability to the verified baseline and emits diagnostics. Operators may set `semantic.required` when semantic enrichment is a release requirement.

## Consequences

Positive:

- Model strengths improve discoverability without granting execution authority.
- Baselines remain available for offline, deterministic, and incident workflows.
- Multiple providers and evolving model catalogues fit one small interface.
- Proposal fingerprints, prompt fingerprints, attempts, and selected models provide compilation evidence.
- Independent verification catches source or immutable-contract drift.

Costs and risks:

- Semantic quality is limited to fields expressible by the proposal schema.
- Model calls can disclose capability descriptions and schemas to a provider.
- Provider modules are trusted in-process code even though model output is untrusted data.
- Dynamic operational metrics can make semantic selection and result fingerprints vary across runs.
- Fallback may yield a release with uneven semantic quality unless semantic compilation is required.

## Alternatives considered

### No model involvement

Safest operationally, but API metadata alone often produces weak agent-facing intent. Retained as the default compile path rather than the only mode.

### Let the model generate the complete capability

This would allow richer restructuring but makes hallucinated endpoints, weakened authentication, and incorrect side effects part of the executable contract. Rejected.

### Hard-code one provider and model

Simple initially, but couples an open-source compiler to vendor naming, availability, pricing, and model churn. Rejected.

### Accept free-form model text and parse it heuristically

This produces ambiguous failure modes and weakens validation. Rejected in favor of provider-level structured output and a strict proposal schema.

## Follow-up

- Add semantic quality benchmarks based on representative agent tasks.
- Add review tooling that shows baseline-to-semantic changes.
- Isolate provider modules in a worker or separate process where appropriate.
- Define provenance export and reproducibility expectations for model-assisted releases.
