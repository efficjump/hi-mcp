# HiMCP usage guide

**English** | [한국어](usage-guide.ko.md)

HiMCP is a local tool that analyzes an API contract and exports only the operations you review as verified MCP tools. This guide follows the web console from source preparation through connection to an AI tool.

> HiMCP is early alpha software. Before connecting it to a real system, review the source, selected operations, execution origins, credential names, and possible side effects.

## 1. Install and open the local console

HiMCP requires Node.js 22 or newer and pnpm 11.

From the repository root, install the locked dependencies, build the workspace, and start the console:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm web
```

Open these local addresses in a browser:

- Console: `http://127.0.0.1:4173`
- In-app guide: `http://127.0.0.1:4173/guide`

Set `HIMCP_WEB_PORT` to use another port or `HIMCP_WEB_DATA_DIR` to use another managed-artifact directory. Regardless of those settings, the server refuses to bind to a non-loopback address.

### Optional command-line smoke check

The built CLI can analyze, compile, and source-validate the repository examples without starting the console:

```bash
node apps/cli/dist/bin.js analyze \
  examples/customer-support/openapi.yaml \
  --source-type auto

node apps/cli/dist/bin.js compile \
  examples/customer-support/openapi.yaml \
  --source-type openapi \
  --output .himcp/quickstart/customer-support.release.json

node apps/cli/dist/bin.js validate \
  .himcp/quickstart/customer-support.release.json \
  --source examples/customer-support/openapi.yaml \
  --source-type openapi
```

The `.himcp` directory is ignored by Git. The included examples use documentation-only upstream hosts, so they support contract analysis, compilation, validation, and tool discovery rather than successful upstream API calls.

## 2. Choose a supported API source

The running source-adapter registry determines the supported formats; the console does not use a fixed API catalogue. The built-in registry currently provides these paths:

- Analyze OpenAPI 3.x documents directly.
- For an HTTP API without OpenAPI, use the declarative HTTP manifest to define its method, path, server, request and response schemas, authentication, and risk metadata.
- Add another source adapter to connect a new contract format to the same normalization and verification pipeline.

The manifest can therefore register REST operations as well as explicitly described GraphQL over HTTP, SOAP/XML, form, JSON, text, and canonical base64 request bodies. Native gRPC, WebSocket, SDK-only calls, arbitrary scripts, and other transports outside the verified HTTP execution model are not executed through a fallback path.

The governing rule is not to execute every input. HiMCP dynamically connects adapters only for API behavior that can be expressed as a contract and verified.

## 3. Prepare a source

Prepare one of the following:

- an OpenAPI 3.x JSON or YAML document;
- an HTTP manifest in JSON or YAML; or
- one of the repository examples currently returned by the console.

Do not put API keys, tokens, cookie values, customer records, or operational secrets in a source. Source-derived schemas and descriptions can remain in a verified artifact. In the connection-policy step, bind only **environment-variable names**, never credential values.

## 4. Create an MCP connection in five steps

### Step 1. Register the API source

1. Paste the contract into the editor or upload a UTF-8 JSON or YAML file.
2. Use `자동 감지` (automatic detection), or explicitly choose an adapter ID from the running registry when detection is ambiguous.
3. Check the display filename and source-size information, then select `API 분석` (analyze API).

The repository-example buttons on the in-app guide are generated dynamically from the sample list returned by the server. Selecting one opens the source step and loads that contract.

### Step 2. Review the analysis and select operations

Review the document fingerprint, server origins, authentication schemes, diagnostics, and normalized operations. Every operation is initially selected. Narrow the MCP surface with:

- search across operation ID, summary, description, method, path, and tag;
- HTTP-method and tag filters derived from the analyzed document;
- included and excluded state filters;
- individual checkboxes; and
- bulk selection for the current filtered results or all operations.

