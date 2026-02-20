# Resumable Sessions Design

Date: 2026-02-20
Status: **Draft**
Owner: Push
Related: `documents/Background Coder Tasks Plan.md` (deferred server-side approach), `documents/Harness Reliability Plan.md` Track D

## Problem

When the user locks their phone or switches apps, the browser suspends JS execution. The tool loop in `useChat.ts` stops mid-iteration — the SSE connection dies, in-flight tool executions hang, and the accumulated assistant response for the current round is lost. When the user returns, they see a frozen or errored chat with no way to continue where the agent left off.

This is the single biggest reliability gap for a mobile-first coding agent. Background Coder Tasks (server-side execution) was the ideal solution but was deferred because it requires a Durable Object execution layer that duplicates the client-side harness. This design addresses the same user pain with zero backend changes.

## Goal

When the user returns to a suspended session, the app recovers gracefully: no lost work, no half-executed limbo, and the agent can pick up where it left off with minimal context loss.

## Non-goals

- Keeping the tool loop running while the app is backgrounded (that's the Background Coder Tasks plan)
- Server-side state or execution changes
- Idempotency keys, batch IDs, or wire protocol changes (premature without a server-side loop)
- Guaranteeing zero re-execution of tool calls (sandbox truth is the arbiter, not client bookkeeping)

## Why this works without server-side changes

The key insight: **the sandbox is already persistent and is already the source of truth.** Modal containers survive client disconnects (up to 30 min). `git status` and `git diff` tell you exactly what mutations ran. The Coder's `[CODER_STATE]` working memory already survives context trimming. The missing piece is purely client-side: checkpoint the loop state so we can reconstruct "where we were" on wake.

## Design

### 1. Run Checkpoint (the core primitive)

After every completed tool batch in the orchestrator loop (`useChat.ts` line ~804), persist a checkpoint to localStorage:

```typescript
type LoopPhase = 'streaming_llm' | 'executing_tools' | 'delegating_coder';

interface RunCheckpoint {
  chatId: string;
  round: number;
  phase: LoopPhase;
  // Index into the persisted conversation's message array.
  // On recovery, we reconstruct: persistedMessages.slice(0, baseMessageCount) + deltaMessages.
  // This avoids duplicating the full apiMessages array (already saved under CONVERSATIONS_KEY).
  baseMessageCount: number;
  // Messages added during the current run that aren't yet in the persisted conversation
  // (tool results injected this round, synthetic messages, etc.)
  deltaMessages: Array<{ role: string; content: string }>;
  // The accumulated assistant response for the current round
  // (lost on interrupt without this)
  accumulated: string;
  // Thinking content if present
  thinkingAccumulated: string;
  // Was there a Coder delegation in progress?
  coderDelegationActive: boolean;
  // Last known CODER_STATE (if delegation was active)
  lastCoderState: string | null;
  // Timestamp for staleness detection
  savedAt: number;
  // Provider + model locked for this chat
  provider: AIProviderType;
  model: string;
  // Sandbox identity — used to validate the checkpoint matches the current sandbox
  sandboxSessionId: string;
  activeBranch: string;
  repoId: string;
}
```

Storage key: `run_checkpoint_${chatId}`

**When to save:** After each of these events completes:
- All parallel read-only tool results received
- Trailing mutation tool result received
- LLM streaming response fully accumulated (before tool detection)
- Coder delegation returns

Update `phase` at each transition: set `streaming_llm` before calling `streamChat`, `executing_tools` before dispatching tool batch, `delegating_coder` before entering delegation.

**When to clear:** When the loop exits normally (model stops emitting tool calls, user aborts, or error surfaced).

**Size budget:** The checkpoint does NOT duplicate `apiMessages`. Conversations are already persisted under `CONVERSATIONS_KEY` after each user message and tool result. The checkpoint stores only `baseMessageCount` (index into the persisted array) and `deltaMessages` (messages added during the in-flight run). On recovery: `persistedMessages.slice(0, baseMessageCount).concat(deltaMessages)`. This keeps checkpoint payloads small (~5-15KB typical) and avoids repeated large `JSON.stringify` calls on the main thread.

### 2. Proactive flush on `visibilitychange`

Add a `visibilitychange` listener in `useChat` that fires when the document becomes `hidden`:

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && loopActiveRef.current) {
    flushCheckpoint(); // Save current accumulated + deltaMessages immediately
  }
});
```

**Implementation detail:** `flushCheckpoint()` must read `accumulated` from a `useRef`, not from React state. The `useState` value may lag behind the actual token stream by a render cycle. Track accumulated tokens in a mutable ref (`accumulatedRef.current`) that updates synchronously on every SSE chunk. The `useState` version drives UI renders; the ref drives checkpoint flushing. Mobile browsers give a very narrow synchronous window on `visibilitychange` before suspending — reading from a ref is synchronous and guaranteed to have the latest value.

This catches the "phone locked mid-stream" case where accumulated tokens would otherwise be lost. It won't fire if the OS kills the tab outright, but the last completed-round checkpoint still survives.

### 3. Interruption detection on mount

When `useChat` initializes (or when the component remounts after a tab revival), check for an orphaned checkpoint:

```typescript
function detectInterruptedRun(
  chatId: string,
  currentSandboxId: string | null,
  currentBranch: string | null,
  currentRepoId: string | null,
): RunCheckpoint | null {
  const raw = safeStorageGet(`run_checkpoint_${chatId}`);
  if (!raw) return null;
  const checkpoint: RunCheckpoint = JSON.parse(raw);

  // Stale check: if the checkpoint is older than the sandbox max age,
  // the container is likely dead. Don't attempt recovery.
  const age = Date.now() - checkpoint.savedAt;
  if (age > 25 * 60 * 1000) return null; // matches SANDBOX_MAX_AGE_MS

  // Identity check: checkpoint must match the current sandbox, branch, and repo.
  // If any mismatch, the sandbox was recreated or the user switched context.
  if (currentSandboxId && checkpoint.sandboxSessionId !== currentSandboxId) return null;
  if (currentBranch && checkpoint.activeBranch !== currentBranch) return null;
  if (currentRepoId && checkpoint.repoId !== currentRepoId) return null;

  return checkpoint;
}
```

If a checkpoint exists, matches the current sandbox/branch/repo, and the loop isn't currently running, the session was interrupted.

### 4. Recovery flow

When an interrupted run is detected:

**Step 1: Surface a resume affordance.**
Show a banner or inline card: "Session was interrupted. Resume where you left off?" with Resume / Dismiss actions.

Don't auto-resume — the user may have intentionally abandoned the task, or the sandbox may have expired. Let them choose.

**Step 2: On Resume, reconcile with sandbox truth.**
Fetch lightweight sandbox state:

```
sandbox_exec: git status --porcelain && git rev-parse HEAD && git diff --stat && git diff --name-only
```

This tells us:
- What files are dirty (mutations that ran)
- Current HEAD (commits that landed)
- Diff summary (scope of changes)
- Exact list of changed files (critical for partial-mutation detection)

This is one sandbox round-trip. Cheap. If the `--name-only` output exceeds 50 files, truncate to the first 50 with a `(and N more files)` suffix to avoid bloating the reconciliation message.

**Step 3: Inject a phase-specific reconciliation message and re-enter the loop.**
The reconciliation message is constructed from the checkpoint's `phase` field, sandbox truth, and any saved context. Using the phase produces a specific instruction rather than a generic "figure it out" prompt.

Phase-specific templates:

```
[SESSION_RESUMED]
Sandbox state at recovery:
- HEAD: {sha}
- Dirty files: {list or "clean"}
- Diff summary: {stat}
- Changed files: {git diff --name-only output}

