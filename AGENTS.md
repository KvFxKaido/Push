# Push — Agent Context

This is the **required entry doc** for Push. Repo instruction loaders read `AGENTS.md` before `CLAUDE.md` and `GEMINI.md`, so this file must be self-sufficient. The CLI may still prefer a local `.push/instructions.md` override when present.

[`docs/architecture.md`](docs/architecture.md) is the deeper canonical reference for architecture and implementation details, but this file carries the minimum contract Push agents need at startup.

## Core model

- Push is a mobile-first AI coding notebook with a web app and local CLI.
- Core roles: **Orchestrator**, **Explorer**, **Coder**, **Reviewer**, **Auditor**.
- Repo context is locked to the selected repo.
- Chats are branch-scoped.
- The **active branch** is the commit target, push target, diff base, and chat context.
- Branch transitions preserve context: the sandbox stays alive, and the active chat either migrates to the new branch (fork) or routes to the existing chat for that branch (switch).
- Models can create branches via `sandbox_create_branch` and switch to existing branches via `sandbox_switch_branch`. Both keep Push's tracked branch in sync with sandbox HEAD. Raw `git checkout <branch>` / `git switch <branch>` (and `-b` / `-c` variants) are blocked in `sandbox_exec` and route through the typed tools.

## Repo map

- `app/` — web app, worker, UI, hooks, and app logic
- `cli/` — local terminal agent
- `sandbox/` — Modal sandbox backend
- `Dockerfile.sandbox` + `app/src/worker/worker-cf-sandbox.ts` + `app/src/lib/cloudflare-sandbox-provider.ts` — Cloudflare Sandbox SDK sibling; selected via `PUSH_SANDBOX_PROVIDER`
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

## Behavior lives in code

Prompts and docs describe behavior; they do not create it.

- If a prompt change is compensating for something the runtime *should* handle (validation, routing, safety, correctness), fix the runtime instead. Prompts are guidance for model cooperation, not a control plane.
- Legitimate prompt/doc updates: teaching models about hard runtime boundaries that already exist in code (e.g. PR #378 documenting that the tool-call parser only scans `content`, not reasoning tokens), clarifying role contracts, or surfacing quirks models can't infer.
- When in doubt: ask whether a non-cooperating model could break the system. If yes, the fix belongs in code.

## Scratch workspace

- Scratch workspaces are available when GitHub auth is not needed.
- They are sandbox-only and do not use repo GitHub tools.
- Use them for quick experiments or when starting without repo auth.

## New feature checklist

Three guardrails surfaced during the 2026-04 Big Four extraction and CLI parity work. Apply them before adding a cross-surface feature:

- **Storage: scope keys CLI-first.** Durable identifiers (e.g. `repoFullName + branch`) beat per-session ones. Web chatId is durable; CLI sessionId is per-run, so a chatId-shaped key breaks cross-run retrieval on CLI (see the PR #333 typed-memory retraction). If both surfaces touch the store, put the scope resolver in `lib/` from day one — follow the shared-module pattern of `lib/role-memory-budgets.ts`, not a per-surface helper like today's `cli/workspace-identity.ts` (which should be promoted to `lib/` the next time web needs it).
- **Background tasks: name the coordinator's home first.** State + callback clusters need an owning module before the first line of code. If the owner isn't obvious in one sentence, the coordinator lands in `useChat.ts` by default (this is how it regrew 125% between 2026-03-25 and 2026-04-19). New feature hooks ship as sibling modules under `app/src/hooks/` or `app/src/lib/`; the `max-lines` ESLint guard on `useChat.ts` enforces this at CI.
- **Web/CLI communication: one source of truth per vocabulary.** Any new tool, event, or envelope type needs a single canonical definition and a drift-detector test in the same PR. Gap 2 (2026-04-18) surfaced three parallel layers (dispatcher allowlist, prompt protocol, capability table) diverging silently. Pick the precedent that matches the vocabulary: tool-protocol drift uses `cli/tests/daemon-integration.test.mjs` (prompt-vs-capability sync); event/envelope drift uses `cli/tests/protocol-drift.test.mjs` (strict-mode schema pins). Extend `lib/capabilities.ts` for shared capability tables and `cli/protocol-schema.ts` strict mode for protocol envelopes.

If a fourth guardrail emerges, promote this section to its own doc under `docs/decisions/` rather than appending.

## Pointer

For full architecture, tool protocol, and implementation detail, see [`docs/architecture.md`](docs/architecture.md).
For quick start and entry points, see [`CLAUDE.md`](CLAUDE.md).
If this file conflicts with `docs/architecture.md`, prefer `docs/architecture.md` for detailed behavior and this file for startup contract.
