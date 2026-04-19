# Phase 5 Handoff — Task-Graph Extraction

**Date:** 2026-04-19
**Status:** Not started. Design decision required before extraction.
**Target:** `app/src/hooks/useAgentDelegation.ts` task-graph branch (lines 437–1173) → `app/src/lib/task-graph-delegation-handler.ts` (or split into multiple modules; see §Open Design Question).
**Gated on:** Resolution of `lastCoderStateRef` accumulation strategy (open question #1 from `useAgentDelegation Coupling Recon.md`).

## What's Done (Phases 2–4)

Three PRs merged across two sessions. Current hook state: **1,213 lines**, down from **1,883** at Phase 1 start (−670, −36%).

| Phase | PR | Module | Lines | Merged |
|---|---|---|---|---|
| 1 | (in-session commit) | `lib/memory-context-helpers.ts` | 97 | pre-session baseline |
| 2 | #336 | `lib/explorer-delegation-handler.ts` | 309 | 2026-04-18 |
| 3 | #337 | `lib/coder-delegation-handler.ts` | 691 | 2026-04-18 |
| 4 | #338 | `lib/auditor-delegation-handler.ts` | 300 | 2026-04-19 |

**Key artifacts for Phase 5 to consume:**
- `CoderAuditorInput` type in `coder-delegation-handler.ts` — Phase 3 established this as the typed contract for Coder → Auditor handoff. Phase 5 may want a parallel `TaskGraphAuditorInput` in the new module.
- `AuditorHandlerContext` + `handleCoderAuditor` in `auditor-delegation-handler.ts` — the TG Auditor seam has similar shape but reads *aggregated* state from multiple TG Coder nodes, not a single Coder arc. The existing handler is Coder-specific; Phase 5 either (a) generalizes it, (b) creates a sibling `handleTaskGraphAuditor`, or (c) extracts a shared primitive.

## TG Seam Anatomy (post-Phase-4 line numbers)

The `plan_tasks` branch in `useAgentDelegation.ts`:

| Sub-seam | Line | What it does |
|---|---|---|
| Branch entry | 437 | `else if (toolCall.call.tool === 'plan_tasks')` |
| TG Explorer span | 528 | `withActiveSpan('taskgraph.explorer', …)` wraps `runExplorerAgent` at line 541 |
| TG Coder span | 635 | `withActiveSpan('taskgraph.coder', …)` wraps `runCoderAgent` at line 648, writes `lastCoderStateRef.current` in its onStateUpdate callback |
| TG Execute span | 798 | `withActiveSpan('taskgraph.execute', …)` wraps `executeTaskGraph(…)` at line 810 with `taskExecutor` closure containing the Explorer/Coder sub-seams |
| TG Auditor span | 1003 | `withActiveSpan('subagent.auditor', …)` wraps `runAuditorEvaluation` at line 1016. Reads `lastCoderStateRef.current` for `evalWorkingMemory` |
| Branch exit (~) | 1173 | Near end of the `plan_tasks` case arm |

Total TG seam: ~736 lines (lines 437–1173). For comparison: the Sequential Coder seam Phase 3 extracted was ~658 lines.

## Open Design Question (must resolve first)

**`lastCoderStateRef` accumulation in parallel TG node execution.**

The current behavior:
1. `taskExecutor` closure (line ~500) is invoked by `executeTaskGraph` once per node in topological order.
2. Each TG Coder node (line 635) calls `runCoderAgent` with an `onStateUpdate` callback that does `lastCoderStateRef.current = state`.
3. If the graph has N Coder nodes, the ref is overwritten N times — only the **last** completing node's state survives.
4. TG Auditor (line 1003) reads `lastCoderStateRef.current` for `evalWorkingMemory`, but if `coderNodeStates.length > 1`, the code explicitly passes `null` instead (to avoid misleading the evaluator with only the last node's memory).

**The hazard** (recon doc §3, "Task-Graph Auditor Coupling to Node States"):
- Single-node graphs work correctly.
- Multi-node graphs are lossy-but-correct — they forfeit all per-node working memory rather than use a misleading last-node value.
- Any future optimization that wants to feed all node states to the auditor cannot do so with the current single-ref pattern.

**Two design options:**

### Option A — Keep the ref, extract unchanged
- Preserves current behavior byte-for-byte.
- Phase 5 handler inherits the "pass null for multi-node" quirk.
- Smallest extraction risk, but freezes the limitation into the module boundary.
- Phase 6+ optimizations that want per-node memory have to re-plumb.

### Option B — Replace the ref with `Map<nodeId, CoderState>` accumulation
- Handler owns a local Map populated as each TG Coder node completes.
- TG Auditor receives the full Map (or a projection) instead of a single state.
- Breaks the current "null for multi-node" contract — auditor can now see all node memories.
- **Behavior change** — not a pure refactor. Would need characterization tests for the auditor's behavior change (currently uncovered per recon §Test Coverage Matrix).

**Recommendation:** **Option A for Phase 5**, with a follow-up issue tracking Option B as a future optimization. Rationale:
- Phase 5 is already the largest extraction (736 lines, 4 coupled sub-seams). Bundling a behavior change multiplies risk.
- Option A preserves the three-piece discipline (characterization first, extraction second, optional cleanup third). Option B forces a fourth piece (new auditor contract) that's design-heavy.
- Option B's value is speculative — no current feature needs multi-node auditor memory. Option A defers the cost to when it's justified.
- The recon doc's hazard-level rating for the current pattern is "Medium" (not "High") — lossy but correct, not incorrect.

Either way: **decide this first, before any code gets written.** Don't discover mid-extraction that the wrong choice was made.

## Patterns That Apply from Phases 2–4

- **`*HandlerContext` pattern:** refs + bound callbacks enumerated in a context interface, build-function stays hook-local, handler module is one-way (never imports from the hook).
- **Typed input contracts:** Phase 3's `CoderAuditorInput` named the handoff payload with intent (`auditorInput`, not `state`). Phase 5 should do the same if TG Auditor is a separate handler — name the payload `taskGraphAuditorInput` or similar.
- **Gating in the hook:** policy decisions (when to run what) stay in the hook. Handlers are reactive.
- **Commit A / Commit B discipline:** characterization tests first, extraction second. Per PR workflow memory, single review round.
- **Read-once ref semantics:** Phase 4's `readLatestCoderState()` called inside the ternary (not eagerly at top) is the right pattern for any downstream ref access.

## Patterns That Do NOT Apply

- **Boring leaf handler (Phase 4):** Phase 5 is not a leaf. TG Execute coordinates TG Explorer + TG Coder sub-seams, TG Auditor reads aggregated state from TG Coder. The return-shape complexity must match the coupling — expect either a discriminated union (Phase 3 shape) or multiple handler modules.
- **Single-task working memory (Phases 3–4):** Phase 5 has N-ary state. The `lastCoderStateRef` ownership model needs a new answer (see Open Design Question).
- **Sequential execution (Phases 2–4):** TG nodes execute in parallel where topology permits. `activeTasks` is a Map shared between TG Explorer + TG Coder nodes running concurrently. Phase 5 must respect this — moving the Map into a handler without thinking about concurrency is a race-condition hazard.

## What's Different From Phases 2–4

| Concern | Phases 2–4 | Phase 5 |
|---|---|---|
| Number of sub-seams | 1–2 (Explorer alone, or Coder + Planner) | 4 (TG Execute, TG Explorer, TG Coder, TG Auditor) |
| Execution mode | Sequential | Parallel (topology-dependent) |
| Shared state | `lastCoderStateRef` written by one Coder arc | `lastCoderStateRef` written by N Coder nodes; `activeTasks` Map co-mutated by explorer + coder nodes |
| Event emission | `subagent.*` events | `task_graph.task_*` events + nested `subagent.*` events per node |
| Test coverage | Explorer well-covered, Coder well-covered, Auditor covered after Phase 4 commit A | **TG Execute/Explorer/Coder/Auditor all uncovered** per recon §Test Coverage Matrix — 3–4 tests needed as pre-requisite |
| Auditor gate | `harnessSettings.evaluateAfterCoder && summaries.length > 0` | `coderNodeStates.length > 0 && !graphResult.aborted` (different policy) |

## Recommended First Move

1. **Design spike (no code):** answer the Option A vs. B question. 15–30 min of thinking + a short write-up in a session note or as an update to the recon doc's Open Questions section.
2. **Commit A — TG characterization tests.** Per recon §Test Coverage Matrix §2: (a) `task_graph.graph_completed` event fires on success, (b) memory persistence calls, (c) TG Auditor gate fires when graph has coder nodes. Add a 4th test for the `lastCoderStateRef` / multi-node policy to protect Option A's contract.
3. **Commit B — Extraction.** Structure depends on Option A/B decision.

## First Reads for the Next Session

1. **This handoff doc** — orients on current state + design question.
2. `docs/decisions/useAgentDelegation Coupling Recon.md` §Phase 5 (lines ~491–515), §Coupling Hazards #3 (TG Auditor state coupling), §Open Questions #1 (the accumulation strategy).
3. `app/src/hooks/useAgentDelegation.ts` — the TG branch, lines 437–1173.
4. `app/src/lib/coder-delegation-handler.ts` + `auditor-delegation-handler.ts` — see the pattern Phase 5 will mirror or diverge from.
5. `app/src/lib/task-graph.ts` — the role-kernel the TG Execute seam calls through. The handler must respect its contract; understand `executeTaskGraph`'s guarantees before wrapping.

## Gotchas Inherited From Previous Sessions

- **commitlint body-max-line-length=100.** Hard-wrap HEREDOC commit bodies at 80–90 chars.
- **Biome silently skips files with non-ASCII chars in path** (em-dash bug). Keep new code file paths ASCII-only.
- **WSL `cd` doesn't persist between Bash tool calls.** Use absolute paths or `git -C <path>` defensively.
- **commitlint allowed scopes** include `context` — all four Phase 2/3/4 commits used `refactor(context):` / `test(context):`.
- **ESLint `eslint-disable-next-line` must be adjacent to the violating line** — if the cast `as any` is split across multi-line `toolCall` objects, extract to a local variable so the disable comment can sit right before the cast.
- **One review round only.** After addressing reviewer feedback (or rejecting a false positive with documentation), stop. Don't offer to re-poll for fresh reviews unless explicitly asked.
- **Copilot is the merge gate.** Other bots (Codex, Kilo, Gemini, github-actions) are bonus signal. Gemini/github-actions has a history of false-positive "unused import" claims against files that use the symbol outside the diff window — verify with grep before accepting.

---

**Generated:** 2026-04-19 at Phase 4 close. Not a living doc — consume once at Phase 5 start, then decide if any of the design assumptions above need updating based on current code state (grep and recheck before acting on any claim).
