# Goal-Anchored Task Graph Layering

**Status:** Current, web shipped 2026-05-14 (PR #550), CLI parity shipped 2026-05-14 (this PR)
**Scope:** Orchestrator plan_tasks emission + delegation brief + CLI planner output
**Related:** [`docs/architecture.md`](../architecture.md), PR #549 (user-goal anchor v1+v2), PR #550 (web runtime gate)

## Problem

The 2026-05-14 user-goal anchor (PR #549) injects a `[USER_GOAL]` block near the recent tail on every compaction. The Orchestrator sees the goal, but nothing in the runtime forces it to **act** on it — task graphs the Orchestrator emits can address any work the model decides is interesting, with no programmatic tie back to what the user actually asked for.

That makes the layering decorative:

```
User intent  ─────►  goal.md  ─────►  [USER_GOAL] anchor in prompt
                                                        │
                                                        ▼
                                              Orchestrator sees it
                                                        │
                                                        ▼
                                              ... and may ignore it
```

Concretely: a long-running chat that drifted into a tangent could trigger a delegation that explores an entirely unrelated area, and the resulting `plan_tasks` would pass structural validation without ever mentioning the original goal. Same problem one layer down — delegated Coder and Explorer agents previously saw only their slice (`task`, `knownContext`, `constraints`), with no upstream goal context at all.

## Decision

Make goal alignment **load-bearing** at each layer of the planning stack via runtime-enforced rationale fields.

### 1. `TaskGraphNode.addresses` (schema)

New optional field on `TaskGraphNode` (`lib/runtime-contract.ts`):

```ts
addresses?: string;
```

Free-form short rationale naming which part of the goal the task advances. Expected to reference a specific section of `goal.md` — `Initial ask`, `Current working goal`, or a named Constraint.

Optional in the type so legacy and CLI emitters keep validating; promoted to a hard requirement at validation time when a goal is loaded.

### 2. `validateTaskGraphAgainstGoal` (shared validator)

In `lib/task-graph.ts`. Gated on the caller passing a `UserGoalAnchor` — when no goal exists (no `goal.md`, no first user turn), the check is skipped and the field stays optional. When a goal exists, every node must have a non-empty `addresses`; offenders produce per-node `TaskGraphGoalValidationError`s.

### 3. Structured rejection back to the model

`formatGoalRejection` renders the per-node errors into a `[Goal Alignment Required]` tool-result body, mirroring the existing `formatRoleCapabilityDenial` pattern (`lib/capabilities.ts`). The body includes the formatted `[USER_GOAL]` block so the model has the goal in immediate context for its re-emission.

The web handler (`app/src/lib/task-graph-delegation-handler.ts`) returns this string as the tool result on rejection. The model sees it on its next turn and re-emits `plan_tasks` with `addresses` populated. **No extra runtime LLM call** — the retry happens in-band via the normal tool-result feedback loop.

### 4. Delegation brief carries the goal + rationale

`DelegationBriefFields` (in `app/src/types/index.ts`) gains:

- `userGoal?: UserGoalAnchor` — rendered as a `[USER_GOAL]` block at the top of the brief
- `addresses?: string` — rendered as `Addresses: <text>` alongside

`buildDelegationBrief` in `lib/delegation-brief.ts` emits both when present. The task-graph delegation handler populates them from the parsed node + the per-conversation anchor when calling `runCoderAgent` / `runExplorerAgent`. **Delegated agents now see the same goal the Orchestrator was bound by**, with the per-node `addresses` rationale telling them why this slice was chosen.

### 5. Orchestrator prompt update

`lib/orchestrator-prompt-builder.ts` documents the new field in the `plan_tasks` example and explicitly names the rejection path so cooperating models populate `addresses` without learning the validator the hard way.

## Scope: web runtime gate (PR #550) + CLI parity (this PR)

Web's runtime gate (PR #550) lives at the `plan_tasks` tool-call parse path. The Orchestrator emits, the runtime rejects with a structured `[Goal Alignment Required]` body, the model re-emits with `addresses` populated on the next turn. In-band retry via the tool-result feedback loop, no extra LLM call from the runtime.

CLI parity uses the same shared validator (`validateTaskGraphAgainstGoal`) and the same shared brief (`buildDelegationBrief` rendering `userGoal` + `addresses`), but the planner is structurally one-shot — there is no tool-result loop to bounce a rejection back through. So the CLI rejection path is **graceful degradation**, not retry:

1. `runPlannerCore` learns `goal?: UserGoalAnchor`. When provided, the planner sees the formatted `[USER_GOAL]` block at the top of its user message and is asked (via the planner system prompt) to populate `addresses` on every feature.
2. `PlannerFeature.addresses?` is propagated through `planToTaskGraph` onto `TaskGraphNode.addresses`.
3. After `validateTaskGraph` (structural), `validateTaskGraphAgainstGoal` runs. On miss the CLI emits a `delegation.goal_invalid` session event + a `[delegation]` warning, then falls back to the existing non-delegated single-agent loop. Matches the existing `delegation.graph_invalid` pattern for structural validation failures — both flow into the same `runNonDelegatedFallback` helper in `cli/delegation-entry.ts`.
4. Each per-node delegation brief carries `userGoal` + `node.addresses`, same as the web task-graph executor.
5. The single-agent fallback inherits the same goal through convergent derivation rather than explicit threading. `runAssistantLoop` (via `cli/engine.ts`) reads `<cwd>/.push/goal.md` and, when absent, derives an anchor from `state.messages` using the same first-non-tool-result-user-message rule the delegation entry uses. So a `.push/goal.md` that triggered rejection still appears in the fallback's compaction-time `[USER_GOAL]` injection, and a derived anchor reproduces from the same seed.

### Why graceful degradation not retry on CLI

CLI's planner is fail-open by contract (`runPlannerCore` returns `null` on parse/stream failure → caller falls back). Adding a retry loop would mean either:

- **Re-running the planner with a feedback prompt.** Possible, but doubles the latency budget on every miss, and there's no evidence cooperating models that produced unaligned output once will produce aligned output the second time without architectural changes (e.g. fine-tuning, a stronger system prompt).
- **Surfacing the failure back to a calling orchestrator.** CLI doesn't have one — the planner *is* the top of the stack for headless delegation runs.

Graceful degradation preserves the user's task (they still get an answer from the single-agent loop) and surfaces the misalignment as a structured event observable in `aggregateStats` and the session log.

### What this means for cooperating vs non-cooperating models on CLI

- **Cooperating models** with goal context in the prompt populate `addresses` and the gate is silent — same outcome as web's cooperating path.
- **Non-cooperating models** that omit the field on CLI trigger the warning + single-agent fallback. Web bounces; CLI degrades. Different surfaces, different idioms; same gate semantics.

## Scope: not building agent-write to `goal.md`

The PR #549 review-feedback path noted that auto-seed bypasses the cap; that's fixed. A separate followup (v3) will add an `update_user_goal` tool the agent can call with provenance + stale-write protection — once we see real evidence the agent **needs** to update the goal mid-session, not as speculative ceremony.

## Scratchpad vs `goal.md` — when to use which

Adjacent question that surfaces every time someone adds long-lived state: **scratchpad** and **goal.md** look superficially similar. They are not.

| | Scratchpad | `goal.md` |
|---|---|---|
| Purpose | Free-form notes, decisions, context for future-me | Structured statement of user intent |
| Shape | Markdown prose, no required format | Fixed sections: `Initial ask`, `Current working goal`, `Constraints`, `Do not`, `Last refreshed` |
| Persistence | localStorage (web), session state (CLI), repo-scoped | File at `<cwd>/.push/goal.md` (gitignored), workspace-local |
| Who writes | Agent (via `scratchpad_*` tools) + user manual edit | User manual edit; agent reads only (auto-seed on first compaction excepted) |
| Lifetime | Per repo, per session-flavor | Persists across rounds, branches, sessions |
| Wire surface | `[SCRATCHPAD]` block | `[USER_GOAL]` anchor near recent tail post-compaction |

**Heuristic**: if the content is *structured intent* — what the user is trying to accomplish, what they're explicitly constraining, what they don't want — it belongs in `goal.md`. If it's *prose notes* — decisions, sketches, things-to-remember — it belongs in scratchpad. If you find yourself adding `## Initial ask`-shaped sections to scratchpad, the right move is to lift them to `goal.md` instead.

## Why prompt + runtime rather than prompt alone

Push's standing rule from CLAUDE.md: *"Behavior lives in code, not prompts."*

The prompt addition alone (telling cooperating models to fill in `addresses`) is the lightest enforcement layer. Cooperating models will do it. Small or non-cooperating models will silently ignore the instruction, leaving the layering decorative for exactly the audience the goal-anchor was built to help.

Pairing prompt guidance with the validator + structured rejection gives both:

- **Cooperating models** see the field documented and never hit the rejection path.
- **Non-cooperating or noisy models** that omit the field get a structured retry signal they can act on the next turn.

Both surfaces of the same rule, applied in the right register.

## Open questions / followups

- **`addresses` content validation** — currently any non-empty string passes. A future tightening could require the string to reference one of the actual goal sections (literal string match against known headings). Held until we see whether free-form usage produces real misalignment cases.
- **Web v2.5 of `goal.md`** — the sandbox-persistence story for the file itself (deferred from PR #549). Goal anchor injection on web today uses inline derivation from the first user turn, not a file. Once persistence lands, the same `addresses` runtime check carries over for free.
- **CLI planner retry** — graceful degradation today; a one-time retry loop could land later if measurement shows cooperating models routinely producing unaligned output on first pass. Held until that evidence appears, because the simple/fail-open contract of `runPlannerCore` is itself load-bearing for CLI surface predictability.
