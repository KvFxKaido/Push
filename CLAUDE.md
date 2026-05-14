# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Push is a mobile-first AI coding agent with three surfaces — a web app, an experimental Capacitor Android shell, and a local CLI — all sharing a role-based runtime in root `lib/`.

> Loader order is `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`. `AGENTS.md` carries the startup contract and overrides this file when they conflict; `docs/architecture.md` is the canonical source of truth for architecture details.

## Quick start

### Web app + Worker

```bash
cd app && npm install && npm run dev      # Vite on :5173, /api/* proxies to :8787
npx wrangler dev --port 8787              # in a second terminal, from repo root
```

### CLI

```bash
npm install
./push config init        # interactive provider/model/key setup → ~/.push/config.json (chmod 0600)
./push                    # full-screen TUI today; PUSH_TUI_ENABLED=0 ./push for transcript REPL
./push run --task "..."   # headless single-task mode
```

### Android (experimental, debug-only)

```bash
cd app && npm run android:sync && cd android && ./gradlew installDebug
```

`app/android/` is gitignored — `npm run android:setup` regenerates it.

## Validation commands

`AGENTS.md` declares the canonical commands; mirror them when wiring scripts:

```bash
# test:
npm run test:cli && npm run test:mcp:github
# typecheck:
npm run typecheck:tsgo
# check:
npm run typecheck:tsgo
```

Per-surface:

| Surface | Lint | Typecheck | Test | Build |
|---|---|---|---|---|
| Root (CLI + MCP wiring) | `npm run format:check` (Biome) | `npm run typecheck:tsgo` | `npm run test:cli` | `npm run build:cli` |
| `app/` | `npm run lint` (ESLint) | `npm run typecheck` | `npm test` (vitest) / `npm run test:watch` | `npm run build` |
| `mcp/github-server/` | — | `npm run typecheck` | `npm test` | `npm run build` |

Run a single CLI test with `node --import tsx --test cli/tests/<name>.test.mjs`. Run a single app test with `cd app && npx vitest run path/to/file.test.ts`.

Typechecking uses `tsgo` from `@typescript/native-preview` (TypeScript 7). If `tsgo: not found` (unsupported platform, `--no-optional` install), fall back to `npx tsc --noEmit` for `cli/` and `mcp/github-server`, `npx tsc -b` for `app/`. Emit: `build:cli` and `mcp/github-server`'s `build` use `tsc`; `app/` uses `vite build` (esbuild/rollup), with `tsgo`/`tsc` only running for typecheck.

Biome formats the entire monorepo from the root config (`biome.json`); the linter is intentionally disabled there — ESLint runs only inside `app/`. Biome ignores `app/src/components/ui/**`, `sandbox/**`, and the standard build artifacts.

## Architecture

### Roles (locked, models replaceable)

| Role | Responsibility |
|---|---|
| **Orchestrator** | Conversational lead, interprets intent, delegates |
| **Explorer** | Read-only investigation, code tracing, evidence gathering |
| **Coder** | Autonomous implementation in the sandbox |
| **Reviewer** | On-demand advisory diff review (branch diff / last commit / working tree) |
| **Auditor** | Pre-commit SAFE/UNSAFE gate; defaults to UNSAFE on error |

**Provider routing.** Settings holds defaults + the active backend pick. The current chat **locks** the Orchestrator provider/model on first send; delegated Coder and Explorer runs **inherit** that lock. Reviewer keeps its own sticky selection. Auditor follows the chat lock when present, else the active backend.

### Repo / session / branch model

- One **active branch** per repo session — it's the commit target, push target, diff base, and chat context.
- Chats are **branch-scoped**. Branch transitions initiated via the typed branch tools (`create_branch` / `switch_branch`) **preserve the sandbox** — `skipBranchTeardownRef` in `app/src/sections/WorkspaceSessionScreen.tsx` and `app/src/hooks/useWorkspaceSandboxController.ts` suppresses teardown so the long-running container survives. **UI-initiated branch swaps restart the sandbox** by design (the controller defaults to `stopSandbox()` on `current_branch` change) — that's the desync guard, not an oversight. Use the typed tools when the intent is to keep the sandbox.
- A `BranchSwitchPayload` of `kind: 'forked'` migrates the current chat onto the new branch; `'switched'` routes to (or auto-creates) the chat for the target branch.
- Branch ops are **tool-callable**: `create_branch` (forked) and `switch_branch` (switched). Long-form aliases `sandbox_create_branch` / `sandbox_switch_branch` still resolve.
- Raw `git checkout <branch>` / `git switch <branch>` (and `-b`/`-c`) are **blocked** in `sandbox_exec` regardless of approval mode — the issue is state sync, not consent. Detection is best-effort: bare names are caught; for `git checkout`, operands containing `/` or `.` pass through so file restores like `src/utils` keep working; for `git switch`, slash-shaped names like `feat/foo` are blocked because `switch` is branch-only. Use the typed tools when you know the operand is a branch.
- Foreground/background result split: foreground tools emit `branchSwitch` for UI routing; background coder jobs emit `meta.branchCreated` / `meta.branchSwitched` for observability only.

