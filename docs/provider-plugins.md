# Semantic provider plugins

Semantic compilation is optional. Its purpose is to improve how an agent understands a deterministic capability, not to let a model design the HTTP request. Provider modules bridge HiMCP's small interface to any hosted model gateway, vendor SDK, or local inference service that can produce structured JSON.

The CLI never loads a provider during a normal deterministic compile. Provider execution requires the explicit combination `compile --semantic --config <path>`, and the named configuration must contain at least one enabled provider.

## Loading contract

Each enabled configuration entry names an ECMAScript module and exported factory:

```yaml
semantic:
  required: false
  requestTimeoutMs: 60000
  maxConcurrency: 4
  providers:
    - module: '@your-scope/himcp-semantic-provider'
      export: createSemanticProvider
      enabled: true
      settings:
        apiKeyEnvironmentVariable: MODEL_GATEWAY_API_KEY
```

HiMCP imports the module inside the compiler process and calls:

```ts
type ProviderFactory = (
  settings: Readonly<Record<string, unknown>>,
) => SemanticModelProvider | Promise<SemanticModelProvider>;
```

An installed package specifier is the most portable module value. It is resolved relative to the explicit configuration file. URL-scheme module values, including `file:`, `data:`, and `node:`, are rejected.

Local development modules may use an absolute path or a path relative to the configuration file, but both controls below are mandatory:

```yaml
semantic:
  providers:
    - module: ./providers/local-provider.mjs
      export: createSemanticProvider
      enabled: true
      allowLocal: true
      integrity: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      settings: {}
```

`integrity` is the SHA-256 digest of the resolved module entry file. It detects a changed entry file before import; it does not cover transitive dependencies, runtime reads, generated code, or subsequent network activity. Package specifiers may also declare an entry-file integrity value, but operators must separately pin and review the complete package dependency graph.

Provider modules are trusted executable code loaded in the compiler process with its filesystem, environment, and network authority. Module initialization and the factory run before interface validation; `allowLocal` and entry-file integrity do not sandbox that code. The `settings` object is opaque to HiMCP, so the module is responsible for validating it. Store only the name of a secret environment variable in configuration, never the secret value.

## Provider interface

The current public contract from `@hi-mcp/semantic-compiler` is:

```ts
interface SemanticModelProvider {
  readonly id: string;

  listModels(signal?: AbortSignal): Promise<readonly SemanticModelDescriptor[]>;

  generateStructured(request: SemanticModelRequest): Promise<SemanticModelResponse>;
}

interface SemanticModelDescriptor {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly quality: Readonly<Record<string, number>>; // each value is 0..1
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
  readonly estimatedInputCostPerMillionTokens?: number;
  readonly estimatedOutputCostPerMillionTokens?: number;
  readonly observedLatencyMs?: number;
  readonly availability?: number; // 0..1
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface SemanticModelRequest {
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly responseSchema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface SemanticModelResponse {
  readonly output: unknown;
  readonly requestId?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

The CLI validates every returned model descriptor. Provider catalogues and generated output must be bounded, plain JSON-compatible data: cycles, accessors, unsafe object keys, excessive depth, and excessive collection or string sizes are rejected before recursive schema parsing. `generateStructured` should return parsed data in `output`, not JSON text or Markdown. The semantic compiler then validates that data against the proposal schema.

## Complete HTTP gateway adapter example

The following module uses a small provider-neutral gateway contract:

- `GET catalogUrl` returns `{ "models": SemanticModelDescriptor[] }`.
- `POST generationUrl` accepts the semantic request and returns `SemanticModelResponse` JSON.

Adapt the two wire shapes if your gateway differs.

```ts
import type {
  SemanticModelDescriptor,
  SemanticModelProvider,
  SemanticModelRequest,
  SemanticModelResponse,
} from '@hi-mcp/semantic-compiler';

type Settings = Readonly<{
  providerId: string;
  catalogUrl: string;
  generationUrl: string;
  apiKeyEnvironmentVariable: string;
}>;

function requiredString(value: Readonly<Record<string, unknown>>, key: keyof Settings): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new TypeError(`settings.${key} must be a non-empty string`);
  }
  return candidate;
}

function settingsFrom(value: Readonly<Record<string, unknown>>): Settings {
  const settings = {
    providerId: requiredString(value, 'providerId'),
    catalogUrl: requiredString(value, 'catalogUrl'),
    generationUrl: requiredString(value, 'generationUrl'),
    apiKeyEnvironmentVariable: requiredString(value, 'apiKeyEnvironmentVariable'),
  };
  new URL(settings.catalogUrl);
  new URL(settings.generationUrl);
  return settings;
}

