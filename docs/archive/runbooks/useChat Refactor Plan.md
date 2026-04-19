# useChat Refactor Plan

> **Regression notice (2026-04-19):** This plan shipped "Complete" at 770 lines on 2026-03-25, but useChat.ts has since regrown to 1,733 lines (+125%) as features (harness runtime evolution, steerable runs, persisted queued followups, and more) accreted coordinator wiring directly in the hook. See `docs/decisions/useChat Regression Audit.md` for the diagnosis and a proposed 4-phase re-extraction track. The proximate cause identified in the audit was this plan's Phase 2 deferral marker — *"helpers exist but not yet applied inline — deferred"* — which left an optional landing spot that the next feature authors bypassed. The audit's discipline rule for the re-extraction: migration lands in the same PR as extraction, no "helpers exist but hook still does it directly" half-states.

## Status
- Last updated: 2026-03-25
- State: ~~**Complete** — all four phases and quick wins done~~ **Regressed 2026-04-19.** See regression notice above.
- Result: useChat.ts 2207 → 770 lines (65% reduction); zero TypeScript errors; build passes *at time of completion; regrown to 1,733 lines by 2026-04-19.*
- Goal: Reduce useChat.ts from 2206 lines to a true orchestrator, surface stable seams for future work

## Baseline

Completed extractions as of 2026-03-25:
- [x] `app/src/hooks/chat-persistence.ts` — conversation load/save/migration
- [x] `app/src/hooks/chat-tool-execution.ts` — tool dispatch and structured error handling
- [x] `app/src/hooks/useAgentDelegation.ts` — coder and explorer delegation
- [x] Recovery and multi-mutation error handling pulled out of the send loop

Remaining in `useChat.ts` (2206 lines):
- Checkpoint refs cluster: lines 218–350
- Resume lifecycle: lines 367–598
- CI poller: lines 260–288
- Chat management callbacks: lines 749–900
- `sendMessage` loop: lines 917–1675 (~758 lines)
- `regenerateLastResponse`, `editMessageAndResend`, `diagnoseCIFailure`: lines 1676–1748
- Card action handlers: lines 1749–2145 (~400 lines)
- 39 scattered `setConversations`/dirty-mark call sites throughout

## Principles

1. Extract bounded subsystems first, not the hardest things first.
2. Discover the helper surface from real extraction work, not from theory.
3. Each extraction should leave `useChat.ts` strictly smaller and still passing tests.
4. `sendMessage` stays as the orchestrator — extract pure sub-functions, not the whole thing.

---

## Phase 1 — Extract card actions → `chat-card-actions.ts`

**Why first:** The card action block (lines 1749–2145) is the cleanest seam in the file. It is a post-response UI workflow subsystem with its own internal helpers and no dependency on the streaming loop. Extracting it first forces a precise accounting of state dependencies, which informs what conversation state helpers actually need to look like in Phase 2.

**Target functions:**
- `updateCardInMessage` (1751)
- `injectSyntheticMessage` (1769)
- `injectAssistantCardMessage` (1789)
- `handleCardAction` (1813) — the large switch including commit-approve, PR flow, and CI actions

**External dependencies to thread in as params or refs:**
- `setConversations` + `dirtyConversationIdsRef` — state mutation
- `activeChatId` / `activeChatIdRef`
- `sandboxIdRef`, `isMainProtectedRef`, `branchInfoRef`, `repoRef`, `workspaceSessionIdRef`
- `ensureSandboxRef`
- `updateAgentStatus`
- `sendMessage` (used in PR/CI card actions to kick off follow-up messages)
- `execInSandbox` (imported utility — no extra threading needed)

**Output:** A `useChatCardActions` hook (or exported function bundle) that `useChat` composes at line ~1749. The call site in `useChat` becomes ~10 lines.

**Also do in this PR:** Pull the CI poller (lines 260–288) into its own `useEffect` block or thin `useCIPoller` hook. It is fully standalone and has no coupling to the card action changes — include it as a quick win alongside Phase 1.

- [x] Extract `useChatCardActions` to `app/src/hooks/chat-card-actions.ts`
- [x] Extract CI poller to `app/src/hooks/useCIPoller.ts`

---

## Phase 2 — Conversation state helpers → `conversationOps.ts`

**Why second:** After Phase 1 extraction, the pattern of repeated `setConversations` + `dirtyConversationIdsRef.current.add(chatId)` inside the remaining file will be clearer. Phase 1 was the survey; Phase 2 formalizes what was discovered.

**Proposed helpers (pure updater functions):**
```ts
// Takes setConversations + dirtyRef, returns typed helpers
function makeConversationOps(
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>,
  dirtyRef: React.MutableRefObject<Set<string>>,
) {
  return {
    appendMessage(chatId: string, msg: ChatMessage): void,
    replaceLastAssistantContent(chatId: string, content: string, thinking?: string): void,
    markConversationMeta(chatId: string, patch: Partial<Conversation>): void,
    markDirty(chatId: string): void,
  };
}
```

**Design constraint:** Helpers must not close over `dirtyRef` at construction time — they receive the ref as a parameter so they always read the current ref value. This avoids stale-closure issues in async paths.

**What this buys:** The remaining `sendMessage` loop and resume lifecycle become easier to read and easier to extract in Phases 3–4 because the state mutation boilerplate is gone.

