# Oh My OpenAgent (OMO) Review

**Date:** 2026-04-12
**Source:** [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)
**Status:** Comparative research reference. Informs the quick-wins list at the bottom.

---

## 1. What OMO is

OMO is an opinionated harness layered on top of OpenCode. It is not a model
and it is not a from-scratch agent runtime — it is a bundle of orchestration,
routing, and tool policy decisions whose stated purpose is "stop agonizing
over harness choices, I'll steal the best and ship it here." Fully
backward-compatible with Claude Code hooks, commands, skills, MCPs, and
plugins.

## 2. Features OMO adds on top of stock OpenCode

| Feature | Summary |
|---|---|
| **Named persona agents** | Sisyphus (orchestrator), Hephaestus (deep exec), Prometheus (planner), Oracle (debug), Librarian (docs), Explore (search) |
| **Category-based model routing** | Agents declare task categories (`visual-engineering`, `deep`, `quick`, `ultrabrain`); harness picks a model. Models are fungible. |
| **Hashline edits** | Every read line tagged with a content hash (e.g. `11#VK\|`); edits anchor on the hash, not reproduced content. Claimed 6.7% → 68.3% edit success on one benchmark. |
| **IntentGate** | Classify true user intent before dispatching to an action. |
| **Ralph Loop** | Self-referential completion loop; stops only at 100%. |
| **Todo Enforcer** | Yanks idle agents back to unfinished items. |
| **`ultrawork` / `ulw`** | Single command spins up every agent and runs until done. |
| **`/init-deep`** | Walks a repo and writes hierarchical `AGENTS.md` files for auto context injection. |
| **Skill-embedded MCPs** | MCPs spin up on demand and tear down after use to keep context windows lean. Bundled: Exa (search), Context7 (docs), Grep.app (code search). |
| **LSP + ast-grep tools** | Workspace rename, diagnostics, AST rewrites at IDE precision. |
| **Prometheus planner** | `/start-work` runs an interview-mode planning pass before execution. |
| **Tmux integration** | Full interactive terminal for REPLs, debuggers, TUIs. |
| **Comment Checker** | Blocks AI-comment noise (`// added validation`, restated-next-line comments, etc). |
| **Model fallbacks** | Per-fallback object settings mixed with plain model strings. |

## 3. Problems OMO targets

1. **Model juggling fatigue** — category routing removes manual model picking.
2. **Edit tool unreliability** — hashline anchors prevent stale-line corruption.
3. **Context window bloat** — MCPs activate on demand, not permanently.
4. **Agent abandonment on long runs** — Todo Enforcer + Ralph Loop force completion.
5. **Walled gardens** — multi-provider (Claude, Kimi, GLM, GPT) as a lock-in hedge.

## 4. Overlap with Push today

Push already overlaps meaningfully. Before we start copying, the honest list:

- **Role-based agents** with locked roles and replaceable models (`docs/architecture.md:15`).
- **Delegation and orchestration** including dependency-aware task graphs via `plan_tasks` (`docs/architecture.md:37`).
- **Adaptive hashline edits, patchset transactions, resumable sessions** already listed under harness reliability (`docs/architecture.md:42`). See also `docs/decisions/Hashline System Review.md`.
- **Project-instruction loading** for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` (`docs/architecture.md:44`).
- **Shared runtime contract** for task-graph, memory, delegation briefs, role-context, and run events in root `lib/` (`docs/architecture.md:39`).
- **MCP integration** exists in `mcp/` but without a formal per-skill teardown story.
- **Auditor** pre-commit gate with SAFE/UNSAFE verdict (`docs/architecture.md:23`).
- **Reviewer** on-demand diff review (`docs/architecture.md:22`).

So: persona naming, hashline, shared runtime, role separation, project
instructions, and delegation graphs are covered. The genuine deltas are in
routing, bootstrapping, loop discipline, and MCP lifecycle.

## 5. Candidate items to borrow

Ranked by effort vs payoff.

### Tier 1 — small, self-contained, ship this session

1. **Comment Checker in the Auditor.** A content-policy pass over the pending
   diff flags high-confidence AI-comment artifacts (operation narration like
   `// added X`, meta markers like `// NEW:`, and trivial docblocks). It
   deliberately skips the ambiguous "comment restates the next line" class
   to keep precision high. Slots into the existing SAFE/UNSAFE gate — no
   new role, no new provider plumbing.

