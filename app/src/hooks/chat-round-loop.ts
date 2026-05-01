/**
 * chat-round-loop.ts
 *
 * Final-phase extraction from `useChat.ts`'s `sendMessage`. Owns the
 * round-loop body — every iteration of the assistant turn:
 *
 *   - emit ROUND_STARTED + assistant.turn_start
 *   - splice a fresh streaming assistant draft on rounds > 0
 *   - stream the LLM via streamAssistantRound (already extracted)
 *   - drain a pending steer if one arrived during streaming
 *   - emit TOOLS_STARTED + checkpoint, mark journal
 *   - process the assistant turn via processAssistantTurn (already extracted)
 *   - drain a pending steer if one arrived during tool dispatch
 *   - emit assistant.turn_end and decide continue/break
 *
 * Extraction rationale: the loop body was the largest remaining inline
 * block in useChat.ts (~235 lines, including a duplicated pending-steer
 * drain in two places). Pulling it out lets useChat hold only the
 * try/catch/finally bookend (LOOP_FAILED emission + finalizeRunSession +
 * nextFollowUp scheduling, which depends on `sendMessage` itself), and
 * makes the loop's control flow testable against a fake SendLoopContext.
 *
 * The function throws on unexpected errors so the caller's catch can
 * emit LOOP_FAILED with the thrown reason. Stream errors (the
 * StreamRoundResult.error path) are handled inline because they break
 * out of the loop after writing an error message into the conversation,
 * not by throwing.
 */

import type { MutableRefObject } from 'react';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { markJournalCheckpoint, type RunJournalEntry } from '@/lib/run-journal';
import { summarizeQueuedInputPreview } from '@/lib/queued-follow-up-utils';
import {
  createMutationFailureTracker,
  type MutationFailureTracker,
} from '@push/lib/agent-loop-utils';
import { createId } from '@push/lib/id-utils';
import { type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ChatMessage } from '@/types';
import { processAssistantTurn, streamAssistantRound, type SendLoopContext } from './chat-send';
import { buildRuntimeUserMessage } from './chat-prepare-send';
import type { PendingSteersByChat } from './usePendingSteer';

export interface RunRoundLoopDeps {
  runJournalEntryRef: MutableRefObject<RunJournalEntry | null>;
  persistRunJournal: (entry: RunJournalEntry | null, options?: { prune?: boolean }) => void;
  dequeuePendingSteer: (chatId: string) => import('@/types').PendingSteerRequest | null;
  pendingSteersByChatRef: MutableRefObject<PendingSteersByChat>;
}

export interface RunRoundLoopInitial {
  apiMessages: ChatMessage[];
  recoveryState: ToolCallRecoveryState;
}

export interface RunRoundLoopResult {
  loopCompletedNormally: boolean;
}

interface SteerDrainArgs {
  round: number;
  apiMessages: ChatMessage[];
  /** When provided, the assistant draft is preserved-or-popped; when null, the steer is appended after a completed turn. */
  draftAssistant: { accumulated: string; thinkingAccumulated: string } | null;
}

interface SteerDrainDeps {
  loopCtx: SendLoopContext;
  dequeuePendingSteer: RunRoundLoopDeps['dequeuePendingSteer'];
  pendingSteersByChatRef: MutableRefObject<PendingSteersByChat>;
}

type SteerDrainResult = { drained: false } | { drained: true; nextApiMessages: ChatMessage[] };

function drainPendingSteerIfAny(args: SteerDrainArgs, deps: SteerDrainDeps): SteerDrainResult {
  const { round, apiMessages, draftAssistant } = args;
  const { loopCtx, dequeuePendingSteer, pendingSteersByChatRef } = deps;
  const { chatId } = loopCtx;

  const pending = dequeuePendingSteer(chatId);
  if (!pending) return { drained: false };

  // FIFO drain: the engine's hasPendingSteer flag tracks "is anything
  // queued?", not "did we just consume one?". After the dequeue we either
  // have a new head (re-arm with STEER_SET so the preview matches) or an
  // empty queue (STEER_CONSUMED).
  const remainingHead = pendingSteersByChatRef.current[chatId]?.[0];
  if (remainingHead) {
    loopCtx.emitRunEngineEvent({
      type: 'STEER_SET',
      timestamp: Date.now(),
      preview: summarizeQueuedInputPreview(
        remainingHead.text,
        remainingHead.attachments,
        remainingHead.options?.displayText,
      ),
    });
  } else {
    loopCtx.emitRunEngineEvent({ type: 'STEER_CONSUMED', timestamp: Date.now() });
  }

  const steerUserMessage = buildRuntimeUserMessage(
    pending.text,
    pending.attachments,
    pending.options?.displayText,
  );

  let nextApiMessages: ChatMessage[];

  if (draftAssistant) {
    const { accumulated, thinkingAccumulated } = draftAssistant;
    const shouldKeepAssistantDraft = accumulated.trim().length > 0;

    loopCtx.setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      const lastIdx = msgs.length - 1;
      if (msgs[lastIdx]?.role === 'assistant') {
        if (shouldKeepAssistantDraft) {
          msgs[lastIdx] = {
            ...msgs[lastIdx],
            content: accumulated,
            thinking: thinkingAccumulated || undefined,
            status: 'done',
          };
        } else {
          msgs.pop();
        }
      }
      const updated = {
        ...prev,
        [chatId]: {
          ...conv,
          messages: [...msgs, steerUserMessage],
          lastMessageAt: Date.now(),
        },
      };
      loopCtx.dirtyConversationIdsRef.current.add(chatId);
      return updated;
    });

    nextApiMessages = [
      ...apiMessages,
      ...(shouldKeepAssistantDraft
        ? [
            {
              id: createId(),
              role: 'assistant' as const,
              content: accumulated,
              timestamp: Date.now(),
              status: 'done' as const,
            },
          ]
        : []),
      steerUserMessage,
    ];
  } else {
    loopCtx.setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const updated = {
        ...prev,
        [chatId]: {
          ...conv,
          messages: [...conv.messages, steerUserMessage],
          lastMessageAt: Date.now(),
        },
      };
      loopCtx.dirtyConversationIdsRef.current.add(chatId);
      return updated;
    });
    nextApiMessages = [...apiMessages, steerUserMessage];
  }

  loopCtx.checkpointRefs.apiMessages.current = nextApiMessages;
  loopCtx.flushCheckpoint();
  loopCtx.emitRunEngineEvent({ type: 'TURN_STEERED', timestamp: Date.now() });
  loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'steered' });

  return { drained: true, nextApiMessages };
}