### Delivery rules

- Standard commits go through **Auditor** as a required SAFE/UNSAFE gate.
- Reviewer is advisory; **only PR-backed branch-diff reviews** can be posted back to GitHub.
- Standard merges go through the **GitHub PR flow** only — Push **never** runs local `git merge`.
- `Protect Main` may block direct commits to `main`.

### Shared runtime in root `lib/`

Cross-surface semantics live here and are consumed by both web and CLI. Don't re-implement them per surface — promote a per-surface helper into `lib/` the moment a second surface needs it. Examples already in `lib/`:

- `task-graph.ts`, `tool-dispatch.ts`, `tool-execution-runtime.ts`, `tool-protocol.ts`, `tool-registry.ts`
- `context-memory*` (store / retrieval / packing / invalidation), `working-memory.ts`, `role-memory-budgets.ts`
- `delegation-brief.ts`, `role-context.ts`, `runtime-contract.ts`, `run-events.ts`
- Role agents: `coder-agent.ts`, `explorer-agent.ts`, `auditor-agent.ts`, `reviewer-agent.ts`, `deep-reviewer-agent.ts`
- `sandbox-provider.ts` (the abstraction Cloudflare and Modal both implement)
- `capabilities.ts` (shared capability tables — extend here, not per-surface)

The web app and CLI keep **shell-specific coordinators local** (e.g. `app/src/hooks/chat-*` for the web round loop, `cli/engine.ts` for the terminal loop). The target is a shared agent/runtime contract, not identical UX.

### Sandbox backend (pluggable)

Both backends implement `SandboxProvider` and route through the same `/api/sandbox/*` Worker endpoint. The selector is `PUSH_SANDBOX_PROVIDER` in `wrangler.jsonc`:

- **`cloudflare`** (default) — `Dockerfile.sandbox` + `app/src/worker/worker-cf-sandbox.ts` + `app/src/lib/cloudflare-sandbox-provider.ts`. Container, Durable Object binding, and `SANDBOX_TOKENS` KV are already provisioned in `wrangler.jsonc`; no extra deploy step beyond `wrangler deploy`.
- **`modal`** — `sandbox/app.py` (Python + FastAPI on Modal). Deploy with `cd sandbox && modal deploy app.py` and set `MODAL_SANDBOX_BASE_URL` via `wrangler secret put`.

### Tool protocol

Tool calls normalize to the same text-dispatch path: fenced/bare JSON in the model's `content` stream, plus OpenAI-native `tool_calls` that `lib/openai-sse-pump.ts` flushes back into fenced JSON. `lib/tool-call-parsing.ts` only scans `content`, **not** reasoning tokens — relevant when teaching models that emit thinking blocks. **Per-turn budget:** read-only calls run in parallel (cap 6), pure file mutations run sequentially as one batch (cap 8), and at most one trailing side-effecting call (`sandbox_exec`, commit/push, delegation, workflow dispatch, etc.) is allowed. Ordering violations and extra side effects are rejected with structured errors. Web grouping lives in `app/src/lib/tool-dispatch.ts`; the shared CLI detection kernel lives in `lib/tool-dispatch.ts`.

### Surface-specific landmarks

