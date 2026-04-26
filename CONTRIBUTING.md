# Contributing

Thanks for checking out Push.

Push is an opinionated project. Many architectural decisions are deliberate tradeoffs, not missing features or unfinished abstractions. Contributions are welcome, but alignment with the project's direction matters more than maximizing flexibility.

## Before opening a PR

For small fixes, typo corrections, and scoped quality-of-life improvements, feel free to open a PR directly.

For larger changes, please open an issue or discussion first. This includes:

- architectural refactors
- workflow changes that alter the chat/repo/sandbox model
- provider or runtime abstractions that increase complexity
- UI changes that shift the product away from its mobile-first focus

## What tends to fit well

- bug fixes
- documentation improvements
- focused reliability improvements
- narrow UX polish that preserves the existing product direction

## What may be declined

A suggestion or PR may be declined even if it is technically valid. That usually means it conflicts with the current design philosophy, scope, or tradeoffs Push is intentionally making.

Please do not take that personally.

## Philosophy

Push is being built around a few strong constraints:

- chat-first, repo-anchored workflows
- self-hosted and provider-flexible execution
- mobile-first usefulness
- reliability and observability over black-box automation

Those constraints are part of the product, not temporary limitations.

## Local development

Typechecking uses `tsgo` from `@typescript/native-preview` (TypeScript 7.0). The root `npm run typecheck` covers `cli/`; `cd app && npm run typecheck` covers the app's two leaf tsconfigs (`tsconfig.app.json` and `tsconfig.node.json`); `cd mcp/github-server && npm run typecheck` covers the GitHub MCP server; `npm run typecheck:tsgo` at the root runs everything. The native binary ships via platform-specific `optionalDependencies` (linux/darwin/win × x64/arm64). If you install with `--no-optional`, run on an unsupported platform, or otherwise see `tsgo: not found`, fall back to `npx tsc --noEmit` (cli, mcp/github-server) or `npx tsc -b` (app). Emit (`build:cli`, mcp/github-server's `build`, vite's `build`) still uses `tsc`, so nothing else changes.
