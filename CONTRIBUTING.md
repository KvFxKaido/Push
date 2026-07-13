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

The TypeScript toolchain **typechecks with TS 7.0 GA (`7.0.2`) everywhere**; the `app/` stays split only for ESLint:

- **`cli/` and `mcp/github-server`** run **`typescript@~7.0.2`**. Both typecheck **and** emit go through the native `tsc` — `pnpm run typecheck` (root, covers `cli/`, which has no `package.json` of its own and compiles with the root's `typescript`), `cd mcp/github-server && pnpm run typecheck`, plus `build:cli` and the MCP server's `build`. TS 7's `tsc` ships a platform-specific native binary under `optionalDependencies`.
- **`app/`** typechecks with the **same GA `typescript@7.0.2`**, installed under an alias (`typescript-go: npm:typescript@~7.0.2`) and invoked as `node node_modules/typescript-go/lib/tsc.js`, plus **TS 6** (`typescript@^6.0.3`) for ESLint (emit is Vite's job — no `tsc` involved). It can't collapse to a single `typescript@7` yet: TS 7.0 GA ships **no** programmatic API, and `typescript-eslint` still hard-caps its `typescript` peer at `<6.1.0` ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) — gated on the stable API in TS 7.1 + ESLint async-parser support, months out). The alias dodges a `.bin/tsc` collision (GA `typescript@7` and the TS 6 copy both expose a `tsc` bin), so the app calls GA's compiler by explicit path. Under pnpm the split needs **no override**: pnpm resolves per importer instead of hoisting, so `app/` gets TS 6 and root/`mcp/` get TS 7 on their own (npm's `overrides: { "typescript": "$typescript" }` existed only to fight npm's flat tree, and is gone). Don't add a global `typescript` override to `pnpm-workspace.yaml` — overrides there are root-global and would pull cli/mcp down to TS 6. `cd app && pnpm run typecheck` covers the two leaf tsconfigs (`tsconfig.app.json`, `tsconfig.node.json`).

`pnpm run typecheck:all` at the root runs everything (cli + mcp on `tsc`, app on the aliased `tsc`). If the app's aliased native binary is missing (`--no-optional`, unsupported platform), typecheck it from the repo root with the root's GA compiler: `node node_modules/typescript/lib/tsc.js --noEmit -p app/tsconfig.app.json` (and `app/tsconfig.node.json`). When typescript-eslint supports TS 7, the app collapses the alias into a single `typescript@7` and the split goes away.

## Environments (WSL / Linux / macOS / Windows)

Primary development is **WSL / Linux / macOS / cloud**; native Windows is used mainly for the Android/APK shell. The repo is set up to behave the same across them, with a few knobs:

- **Line endings.** `.gitattributes` stores everything as **LF** (`* text=auto eol=lf`; `.bat`/`.cmd` stay CRLF in the working tree). On a Windows checkout, also set `git config core.autocrlf false` once — leaving the Windows default `true` makes git re-convert line endings that `.gitattributes` then has to undo, which shows up as phantom diffs and a Biome-format/commit dance.
- **Package manager.** The repo is a **pnpm workspace** (`pnpm-workspace.yaml`): root + `app/` + `mcp/github-server` share **one** `pnpm-lock.yaml`. A single `pnpm install` at the root installs all three — there is no separate `cd app && install` step any more. `package.json` pins `packageManager: pnpm@<version>` (corepack), so use that pnpm and the lockfile won't churn between environments; `git checkout -- pnpm-lock.yaml` is the safe reset. **pnpm stays on 10.x**, not 11 — pnpm 11 requires Node >=22.13 and the Cloudflare sandbox base image ships Node 20, where Push's own deps get pre-baked (`Dockerfile.sandbox`). Dependency build scripts are blocked by default; the ones that genuinely need a postinstall (esbuild, sharp, onnxruntime-node, protobufjs) are allow-listed in `pnpm-workspace.yaml` under `allowBuilds`.
- **CLI tests on native Windows.** Run `pnpm run test:cli` in **WSL/Linux** for a clean pass. On native Windows it still runs, but: tests that assert POSIX file modes (`0600`/`0700`) are auto-skipped via `skipOnWindows` (`cli/tests/test-environment.mjs`), so they report as **skips, not failures**. A handful of **genuine** Windows gaps remain *unskipped on purpose* (e.g. atomic-write-via-`rename` is not concurrency-safe on Windows — `EPERM` — and some skill-loader path handling) so they stay visible as real failures rather than being papered over. Don't add `skipOnWindows` to a test unless the behavior is truly POSIX-only.
- **Stray `nul` files / `tmpclaude-*` dirs.** Cross-platform bugs can create a `nul` file (a Windows reserved device name) that Windows can't delete; remove it from WSL with `wsl rm -f /mnt/c/path/to/nul`. Leftover `tmpclaude-*` subagent dirs are safe to delete (`wsl rm -rf /mnt/c/path/to/tmpclaude-*`).