{if phase === 'streaming_llm'}
Interruption: connection dropped while you were generating a response (round {N}).
Your partial response before disconnection:
---
{accumulated}
---
Resume your response. The sandbox state above reflects the current truth.

{else if phase === 'executing_tools'}
Interruption: connection dropped while executing tool calls (round {N}).
The tool batch may or may not have completed. Check the sandbox state above
against what the tools were supposed to do. If the expected changes are present,
proceed to the next step. If not, re-attempt the tool calls.

{else if phase === 'delegating_coder'}
Interruption: connection dropped during Coder delegation (round {N}).
Last known Coder state:
{lastCoderState}
The Coder's work may be partially complete. Check the sandbox state above.
Decide whether to re-delegate the remaining work or proceed based on what's done.
{/if}

Do not repeat work that is already reflected in the sandbox.
```

Then re-enter the normal tool loop with the restored messages (`persistedMessages.slice(0, baseMessageCount).concat(deltaMessages)`) plus this reconciliation message. The LLM handles the rest — it can see what the sandbox looks like and what it was trying to do.

**Step 4: Clear the checkpoint** once the loop exits normally.

### 5. What about Coder delegation?

Coder delegation (`delegate_coder` in `useChat.ts`) is the highest-stakes interruption case because the Coder runs its own multi-round tool loop.

The Coder's `[CODER_STATE]` working memory (plan, open tasks, files touched, assumptions, errors) is already designed to survive context trimming. We piggyback on this:

- The orchestrator checkpoint includes `lastCoderState` if delegation was active
- On resume, the reconciliation message includes the Coder state
- The Orchestrator can re-delegate to the Coder with the saved state as context, or decide the task is done based on sandbox truth

We do NOT try to resume the Coder's inner loop directly. The Orchestrator re-evaluates from scratch with full sandbox truth. This is simpler and more robust than trying to reconstruct the Coder's exact position.

### 6. Edge cases

**Sandbox expired (container dead).**
If the checkpoint is >25 min old, discard it. If the sandbox health check fails on resume, show "Sandbox expired — starting fresh" and create a new sandbox. The conversation history is still available; only the in-progress run is lost.

**Multiple tabs.**
localStorage is shared across tabs. Use a simple lock flag (`run_active_${chatId}`) set when the loop starts and cleared when it exits. On resume, check if another tab already has the loop running (via BroadcastChannel or storage event). If so, don't resume — the other tab owns it.

**User aborted before interrupt.**
If `abortRef.current` was true when the checkpoint was saved, mark the checkpoint as `userAborted: true` and don't offer resume.

**Partial accumulated response.**
The `visibilitychange` flush may capture a partial LLM response (mid-token). That's fine — the reconciliation message includes it as "may be incomplete" and the LLM can either finish the thought or start fresh.

**Chat was on a different branch.**
The checkpoint includes `chatId`, which is branch-scoped, plus explicit `activeBranch` and `repoId` fields. If the user switched branches or repos before resuming, the identity check in `detectInterruptedRun` discards the checkpoint.

**Partial mutation: `sandbox_apply_patchset` interrupted mid-execution.**
This is the hardest recovery case. The patchset tool is designed to be all-or-nothing, but if the container crashes mid-write, some files could be dirty and others not. On resume: `git diff --name-only` in the reconciliation message shows exactly which files changed. The model compares this against the patchset it was trying to apply. If only a subset of files changed, the model knows the patchset partially applied and can either finish the remaining files or revert and retry. The `executing_tools` phase template explicitly tells the model to "check the sandbox state against what the tools were supposed to do" — this handles the partial case without special logic.

**Sandbox recreated between interrupt and resume.**
If the sandbox crashed and was recreated (new session ID), the `sandboxSessionId` in the checkpoint won't match the current sandbox. The checkpoint is discarded. The user gets a fresh sandbox with the conversation history intact but no in-progress run recovery. This is correct — a new sandbox has no dirty state to reconcile against.

## What this doesn't solve

- **Long tasks while phone is locked.** The loop still pauses with the browser. This design makes the pause graceful, not invisible. For truly background execution, the Background Coder Tasks plan remains the right long-term answer.
- **Network-level retries for SSE.** If the LLM provider is down, resuming the loop will hit the same wall. The existing timeout handling surfaces this. Note: a momentary cellular drop (5 seconds) where the tab stays alive is NOT a checkpoint recovery case — it's an SSE reconnect problem. The tab is still running, the loop hasn't exited, and `detectInterruptedRun` is never called. SSE resilience is a separate concern from session resumability.
- **Concurrent mutations from other sources.** If someone pushes to the branch while the session is suspended, the sandbox is stale. This is the same problem that exists today — sandbox truth still reflects the local state.

## Implementation plan

### Phase 1: Checkpoint persistence (minimal viable recovery)

Files touched:
- `hooks/useChat.ts` — Add checkpoint save/clear logic around the tool loop, `LoopPhase` tracking
- `types/index.ts` — `RunCheckpoint` type, `LoopPhase` enum

Scope:
- Save delta-based checkpoint (`baseMessageCount` + `deltaMessages`, not full `apiMessages`) after every completed tool batch
- Track `LoopPhase` transitions through the loop
- Clear checkpoint on normal loop exit
- Add `visibilitychange` flush
- No UI yet — just persistence

Exit criteria: Checkpoints reliably persist across app suspend/resume cycles. Checkpoint payloads stay under ~15KB.

### Phase 2: Recovery detection + resume UI

Files touched:
- `hooks/useChat.ts` — `detectInterruptedRun()`, resume logic
- `components/chat/ChatContainer.tsx` — Resume banner/affordance
- `lib/sandbox-client.ts` — Lightweight `sandboxStatus()` helper (git status + HEAD + diff stat in one call)

Scope:
- Detect orphaned checkpoints on mount
- Show resume banner
- On resume: fetch sandbox status, inject reconciliation message, re-enter loop

Exit criteria: User can lock phone mid-tool-loop, reopen app, tap Resume, and have the agent continue.

### Phase 3: Coder delegation recovery

Files touched:
- `hooks/useChat.ts` — Capture `lastCoderState` in checkpoint during delegation
- `lib/coder-agent.ts` — Expose last working memory state for checkpoint capture

Scope:
- Include Coder working memory in checkpoint
- Reconciliation message includes Coder state when delegation was active
- Orchestrator re-evaluates delegation status on resume

Exit criteria: Interrupted Coder tasks resume without losing plan/progress context.

### Phase 4: Hardening

- Multi-tab coordination (BroadcastChannel lock)
- Checkpoint size management (alert if deltaMessages exceeds ~50KB, trim oldest deltas)
- Telemetry: track interrupt/resume frequency by `LoopPhase`, success rate, time-to-resume

## Design decisions

**Why no batch IDs or idempotency keys?**
The sandbox (git) is the source of truth for mutations. `git status` tells you what ran. Adding client-side IDs solves a problem that only exists when the execution environment is stateless — Modal containers aren't.

**Why a phase tag but no recovery state machine?**
The `LoopPhase` enum (`streaming_llm`, `executing_tools`, `delegating_coder`) is a checkpoint annotation, not a state machine. It makes the reconciliation message more specific — "interrupted mid-stream" produces a different recovery instruction than "interrupted mid-tool-execution." But the loop itself has no recovery states or transitions. On resume, we inject one message and re-enter the normal loop. The LLM is stateless between rounds; the phase tag just helps us tell it what happened more precisely.

**Why not auto-resume?**
The user may have intentionally abandoned the task. The sandbox may have expired. Auto-resume risks re-executing a mutation the user wanted to cancel. Explicit resume is one tap and eliminates a class of "why did it do that" bugs.

**Why checkpoint to localStorage instead of IndexedDB?**
localStorage is synchronous and already used throughout Push for conversations, sandbox sessions, and config. The checkpoint payload (~5-15KB with delta approach) is well within localStorage limits. IndexedDB would add async complexity for no benefit at this size.

**Relationship to Background Coder Tasks.**
This design is complementary, not competing. Background Coder Tasks (server-side execution) solves "keep working while I'm away." This design solves "don't lose my place when I come back." If/when Background Coder Tasks ships, the checkpoint mechanism becomes the client-side bookkeeping for reconnecting to a server-owned run — the `RunCheckpoint` type would extend to include a `jobId` field and the resume flow would fetch from the server instead of localStorage.

## Review log

### Review 1 (2026-02-20)

Source: external design review.

| Issue | Assessment | Action |
|---|---|---|
| Storing full `apiMessages` is heavy — duplicates persisted chat, large `JSON.stringify` on main thread, risks 5MB localStorage ceiling | **Valid.** Best point in the review. | Fixed: checkpoint now stores `baseMessageCount` + `deltaMessages` (delta against persisted conversation). Payloads drop from ~60KB to ~5-15KB. |
| Recovery message is too vague — LLM-driven reconciliation risks "redo everything" | **Half valid.** The LLM handles ambiguous context every round anyway. But classifying the interruption type does improve specificity. | Fixed: added `LoopPhase` enum to checkpoint. Reconciliation message is now phase-specific (different templates for `streaming_llm` vs `executing_tools` vs `delegating_coder`). |
| 25-min staleness threshold doesn't catch sandbox recreation, branch switch, or repo switch | **Valid.** Implicit chatId-based branch scoping isn't strong enough. | Fixed: added `sandboxSessionId`, `activeBranch`, `repoId` to `RunCheckpoint`. `detectInterruptedRun()` validates all three. |
| `visibilitychange` doesn't fire when OS kills the tab | **Already addressed.** The design already noted this: "It won't fire if the OS kills the tab outright, but the last completed-round checkpoint still survives." The flush is a best-effort optimization on top of per-batch checkpoints. | No change needed. |
| Should add a `LoopPhase` enum (not a state machine, just a tag) for reconciliation and telemetry | **Valid.** Low cost, improves both recovery messages and debugging. | Fixed: `LoopPhase` added to checkpoint type and phase-specific reconciliation templates. |
| Stress test: `sandbox_apply_patchset` mutation interrupted, connection lost before result injection | **Valid edge case.** Patchset is all-or-nothing by design, but container crash mid-write could leave partial state. | Added as explicit edge case. `git diff --name-only` in reconciliation message shows exactly which files changed. Model compares against intended patchset. |

### Review 2 (2026-02-20)

Source: external peer review.

| Issue | Assessment | Action |
|---|---|---|
| `visibilitychange` flush must read from `useRef`, not React state — `useState` lags behind the token stream by a render cycle | **Valid.** Important execution detail. Mobile browsers give a narrow synchronous window on `visibilitychange`; reading stale state defeats the purpose. | Fixed: added implementation note requiring `accumulatedRef` for synchronous reads in `flushCheckpoint()`. |
| Large `git diff` output on resume could blow up the reconciliation message and trigger immediate context compaction | **Half valid.** `--name-only` for 40 files is ~40 lines — negligible. But pathological cases (200+ files) could get noisy. | Fixed: added truncation cap — 50 files max with `(and N more files)` suffix. |
| Momentary network flap (5s cellular drop) shouldn't force user to tap Resume — consider auto-resume for short interruptions in `streaming_llm` phase | **Invalid for this design.** A 5s network drop where the tab stays alive is an SSE reconnect problem, not a checkpoint recovery case. The loop hasn't exited, `detectInterruptedRun` is never called. SSE resilience is a separate concern. | Clarified in "What this doesn't solve" section. No auto-resume path needed. |
