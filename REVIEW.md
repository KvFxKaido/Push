# REVIEW.md

Repository-specific review guidance for Push. Adapted from our GitHub Actions
review bot (`.github/workflows/gemini-review.yml`) so automated and human reviews
share one standard.

Push is a mobile-first AI coding agent with three surfaces — a web app, an
experimental Capacitor Android shell, and a local CLI — all sharing a role-based
runtime in root `lib/`. Most review value here is **cross-surface consistency**
and **runtime-vs-prompt discipline**, not generic lint. The canonical references
are `AGENTS.md` (startup contract, wins on conflict), `CLAUDE.md`, and
`docs/architecture.md`.

Standard review hygiene — fact-based comments only, no duplicate or
restate-the-code noise, one issue per comment — is assumed. This file covers
what's **specific to Push**: how to weight findings and where the real defects
live.

## Review priorities (in order)

1. **Correctness** — logic errors, unhandled edge cases, race conditions,
   incorrect API usage, data-validation flaws.
2. **Security** — injection (command/XSS/SQL), insecure storage, weak access
   controls, secrets exposure. Pay special attention to `sandbox_exec` command
   construction and anything that interpolates model output into a shell.
3. **Cross-surface consistency** — see "Push-specific focus areas" below. This is
   the most common real defect in this repo.
4. **Efficiency & performance** — bottlenecks, needless work, memory leaks,
   behavior under expected load.
5. **Maintainability** — readability, modularity, idiomatic style. Default to the
   language's idiomatic standard when no style guide is specified.
6. **Testing** — adequate unit/integration coverage and edge cases. New shared
   vocabulary (tools, events, envelopes) requires a drift-detector test in the
   same PR (see below).
7. **Error logging & observability** — effective logging and hooks where they
   matter.

## Severity scale

- 🔴 **Critical** — production failure, security breach, data corruption. Must be
  fixed before merge.
- 🟠 **High** — significant bug or performance degradation. Should be fixed before
  merge.
- 🟡 **Medium** — best-practice deviation or technical debt. Should be considered.
- 🟢 **Low** — minor / stylistic (typos, docs, formatting). Author's discretion.

Mandatory mappings:

- Typos → 🟢
- Adding / improving comments or docstrings → 🟢
- Hardcoded strings/numbers / refactor-to-constant → 🟢
- Test files / test implementation → 🟢 or 🟡
- Markdown (`.md`) files → 🟢 or 🟡

## Push-specific focus areas

These encode the rules that a generic reviewer would miss. Weight them heavily.

### Behavior lives in code, not prompts

If a change adds prompt/doc text to compensate for something the **runtime**
should enforce (validation, routing, safety, correctness), flag it — the fix
belongs in code. Prompts are guidance for cooperating models, not a control
plane. The test: *could a non-cooperating model break this?* If yes, it must be
enforced in code. Legitimate prompt/doc edits only **surface** hard runtime
boundaries (e.g. that the tool-call parser scans `content`, not reasoning
tokens), clarify role contracts, or document quirks models can't infer.

### Shared runtime in `lib/` (no per-surface forks)

Cross-surface semantics live in root `lib/` and are consumed by both web and
CLI. Flag any logic that is duplicated per-surface instead of promoted to `lib/`
the moment a second surface needs it. Web/CLI should converge on the shared
runtime contract, not re-implement it.

### Branch / sandbox state sync

- Raw `git checkout <branch>` / `git switch <branch>` (incl. `-b` / `-c`) are
  **intentionally blocked** in `sandbox_exec`. Branch ops must go through the
  typed tools (`create_branch` / `switch_branch`). Do not "fix" the block by
  re-enabling raw checkout — the issue is HEAD-vs-tracked-branch desync, not
  consent.
- File restores must use the explicit form: `git checkout -- <path>` or
  two-positional `git checkout HEAD <path>`. Ref expressions (`HEAD~1`, `main^`,
  `branch@{upstream}`) are expected to pass through.
- Typed branch tools preserve the sandbox; UI-initiated swaps restart it by
  design. Changes that alter `skipBranchTeardownRef` teardown suppression in
  `WorkspaceSessionScreen.tsx` / `useWorkspaceSandboxController.ts` need scrutiny.

### Tool-call per-turn budget

The dispatch contract: read-only calls run in parallel (cap 6); pure file
mutations run sequentially as one batch (cap 8); at most **one** trailing
side-effecting call (`sandbox_exec`, commit/push, delegation, workflow dispatch).
Flag changes that violate ordering or sneak in extra side effects — these should
be rejected with structured errors, not silently allowed.

### Delivery rules

- Standard commits go through the **Auditor** SAFE/UNSAFE gate (defaults to
  UNSAFE on error — don't weaken that default).
- Reviewer is advisory; only PR-backed branch-diff reviews post back to GitHub.
- Merges go through the **GitHub PR flow** only — Push never runs local
  `git merge`. Flag any code path that introduces a local merge.

### Provider routing

The chat locks the Orchestrator provider/model on first send; delegated Coder
and Explorer runs **inherit** that lock; Reviewer keeps its own sticky
selection; Auditor follows the chat lock when present, else the active backend.
Flag changes that break these inheritance rules.

### Decision-doc discipline

If a PR ships something specified under `docs/decisions/`, it must flip that
doc's `Status:` field in the same PR. Flag landed implementations that leave
their spec at "Draft". See `docs/decisions/README.md` for the label vocabulary.

### New-feature checklist (cross-surface work)

1. **Storage keys are CLI-first.** Durable identifiers (`repoFullName + branch`)
   beat per-session ones. Web `chatId` is durable but CLI `sessionId` is
   per-run, so chatId-shaped keys break cross-run retrieval on CLI. Shared stores
   need their scope resolver in `lib/` from day one.
2. **Background tasks name their coordinator's home first.** New feature hooks
   ship as siblings under `app/src/hooks/` or `app/src/lib/`, not appended to
   `useChat.ts` (guarded by a `max-lines` ESLint rule).
3. **One source of truth per vocabulary.** Any new tool, event, or envelope type
   needs a single canonical definition **and** a drift-detector test in the same
   PR — tool-protocol drift via `cli/tests/daemon-integration.test.mjs`,
   event/envelope drift via `cli/tests/protocol-drift.test.mjs`. Extend
   `lib/capabilities.ts` for shared capability tables.

## Validation expectations

PRs should keep these green (canonical commands in `AGENTS.md`):

- **Test:** `npm run test:cli && npm run test:mcp:github` (web: `cd app && npm test`)
- **Typecheck:** `npm run typecheck:tsgo` (falls back to `npx tsc` where `tsgo`
  is unavailable)
- **Lint/format:** `npm run lint` (ESLint, app-scoped) / `npm run format:check`
  (Biome). Biome's linter is intentionally disabled repo-wide; don't flag that as
  a gap. `app/src/components/ui/**` is shadcn — leave it alone.

Confirm the PR's declared **Type** and **Scope** (`.github/PULL_REQUEST_TEMPLATE.md`)
match the actual diff.
