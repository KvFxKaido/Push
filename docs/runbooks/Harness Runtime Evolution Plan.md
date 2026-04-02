# Push Harness Runtime Evolution Plan

Date: 2026-03-30
Status: **Complete**
Owner: Push
Related:
- `docs/runbooks/Harness Reliability Plan.md` — historical rollout of the first reliability wave
- `docs/runbooks/Runtime Enforcement Follow-up Plan.md` — completed follow-on for the runtime enforcement layer
- `docs/decisions/Harness Friction — Agent Self-Report.md`
- `docs/decisions/AgentScope Architecture Review.md`
- `docs/decisions/Copilot SDK Research.md`
- `docs/decisions/Resumable Sessions Design.md`

## Why this plan exists

The first harness wave largely did its job:

- edit reliability is much better (`hashline`, truncation-aware safety, patchset validation)
- tool-loop recovery is much better (garbled-call diagnosis, structured errors, runtime contracts)
- session resilience is much better (checkpointing, resume, queued follow-ups, steering)
- web-side tracing now exists for major runtime boundaries

The next bottleneck is no longer "can the model call tools reliably?" It is **run-state complexity**.

The current web harness still spreads orchestration truth across multiple layers:

- `useChat.ts`
- `chat-send.ts`
- `useChatCheckpoint.ts`
- `useAgentDelegation.ts`
- `checkpoint-manager.ts`
- conversation `runState`
- live-only run events
- sandbox session persistence

That is workable, but expensive. It slows down new features, makes resume/telemetry behavior harder to reason about, and raises the cost of parity with other runtimes.

This plan is the follow-up: preserve the shipped behavior, but make the harness easier to reason about, test, observe, and evolve.

## Goals

1. Make the run loop more serializable and testable.
2. Reduce the number of places where "current run truth" lives.
3. Add session-level verification policy so reliability rules can persist across a chat.
4. Extend tracing from the web app into Worker/server boundaries.
5. Let the harness adapt its strictness and scaffolding by provider/model instead of treating every model the same.

## Implementation Status Snapshot (2026-03-30)

- [x] Phase 0 / Track A foundation is now complete on the web path:
  - serializable `RunEngineState` + `RunEngineEvent` model
  - pure reducer + replay helpers
  - focused reducer/parity test coverage
  - shadow event emission wired into the live send/delegation loop
  - dev-only parity diagnostics comparing engine state against current live refs
- [x] Track A is now authoritative:
  - Engine state drives all run-state reads (phase, round, accumulated, thinking, chatId, provider, model, baseMessageCount, tabLockId)
  - Checkpoint refs reduced to `apiMessages` only (too large for serializable state)
  - Parity diagnostics removed (no longer needed — engine is the single source)
  - `useAgentDelegation` no longer mutates phase refs directly
  - `flushCheckpoint` and `saveExpiryCheckpoint` read from engine state
  - 708 tests now pass with zero regressions on the completed rollout
- [x] Track B (run journal) — unified IndexedDB-backed run journal store with live writes and console fallback reads
- [x] Track C (session verification policy) — policy types, presets, conversation-backed defaults, and agent injection
- [x] Track D (end-to-end observability) — Worker-side tracing and trace context propagation
- [x] Track E (adaptive harness profiles) — conservative adaptive settings are active, with logging retained for diagnostics

## Non-goals

- Rewriting the entire web chat stack from scratch.
- Moving the full orchestration loop into Cloudflare Durable Objects in current PWA scope.
- Reopening native function-calling experiments on the production web path.
- Broad web/CLI convergence as a prerequisite for this work.
- Aesthetic cleanup of `useChat.ts` just to reduce line count.

## Current problems to solve

### 1. Run-state fragmentation

Today, a single in-flight run is represented in multiple overlapping places:

- checkpoint refs for synchronous flush-on-hide behavior
- persisted conversation `runState`
- live-only run events
- local sandbox-session storage
- delegation-local state (`lastCoderStateRef`, queued follow-ups, pending steers)

This makes recovery and observability correct enough, but harder than it should be to evolve.

