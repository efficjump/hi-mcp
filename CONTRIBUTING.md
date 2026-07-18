# Contributing to HiMCP

Thank you for helping make API capabilities safer and easier for agents to use.

## Development setup

HiMCP requires Node.js 22 or newer. Corepack selects the pnpm version declared by the repository. Install dependencies and run the full verification suite:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Design principles

- Keep source adapters independent from MCP protocol versions.
- Represent generated behavior in the canonical Capability IR instead of API-specific code.
- Allow models to propose semantic changes, but execute only deterministic, verified plans.
- Treat remote specifications, tool descriptions, model output, and API responses as untrusted input.
- Add tests and an architecture decision record when changing a public contract or trust boundary.

## Pull requests

Keep pull requests focused and describe the observed behavior, design choice, and verification performed. New source adapters should include representative fixtures without credentials or personal data.

Security vulnerabilities should not be filed as public issues. Follow [SECURITY.md](SECURITY.md) instead.
