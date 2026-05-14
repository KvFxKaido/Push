# Goal-Anchored Task Graph Layering

**Status:** Current, added 2026-05-14
**Scope:** Orchestrator plan_tasks emission + delegation brief
**Related:** [`docs/architecture.md`](../architecture.md), PR #549 (user-goal anchor v1+v2)

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

## Scope: web-only runtime enforcement for v1

This decision applies to **web orchestrator-emitted task graphs**. CLI delegation uses a different shape — `runPlannerCore` produces a `PlannerFeatureList` that `planToTaskGraph` converts to nodes — and doesn't go through the same `plan_tasks` tool-call parsing path. Adding `addresses` extraction to the CLI planner is a separate piece of work that:

1. Requires the planner prompt to teach `addresses`
2. Requires `runPlannerCore` to surface goal-alignment failures back to the model
3. Touches `PlannerFeatureList` schema

That's its own PR. CLI delegation continues to honour the goal via the v1 `[USER_GOAL]` anchor injected at engine entry, but won't reject emissions for missing `addresses` until the planner is updated.

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

- **CLI parity** for the runtime check, gated on `runPlannerCore` learning `addresses`. Without this, CLI orchestrators that mis-plan have no rejection path.
- **`addresses` content validation** — currently any non-empty string passes. A future tightening could require the string to reference one of the actual goal sections (literal string match against known headings). Held until we see whether free-form usage produces real misalignment cases.
- **Web v2.5 of `goal.md`** — the sandbox-persistence story for the file itself (deferred from PR #549). Goal anchor injection on web today uses inline derivation from the first user turn, not a file. Once persistence lands, the same `addresses` runtime check carries over for free.
