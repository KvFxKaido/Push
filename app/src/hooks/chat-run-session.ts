/**
 * chat-run-session.ts
 *
 * Run-session lifecycle helpers extracted from `useChat.ts`'s
 * `sendMessage`. Pairs the start/end bookends:
 *
 *   acquireRunSession   — emits RUN_STARTED, acquires the multi-tab
 *                         lock (with cleanup on denial), starts the
 *                         heartbeat. Caller short-circuits when
 *                         `acquired: false`.
 *   finalizeRunSession  — runs in `sendMessage`'s `finally` block:
 *                         emits the terminal event if the engine
 *                         hasn't recorded one, releases the tab lock,
 *                         clears the streaming flag and abort
 *                         controller, and either drains the queue
 *                         (different active chat) or hands the next
 *                         queued follow-up back to the caller for
 *                         dispatch (same active chat).
 *
 * Both helpers take refs and callbacks explicitly so the run-session
 * lifecycle can be unit-tested without instantiating the full hook.
 * The recursive `sendMessage` re-entry on follow-up dispatch stays in
 * the caller — `finalizeRunSession` returns the dequeued follow-up so
 * the caller (which has `sendMessage` in scope) can invoke it.
 *
 * This is phase 6 of the useChat.ts re-extraction track. Phase 5
 * (`prepareSendContext`) handled the pre-loop setup; this finishes
 * the bookends. The middle of `sendMessage` is the round loop, which
 * already routes through `chat-send.ts`'s `streamAssistantRound` /
 * `processAssistantTurn`.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { clearRunCheckpoint, releaseRunTabLock } from '@/lib/checkpoint-manager';
import { type RunEngineState, type RunEngineEvent } from '@/lib/run-engine';
import type { AgentStatus, Conversation, QueuedFollowUp } from '@/types';

// ---------------------------------------------------------------------------
// finalizeRunSession
// ---------------------------------------------------------------------------

export interface FinalizeRunSessionArgs {
  chatId: string;
  /** Set to true by the loop when it exited via the normal completion
   *  path (so we can decide whether to emit LOOP_COMPLETED vs LOOP_ABORTED
   *  and whether to clear the run checkpoint). */
  loopCompletedNormally: boolean;
}

export interface FinalizeRunSessionRefs {
  runEngineStateRef: MutableRefObject<RunEngineState>;
  cancelStatusTimerRef: MutableRefObject<number | null>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  tabLockIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  activeChatIdRef: MutableRefObject<string>;
  queuedFollowUpsRef: MutableRefObject<Record<string, QueuedFollowUp[]>>;
}

export interface FinalizeRunSessionCallbacks {
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  updateAgentStatus: (status: AgentStatus, opts?: { chatId?: string }) => void;
  clearPendingSteer: (chatId: string) => boolean;
  dequeueQueuedFollowUp: (chatId: string) => QueuedFollowUp | null;
  clearQueuedFollowUps: (chatId: string) => void;
}

export interface FinalizeRunSessionResult {
  /** Set when the same chat is still active and the queue produced a
   *  follow-up to dispatch. Caller is responsible for the
   *  `isMountedRef`-gated `queueMicrotask` re-entry into `sendMessage`
   *  — keeping that out of the helper avoids passing `sendMessage`
   *  back into itself via callbacks. */
  nextFollowUp: QueuedFollowUp | null;
}

/**
 * End-of-run cleanup for a `sendMessage` call. Runs in the `finally`
 * block of the round loop and handles every side effect that needs to
 * happen regardless of whether the loop completed normally, aborted,
 * or threw.
 */
export function finalizeRunSession(
  args: FinalizeRunSessionArgs,
  refs: FinalizeRunSessionRefs,
  callbacks: FinalizeRunSessionCallbacks,
): FinalizeRunSessionResult {
  const { chatId, loopCompletedNormally } = args;

  // Capture tab lock id before the terminal event clears it.
  const tabLockToRelease = refs.runEngineStateRef.current.tabLockId;

  const currentRunPhase = refs.runEngineStateRef.current.phase;
  const runAlreadyTerminal =
    currentRunPhase === 'completed' ||
    currentRunPhase === 'aborted' ||
    currentRunPhase === 'failed';
  if (!runAlreadyTerminal) {
    callbacks.emitRunEngineEvent({
      type: loopCompletedNormally ? 'LOOP_COMPLETED' : 'LOOP_ABORTED',
      timestamp: Date.now(),
    });
  }

  callbacks.setIsStreaming(false);
  if (refs.cancelStatusTimerRef.current === null) {
    callbacks.updateAgentStatus({ active: false, phase: '' });
  }
  refs.abortControllerRef.current = null;

  if (loopCompletedNormally) {
    clearRunCheckpoint(chatId);
  }

  releaseRunTabLock(chatId, tabLockToRelease);
  if (refs.tabLockIntervalRef.current) {
    clearInterval(refs.tabLockIntervalRef.current);
    refs.tabLockIntervalRef.current = null;
  }

  // Branch on whether the user navigated away from the chat that just
  // finished. If they did, drain the queue for that chat; if they
  // stayed, dequeue the next follow-up and let the caller dispatch it.
  if (refs.activeChatIdRef.current !== chatId) {
    if (callbacks.clearPendingSteer(chatId)) {
      callbacks.emitRunEngineEvent({ type: 'STEER_CLEARED', timestamp: Date.now() });
    }
    const hadQueuedFollowUps = (refs.queuedFollowUpsRef.current[chatId]?.length ?? 0) > 0;
    callbacks.clearQueuedFollowUps(chatId);
    if (hadQueuedFollowUps) {
      callbacks.emitRunEngineEvent({ type: 'FOLLOW_UP_QUEUE_CLEARED', timestamp: Date.now() });
    }
    return { nextFollowUp: null };
  }

  if (callbacks.clearPendingSteer(chatId)) {
    callbacks.emitRunEngineEvent({ type: 'STEER_CLEARED', timestamp: Date.now() });
  }
  const nextQueuedFollowUp = callbacks.dequeueQueuedFollowUp(chatId);
  if (nextQueuedFollowUp) {
    callbacks.emitRunEngineEvent({ type: 'FOLLOW_UP_DEQUEUED', timestamp: Date.now() });
  }
  return { nextFollowUp: nextQueuedFollowUp };
}

// Re-export Conversation as a convenience for callers that already
// import the types we use; lets a future co-extracted helper add to
// this surface without forcing useChat.ts to add another import.
export type { Conversation };