If a verified release already exists, choose it under `저장된 release와 계약 비교` (compare with a stored release). The server re-verifies the stored release, re-normalizes the current source, creates a fresh deterministic baseline, and compares the contracts. Destination, authentication, and enforced-risk changes require security review. Request, response, input-schema, output-schema, and removal changes carry compatibility impact. Tool-metadata-only differences require metadata review. A capability absent from the baseline release is classified as added.

Comparison never changes the operation selection. In particular, an `added` result against a subset release means that the capability was absent from that release; it does not prove that the operation was absent from the older source.

For a large contract, browser selection state stores one include-or-exclude default plus sparse exceptions. The operation explorer measures variable row heights and renders a bounded visible and overscan range together with the keyboard focus target. A filtered bulk action still applies to every matching operation, not only the mounted rows. Use the arrow keys, Home, End, Page Up, and Page Down to move checkbox focus. If the browser cannot provide the required resize observation, the explorer falls back to the complete accessible list.

Selection is a compiler-input allowlist, not a client-side display preference. The server reanalyzes the submitted source, verifies the review fingerprint and exact normalized operation IDs, and rejects a missing, empty, duplicate, unknown, malformed, or stale selection.

#### Save a reusable exact-selection preset

1. Select the required operations and enter a preset name.
2. Select `현재 선택 저장` (save current selection).
3. After analyzing the same source again, choose the preset under `선택 프리셋` (selection presets) and select `적용` (apply).
4. If the result is unexpected, select `적용 취소` (undo apply) to restore the immediately preceding selection state.

A preset is an **exact operation-ID allowlist from the saved analysis**, not a filter rule. Preset creation reanalyzes the source and passes the IDs through the same selection verifier used by registration. A preset with the same name and analysis cannot be silently replaced by a different selection; delete the existing preset through the confirmation flow before saving a replacement.

Preset lists return a bounded set of names, included counts, and fingerprint metadata rather than every stored operation ID. When you apply a preset, the console lazy-loads one exact detail record only after its analysis and selection fingerprints match.

A preset from the same discovery scope but a different analysis fingerprint appears as `이전 분석 · 적용 불가` (previous analysis; cannot apply) and cannot be applied directly. Select `재검토` (re-review) to make the server verify the current source, discovery scope, current analysis fingerprint, and saved selection fingerprint. It then offers only saved operation IDs that still exist in the current analysis.

Loading those re-review candidates is a second explicit action. It excludes every current operation that was not in the saved selection and does not bypass registration review. Because the contract behind an unchanged ID may still have changed, compare the release and review each operation contract before saving a new preset. HiMCP does not guess similar IDs or automatically include newly added operations.

The discovery scope is a non-authoritative lookup key derived from the adapter, source kind, normalized display filename and title, and canonical document-level origins. It falls back to the operation-origin set only when there is no usable root origin. Version or operation revisions normally retain the lineage, while a filename, title, or root-origin change starts a new scope. Even if reused identity hints expose an unrelated stale preset, it cannot be applied without an exact analysis-fingerprint match.

### Step 3. Review the execution contract

For every selected capability, review:

- MCP tool name, title, and description;
- HTTP method, path, and exact server;
- input and output JSON Schemas;
- required authentication schemes;
- side effects, risk, and confirmation requirements; and
- source provenance.

Excluded operations do not appear in the release, compilation evidence, or MCP `tools/list` result.

### Step 4. Approve the connection policy

1. Enter a display name and optional description that identify the connection in an AI tool.
2. Review every exact origin derived from the selected release.
3. For each credential binding, enter an environment-variable name rather than a secret value.
4. Review the policy for tools whose verified contract requires confirmation, such as write or delete operations.
5. If the release contains a plain-HTTP origin, separately approve the transport risk.

An origin match includes the scheme, host, and port, not only the hostname. The runtime does not permit a destination absent from the verified profile.

### Step 5. Export the MCP configuration

Copy or download the `mcpServers` JSON on the final screen. The descriptor contains launcher information for the verified profile and does not contain credential values.

The generated descriptor contains server-computed executable and profile paths. Treat it as a machine-local artifact: do not commit it or share it as a portable configuration, and do not replace its paths by hand.