async function jsonRequest(url: string, apiKey: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  if (!response.ok) {
    throw new Error(`Model gateway returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function catalogueFrom(value: unknown): readonly SemanticModelDescriptor[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('models' in value) ||
    !Array.isArray(value.models)
  ) {
    throw new TypeError('Gateway catalogue must contain a models array');
  }
  return value.models as readonly SemanticModelDescriptor[];
}

function responseFrom(value: unknown): SemanticModelResponse {
  if (typeof value !== 'object' || value === null || !('output' in value)) {
    throw new TypeError('Gateway response must contain output');
  }
  return value as SemanticModelResponse;
}

export function createSemanticProvider(
  rawSettings: Readonly<Record<string, unknown>>,
): SemanticModelProvider {
  const settings = settingsFrom(rawSettings);
  const apiKey = process.env[settings.apiKeyEnvironmentVariable];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`Missing environment variable ${settings.apiKeyEnvironmentVariable}`);
  }

  return {
    id: settings.providerId,

    async listModels(signal) {
      const value = await jsonRequest(settings.catalogUrl, apiKey, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      });
      return catalogueFrom(value);
    },

    async generateStructured(request: SemanticModelRequest) {
      const value = await jsonRequest(settings.generationUrl, apiKey, {
        method: 'POST',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        body: JSON.stringify({
          modelId: request.modelId,
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          responseSchema: request.responseSchema,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          metadata: request.metadata,
        }),
      });
      return responseFrom(value);
    },
  };
}
```

The casts at the gateway edge do not bypass HiMCP's descriptor and proposal validation, but a production plugin should validate the exact gateway response shape itself to fail with clearer diagnostics.

## Dynamic routing

Routing has two stages.

First, a descriptor must satisfy all configured constraints:

- provider and model allowlists, when present;
- every `requiredCapabilities` value;
- prompt plus estimated output within its context window;
- its declared maximum output size;
- optional availability, latency, and estimated-cost thresholds.

Second, eligible descriptors are scored using normalized objectives:

- weighted quality dimensions, each published as a `0..1` value;
- estimated input and output cost;
- observed latency;
- availability.

If `qualityWeights` is omitted, the CLI discovers every quality dimension published by current descriptors and gives each equal weight. This avoids embedding a vendor-specific benchmark vocabulary in HiMCP. Missing optional cost, latency, or availability data uses `missingMetricScore` unless a configured threshold requires that metric.

Model catalogues are discovered once per compilation run. No provider or model is selected by a fixed name inside the compiler; allowlists are explicit operator policy. `requestTimeoutMs` bounds discovery and each per-capability compilation stage even if an adapter ignores cancellation, while `maxConcurrency` bounds simultaneous capability compilations. Providers must still honor `AbortSignal` to stop their underlying network or compute work after a timeout.

## Semantic failure policy

When `--semantic` is selected and `semantic.required: false`, failed module loads, catalogue discovery, routing, or generation produce warnings and keep the deterministic baseline for affected capabilities. The final release is still subject to compilation policy: `compile.strict` defaults to `true`, so those warnings block release creation until the failure is fixed. Set strict mode to `false` only when emitting a release with reviewed fallback diagnostics is intentional.

With `semantic.required: true`, the same failures block compilation. Use this only when enriched semantics are a release requirement and provider availability is controlled.

Without `--semantic`, configuration may still supply deterministic compile settings, but no provider module is imported. This default path is appropriate for reproducible baselines and incident isolation.

## Proposal safety rules

A provider must return the response schema it receives without weakening it. The accepted proposal can update:

- tool `name`, `title`, and `description`;
- intent guidance, examples, and tags;
- title, description, and examples for input paths that already exist.

It cannot update execution, authentication, output schema, risk authority, or provenance. A proposal for the wrong capability or baseline fingerprint is rejected. After application, the deterministic verifier compares the result to both source and baseline.

## Plugin checklist

- Use a stable provider ID and discover model descriptors instead of embedding a preferred model.
- Require operators to opt in with `--semantic --config`; document every filesystem, environment, and network permission the module needs.
- For local modules, set `allowLocal: true`, record the exact entry-file SHA-256 digest, and separately pin and review transitive dependencies.
- Honor `AbortSignal` for catalogue and generation requests.
- Send the supplied JSON response schema to the model service as a strict structured-output contract.
- Return parsed JSON and propagate sanitized request IDs and token usage.
- Keep credentials inside the plugin and out of response metadata, errors, prompts, and diagnostics.
- Publish meaningful, evidence-based quality dimensions and current operational metrics.
- Apply network-level timeouts and bounded response parsing in the plugin or model gateway; the compiler's stage deadline cannot forcibly stop adapter work that ignores `AbortSignal`.
- Test invalid catalogue entries, malformed structured output, cancellation, and provider failover.
