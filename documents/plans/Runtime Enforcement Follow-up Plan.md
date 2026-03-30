# Push Runtime Enforcement Follow-up Plan

Date: 2026-03-30
Status: **Complete**
Owner: Push
Related:
- `documents/plans/Harness Runtime Evolution Plan.md` — completed foundation that made this follow-up possible
- `documents/analysis/Architecture Rating Snapshot.md`
- `documents/analysis/Harness Friction — Agent Self-Report.md`
- `documents/analysis/Agent Tool Patterns — Claude Code Cross-Reference.md`

## Why this plan exists

The latest runtime-enforcement work moved one important reliability boundary out of prompts and into code:

- session verification policy is now durable
- completion claims are blocked by runtime verification state
- commit/push boundaries can check the same contract instead of trusting model narration

That solved the clearest prompt-vs-runtime gap, but it also exposed the next layer of soft enforcement.

Push still has a few places where the runtime is strong in spirit but not yet fully authoritative:

- the Orchestrator still learns a lot from human-readable delegation prose
- turn-policy post-tool behavior still cannot fully express runtime actions through the shared hook layer
- some approval-sensitive behaviors are described clearly in prompts but not always represented as first-class runtime gates

This plan is the next enforcement pass: keep prompts for explanation, but move more decision power into structured state and runtime boundaries.

## Goals

1. Stop making the Orchestrator infer critical delegation state from summary prose.
2. Make post-tool runtime policy as expressive as pre-tool policy.
3. Represent approval-sensitive actions as explicit runtime gates, not only prompt guidance.
4. Reuse the run engine, run journal, and verification state instead of adding another parallel policy system.

## Non-goals

- Rewriting every prompt-heavy behavior into rigid runtime logic.
- Removing prompt guidance for reporting, tone, or planning style.
- Building a full server-owned workflow engine.
- Expanding this into a broad permissions redesign before the runtime contracts are stable.

## Current gaps

### 1. Delegation outcomes are still partly prose-shaped

`delegate_coder` and `delegate_explorer` produce useful runtime side effects and verification updates, but the top-level tool result is still mostly a narrated summary.

That is fine for humans, but weaker for orchestration:

- completion logic can still be tempted to treat summary prose as truth
- follow-up reasoning has to infer whether work is complete, incomplete, or inconclusive
- richer downstream UI/runtime decisions have to scrape text instead of reading structured state

### 2. Turn-policy still has a bridge asymmetry

`TurnPolicyRegistry` can express:

- `inject`
- `deny`
- `halt`

But the `ToolHookRegistry` bridge only carries the pre-tool side cleanly. Post-tool policy still cannot fully represent `inject` or `halt` through the shared hook interface, so enforcement remains split between direct loop logic and hook-compatible logic.

### 3. Approval-sensitive behavior is still unevenly enforced

Push already has some good runtime gates:

- protect-main blocking
- commit prep through Auditor flow
- runtime verification on completion / commit boundaries

But there are still approval-shaped behaviors that can remain too prompt-described:

- destructive or user-sensitive sandbox actions
- explicit override paths for direct git behavior
- remote side effects that should force `ask_user`

These should become explicit runtime decisions with durable reasoning, not only “the model was told to ask first.”

## Workstreams

### Track A: Structured Delegation Outcome Contract

### Objective

Give delegated runs a machine-readable result contract that the Orchestrator and UI can trust directly.

### Scope

- Add a structured delegation outcome shape for `delegate_coder` and `delegate_explorer`.
- Capture, at minimum:
  - `status: complete | incomplete | inconclusive`
  - `summary`
  - `evidence`
  - `checks`
  - `gateVerdicts`
  - `missingRequirements`
  - `nextRequiredAction`
- Keep the readable tool-result prose for humans, but derive it from the structured result rather than the reverse.
- Persist the structured outcome in the run journal / runtime state where useful.

### Likely touch points

