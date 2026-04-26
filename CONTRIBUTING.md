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

The root `npm run typecheck` runs against `cli/tsconfig.json` using `tsgo` from `@typescript/native-preview` (TypeScript 7.0). The native binary is delivered through platform-specific `optionalDependencies` (linux/darwin/win × x64/arm64). If you install with `--no-optional`, run on an unsupported platform, or otherwise see `tsgo: not found`, fall back to `cd cli && npx tsc --noEmit` — emit and `build:cli` still use `tsc`, so nothing else changes. The fan-out across all leaf tsconfigs lives at `npm run typecheck:tsgo`.
