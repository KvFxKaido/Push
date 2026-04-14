# Canonical SOP Playbooks Spike

Status: Draft spike, added 2026-04-14
Origin: [Task Graph Orchestration Plan](Task%20Graph%20Orchestration%20Plan.md), [Harness Reliability Plan](Harness%20Reliability%20Plan.md), r/ollama CPU SLM agent post (2026-04)

## Why This Exists

Push already has the substrate for structured, non-improvised agent work:

- `plan_tasks` lets the Orchestrator express a dependency-aware task graph instead of freeform ReAct.
- Delegation briefs carry `knownContext`, `constraints`, `deliverables`, and `acceptance` per task.
- The Auditor is a hard SAFE/UNSAFE gate on standard commits.
- Hashline edits and patchset transactions keep Coder mutations surgical.

What we don't have is **named playbooks** — canonical task graphs for recurring flows that every user runs through. Today, "fix this failing test", "apply this PR review comment", and "resolve this merge conflict" each get re-decomposed by the Orchestrator on the fly. That means:

- The Orchestrator burns tokens re-planning the same shape of work on every repeat.
- Quality is inconsistent across sessions because planning is non-deterministic.
- Good patterns discovered in one session are not durable — they live in the transcript, not in the system.
- Telemetry can't roll up by playbook because playbooks don't exist as first-class objects.

The external SLM writeup's SOP concept maps cleanly onto Push: a **Playbook = a named, parameterized, canonical task graph**, where the Orchestrator's job shifts from *plan this work from scratch* to *pick the playbook and fill in the parameters.* The Orchestrator still gets to improvise for novel work; it just doesn't have to re-derive the common cases every time.

## Goal

Introduce first-class **Playbooks** built on top of the existing task-graph runtime, ship three canonical ones covering the highest-frequency recurring flows, and measure whether they improve latency, token cost, and outcome quality vs. freeform Orchestrator planning.

## Non-Goals

- No new runtime substrate. Playbooks compile to task graphs that the existing `plan_tasks` executor already runs.
- No YAML configuration surface. Playbooks are code in `lib/` so they can be reviewed, typed, and unit-tested.
- No user-authored playbooks in v1. The surface is curated and small until we know the shape is right.
- No replacement for freeform orchestration. Playbooks are a fast path, not the only path.
- No auto-selection without visibility. If the Orchestrator picks a playbook, the user sees which one and can override.

## Design

### Shape of a Playbook

A Playbook is a typed module exporting:

- a unique `id` and human-readable `name`
- a `match` function that decides whether an incoming user goal fits the playbook (gets the user ask, active branch/repo state, and recent context as input; returns a confidence score)
- a `parameters` schema describing what inputs must be resolved before the graph can run
- a `resolve` step that maps the user ask + context to those parameters (usually one scoped Explorer call or a single LLM extraction prompt — think "this step does one thing")
- a `compile` function that produces a concrete task graph ready for the existing `plan_tasks` executor
- a `successCriteria` block defining what "the playbook finished cleanly" means

Sketch:

```ts
export type Playbook<Params> = {
  id: string;
  name: string;
  match: (input: PlaybookInput) => { confidence: number; reason: string };
  parameters: ParamSchema<Params>;
  resolve: (input: PlaybookInput) => Promise<Params>;
  compile: (params: Params) => TaskGraph;
  successCriteria: (result: TaskGraphResult) => "success" | "partial" | "failed";
};
```

Parameter resolution is deliberately one narrow LLM step at most. The executor steps after that are the existing Explorer/Coder/Auditor agents running the compiled task graph. The playbook does **not** get to invent new runtime behavior; it gets to choose and parameterize existing behavior.

#### `resolve` Failure Semantics

`resolve` returns `Promise<Params>` and can fail. A failure here means the LLM extraction step could not produce the parameters the playbook declared as required — for example, the user asked to apply a PR review comment but the recent context does not contain enough detail to identify which comment. The behavior is:

- **Silent fallback, not a user-facing error.** A `resolve` failure must fall through to freeform Orchestrator planning as if the playbook had never matched. The user should see the freeform plan run, not an error dialog.
- **Single trace event.** The runtime emits a `playbook.resolve_failed` trace event (added to the run-event vocabulary alongside the other `playbook.*` events) carrying the playbook id and a short machine-readable reason (`missing_param`, `ambiguous_param`, `extraction_error`). This is how measurement sees the failure — not through user-visible surfaces.
- **No partial parameters.** If `resolve` cannot produce the full `Params` object that `compile` expects, it fails. The playbook is not allowed to ship a half-populated graph and hope the agents figure it out.
- **No retry inside the playbook.** One extraction attempt per turn. Retry is the Orchestrator's problem once we have fallen through.
- **Deterministic on success.** Given the same input, `resolve` is allowed to be probabilistic (it calls an LLM), but `compile` must be deterministic: same `Params` in, same `TaskGraph` out. This is what makes playbook behavior reviewable and measurable.

A playbook whose `resolve_failed` rate is high in measurement should either be tightened (narrower `match`) or removed. A failing `resolve` is telling us the match function was too optimistic about the playbook's fit.

### Canonical Starter Playbooks

Three flows worth starting with, chosen because they are high-frequency, bounded, and currently under-served by freeform planning:

