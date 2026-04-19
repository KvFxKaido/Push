# Push — Agent Context

This is the **required entry doc** for Push. The loader currently reads `AGENTS.md` first, so this file must be self-sufficient.

[`docs/architecture.md`](docs/architecture.md) is the deeper canonical reference for architecture and implementation details, but this file carries the minimum contract Push agents need at startup.

## Core model

- Push is a mobile-first AI coding notebook with a web app and local CLI.
- Core roles: **Orchestrator**, **Explorer**, **Coder**, **Reviewer**, **Auditor**.
- Repo context is locked to the selected repo.
- Chats are branch-scoped.
- The **active branch** is the commit target, push target, diff base, and chat context.
- Branch switching is explicit and tears down the sandbox.
- Branch creation is UI-owned; the assistant should not create or switch branches itself.

## Repo map

- `app/` — web app, worker, UI, hooks, and app logic
- `cli/` — local terminal agent
- `sandbox/` — Modal sandbox backend
- `lib/` — shared logic used by app/cli
- `docs/` — plans, design notes, and archived references

## Provider behavior

- Settings stores default backend/model picks plus the active backend preference.
- The current chat locks the Orchestrator provider/model on first send.
- Delegated **Coder** and **Explorer** runs inherit that chat-locked provider/model.
- **Reviewer** keeps its own sticky provider/model selection.
- **Auditor** follows the chat lock when available, otherwise the active backend.

## Workflow rules

- Use **Explorer** for read-only investigation and architecture tracing.
- Use **Coder** for implementation in the sandbox.
- Use **Reviewer** for advisory diffs on branch diff, last commit, or working tree.
- Use **Auditor** for the pre-commit SAFE/UNSAFE gate on standard commits.
- Standard merges go through **GitHub PR flow** only.
- Push never runs `git merge` locally.
- PR-backed branch diff reviews are the only reviews that can be posted back to GitHub.

## Scratch workspace

- Scratch workspaces are available when GitHub auth is not needed.
- They are sandbox-only and do not use repo GitHub tools.
- Use them for quick experiments or when starting without repo auth.

## New feature checklist

Three guardrails surfaced during the 2026-04 Big Four extraction and CLI parity work. Apply them before adding a cross-surface feature:

- **Storage: scope keys CLI-first.** Durable identifiers (e.g. `repoFullName + branch`) beat per-session ones. Web chatId is durable; CLI sessionId is per-run, so a chatId-shaped key breaks cross-run retrieval on CLI (see the PR #333 typed-memory retraction). If both surfaces touch the store, put the scope resolver in `lib/` from day one — follow the `lib/workspace-identity.ts` + `lib/role-memory-budgets.ts` pattern, not a per-surface helper.
- **Background tasks: name the coordinator's home first.** State + callback clusters need an owning module before the first line of code. If the owner isn't obvious in one sentence, the coordinator lands in `useChat.ts` by default (this is how it regrew 125% between 2026-03-25 and 2026-04-19). New feature hooks ship as sibling modules under `app/src/hooks/` or `app/src/lib/`; the `max-lines` ESLint guard on `useChat.ts` enforces this at CI.
- **Web/CLI communication: one source of truth per vocabulary.** Any new tool, event, or envelope type needs a single canonical definition and a drift-detector test in the same PR. Gap 2 (2026-04-18) surfaced three parallel layers (dispatcher allowlist, prompt protocol, capability table) diverging silently; the `cli/tests/daemon-integration.test.mjs` sync test is the precedent. `lib/capabilities.ts` and `cli/protocol-schema.ts` strict mode are the shared-table patterns to extend.

If a fourth guardrail emerges, promote this section to its own doc under `docs/decisions/` rather than appending.

## Pointer

For full architecture, tool protocol, and implementation detail, see [`docs/architecture.md`](docs/architecture.md).
For quick start and entry points, see [`CLAUDE.md`](CLAUDE.md).
If this file conflicts with `docs/architecture.md`, prefer `docs/architecture.md` for detailed behavior and this file for startup contract.