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

The TypeScript toolchain is on **TS 7.0 GA**, still split by package:

- **`cli/` and `mcp/github-server`** run **TS 7.0 GA** (`typescript@~7.0.2`). Both typecheck **and** emit go through the native `tsc` — `npm run typecheck` (root, covers `cli/`, which has no `package.json` of its own and compiles with the root's `typescript`), `cd mcp/github-server && npm run typecheck`, plus `build:cli` and the MCP server's `build`. TS 7's `tsc` ships a platform-specific native binary under `optionalDependencies`.
- **`app/`** stays on **TS 7 native-preview** typecheck (`tsgo` from `@typescript/native-preview`, also platform-specific `optionalDependencies`) plus **TS 6** (`typescript@^6.0.3`) for ESLint (emit is Vite's job — no `tsc` involved). The app can't move to TS 7's `typescript` package yet: TS 7.0 GA ships **no** programmatic API (7.1 is expected to introduce a new one), and `typescript-eslint` still hard-caps its `typescript` peer at `<6.1.0` (as of 8.63.0). It keeps `tsgo` (a distinct binary) rather than GA `tsc` on purpose — GA `typescript@7`'s only bin is `tsc`, which would collide in `.bin/tsc` with the app's TS 6 copy. `cd app && npm run typecheck` covers the two leaf tsconfigs (`tsconfig.app.json`, `tsconfig.node.json`).

`npm run typecheck:all` at the root runs everything (cli + mcp on `tsc`, app on `tsgo`). If you install with `--no-optional`, run on an unsupported platform, or otherwise see `tsgo: not found`, fall back to `npx tsc --noEmit` (cli, mcp/github-server) or `npx tsc -b` (app). When typescript-eslint supports TS 7, the app drops native-preview and folds onto `typescript@7` too, and the `tsgo` split goes away.

## Environments (WSL / Linux / macOS / Windows)

Primary development is **WSL / Linux / macOS / cloud**; native Windows is used mainly for the Android/APK shell. The repo is set up to behave the same across them, with a few knobs:

- **Line endings.** `.gitattributes` stores everything as **LF** (`* text=auto eol=lf`; `.bat`/`.cmd` stay CRLF in the working tree). On a Windows checkout, also set `git config core.autocrlf false` once — leaving the Windows default `true` makes git re-convert line endings that `.gitattributes` then has to undo, which shows up as phantom diffs and a Biome-format/commit dance.
- **Package manager.** `package.json` pins `packageManager: npm@<version>` (corepack). Use that npm so `package-lock.json` doesn't churn between environments. If a lockfile shows up modified after a plain install, `git checkout -- package-lock.json` is the safe reset.
- **CLI tests on native Windows.** Run `npm run test:cli` in **WSL/Linux** for a clean pass. On native Windows it still runs, but: tests that assert POSIX file modes (`0600`/`0700`) are auto-skipped via `skipOnWindows` (`cli/tests/test-environment.mjs`), so they report as **skips, not failures**. A handful of **genuine** Windows gaps remain *unskipped on purpose* (e.g. atomic-write-via-`rename` is not concurrency-safe on Windows — `EPERM` — and some skill-loader path handling) so they stay visible as real failures rather than being papered over. Don't add `skipOnWindows` to a test unless the behavior is truly POSIX-only.
- **Stray `nul` files / `tmpclaude-*` dirs.** Cross-platform bugs can create a `nul` file (a Windows reserved device name) that Windows can't delete; remove it from WSL with `wsl rm -f /mnt/c/path/to/nul`. Leftover `tmpclaude-*` subagent dirs are safe to delete (`wsl rm -rf /mnt/c/path/to/tmpclaude-*`).
