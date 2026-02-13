# Push Harness Reliability Plan (Hashline Included)

## Status
- Last updated: 2026-02-13
- State: Active planning
- Intent: Improve coding task success by upgrading the harness, not just swapping models

## Why this doc changed

This started as a hashline-only spike. That was too narrow.  
The bigger opportunity is harness reliability across the full coding loop:

1. task interpretation
2. file reads/edits
3. tool execution + retries
4. validation + commit flow
5. mobile/session resilience
6. operator visibility

Hashline remains a candidate within this larger plan.

## Harness Principles

1. Prioritize reliability over raw capability.
2. Prefer small, reversible bets over broad rewrites.
3. Add measurement before rollout.
4. Keep fallback paths available.
5. Kill experiments quickly if metrics do not improve.

## Current Baseline (Already in place)

- File-level stale write protection for `sandbox_write_file` via `expected_version`.
- Baseline write-path metrics (`success`, `stale`, `error`, latency).
- Tool-result provenance metadata for execution traceability.
- Console now surfaces Coder status events, not only Orchestrator/tool logs.
- Chat now preserves assistant dialogue even when a tool call is emitted in the same message.
- Snapshot and restore primitives exist for sandbox continuity.

## Main Harness Opportunities

### Track A: Edit Reliability (Hashline Experiment)

Problem:
- Full-file replacement still forces brittle content reproduction.

Hypothesis:
- Line-tagged references (`line:hash`) reduce edit failures and retries.

Gate first (required):
- Run provider compliance micro-test before implementation.
- Go only if at least 2 providers can produce valid hashline edit calls consistently.

If gate passes, MVP scope only:
- Add `sandbox_edit_file(path, edits, expected_version?)`
- Ops: `replace_line`, `insert_after`, `delete_line`
- Reject stale/invalid refs and overlapping edits
- Return touched-window refs + unified diff + rich error details
- Keep `sandbox_write_file` fallback
- Ship behind `hashlineEditEnabled` flag

Success targets:
- >= +10pp edit-apply success rate vs baseline
- >= 20% reduction in retry loops
- no truncation regression from annotation overhead

Kill criteria:
- gate fails
- one week of dogfooding shows no meaningful gain
- annotation overhead causes frequent regressions

### Track B: Read/Context Efficiency for Editing

Problem:
- Edit flows over-read large files; tokens and truncation pressure increase.

Scope:
- Add line-range reads (`start_line`, `end_line`) for sandbox file reads.
- Keep annotation opt-in and targeted to edit flows.
- Ensure UI continues to show clean, non-annotated text.

Success signal:
- reduced average read payload size in edit-heavy tasks
- fewer truncation-adjacent failures

### Track C: Tool-Loop Robustness

Problem:
- Minor tool-call formatting failures still cost rounds/time.

Scope:
- Continue hardening malformed/unimplemented tool-call feedback loops.
- Standardize structured retry hints in tool errors.
- Track malformed-call rate by provider/model.

Success signal:
- fewer recoverable tool-loop stalls
- lower average rounds per successful task

### Track D: Long-Run Resilience (Mobile Background Reality)

Problem:
- Browser-driven loops pause when phone app backgrounds/locks.

Scope (design now, implementation separate):
- server-run background job model
- reconnectable job timelines
- cancel/resume controls

This is a harness-level capability and should be planned independently of hashline.

### Track E: Operator Visibility

Problem:
- Debugging harness issues is slow without clear execution traces.

Scope:
- Keep improving console signal quality (role/source labeling, useful status granularity).
- Keep tool calls and dialogue understandable in chat.
- Preserve actionable logs for “why task failed” analysis.

Success signal:
- faster root-cause diagnosis for failed tasks
- lower “mystery failure” incidents during dogfooding

## Prioritization (Now / Next / Later)

Now:
1. Run Track A micro-test gate.
2. Add minimal instrumentation needed for Track A/B comparison.

Next:
1. If gate passes: implement Track A MVP behind flag.
2. Implement Track B line-range reads (small, broadly useful).

Later:
1. Track D server-side background jobs.
2. Additional Track A ops (`replace_range`, `delete_range`, `insert_before`) only if MVP earns it.

## Measurement Framework

Primary metrics:
- edit apply success rate
- retries per task
- coder rounds per successful task
- p99 edit latency

Secondary metrics:
- read payload size for edit tasks
- truncation incidents
- malformed tool-call rate

Evaluation cadence:
- baseline capture before each experiment
- 1-week dogfood window per enabled experiment
- go/hold/kill review at end of each window

## Decision Log Template (for each experiment)

- Experiment:
- Date enabled:
- Cohort/flag:
- Baseline:
- Result:
- Decision: `go` / `hold` / `kill`
- Notes:

## External Review Checklist (PWA-GPT)

Source: external PWA-focused review (2026-02-13).  
Decision labels: `accept`, `partial`, `reject`.

| Recommendation | Decision | Why | Next Step |
|---|---|---|---|
| Narrow primary persona to power users (solo founder, lead dev, CTO in motion) | accept | Tightens product narrative and onboarding clarity | Update README/onboarding copy to explicitly target power users |
| Emphasize true differentiators (role-separation, branch-scoped chats, provider-agnostic backends) | accept | Already core strengths; should be foregrounded consistently | Keep these three as top-level positioning in root docs and pitch copy |
| Treat PWA as first-class feature (offline, push, background sync) | partial | Good direction, but API support is inconsistent on mobile (especially iOS) | Prioritize reliable pieces first: offline scratchpad/read-only history + completion notifications |
| Move long-running orchestration to server-side jobs | accept | Client-driven loops pause when app backgrounds/locks | Execute `Background Coding Jobs Design` roadmap item (`start/status/events/cancel`) |
| Add explicit service worker cache strategy | partial | Useful, but must avoid stale execution state and broken live sessions | Add a documented cache policy pass for app shell/static/api paths before broad SW changes |
| Harden pre-merge safeguards and surface checks clearly | partial | Most merge safeguards exist; visibility can improve | Add clearer merge-flow UI states for stale base, CI required, and branch protection blocks |
| Add provider tool-call compliance validation + scoring | accept | Directly aligns with harness reliability goals | Add malformed-call and recovery metrics by provider/model in settings/debug view |
| Make chat less central over time | reject | Push remains chat-first by product principle | Keep chat as interface, but continue shifting execution UX toward card-first actions |
| Make Workspace Hub feel like mission control | accept | Fits mobile execution-control positioning | Prioritize Hub v2 diff ergonomics + status visibility |
| Build-in-public growth metrics and signature feature ideation | hold | Valuable for growth, but secondary to reliability work | Revisit after harness tracks A-D show measurable stability gains |
| Keep surface area small; hide complexity under the hood | accept | Matches biggest current risk (feature sprawl) | Enforce explicit non-goals and kill criteria for each harness experiment |

## Immediate Next Action

Run the hashline provider micro-test and make a go/no-go call in one review.  
Do not start full hashline implementation before that gate is passed.
