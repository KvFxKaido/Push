# Push — Agent Context

Startup loaders use the first existing file in this order: `PUSH.md` → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`. With no `PUSH.md`, keep this file self-sufficient.

[`ARCHITECTURE.md`](ARCHITECTURE.md) is canonical for detailed behavior; this file is the startup contract.

## Core model

- Push collapses the mobile dev stack — GitHub, terminal, CI, code, and AI — into one conversation: a git tool with the feel of your everyday AI app, across a web app, an experimental Capacitor Android shell, and a local CLI.
- Internal runtime roles are **Orchestrator**, **Explorer**, **Coder**, **Reviewer**, and **Auditor**. User-facing surfaces de-emphasize that org chart: Explorer/Coder render as workflow phases through `lib/role-display.ts`, while Reviewer/Auditor keep names where attribution is a trust signal.
- Repo context is locked to the selected repo.
- Chats are repo-scoped; the active branch is mutable session state that follows sandbox HEAD.
- The **active branch** is the commit target, push target, and diff base.
- Typed branch tools and chat resume preserve the sandbox (warm switch); a branch change updates the active conversation's branch **in place** — it no longer migrates the chat or routes to a per-branch chat. A bare UI swap that bypasses the warm path may restart the sandbox.
- Models can create branches with `create_branch` and switch with `switch_branch` (`sandbox_create_branch` / `sandbox_switch_branch` still resolve). These keep Push's tracked branch in sync with sandbox HEAD. Raw `git checkout` / `git switch` branch ops and any single bare operand except previous-branch shorthand (`git checkout -` / `git switch -`) block in `sandbox_exec` and route through typed tools. File restores require `git checkout -- <path>` or `git checkout HEAD <path>`; ref expressions (`HEAD~1`, `main^`, `branch@{upstream}`) pass through. `git branch -m`/`-M`/`--move` blocks outright (rename would desync the tracked branch; no typed rename — use `create_branch` at the same commit, then delete the old name).

## Repo map

- `app/` — web app, experimental Capacitor Android app, worker, UI, hooks, and app logic
- `app/android/` — Capacitor Android project; **committed source** (build outputs + the regenerated web bundle are ignored via `app/android/.gitignore`); `cap sync` updates web assets + plugin registration
- `cli/` — local terminal agent
- `mcp/` — MCP server integration (`mcp/github-server/` is the `push-github-mcp` binary that exposes the shared GitHub tool core over stdio)
- `sandbox/` — Modal sandbox backend
- `Dockerfile.sandbox` + `app/src/worker/worker-cf-sandbox.ts` + `app/src/lib/cloudflare-sandbox-provider.ts` — Cloudflare Sandbox SDK sibling; selected via `PUSH_SANDBOX_PROVIDER`
- `lib/` — shared logic used by app/cli
- `docs/` — plans, design notes, and archived references

## Provider behavior

- Settings stores default backend/model picks plus the active backend preference.
- The current chat locks the Orchestrator provider/model on first send.
- Delegated Coder/Explorer runtime runs inherit that chat-locked provider/model.
- Reviewer keeps its own sticky provider/model selection.
- Auditor follows the chat lock when available, otherwise the active backend.

## Workflow rules

- The Orchestrator is the single capable lead — it implements directly (read → edit → run → ship) rather than handing ordinary coding off. Do the work in-loop.
- Use the Explorer runtime for read-only investigation and architecture tracing.
- The Coder runtime is the detached path (CLI/daemon task graphs, background jobs), not the default — reach for `delegate:coder` only for genuinely detached work, not ordinary edits.
- Use Reviewer for advisory diffs on branch diff, last commit, or working tree.
- Use Auditor at the delivery boundary: web/cloud `sandbox_commit` is silent/local and `prepare_push` / direct `sandbox_push` audit the cumulative push diff; CLI `git_commit` still uses the pre-commit SAFE/UNSAFE gate.
- Standard merges go through **GitHub PR flow** only.
- Push never runs `git merge` locally.
- PR-backed branch diff reviews are the only reviews that can be posted back to GitHub.

## Behavior lives in code

Prompts and docs describe behavior; they do not create it.

- If a prompt change is compensating for something the runtime *should* handle (validation, routing, safety, correctness), fix the runtime instead. Prompts are guidance for model cooperation, not a control plane.
- Legitimate prompt/doc updates: teaching models about hard runtime boundaries that already exist in code (e.g. PR #378 documenting that the tool-call parser only scans `content`, not reasoning tokens), clarifying role contracts, or surfacing quirks models can't infer.
- When in doubt: ask whether a non-cooperating model could break the system. If yes, the fix belongs in code.

## Decision-doc discipline

When you ship something specified in a `docs/decisions/` doc, flip that doc's `Status:` field in the same PR — part of the ship checklist, not a follow-up. Spec docs that drift become silently misleading. See `docs/decisions/README.md` for the status labels (Current / Historical / Draft / Reference / Superseded by `<doc>` / Merged into `<doc>`).

## Validation commands

Push derives validation commands (test, lint, typecheck, format, build, check) from `package.json` scripts and recognized config files. To override one kind, add a fenced `bash`/`sh`/`shell` block with a leading `# kind:` directive to the first project-instruction file in loader order (`PUSH.md` → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`). Overrides are per-kind and first-hit wins; the umbrella `check` is always additive. `setup` is a hint-only kind (never derived from scripts): the environment-preparation command the autonomous reviewer runs once in its sandbox before the typecheck/test verifiers.