- [x] Write `app/src/hooks/conversationOps.ts` with typed helper factory
- [ ] Replace `setConversations` call sites in `useChat.ts` body (outside card actions) with helpers — deferred; helpers exist but not yet applied inline

---

## Phase 3 — Extract checkpoint lifecycle → `useChatCheckpoint.ts`

**Why third:** The checkpoint block (refs at 218–350, effects at 357–365, resume state at 367–598) already reads like a distinct hook. It has its own refs, its own effects, its own state, and its own manager API calls. But it has one notable forward dependency: `resumeInterruptedRun` (line 453) calls `sendMessageRef.current`, and `sendMessageRef` is not populated until after `sendMessage` is defined at line 917.

**Forward dependency handling:** Pass `sendMessageRef` into `useChatCheckpoint` as a parameter. The ref is defined in `useChat` at line 233, populated after `sendMessage` is defined, and passed by reference — so the extracted hook always reads the live value.

**What to extract:**
- All 10 checkpoint refs (`checkpointAccumulatedRef`, `checkpointThinkingRef`, etc.) + `loopActiveRef`
- `lastCoderStateRef`, `tabLockIntervalRef`, `tabLockIdRef`
- `saveExpiryCheckpoint`, `flushCheckpoint`
- `interruptedCheckpoint` state
- `appendAgentEvent`, `updateAgentStatus`
- Resume detection effect
- `dismissResume`, `resumeInterruptedRun`
- Visibility change effect

**External dependencies to thread in:**
- `sandboxIdRef`, `branchInfoRef`, `repoRef`, `workspaceSessionIdRef`, `ensureSandboxRef`
- `setConversations` + `dirtyRef` (or the helpers from Phase 2)
- `sendMessageRef`
- `isStreaming`, `activeChatId`

**Output:** `useChatCheckpoint` returns `{ interruptedCheckpoint, resumeInterruptedRun, dismissResume, saveExpiryCheckpoint, flushCheckpoint, updateAgentStatus, appendAgentEvent, loopActiveRef, lastCoderStateRef, checkpointRefs }`.

The checkpoint refs bundle can be a plain object returned from the hook so `sendMessage` can populate them by assigning into the bundle during a round.

- [x] Extract `useChatCheckpoint` to `app/src/hooks/useChatCheckpoint.ts`
- [x] Verify `sendMessageRef` wiring — no stale closure possible

---

## Phase 4 — Slim `sendMessage` into round helpers

**Why last and why careful:** `sendMessage` at 758 lines is the most coupled piece of the file. It touches streaming state, checkpoint refs, tool execution, delegation, recovery, and conversation state. Extracting it incorrectly will break the entire chat loop.

**Strategy:** Keep `sendMessage` as the orchestrator. Extract pure sub-functions that encapsulate a well-defined step. Do NOT extract the whole function into a single helper.

**Proposed extractions:**

```
prepareRoundContext(options) → { chatId, userMessage, currentMessages, providerConfig }
  — Lines ~917–966: message assembly, provider/model resolution

streamAssistantRound(ctx, abortRef, updateFns) → { accumulated, thinking, finishReason, ... }
  — The streaming accumulation + chunk processing

handleToolRound(toolCalls, ctx) → { results, shouldContinue }
  — Tool dispatch, parallel vs single routing (delegates to chat-tool-execution)

finalizeRound(ctx, result) → void
  — Conversation state commit, checkpoint flush, dirty mark
```

**What stays in `sendMessage`:** The loop itself (`while (round < maxRounds)`), the round counter, abort checks, recovery logic, and the orchestration sequencing. This is the control flow; it stays readable.

**Prerequisite:** Phases 2 and 3 must be done first. Phase 2 eliminates the state mutation noise that makes `sendMessage` hard to read. Phase 3 extracts the checkpoint refs so `sendMessage` receives them as a bundle rather than accessing 10 refs directly.

- [x] Extract `streamAssistantRound` to `app/src/hooks/chat-send.ts`
- [x] Extract `processAssistantTurn` to `app/src/hooks/chat-send.ts` (combines handleToolRound + recovery)
- [x] sendMessage loop reads cleanly — ~250 lines, calls two helper functions per round
- Note: prepareRoundContext and finalizeRound stayed inline in sendMessage; the loop orchestration is already clean

---

## Quick wins (any phase)

- [x] Chat management callbacks → `app/src/hooks/chat-management.ts` (useChatManagement hook)
- [x] `regenerateLastResponse`, `editMessageAndResend`, `diagnoseCIFailure` → `app/src/hooks/chat-replay.ts` (useChatReplay hook)

---

## Target shape after all phases

```
useChat.ts                ~300–400 lines  (state declarations, effect wiring, return)
chat-card-actions.ts      ~450 lines      (card action subsystem)
useChatCheckpoint.ts      ~300 lines      (checkpoint + resume lifecycle)
conversationOps.ts        ~80 lines       (state mutation helpers)
chat-management.ts        ~150 lines      (CRUD callbacks)
chat-replay.ts            ~80 lines       (regenerate, editAndResend, diagnoseCIFailure)
[sendMessage sub-fns]     ~400 lines      (round helpers, possibly inline or in chat-send.ts)
```

The existing `chat-persistence.ts`, `chat-tool-execution.ts`, and `useAgentDelegation.ts` remain unchanged.