2. **`init-deep` bootstrap command.** Walk the current repo, derive a short
   summary for each top-level (and significant sub-) directory from
   deterministic hints (`README.md`, `package.json` name/description, child
   listings), and write an `AGENTS.md` file at each level. Uses existing
   file tools only — no Explorer delegation, no model calls, no provider
   dependency. Largest UX win for mobile users dropped into a fresh repo.

3. **Published hashline metric.** Pick a fixture set, run edits with hashline
   on/off, record the success-rate delta. Validates (or disproves) a claim we
   already ship. Plan drafted in
   [`../runbooks/Hashline Effectiveness Metric.md`](../runbooks/Hashline%20Effectiveness%20Metric.md).

### Tier 2 — one session with a short design note

4. **Task-category tags on delegation briefs.** Add
   `category: 'quick' | 'deep' | 'visual' | 'ultrabrain'` to the delegation
   brief. Settings maps category → model per backend. Chat-lock
   (`docs/architecture.md:27-31`) remains the override. Touches provider
   routing but the diff is contained.

5. **Todo Enforcer around `plan_tasks`.** After each task-graph step, check
   for unfinished todos and re-prompt the Coder instead of returning control.
   Graph-scoped task memory already tracks this — it is a policy change
   inside the orchestrator, not new infrastructure.

### Tier 3 — don't start this session

- **IntentGate.** Needs a cheap classifier and evals. Easy to half-build.
- **Skill-embedded MCP lifecycle.** Interacts with sandbox proxy; worth its
  own session.
- **Ralph Loop / `ultrawork`.** Cost and battery policy question for mobile,
  not a coding task.

## 6. Items to explicitly skip

- **Named personas as user-facing UX.** Push's locked roles map to mobile
  affordances better than mythological names. Surface which specialist is
  running, but keep the names neutral.
- **Tmux integration.** No terminal on phone.
- **`ultrawork` "run everything forever" default.** Wrong incentive on a
  mobile/battery-bound surface.
- **Full Claude Code plugin surface.** Scope creep for a mobile-first agent.

## 7. Action list

This doc supersedes any scattered notes about OMO. The concrete follow-ups
are the three Tier-1 items above. They are being tackled on branch
`claude/explore-openagent-features-q3vuR`:

- [x] Comment Checker in the Auditor — shipped on this branch. Canonical
      logic in `lib/comment-check.ts`, wired into the Auditor at
      `app/src/lib/auditor-agent.ts`, 13 vitest cases in
      `app/src/lib/comment-check.test.ts`.
- [x] `init-deep` command — shipped on this branch. Canonical planner in
      `lib/init-deep.ts`, CLI adapter in `cli/init-deep.ts`, subcommand
      wired into `cli/cli.ts`. 18 vitest cases + 4 node:test cases covering
      the shared planner and the filesystem adapter. Usage:
      `push init-deep [--dry-run] [--force]`.
- [x] Hashline metric runbook — drafted as
      [`../runbooks/Hashline Effectiveness Metric.md`](../runbooks/Hashline%20Effectiveness%20Metric.md).
      Not yet executed; the plan is fixtures + control path + committed
      `results.json`, no runtime flag.

Tier 2 items are not committed work — promote to a runbook or ROADMAP entry
- [x] Hashline metric runbook — executed. Initial results (100% vs 66.7%) recorded in `docs/decisions/Hashline System Review.md`. Fixtures and harness live in `tests/hashline-effectiveness/`.