For this repo:

```bash
# NOTE: text on a `# kind:` line IS the command (the parser's inline form). Keep
# prose on its own comment line — a parenthetical here silently becomes the command
# and the real one below is dropped. One pnpm install covers root + app/ + mcp/.
# setup:
pnpm install
# test:
TMPDIR=/tmp TEMP=/tmp TMP=/tmp pnpm run test:cli && pnpm run test:mcp:github
# typecheck:
pnpm run typecheck:all
# check:
pnpm run typecheck:all
```

## Scratch workspace

- Available when GitHub auth isn't needed: sandbox-only, no repo GitHub tools.
- Use for quick experiments or when starting without repo auth.

## New feature checklist

Three guardrails surfaced during the 2026-04 Big Four extraction and CLI parity work. Apply them before adding a cross-surface feature:

- **Storage: scope keys CLI-first.** Durable identifiers (e.g. `repoFullName + branch`) beat per-session ones. Web chatId is durable; CLI sessionId is per-run, so a chatId-shaped key breaks cross-run retrieval on CLI (see the PR #333 typed-memory retraction). If both surfaces touch the store, put the scope resolver in `lib/` from day one — follow the shared-module pattern of `lib/role-memory-budgets.ts` and `lib/workspace-identity.ts`.
- **Background tasks: name the coordinator's home first.** State + callback clusters need an owning module before the first line of code. If the owner isn't obvious in one sentence, the coordinator lands in `useChat.ts` by default. New feature hooks ship as sibling modules under `app/src/hooks/` or `app/src/lib/`; the `max-lines` ESLint guard on `useChat.ts` enforces this at CI.
- **Web/CLI communication: one source of truth per vocabulary.** Any new tool, event, or envelope type needs a single canonical definition and a drift-detector test in the same PR. Gap 2 (2026-04-18) surfaced three parallel layers (dispatcher allowlist, prompt protocol, capability table) diverging silently. Pick the precedent that matches the vocabulary: tool-protocol drift uses `cli/tests/daemon-integration.test.mjs` (prompt-vs-capability sync); event/envelope drift uses `cli/tests/protocol-drift.test.mjs` (strict-mode schema pins). Extend `lib/capabilities.ts` for shared capability tables and `lib/protocol-schema.ts` strict mode for protocol envelopes.
