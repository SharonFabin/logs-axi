# Contributing to logs-axi

## Setup

Node 20 or newer.

```bash
npm install
npm test          # vitest
npm run typecheck
npm run bench     # token-cost bench, see README "Bench"
```

## Design

logs-axi follows the AXI guidelines for agent-facing CLIs: https://axi.md.
Keep output token-efficient, read-only and redacted by default.

## Tests

Tests use synthetic fixtures only. Never commit real log data, tokens, credentials or
patient data, in fixtures, snapshots, bench inputs or issue/PR text.

## Commits and PRs

Use [conventional commit](https://www.conventionalcommits.org/) messages (`feat:`, `fix:`,
`docs:`, `chore:`, ...). release-please reads them to pick the next version and write the
changelog, so the type matters: `feat` bumps minor, `fix` bumps patch.

Open a PR against `main`. A PR merges only with green CI (typecheck, tests, build).