function appendStreamingAssistantDraft(loopCtx: SendLoopContext): void {
  const { chatId } = loopCtx;
  const newAssistant: ChatMessage = {
    id: createId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: 'streaming',
  };
  loopCtx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    return { ...prev, [chatId]: { ...conv, messages: [...conv.messages, newAssistant] } };
  });
}

function applyStreamErrorToConversation(loopCtx: SendLoopContext, errorMessage: string): void {
  const { chatId } = loopCtx;
  loopCtx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = [...conv.messages];
    const lastIdx = msgs.length - 1;
    if (msgs[lastIdx]?.role === 'assistant') {
      msgs[lastIdx] = {
        ...msgs[lastIdx],
        content: `Something went wrong: ${errorMessage}`,
        status: 'error',
      };
    }
    const updated = { ...prev, [chatId]: { ...conv, messages: msgs } };
    loopCtx.dirtyConversationIdsRef.current.add(chatId);
    return updated;
  });
}

function markJournalCheckpointIfPresent(
  runJournalEntryRef: MutableRefObject<RunJournalEntry | null>,
  persistRunJournal: RunRoundLoopDeps['persistRunJournal'],
): void {
  if (runJournalEntryRef.current) {
    runJournalEntryRef.current = markJournalCheckpoint(runJournalEntryRef.current, true);
    persistRunJournal(runJournalEntryRef.current);
  }
}

export async function runRoundLoop(
  loopCtx: SendLoopContext,
  initial: RunRoundLoopInitial,
  deps: RunRoundLoopDeps,
): Promise<RunRoundLoopResult> {
  const { chatId, abortRef } = loopCtx;
  const { runJournalEntryRef, persistRunJournal, dequeuePendingSteer, pendingSteersByChatRef } =
    deps;

  let apiMessages = initial.apiMessages;
  let toolCallRecoveryState = initial.recoveryState;
  const tracker: MutationFailureTracker = createMutationFailureTracker();
  let loopCompletedNormally = false;

  for (let round = 0; ; round++) {
    if (abortRef.current) break;
    fileLedger.advanceRound();

    loopCtx.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: Date.now(), round });
    loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_start', round });

    if (round > 0) appendStreamingAssistantDraft(loopCtx);

    loopCtx.updateAgentStatus(
      { active: true, phase: round === 0 ? 'Thinking...' : 'Responding...' },
      { chatId },
    );

    const { accumulated, thinkingAccumulated, error } = await streamAssistantRound(
      round,
      apiMessages,
      loopCtx,
    );

    if (abortRef.current) {
      loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'aborted' });
      break;
    }

    if (error) {
      loopCtx.emitRunEngineEvent({
        type: 'LOOP_FAILED',
        timestamp: Date.now(),
        reason: error.message,
      });
      loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'error' });
      applyStreamErrorToConversation(loopCtx, error.message);
      break;
    }

    loopCtx.emitRunEngineEvent({
      type: 'STREAMING_COMPLETED',
      timestamp: Date.now(),
      accumulated,
      thinking: thinkingAccumulated,
    });

    const beforeToolsDrain = drainPendingSteerIfAny(
      { round, apiMessages, draftAssistant: { accumulated, thinkingAccumulated } },
      { loopCtx, dequeuePendingSteer, pendingSteersByChatRef },
    );
    if (beforeToolsDrain.drained) {
      apiMessages = beforeToolsDrain.nextApiMessages;
      continue;
    }

    loopCtx.emitRunEngineEvent({ type: 'TOOLS_STARTED', timestamp: Date.now() });
    loopCtx.flushCheckpoint();
    markJournalCheckpointIfPresent(runJournalEntryRef, persistRunJournal);

    const turnResult = await processAssistantTurn(
      round,
      accumulated,
      thinkingAccumulated,
      apiMessages,
      loopCtx,
      toolCallRecoveryState,
      tracker,
    );

    apiMessages = turnResult.nextApiMessages;
    toolCallRecoveryState = turnResult.nextRecoveryState;
    loopCtx.checkpointRefs.apiMessages.current = apiMessages;

    const afterTurnDrain = drainPendingSteerIfAny(
      { round, apiMessages, draftAssistant: null },
      { loopCtx, dequeuePendingSteer, pendingSteersByChatRef },
    );
    if (afterTurnDrain.drained) {
      apiMessages = afterTurnDrain.nextApiMessages;
      continue;
    }

    const turnOutcome =
      turnResult.loopAction === 'continue'
        ? 'continued'
        : turnResult.loopCompletedNormally
          ? 'completed'
          : 'aborted';
    if (turnResult.loopCompletedNormally) loopCompletedNormally = true;
    loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: turnOutcome });
    if (turnResult.loopAction === 'break') break;
    loopCtx.emitRunEngineEvent({ type: 'TURN_CONTINUED', timestamp: Date.now() });
  }

  return { loopCompletedNormally };
}