## 5. Connect an AI tool

AI tools use different settings locations and interfaces, so HiMCP does not hard-code a product-specific path. Treat the descriptor generated by the console as the authoritative launcher configuration.

1. Merge its `mcpServers` entry into the MCP configuration for your AI tool.
2. Inject a value for each environment-variable name reported on the final screen through the MCP host's secret-aware process environment.
3. Restart or reload the AI tool or MCP host process.
4. Confirm that the host's tool list contains only the selected operations.
5. Before calling a write or delete tool, review its approval policy and expected upstream effect.

Consult the current documentation for your AI tool for its configuration location, environment injection, and MCP reload behavior. Changing the executable or profile path inside the descriptor can cause startup verification to fail.

## 6. Verify the connection

A valid connection has these observable properties:

- MCP initialization succeeds.
- `tools/list` contains only the selected capabilities.
- Calling an excluded tool name fails as an unknown capability.
- When authentication is required, the runtime reads only the environment variables declared by the profile.
- Every execution target matches an exact origin approved in the profile.

The repository test suite analyzes a complete API, compiles only a subset of its operations, and runs MCP initialization and `tools/list` through the JSON-lines stdio transport. It also verifies that an excluded tool call fails before it can reach the HTTP executor.

## 7. Troubleshooting

| Symptom                                   | What to check                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `API 분석` (analyze API) is disabled      | Confirm that the source and display filename are present and the displayed source-size limit is not exceeded.                                |
| Automatic detection fails                 | Check the source format and version, then choose an explicit source type from the current adapter list.                                      |
| Registration is disabled                  | Select at least one operation and resolve every error-severity diagnostic.                                                                   |
| A stale-analysis error appears            | The source changed after analysis. Analyze the current source again and re-review the selection.                                             |
| A preset cannot be applied                | If it is marked as a previous analysis, load the re-review candidates, inspect the current contract, and save a new preset.                  |
| Saving a same-name preset conflicts       | Presets are not overwritten. Confirm and delete the existing preset or save the current exact selection under another name.                  |
| Plain HTTP requires approval              | Prefer encrypted transport. Approve the risk explicitly only when plain HTTP is unavoidable in an appropriate environment.                   |
| The AI tool shows no tools                | Check where the descriptor was merged, the profile path, required environment variables, and whether the MCP host was restarted or reloaded. |
| A call fails during credential resolution | Confirm that the value was injected into the MCP host process environment, not stored in the descriptor or profile.                          |
| An excluded tool cannot be called         | This is expected. Analyze the source again and create a new release and profile that include the operation.                                  |

## 8. Local security boundary

The web console is a loopback-only setup tool, not a remote operations service.

- Do not expose it through a public reverse proxy or external hosting service.
- Raw source text is processed within a request and is not persisted as a console-managed artifact.
- Releases, profiles, descriptors, and selection presets are stored under `.himcp/console` by default with owner-only permissions.
- A preset is stored at `.himcp/console/selection-presets/<scope>/<preset>/preset.json`. It contains exact operation IDs and fingerprints but excludes raw source text, schemas, origins, authentication contracts, and credential names or values.
- The browser has no credential-value field, arbitrary launcher-command field, executable-module selector, or arbitrary output-path field.
- Every mutation, including POST and DELETE requests, is subject to loopback Host validation, exact same-origin validation, and a per-process CSRF token.
- This is a single-operating-system-user boundary. It does not prevent another process already running as the same user from changing managed artifacts.

See the [security model](security-model.md) and [architecture](architecture.md) for the complete trust boundaries.

## 9. Mobile layout

The same guide and workflow use a responsive layout rather than a separate mobile DOM. On a small screen, menus and primary actions retain touch targets of at least 44 pixels, and step cards render in one column without horizontal scrolling.

## Related documentation

- [Registering an HTTP API without OpenAPI](http-manifest.md)
- [Semantic provider plugins](provider-plugins.md)
- [Security model](security-model.md)
- [Architecture](architecture.md)