### 2. Persistence model is split by purpose, not by run

Push already persists the right ingredients:

- conversations in IndexedDB
- checkpoints in IndexedDB
- sandbox reconnect state in storage
- some live telemetry only in memory

But there is no single local "run journal" that acts as the authoritative record for a run's lifecycle.

### 3. Verification is still mostly per-delegation

Coder acceptance criteria and Auditor evaluation are strong at the delegation boundary, but users cannot yet attach durable verification policy to a whole chat session such as:

- always run `npm test` before claiming done
- require typecheck before commit prep
- require diff evidence before completion claims

### 4. Tracing stops too early

The web runtime now emits useful spans, but Push still lacks:

- Worker/server extraction and propagation
- stronger correlation between request id, run id, chat id, and trace id
- visibility into permission/session lifecycle boundaries

### 5. Harness behavior is still mostly static across models

Push measures malformed-call and tool reliability by provider/model, but the harness does not yet use that information to adapt:

- planner use
- correction strictness
- tool result verbosity
- retry posture
- protocol shaping

## Workstreams

### Track A: Serializable Run Engine

### Objective

Extract orchestration phase transitions into a pure, serializable engine layer with a small command surface and deterministic tests.

### Why first

This is the highest-leverage change because it simplifies every other track:

- persistence becomes cleaner
- resume behavior becomes less ad hoc
- event logging becomes easier
- session policy hooks have a single place to attach
- CLI/native follow-through becomes more realistic later

### Scope

- Introduce a `RunEngineState` model for:
  - active chat/run identity
  - phase transitions
  - queue/steer state
  - checkpointable round metadata
  - completion / cancellation / failure outcomes
- Represent transitions as pure events/reducer steps where possible.
- Keep side effects in thin adapters:
  - React state updates
  - IndexedDB writes
  - provider streaming
  - sandbox calls
  - delegated-agent execution

### Likely touch points

- `app/src/hooks/useChat.ts`
- `app/src/hooks/chat-send.ts`
- `app/src/hooks/useChatCheckpoint.ts`
- `app/src/hooks/useAgentDelegation.ts`
- `app/src/lib/chat-runtime-state.ts`
- new runtime module(s) under `app/src/lib/` or `app/src/hooks/`

### Exit criteria

- Queue, steer, resume, cancel, and delegation phase changes are all driven through the same engine contract.
- Behavior is unchanged from the user perspective.
- A deterministic test suite can replay full run scenarios without mounting most UI hooks.

### Track B: Unified Local Run Journal

### Objective

Create one local persistence model for run lifecycle state: snapshots plus append-only events keyed by run/chat identity.

### Scope

- Add a dedicated IndexedDB-backed run journal store.
- Persist:
  - run lifecycle markers
  - persisted run events
  - compact checkpoint snapshots
  - optional reconciliation metadata
- Make resume, console reconstruction, and diagnostics read from the same journal shape.
- Reduce duplicated meaning between:
  - conversation `runState`
  - standalone checkpoint storage
  - live/persisted event merging logic

### Notes

This does **not** mean storing every token delta forever. The current live-vs-persisted split is good. The change is about making the persisted side coherent.

### Exit criteria

- One run journal can explain "what happened" for a given run without reading multiple ad hoc stores.
- Resume logic uses the journal shape directly.
- Console replay and persisted diagnostics use the same event record model.

### Track C: Session-Level Verification Policy

### Objective

Let a chat/session carry durable verification expectations instead of treating verification as a one-off delegation concern.

### Examples

- "Always run typecheck before done."
- "Require tests for backend changes."
- "Do not claim complete without diff or artifact evidence."
- "Always prepare commit through Auditor flow before suggesting push."

### Scope

- Add a small `verificationPolicy` shape on the chat/workspace session.
- Inject policy into runtime contract / orchestrator context.
- Feed the policy into:
  - completion-claim guardrails
  - Coder acceptance criteria defaults
  - Auditor evaluation context
  - commit-prep / review UX where relevant

### Recommended rollout