- **Web app** (`app/src/`): `hooks/chat-*` is the round loop and queue (`useChat.ts` is guarded by an ESLint `max-lines` rule — new feature hooks ship as sibling modules under `hooks/` or `lib/`, not appended here). `worker.ts` is the Cloudflare Worker entry; `worker/worker-cf-sandbox.ts` is the CF Sandbox handler. `components/ui/` is shadcn — Biome and contributors generally leave it alone.
- **CLI** (`cli/`): entry `cli.ts`, loop `engine.ts`, executor `tools.ts`, hashline edits `hashline.ts`, sessions `session-store.ts`, daemon `pushd.ts`. CLI auto-loads workspace skills from `.push/skills/*.md` and `.claude/commands/**/*.md` (nested paths flatten with hyphens).
- **MCP** (`mcp/github-server/`): the GitHub MCP server consumed in the chat layer. It has its own `package.json`, `tsconfig`, and test runner.

## Conventions

### Behavior lives in code, not prompts

If a prompt change is compensating for something the runtime *should* handle (validation, routing, safety, correctness), **fix the runtime instead**. Prompts are guidance for cooperating models — not a control plane. Legitimate prompt/doc updates: surfacing hard runtime boundaries (e.g. that the parser ignores reasoning tokens), clarifying role contracts, or documenting quirks models can't infer. Test: if a non-cooperating model could break it, the fix belongs in code.

### Decision-doc discipline

When you ship something specified in `docs/decisions/`, **flip that doc's `Status:` field in the same PR**. Don't leave specs at "Draft" while the code has landed. See `docs/decisions/README.md` for the label vocabulary (Current / Historical / Draft / Reference / Superseded by `<doc>` / Merged into `<doc>`).

### New feature checklist (cross-surface work)

Three guardrails from the 2026-04 Big Four extraction; apply before adding cross-surface features:

1. **Storage: scope keys CLI-first.** Durable identifiers (`repoFullName + branch`) beat per-session ones. Web `chatId` is durable but CLI `sessionId` is per-run, so chatId-shaped keys break cross-run retrieval on CLI. If both surfaces touch the store, put the scope resolver in `lib/` from day one (see `lib/role-memory-budgets.ts` as the shape to follow).
2. **Background tasks: name the coordinator's home first.** State + callback clusters need an owning module **before the first line of code**. If the owner isn't obvious in one sentence, the coordinator silently lands in `useChat.ts`. Ship feature hooks as siblings under `app/src/hooks/` or `app/src/lib/`; the `max-lines` ESLint guard on `useChat.ts` enforces this in CI.
3. **Web/CLI communication: one source of truth per vocabulary.** Any new tool, event, or envelope type needs a single canonical definition **and a drift-detector test in the same PR**. Tool-protocol drift uses `cli/tests/daemon-integration.test.mjs` (prompt-vs-capability sync); event/envelope drift uses `cli/tests/protocol-drift.test.mjs` (strict-mode schema pins). Extend `lib/capabilities.ts` for shared capability tables and `cli/protocol-schema.ts` strict mode for envelopes.

### Project instructions loading

Loader order is `AGENTS.md` → `CLAUDE.md` → `GEMINI.md` (first found wins). Caps differ per surface: the **web/repo** loader (`fetchProjectInstructions` in `app/src/lib/github-tools.ts`) fetches via GitHub REST and truncates at **5,000 chars** with a marker, then re-reads from the sandbox once it's ready (two-phase, not strictly first-found-wins end-to-end). The **CLI/shared** loader (`lib/project-instructions.ts`, `cli/workspace-context.ts`) caps at **8,000 chars**. The CLI additionally honors `.push/instructions.md` as a higher-priority local override, then falls back to the same chain. CLI workspace context injects the result as a `[PROJECT_INSTRUCTIONS]` block alongside a workspace snapshot (git branch, dirty files, top-level tree, manifest summary).

## Pointers

- [`AGENTS.md`](AGENTS.md) — startup contract; **read this first**, it overrides this file
- [`docs/architecture.md`](docs/architecture.md) — canonical architecture, tool protocol, repo/session model
- [`docs/DESIGN.md`](docs/DESIGN.md) — visual tokens, colors, typography, components
- [`cli/README.md`](cli/README.md) — CLI surfaces, providers, env vars, tools, sessions
- [`cli/architecture.md`](cli/architecture.md) — CLI runtime layers
- [`app/README.md`](app/README.md) — frontend, Worker secrets, sandbox backend selection, Android
- [`docs/decisions/`](docs/decisions/) — design decisions with `Status:` lifecycle
- [`docs/runbooks/`](docs/runbooks/), [`docs/security/`](docs/security/) — ops + provider usage policies
- [`ROADMAP.md`](ROADMAP.md) — current product priorities
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — philosophy, what fits, what may be declined