- `app/src/hooks/useAgentDelegation.ts`
- `app/src/hooks/chat-send.ts`
- `app/src/lib/chat-run-events.ts`
- `app/src/lib/run-journal.ts`
- `app/src/types/index.ts`

### Exit criteria

- The Orchestrator can distinguish complete / incomplete / inconclusive delegation results without parsing free-form summary text.
- Delegation outcomes carry verification and evidence context in a structured way.
- Human-readable result text becomes a view over runtime truth, not the source of truth.

### Track B: Finish The Turn-Policy Runtime Bridge

### Objective

Make the shared hook/policy layer expressive enough to represent post-tool runtime actions without falling back to ad hoc loop logic.

### Scope

- Expand the post-tool hook result surface so runtime policy can express:
  - corrective injection
  - loop halt
  - structured invalidation / retry guidance
- Remove the current asymmetry where post-tool policy must bypass the generic tool-hook path.
- Clarify which guarantees belong in:
  - turn policy
  - tool hooks
  - runtime verification state

### Likely touch points

- `app/src/lib/turn-policy.ts`
- `app/src/lib/tool-hooks.ts`
- `app/src/lib/tool-dispatch.ts`
- agent loops that currently evaluate `afterToolExec` directly

### Exit criteria

- Post-tool policy can express the same class of runtime actions that the loop currently handles manually.
- The bridge comment about `inject` / `halt` no longer reflects a capability gap.
- More runtime invariants can be declared once and shared across agent paths.

### Track C: Approval Rules As Runtime Gates

### Objective

Turn approval-sensitive actions into explicit runtime gate checks with structured failure reasons and user-facing fallback paths.

### Scope

- Inventory actions that should require either:
  - explicit user approval
  - a safe audited path
  - a higher-trust override state
- Prioritize:
  - direct git override flows
  - destructive sandbox actions
  - external / remote side effects that should force `ask_user`
- Represent approval failures with structured runtime results, not only prompt admonitions.
- Reuse the runtime verification / gating pattern where possible instead of adding bespoke booleans.

### Likely touch points

- `app/src/lib/tool-dispatch.ts`
- `app/src/lib/sandbox-tools.ts`
- `app/src/hooks/chat-send.ts`
- `app/src/lib/ask-user-tools.ts`
- relevant card / approval UI surfaces

### Exit criteria

- Approval-sensitive paths fail closed in runtime when approval is missing.
- The model gets a clear structured result explaining the blocked action and safest next path.
- Override paths are explicit, auditable, and easier to reason about in telemetry.

## Recommended order

1. **Track A first**
   This gives the rest of the system structured delegation truth to build on.

2. **Track B second**
   Once delegation outcomes are structured, the next highest leverage is finishing the policy bridge so runtime rules are declared once.

3. **Track C third**
   Approval gating should ride on top of the cleaner runtime contract rather than being bolted onto the current mixed abstraction layer.

## Rollout notes

### Phase 0: Data-shape groundwork

- Add the structured delegation outcome types.
- Add any required run-journal or runtime-state persistence fields.
- Keep all current user-visible behavior intact.

### Phase 1: Shadow structured outcomes

- Emit structured delegation outcomes alongside existing text summaries.
- Update tests and diagnostics to compare structured state against current behavior.

### Phase 2: Runtime cutover

- Make completion and follow-up logic read structured delegation truth.
- Stop relying on delegation prose markers for critical state.

### Phase 3: Policy bridge upgrade

- Expand post-tool hook expressiveness.
- Move selected direct loop checks into the shared policy/hook layer.

### Phase 4: Approval gate rollout

- Start with the highest-risk approval-sensitive actions.
- Add structured blocked-result surfaces plus `ask_user` fallbacks.

## Risks

### 1. Too much rigidity

Not every prompt instruction should become a runtime rule. Over-enforcement would make the system brittle and raise round churn.

### 2. Double-accounting of truth

If structured delegation outcomes, run journal state, and tool result prose drift apart, the system gets harder to debug, not easier.

### 3. Approval sprawl

