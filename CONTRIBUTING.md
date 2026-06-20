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

The TypeScript toolchain is mid-transition to 7.0 and is split by package:

- **`cli/` and `mcp/github-server`** run **TS 7.0 RC** (`typescript@rc`). Both typecheck **and** emit go through the native `tsc` — `npm run typecheck` (root, covers `cli/`), `cd mcp/github-server && npm run typecheck`, plus `build:cli` and the MCP server's `build`. TS 7's `tsc` ships a platform-specific native binary under `optionalDependencies`.
- **`app/`** stays on **TS 7 native-preview** typecheck (`tsgo` from `@typescript/native-preview`, also platform-specific `optionalDependencies`) plus **TS 6** (`typescript@^6.0.3`) for emit and ESLint. The app can't move to TS 7's `typescript` package yet: TS 7.0 only exposes the `./unstable/*` programmatic API, and `typescript-eslint` needs the legacy API that lands in **TS 7.1**. `cd app && npm run typecheck` covers the two leaf tsconfigs (`tsconfig.app.json`, `tsconfig.node.json`); emit is Vite's job.

`npm run typecheck:all` at the root runs everything (cli + mcp on `tsc`, app on `tsgo`). If you install with `--no-optional`, run on an unsupported platform, or otherwise see `tsgo: not found`, fall back to `npx tsc --noEmit` (cli, mcp/github-server) or `npx tsc -b` (app). When typescript-eslint supports TS 7.1, the app folds onto `typescript@rc`/`latest` too and the `tsgo` split goes away.
