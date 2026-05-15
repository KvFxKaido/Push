# Claude Code In-App Patterns — Lessons For Push

Date: 2026-05-15
Author: Claude (via Claude Code)
Status: Partly shipped — #1 (PR #561), #2 (PRs #562 + #563), and #7 (this PR, 2026-05-15) landed; remaining patterns Draft.

---

## What this is

A second pass on the cross-reference from `Agent Tool Patterns — Claude Code Cross-Reference.md` (2026-02 / refreshed 2026-03-30), focused on patterns documented in `code.claude.com/docs` that weren't fully covered in the earlier note. The original doc is still the canonical comparison; this one is the addendum.

Sources: `code.claude.com/docs/en/{how-claude-code-works,permissions,hooks,sub-agents,mcp,skills,context-window,agent-view}`. Everything here is publicly documented — no reverse-engineering, no inference about Anthropic's internal pipelines.

For each pattern: (a) what Anthropic publicly does, (b) Push's current state, (c) the load-bearing next step if we want to borrow it. Where Push is already at parity or ahead, the note says so rather than inventing busywork.

---

## 1. Subagent context isolation

### Claude Code

Subagents (`Explore`, `Plan`, `general-purpose`) run with **separate context windows**. The parent agent sees only the subagent's final returned message — typically a short summary. The subagent's full tool-call history (file reads, greps, intermediate analysis) never enters the parent's context.

### Push today

Closer to parity than the surface read of the synthesis suggested:

- `runExplorerAgent` and `runCoderAgent` maintain their own `messages[]` arrays. Sandbox reads, edits, and tool-result blocks stay in the subagent's loop.
- `formatCompactDelegationToolResult` (`app/src/lib/delegation-result.ts`) truncates the returned summary to **260 chars** and extracts labelled sections (`Done:` / `Verified:` / `Open:` for Coder) before it lands in the Orchestrator's message list.
- The `DelegationResultCard` carries structured counts (files, checks passed/total, rounds, checkpoints) — those render in the UI but the Orchestrator sees them via the compact text form.
- Coder working memory persists across delegations but reinjection is **conditional** (first sync / state changed / context pressure >60% / cadence every 6 rounds), per `lib/coder-agent.ts` and `app/src/lib/coder-context-trim.ts`.

So the Orchestrator already gets less than Claude Code parents do. The remaining gap is more about **the return contract being free-text** than about quantity of bytes.

### Load-bearing next step

Three possible scopes, finest → coarsest:

1. **Instrument the leak.** Add a per-delegation metric: bytes added to Orchestrator messages after a `delegate_coder` / `delegate_explorer` resolves. This is the empirical basis for any further tightening.
2. **Formalize the return envelope.** Today `outcome.summary` is free-text and the Coder system prompt asks for `**Changed:** / **Done:** / **Verified:** / **Open:**` sections by convention. Promote that to a typed `DelegationReturn` shape the role agent emits as its terminal message, with strict field caps. Removes the "did the model write a valid summary?" coupling.
3. **Evidence pointers, not evidence inlining.** When `coderResult.summary` is too tight to capture nuance, callers like `recordVerificationArtifact` currently inline 220 chars of free text. Replace with a pointer — `evidence-id: coder-xyz` — that the Orchestrator can choose to fetch via a dedicated tool if it needs more. Mirrors Claude Code's pattern where subagent results aren't browsable from the parent.

---

## 2. Hooks as policy-as-code

### Claude Code

Lifecycle events (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `FileChanged`, `CwdChanged`, `Stop`) fire shell scripts / HTTP endpoints. Hooks can **deny / allow / modify** tool calls before execution. Deny precedence is enforced by the harness, not the model.

### Push today

**Shipped 2026-05-15** (this PR). Push had a partial `ToolHookRegistry` + `ApprovalGateRegistry` in `app/src/lib/`, plus two inline checks (git guard in `sandbox-tools.ts`, Protect Main in `web-tool-execution-runtime.ts`) that bypassed the registry. This PR lifted the registry types and factories to `lib/`, ported both inline checks to `PreToolUse` hooks (`lib/default-pre-hooks.ts`), and wired CLI's `executeToolCall` to evaluate the same registry — so web and CLI now share one rule set.