If approval gating is implemented as many one-off checks, Push will recreate the same fragmentation this plan is trying to remove.

## Success criteria

- The Orchestrator no longer needs to parse human-readable delegation prose for critical completion state.
- Post-tool runtime policy is a first-class shared surface, not a partial bridge.
- Approval-sensitive behavior is enforced by runtime gates with structured outcomes and clear user fallback paths.
- The resulting system feels more boring and trustworthy: fewer “the prompt said not to,” more “the runtime knows what is allowed.”

## Implementation log

### 2026-03-30 — Phases 0–1 + Track B bridge + Track C gates

**Phase 0 (types):**
- Added `DelegationOutcome`, `DelegationStatus`, `DelegationEvidence`, `DelegationCheck`, `DelegationGateVerdict` to `types/index.ts`
- Expanded `PostToolUseResult` with `action`, `injectMessage`, `haltSummary`
- Added `ApprovalGateRule`, `ApprovalGateRegistry`, `ApprovalGateBlockedResult`, `ApprovalGateCategory`, `ApprovalGateDecision`
- Added `APPROVAL_GATE_BLOCKED` to `ToolErrorType`
- Extended `ToolExecutionResult`, `RunEventInput.subagent.completed`, `RunJournalEntry` with `delegationOutcome`

**Track A (structured delegation outcomes — shadow mode):**
- `useAgentDelegation.ts` builds `DelegationOutcome` for both Coder and Explorer paths
- Status derived from auditor verdict → criteria results → inconclusive fallback
- Evidence, checks, gate verdicts, missing requirements all populated from existing data
- Outcome attached to `ToolExecutionResult.delegationOutcome` and `subagent.completed` events
- Text format unchanged (shadow mode — structured data emitted alongside prose)
- `run-journal.ts` gained `recordDelegationOutcome()` helper

**Track B (turn-policy bridge):**
- `turn-policy.ts`: `toToolHookRegistry()` now bridges both `beforeToolExec` (pre) and `afterToolExec` (post)
- `PostToolUseResult` expanded to express `inject` and `halt` actions
- `ToolExecutionResult` gained `postHookInject` and `postHookHalt` fields
- `tool-dispatch.ts`: post-hook evaluation propagates inject/halt to result
- `tool-hooks.ts`: merge logic updated — first action wins across post-hooks
- `coder-agent.ts`: calls `evaluateAfterTool()` at both sequential and parallel tool execution sites
- Inline mutation tracking preserved alongside bridge (removal deferred to validation pass)

**Track C (approval gates):**
- New `approval-gates.ts` with `ApprovalGateRegistry` class and `createDefaultApprovalGates()` factory
- Three default gates: `destructive-sandbox-exec`, `git-direct-override`, `remote-side-effect`
- Gates evaluated in `tool-dispatch.ts` after pre-hooks, before execution
- Blocked results include structured reason + recovery path
- `ask_user` decision returns retryable error guiding model to request approval

### 2026-03-30 — Phase 2–4 completion

**Track A follow-through:**
- `useChat.ts` now persists `DelegationOutcome` into the live run journal when `subagent.completed` events land
- the journal’s structured delegation field is no longer just a helper surface; it is maintained on the active runtime path

**Track B follow-through:**
- `chat-send.ts` now consumes `postHookInject` and `postHookHalt` on the main Orchestrator tool loop
- post-tool policy actions can now affect the next round instead of stopping at `ToolExecutionResult` fields
- the bridge is now live on the generic chat harness, not only in the Coder loop

**Track C follow-through:**
- `chat-tool-execution.ts` now runs normal tool calls through `createDefaultApprovalGates()`
- `agent-loop-utils.ts` also supplies the default approval gates to shared read-only agent loops
- approval-sensitive runtime gates are now active in the live `executeAnyToolCall` call sites, not just implemented in dispatch

**Validation:**
- `npx tsc -p tsconfig.app.json --noEmit`
- `npx vitest run` → 75 files, 717 tests passed
- targeted ESLint on touched runtime files