1. **`fix_failing_test`**
   - Match: user ask names a failing test, or a recent tool call just reported a test failure.
   - Parameters: failing test file, failing test name, failure excerpt.
   - Graph: Explorer (trace the failing test + the code under test) → Coder (produce a fix under the constraint "do not modify the test unless the test is itself wrong") → Auditor gate on commit.
   - Success: test passes locally, Auditor is SAFE.

2. **`apply_pr_review_comment`**
   - Match: user ask references a specific PR review comment, or the PR-comment fetch tool result is in recent context.
   - Parameters: PR number, comment id, target file/range, interpreted intent.
   - Graph: Explorer (load the file and surrounding code to verify the comment's target) → Coder (apply the change with a scoped deliverable) → Auditor gate.
   - Success: change applied, Auditor is SAFE, commit message references the comment.

3. **`resolve_merge_conflict`**
   - Match: sandbox state shows active merge conflicts, or the user ask mentions a conflict.
   - Parameters: conflicted files list, base branch, incoming branch.
   - Graph: Explorer (read both sides of each conflicted range) → Coder (resolve ranges with explicit rationale per hunk) → Auditor gate.
   - Success: no conflict markers remain, tests still pass if a test command is configured, Auditor is SAFE.

Each playbook is a few hundred lines of typed code at most. The actual work is done by the existing agents.

### Selection Flow

1. User message arrives at the Orchestrator.
2. The playbook registry runs every `match` function in parallel (cheap, they're local predicates).
3. If exactly one playbook scores above a confidence threshold, the Orchestrator proposes it to the user with a single-line visible label ("Using playbook: `fix_failing_test`"). The user can override with a dismiss action or a `??` force-escalate prefix.
4. If multiple playbooks match, or none clear the threshold, we fall through to freeform Orchestrator planning.
5. A chosen playbook resolves parameters, compiles its graph, and hands it to `plan_tasks` as if the Orchestrator had produced it itself.

No playbook auto-executes without the user being able to see that it was chosen.

### Integration Points

- New `lib/playbooks/` module with registry + the three starter playbooks. Shared between web and CLI.
- `app/src/lib/orchestrator.ts` consults the registry before the freeform planning path.
- Task-graph execution is unchanged — playbooks produce the same graph shape `plan_tasks` already runs.
- Trace events: `playbook.match_considered`, `playbook.selected`, `playbook.skipped`, `playbook.resolve_failed`, `playbook.completed`. Added to the run-event vocabulary and validated by the CLI protocol schema harness.

### Relationship to `plan_tasks`

Playbooks are a **compiler for `plan_tasks` input**, not a replacement. Given the same parameters, a playbook always emits the same graph. Freeform planning still exists and still owns anything a playbook can't match. If a playbook is ever found to be worse than freeform planning on its own flow, we remove it.

## Safety and UX Rules

- **Visible selection.** The UI shows which playbook is running, and the user can cancel or override.
- **Auditor stays binding.** Playbook commits still go through the SAFE/UNSAFE gate. Playbooks cannot skip the Auditor.
- **No silent branch moves.** Playbooks never create or switch branches. That remains UI-owned.
- **No playbook may bypass harness safety.** Hashline edits, patchset transactions, and structured tool-error reporting all still apply.
- **Override escape hatch.** The `??` prefix (shared with the Tiered Routing spike) forces freeform planning and skips the registry.

## Acceptance Criteria

1. `lib/playbooks/` lands with registry + typed interface + at least one playbook fully wired end-to-end.
2. All three canonical playbooks ship with unit tests for `match`, `resolve`, and `compile`, plus one integration test exercising the full path through `plan_tasks`.
3. Trace events are emitted and validated by the CLI protocol schema harness (matching the hardening already landed for delegation events).
4. The web chat UI shows playbook selection as a distinct, labeled event in the transcript.
5. Follow-up measurement note compares playbook runs vs. freeform planning on: token cost per task, end-to-end latency, Auditor SAFE rate, and user-reported failure rate.

## Open Questions

- Does playbook selection happen before or after the Tiered Routing rule engine? Probably after: routing resolves trivial non-agent turns, playbooks resolve structured agent work. Worth confirming during spike.
- Do playbooks live on the current chat provider lock, or can they temporarily run a cheaper provider for parameter resolution? Leaning toward "stay on the lock" for v1 to avoid provider drift inside a single task.
- How should playbook results be recorded in typed context memory? They should probably write a distinct record kind so future retrieval can learn from past playbook runs.
- Should playbooks be CLI-first or web-first? The CLI transcript-first REPL is the cleaner place to validate the UX story (labeled selection, cancellation, override), but web has the higher volume for measurement. Likely: land the substrate in `lib/`, enable on web first, adopt on CLI as part of the selective shared-runtime tranche.
- Are there any flows where playbook-style determinism would actively hurt (e.g. exploratory refactors)? Yes — those should simply not match any playbook. The registry's job is to stay out of the way for work that doesn't fit.

## Success Metric (v1)

The spike is a success if, on the three starter flows, playbook runs demonstrate a measurable reduction in token cost per completed task **and** a non-negative change in Auditor SAFE rate compared to freeform planning on the same flows, over a dogfood window of at least a few dozen real runs per playbook.