Concrete inventory:
- `lib/tool-hooks.ts` — `PreToolUseHook`, `PostToolUseHook`, `ToolHookRegistry`, `evaluatePreHooks`, `evaluatePostHooks`. `PreToolUseResult` gained an optional `errorType` so hooks emit structured-error codes (`GIT_GUARD_BLOCKED`, `PROTECT_MAIN_BLOCKED`) the runtime promotes to a `StructuredToolError`.
- `lib/approval-gates.ts` — `ApprovalGateRegistry` with injected `modeProvider`. Web wires `getApprovalMode()` (safeStorage); CLI wires its own provider when it adopts modes.
- `lib/git-mutation-detection.ts` — `detectBlockedGitCommand` lifted from `app/src/lib/sandbox-tool-utils.ts` (pure heuristic, no app deps).
- `lib/default-pre-hooks.ts` — `createGitGuardPreHook({ modeProvider })`, `createProtectMainPreHook()`. The Protect Main matcher covers both web (`sandbox_prepare_commit` / `sandbox_push`) and CLI (`git_commit`) vocabularies.
- `app/src/lib/web-default-hooks.ts` — `getDefaultWebHookRegistry()` lazily registers both factories with web's approval-mode provider. `WebToolExecutionRuntime.execute()` evaluates default + caller-supplied registries in series.
- `cli/tool-hooks-default.ts` — `getDefaultCliHookRegistry()` registers Protect Main only (the git guard's *why* — keeping Push's tracked branch in sync with sandbox HEAD — doesn't apply to CLI, which operates on a real working tree). `readCliCurrentBranch(workspaceRoot)` uses `git branch --show-current` for the branch reader.
- `cli/tools.ts:executeToolCall` — new `hooks` / `getCurrentBranch` / `isMainProtected` / `defaultBranch` options, evaluated after the role-capability check.

Drift-detector coverage: `lib/default-pre-hooks.test.ts` pins the rule semantics across both surfaces (git guard branches: branch-create/branch-switch/commit-push, approval-mode handling, `allowDirectGit` consent gate; Protect Main: default-branch match, fail-safe behavior, CLI matcher coverage).

### What's not in scope here

- The Auditor SAFE/UNSAFE gate stays a delegation hop. The hook surface could host it, but Auditor outputs a verdict + summary, not a binary allow/deny — different return shape, different next move.
- Protocol-violation handling in `tool-dispatch.ts` (parallel-cap, single-trailing-mutation) stays in the dispatcher. Those are parse-time grouping rules, not pre-execution gates.
- `coder-job-executor-adapter.ts` (worker-side coder job) still has its own duplicated git-guard logic — Cloudflare Worker context can't read `safeStorage`. Separate consolidation step.

---

## 3. Deny-first permissions with explicit specifiers

### Claude Code

Three-tier: read-only (no prompt), Bash/file (ask), file modification (ask). Precedence is **deny > ask > allow**. Specifiers are pattern-aware: `Bash(npm run *)`, `Edit(src/**/*.ts)`, `WebFetch(domain:github.com)`, `mcp__github__*`.

### Push today

Permission model is mostly implicit and role-shaped: roles have implied tool access via `ROLE_CAPABILITIES` (`lib/capabilities.ts`). Protect Main and approval modes are runtime checks, not declarative rules.

### Load-bearing next step

Conditional on (2). Once a hook surface exists, the natural follow-up is a declarative permission layer that compiles to `PreToolUse` hooks. Until then, this is mostly a re-labelling exercise and not worth the churn. The thing that *is* worth doing now: review the "no local `git merge`" rule (currently documented in CLAUDE.md and enforced by convention) and make sure it surfaces a structured rejection at the dispatch layer, not just a model nudge.

---

## 4. Skills as lazy-loaded knowledge

### Claude Code

Skill **descriptions** load at session start (cheap, ~one line per skill). Skill **bodies** load only when invoked. Frontmatter controls invocation (`disable-model-invocation`, `user-invocable`, `allowed-tools`). `!`git diff HEAD`` runs commands before Claude sees them, inlining real data.

### Push today

CLI already auto-loads workspace skills from `.push/skills/*.md` and `.claude/commands/**/*.md` (per CLAUDE.md). Project instructions are loaded eagerly with a cap (5k chars web, 8k chars CLI). System prompts are sectioned (`SystemPromptBuilder`) and conditionally injected by feature (sandbox / GitHub / scratchpad / web-search / ask_user).

### Load-bearing next step

The biggest concrete asymmetry: project instructions are loaded **into every turn** at up to 5k–8k chars, whereas Claude Code's CLAUDE.md is treated more like a sticky preamble that doesn't get rebuilt every round. Worth measuring the per-turn cost; if it's significant on long sessions, move stable reference content (codebase tour, deployment checklist) behind on-demand fetches and keep only the session-critical guidance always-on. This is essentially the "progressive disclosure" point from the original cross-reference doc, but framed in concrete byte terms.

---

## 5. MCP tool deferral (ToolSearch pattern)

### Claude Code

MCP tools are listed by **name only** in the session opener; their full schemas load only when the model actually wants to call one (via `ToolSearch` with `select:<name>`). Server-level deny rules apply (`mcp__github__*`).

### Push today

GitHub MCP tools (`mcp/github-server/`) ship their full schemas into the model context whenever GitHub is active. The 18 GitHub tools in the registry all carry their parameter descriptions.

### Load-bearing next step

This is the one with the most direct context-budget payoff and the cleanest fit. Steps:

1. Split the GitHub tool protocol section into a names-only manifest (already implied by `getToolPublicName`) and a per-tool schema block.
2. Inject the manifest always; inject schemas on a hit basis when the parser sees the model trying to use a tool whose schema isn't loaded — return a structured "schema needed" error message that the model can react to in the next turn.
3. Cache per-session so a tool used once stays loaded.

Same shape works for any future MCP servers (the Cloudflare MCP server visible in this very session is an example: 25+ tools, almost none used per turn).

---

## 6. Sessions as durable, browsable artifacts (Agent View)

### Claude Code

Sessions are plaintext JSONL under `~/.claude/projects/`. **Agent View** unifies all sessions across projects in one CLI screen, grouped by state (Working / Needs Input / Completed). `--resume` appends; `--fork-session` copies. Background sessions run under a supervisor with separate state storage and survive terminal closure.

### Push today

Branch-scoped chats per repo session, sandbox-preservation via typed branch tools, persisted sessions (`session-store.ts` CLI side, IndexedDB web). Background coder jobs exist but live alongside the chat that spawned them. No unified cross-chat / cross-surface "what's in flight" view.

### Load-bearing next step

A cross-surface in-flight dashboard is a meaningful product surface — not a small change. The narrow first step: an **Agent View–style listing inside the existing workspace screen** (web) that surfaces background coder jobs from other chats in the same workspace, grouped by state. Doesn't require new persistence; the data is already in run events. If CLI adoption of background daemons grows, the same listing extends to those.

---

## 7. Context auto-compaction with deferred priorities

### Claude Code

Auto-compaction clears older tool outputs first, then summarizes if needed. Deferred tool schemas mean only names cost tokens until used. Subagent isolation prevents side-task bloat.

### Push today

**Shipped 2026-05-15** (this PR). Earlier drafts of this doc claimed "no Orchestrator-level compaction primitive" — that read was wrong. Both surfaces already have one: web uses `createContextManager` from `lib/message-context-manager.ts` with `compactChatMessage` + digest insertion; CLI's `cli/context-manager.ts` has its own three-phase trim (summarize → drop pairs → hard fallback). The real gap was three near-duplicate `extractSemanticSummaryLines` / `buildContextSummaryBlock` implementations and no shared tier interface.

This round closed two pieces:

- **Shared semantic-summary primitive.** `lib/context-summary.ts` is now the canonical home for `extractSemanticSummaryLines`, `buildContextSummaryBlock`, `compactMessage`, and `extractToolName`. The richer list-meta detection (with omission markers like `[N more commits omitted from original X-item list; visible items are a sample]`) that previously only lived in `app/src/lib/context-compaction.ts` is now available to all callers. `lib/coder-context-trim.ts` is a back-compat shim; `app/src/lib/context-compaction.ts` re-exports the lib primitive and keeps the typed `compactChatMessage` wrapper. The CLI's own simpler summarizers stay as-is — they're tuned for the CLI's predictability requirements and migrating them was real behavioral churn for limited gain.
- **Compaction tiers primitive.** `lib/compaction-tiers.ts` defines the typed tier interface (`CompactionTier`, `applyTiers`, `CompactionContext`) plus three default tier factories: `createDropToolOutputsTier` (cheap — drops old `isToolResult` messages outside the keep-latest window), `createSemanticCompactTier` (medium — runs `compactMessage` on each touchable message), `createDropOldestPairsTier` (hard fallback — drops oldest assistant+tool-result pairs). `applyTiers` runs them in order with a "do the least amount of compaction necessary" semantics and returns a trace (which tiers attempted, which applied, total chars saved, whether the final result fits).

Test coverage: 13 cases in `lib/compaction-tiers.test.ts` pin cheap-first ordering, fall-through behavior, system-prompt / tail preservation, and trace shape. 22 cases total across context-summary + compaction-tiers.

### What's not in scope here

- The existing concrete managers (`createContextManager`, `cli/context-manager.ts`) keep their current implementations. The tier primitive is offered as the canonical shape for new compaction sites and as a migration target if/when the concrete managers grow more divergent — forcing the existing surfaces through the new tier interface would be a non-trivial behavior change with test churn that didn't pay for itself in this round.
- Deferred tool schemas (the "only names cost tokens until used" half of the Claude Code pattern) is pattern #5 in this doc, not #7.

---

## 8. Drift-detector tests for cross-surface vocabulary

### Claude Code

Internal test files (publicly visible in the CLI repo) pin tool-protocol and event-envelope schemas in strict mode. The contract between layers is enforced by tests, not docs.

### Push today

Already practiced: `cli/tests/daemon-integration.test.mjs` (prompt-vs-capability sync), `cli/tests/protocol-drift.test.mjs` (strict-mode schema pins). `lib/protocol-schema.ts` owns the canonical schema after the Local PC / Remote work.

### Load-bearing next step

Nothing new — keep doing it. The note here exists so the pattern stays visible when adding cross-surface vocabulary. Any new tool, event, or envelope type added in the same PR as the drift-detector test that pins it. The `Web and CLI Runtime Contract.md` doc is the canonical reference.

---

## Summary table

| Pattern | Push state | Next step |
|---|---|---|
| 1. Subagent context isolation | At/ahead of parity (compact 260-char summaries) | Instrument leak, formalize return envelope, or evidence pointers — pick one |
| 2. Hooks as policy-as-code | **Shipped 2026-05-15** — `lib/tool-hooks.ts` + `lib/default-pre-hooks.ts` with git guard + Protect Main as `PreToolUse` hooks across web and CLI | Auditor gate / protocol-violation handling deliberately out of scope |
| 3. Deny-first permissions | Implicit via role capabilities | Defer until (2) lands |
| 4. Skills lazy-loaded | CLI does skill discovery; project instructions still eager | Measure per-turn cost of project-instructions; move stable reference behind on-demand fetches |
| 5. MCP tool deferral | Full schemas always inject | Names-only manifest + on-hit schema fetch — biggest context payoff |
| 6. Agent View | Branch-scoped chats, no cross-chat in-flight view | Workspace-screen listing of background jobs grouped by state |
| 7. Auto-compaction | **Shipped 2026-05-15** — `lib/context-summary.ts` (canonical summary primitive) + `lib/compaction-tiers.ts` (typed tier interface + 3 default tiers). Existing managers kept; CLI summarizers kept. | Concrete-manager migration to tier primitive (if needed) |
| 8. Drift-detector tests | Already practiced | Keep doing it; surface the pattern when adding new cross-surface types |

## Ordering recommendation

If picking work from this list, the high-leverage ordering is **5 → 2 → 7 → 1 → 4 → 6 → 3**:

- **5 (MCP tool deferral)** has the cleanest implementation path and immediate context-budget payoff.
- **2 (hooks)** unlocks 3 and gives a deterministic home for several runtime checks currently scattered across `sandbox-tools.ts` and the Auditor role.
- **7 (compaction)** is a small refactor of existing code.
- **1 (subagent return contract)** is the most subtle — start with instrumentation, decide on envelope shape from data.
- **3, 6, 4** are larger surfaces; only worth picking up after the foundation moves above.

## Pointers

- [`Agent Tool Patterns — Claude Code Cross-Reference.md`](./Agent%20Tool%20Patterns%20%E2%80%94%20Claude%20Code%20Cross-Reference.md) — earlier comparison; still canonical for the patterns it covers
- [`Architecture Remediation Plan — Defusing the Big Four.md`](./Architecture%20Remediation%20Plan%20%E2%80%94%20Defusing%20the%20Big%20Four.md) — owner-named modules convention referenced in (1) and (2)
- [`Web and CLI Runtime Contract.md`](./Web%20and%20CLI%20Runtime%20Contract.md) — drift-detector ownership for (8)
- `code.claude.com/docs/en/{how-claude-code-works,permissions,hooks,sub-agents,mcp,skills,context-window,agent-view}` — source material