1. Start with a few explicit presets.
2. Add custom text only after the preset behavior is stable.

### Exit criteria

- Verification requirements survive across multiple turns in the same chat.
- The model sees the policy in a structured way, not as fragile prose only.
- Completion claims become more consistent without adding excessive round churn.

### Track D: End-to-End Observability

### Objective

Finish the tracing story so a run can be followed across web runtime, Worker, sandbox, and delegated boundaries.

### Scope

- Propagate trace context and request correlation through:
  - app runtime
  - Cloudflare Worker
  - sandbox proxy boundaries
  - delegated subagent boundaries
- Add spans/events for:
  - session start/resume/cancel
  - permission/approval waits
  - queue/steer application
  - reconciliation after resume
- Decide which older in-memory metrics become redundant once traces are trustworthy.

### Exit criteria

- A single failing run can be debugged from one trace/correlation chain.
- Worker routes participate in the trace instead of being a blind hop.
- Session/permission lifecycle is visible, not only model/tool spans.

### Track E: Adaptive Harness Profiles

### Objective

Make the harness shape itself to provider/model behavior and task risk.

### Inputs

- malformed-call metrics
- recovery frequency
- tool success rates
- provider/model capabilities
- task type / risk level
- session verification policy

### Possible adaptations

- planner required vs optional
- stricter or looser correction messaging
- tool protocol verbosity
- working-memory reinjection frequency
- retry and recovery posture
- multi-tool dispatch aggressiveness

### Rollout guidance

- Start with conservative thresholds and keep every adaptation visible in diagnostics.
- Promote only the safest profile switches first.

### Exit criteria

- At least one measured provider/model class gets better results from adaptive policy than from a global static policy.
- Adaptation is explainable in diagnostics and does not feel random.

## Recommended sequence

### Phase 0: Baseline and contracts

- Define the target run-engine state shape.
- Define the target run-journal schema.
- Inventory current invariants around:
  - queue vs steer
  - checkpoint save/clear timing
  - live vs persisted events
  - resume reconciliation

### Phase 1: Track A

- Extract the serializable run engine first.
- Preserve behavior.
- Add replay tests for tricky sequences.

### Phase 2: Track B

- Move persisted run truth behind the journal.
- Keep old persistence paths as compatibility shims during migration.

### Phase 3: Tracks C and D in parallel

- Session verification policy can attach cleanly once the run engine and journal contracts exist.
- End-to-end tracing becomes easier once run identity is more explicit.

### Phase 4: Track E

- Turn observability + run journal data into adaptive harness behavior.
- Keep rollout conservative and reversible.

## Success measures

- Fewer harness regressions in queue/steer/resume flows.
- Less duplicated state plumbing in `useChat` and related hooks.
- Faster root-cause diagnosis for failed or interrupted runs.
- Lower variance in completion quality across providers/models.
- Measurable reduction in "done claim but missing verification" failures.

## Risks

### Risk: a "cleanup refactor" that changes behavior accidentally

Mitigation:
- phase the work
- preserve adapters first
- add replay tests before moving behavior

### Risk: too much persistence churn at once

Mitigation:
- add the run journal alongside existing stores first
- migrate readers before removing old writes

### Risk: verification policy becomes annoying or too rigid

Mitigation:
- start with explicit presets
- make policy visible in the UI/runtime contract
- measure round churn before expanding scope

### Risk: adaptive profiles become spooky

Mitigation:
- use conservative thresholds
- expose chosen profile in diagnostics
- keep per-provider overrides debuggable

## Not in this plan

- Durable-Object-owned background execution in current PWA scope
- Full CLI parity work
- Tool-surface expansion for its own sake
- Major UI redesign

## Immediate next step

All five tracks are implemented. Next steps are operational:

1. **Dogfood** the authoritative engine and journal in real sessions.
2. **Tune** adaptive profile thresholds if live sessions show overcorrection.
3. **Evaluate** whether verification policy presets need tuning based on real usage.
4. **Monitor** Worker tracing spans for completeness gaps.
5. **Retire** older in-memory metrics once tracing data is trustworthy.
