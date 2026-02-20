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
interface RunCheckpoint {
  chatId: string;
  round: number;
  // The full apiMessages array at this point in the loop
  apiMessages: Array<{ role: string; content: string }>;
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
}
```

Storage key: `run_checkpoint_${chatId}`

**When to save:** After each of these events completes:
- All parallel read-only tool results received
- Trailing mutation tool result received
- LLM streaming response fully accumulated (before tool detection)
- Coder delegation returns

**When to clear:** When the loop exits normally (model stops emitting tool calls, user aborts, or error surfaced).

**Size budget:** apiMessages can be large. Apply the same rolling-window compression the app already uses before serializing — keep the last ~60KB of messages. The checkpoint doesn't need to be a perfect replay log; it needs to be enough for the LLM to continue.

### 2. Proactive flush on `visibilitychange`

Add a `visibilitychange` listener in `useChat` that fires when the document becomes `hidden`:

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && loopActiveRef.current) {
    flushCheckpoint(); // Save current accumulated + apiMessages immediately
  }
});
```

This catches the "phone locked mid-stream" case where accumulated tokens would otherwise be lost. It won't fire if the OS kills the tab outright, but the last completed-round checkpoint still survives.

### 3. Interruption detection on mount

When `useChat` initializes (or when the component remounts after a tab revival), check for an orphaned checkpoint:

```typescript
function detectInterruptedRun(chatId: string): RunCheckpoint | null {
  const raw = safeStorageGet(`run_checkpoint_${chatId}`);
  if (!raw) return null;
  const checkpoint: RunCheckpoint = JSON.parse(raw);

  // Stale check: if the checkpoint is older than the sandbox max age,
  // the container is likely dead. Don't attempt recovery.
  const age = Date.now() - checkpoint.savedAt;
  if (age > 25 * 60 * 1000) return null; // matches SANDBOX_MAX_AGE_MS

  return checkpoint;
}
```

If a checkpoint exists and the loop isn't currently running, the session was interrupted.

### 4. Recovery flow

When an interrupted run is detected:

**Step 1: Surface a resume affordance.**
Show a banner or inline card: "Session was interrupted. Resume where you left off?" with Resume / Dismiss actions.

Don't auto-resume — the user may have intentionally abandoned the task, or the sandbox may have expired. Let them choose.

**Step 2: On Resume, reconcile with sandbox truth.**
Fetch lightweight sandbox state:

```
sandbox_exec: git status --porcelain && git rev-parse HEAD && git diff --stat
```

This tells us:
- What files are dirty (mutations that ran)
- Current HEAD (commits that landed)
- Diff summary (scope of changes)

This is one sandbox round-trip. Cheap.

**Step 3: Inject a reconciliation message and re-enter the loop.**
Construct a system message from the checkpoint + sandbox truth:

```
[SESSION_RESUMED]
The session was interrupted during round {N}.

Sandbox state at recovery:
- HEAD: {sha}
- Dirty files: {list or "clean"}
- Diff summary: {stat}

{if coderDelegationActive}
Last known Coder state:
{lastCoderState}
{/if}

The assistant's last partial response (may be incomplete):
---
{accumulated}
---

Continue from this state. If the interrupted action completed (check sandbox state),
proceed to the next step. If it did not complete, re-attempt it.
Do not repeat work that is already reflected in the sandbox.
```

Then re-enter the normal tool loop with the restored `apiMessages` plus this reconciliation message. The LLM handles the rest — it can see what the sandbox looks like and what it was trying to do.

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
The checkpoint includes `chatId`, which is branch-scoped. The sandbox session includes branch info. If the user switched branches before resuming, the checkpoint is for a different branch — discard it.

## What this doesn't solve

- **Long tasks while phone is locked.** The loop still pauses with the browser. This design makes the pause graceful, not invisible. For truly background execution, the Background Coder Tasks plan remains the right long-term answer.
- **Network-level retries for SSE.** If the LLM provider is down, resuming the loop will hit the same wall. The existing timeout handling surfaces this.
- **Concurrent mutations from other sources.** If someone pushes to the branch while the session is suspended, the sandbox is stale. This is the same problem that exists today — sandbox truth still reflects the local state.

## Implementation plan

### Phase 1: Checkpoint persistence (minimal viable recovery)

Files touched:
- `hooks/useChat.ts` — Add checkpoint save/clear logic around the tool loop
- `lib/safe-storage.ts` — May need size-aware helpers for large checkpoint payloads
- `types/index.ts` — `RunCheckpoint` type

Scope:
- Save checkpoint after every completed tool batch
- Clear checkpoint on normal loop exit
- Add `visibilitychange` flush
- No UI yet — just persistence

Exit criteria: Checkpoints reliably persist across app suspend/resume cycles.

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
- Checkpoint size management (compress or trim if >100KB)
- Staleness detection for edge cases (branch switch, repo switch)
- Telemetry: track interrupt/resume frequency, success rate

## Design decisions

**Why no batch IDs or idempotency keys?**
The sandbox (git) is the source of truth for mutations. `git status` tells you what ran. Adding client-side IDs solves a problem that only exists when the execution environment is stateless — Modal containers aren't.

**Why no recovery state machine?**
The LLM is stateless between rounds. It doesn't need to know it's in a "recovery phase" vs a "normal phase." It needs to know what the sandbox looks like and what it was trying to do. A system message achieves this without new states or transitions.

**Why not auto-resume?**
The user may have intentionally abandoned the task. The sandbox may have expired. Auto-resume risks re-executing a mutation the user wanted to cancel. Explicit resume is one tap and eliminates a class of "why did it do that" bugs.

**Why checkpoint to localStorage instead of IndexedDB?**
localStorage is synchronous and already used throughout Push for conversations, sandbox sessions, and config. The checkpoint payload (~60KB after compression) is well within localStorage limits. IndexedDB would add async complexity for no benefit at this size.

**Relationship to Background Coder Tasks.**
This design is complementary, not competing. Background Coder Tasks (server-side execution) solves "keep working while I'm away." This design solves "don't lose my place when I come back." If/when Background Coder Tasks ships, the checkpoint mechanism becomes the client-side bookkeeping for reconnecting to a server-owned run — the `RunCheckpoint` type would extend to include a `jobId` field and the resume flow would fetch from the server instead of localStorage.
