# Durable Runs — Adopt-on-Silence

**Status:** Draft — promoted to `ROADMAP.md` (first priority) 2026-06-10; design committed, implementation pending. Phase 0 is the gate: the latency spike and eval harness must land before Phase 2 is built.

**Date:** 2026-06-10

## Problem

The web orchestrator round loop is browser-resident: the model stream, tool
dispatch, and turn sequencing all run in the page (`app/src/hooks/chat-*`).
Mobile browsers evict background tabs aggressively, so the product's core
promise — dispatch real coding work from a phone — carries an asterisk: *as
long as the screen stays on*. The sandbox half of a run became durable in the
Background Exec track (#861–#867: detached processes survive disconnects,
cursor logs are resumable by construction), which makes the asymmetry sharp:
a ten-minute test run now outlives the phone, but the agent turn awaiting it
dies with the tab.

Adjacent tracks treat symptoms rather than the home: Session Continuity moves
session *state* between surfaces; Pre-Order PRs (Draft) builds a detached
special case; Resumable Sessions recovers from interruption after the fact.
None of them changes where the loop lives.

## Decision

**Local while watched, adopted when away.** The loop is NOT moved wholesale —
today's in-page responsiveness is preserved exactly when a client is attached.
Instead the run learns to survive abandonment:

1. The browser loop checkpoints each turn (extending the Resumable Sessions
   primitives) into a server-side **RunHost** Durable Object.
2. The client heartbeats while attached. When heartbeats lapse past a
   threshold mid-run, the RunHost **adopts** the run from its last checkpoint
   and continues the loop server-side, running the same `lib/` agent kernels.
3. Reopening any client **attaches** as a viewer/controller: bearer-
   authenticated, hydrated from snapshot + cursor over the existing run-event
   vocabulary. An attached client may pull the run back local.

The dual-home pattern is established, not invented: the coder kernel already
executes both in-page (delegated) and inside the CoderJob DO (background),
from one host-agnostic kernel. The orchestrator is the last browser-only
kernel; this track ends that.

**Latency stance.** The agent loop's critical path is dominated by inference
and tool time, and today the phone's radio sits inside it (every tool result
hops sandbox → edge → phone → edge → provider). Adoption removes the phone
from the middle; server-side rounds are plausibly faster, not slower. This is
asserted, not proven — Phase 0 measures it before anything is built on it.

**Relationship to Single-Agent Loop (prior first priority).** Step 1 of that
track — collapse Coder delegation behind a flag, lead edits inline — folds in
as the precondition of Phase 2 here: the loop should be simplified *as* it is
made host-agnostic, not durable-ized with the Planner/brief scaffolding intact
and then re-cut. Its measurement gate ("≥ the delegated path") is supplied by
the Phase 0 eval harness. Steps 2–4 (auto-branch-on-commit, Auditor unbundle
remainder, storage substrate) are untouched and remain sequenced behind it.

## Phases

### Phase 0 — Instruments (gate for everything else)

- **Latency spike:** relay one provider's stream through a DO and measure
  time-to-first-token + per-turn overhead against the direct path, from a
  phone on cellular. If WS-from-DO numbers are ugly, the hybrid leans harder
  local and Phase 2's continuation UX is re-scoped. Throwaway code; numbers
  recorded in this doc.
- **Agent eval harness:** ~10–20 repeatable agent tasks against the live
  stack with scored outcomes (task completion, turn count, wall-clock,
  tool-error rate). Required by this track's Phase 2 comparison AND the
  delegation-collapse A/B, which is currently gated on measurement that does
  not exist. Lives as its own small runner; not CI-gating initially.

### Phase 1 — Checkpoint fidelity

Per-turn run checkpoints sufficient to resume mid-run without context loss:
messages, tool state, locked provider/model, verification state, working
memory, user-goal anchor. Define the `RunCheckpoint` schema in `lib/` with a
strict-mode drift pin (same discipline as `protocol-schema.ts`). Resumable
Sessions checkpoints are the starting point; the gap analysis (what they drop
that adoption needs) is the first task.

### Phase 2 — RunHost DO + adoption

- Delegation collapse lands first (behind a flag, measured via Phase 0 evals).
- `RunHost` DO owns: heartbeat ledger, adoption decision (silence threshold,
  only adopts a run that is mid-flight), the server-side loop over the same
  kernels, checkpoint persistence, orphan/alarm hygiene per the CoderJob and
  PrReviewJob patterns (one alarm, bounded sweeps, persistent backstop —
  lessons from #866 apply verbatim).
- Mode semantics while adopted: full-auto continues uninterrupted (AFK is
  its meaning); supervised runs PAUSE at approval gates and surface a
  notification hook (push notification integration is an open extension, not
  required for v1 — a paused run that survives is already the win).
- Chat-hook tools (scratchpad/todo) execute in-page today; while adopted they
  execute against the server-side store or are deferred with a model-readable
  note. Decide during Phase 2 design; do not silently drop them.

### Phase 3 — Attach/viewer

Reopen → bearer-authenticated attach → snapshot hydration (reuse
`get_session_snapshot` work) + cursor-follow over run events. Controls:
stop, approve/deny pending gates, pull-back-local. The TUI/pushd surface is
unaffected (pushd is already CLI's durable home); a later phase may let the
web client attach to either home through one vocabulary — that is the point
where this track and Session Continuity merge.

## Non-goals (v1)

- Moving the loop server-side unconditionally — attached-and-watching stays
  in-page, byte-for-byte today's behavior.
- Multi-client concurrent control (viewer-only for secondary clients is fine).
- CLI/pushd changes. Pre-Order PRs (separate Draft) — becomes a thin special
  case of RunHost later, not built here.
- Push notifications (hook point defined, integration deferred).

## Risks

- **Two-home drift** during transition — mitigated by the kernel/host split
  already proven on coder, plus eval-harness parity runs between homes.
- **Checkpoint size/cost** per turn — measure in Phase 1; tier if needed.
- **Adoption false-positives** (flaky heartbeat on bad cellular) — threshold
  generous, adoption idempotent, pull-back-local always available.
- **DO colo latency** — Phase 0's job; numbers before architecture.

## Protected throughout

Durable job engine, event-shape compat (`subagent.*`/`task_graph.*` drift
pins), capability gating, Protect Main, git checkout/switch blocks, bearer
auth on every attach (no tokenless class — Universal Session Bearer applies).

## Acceptance (track-level)

Start a multi-tool run on the phone, lock the phone mid-run, wait past the
adoption threshold, reopen: the run continued server-side from its checkpoint,
the transcript is complete across the gap, an approval-gated action in
supervised mode paused rather than proceeded, and a run watched end-to-end
with the tab open behaves exactly as today (no added latency in the attached
path beyond Phase 0's measured budget).
