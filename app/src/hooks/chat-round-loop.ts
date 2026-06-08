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
import { getVibeVerb } from '@/lib/repo-vibe-verbs';
import { getRepoMetadata } from '@/lib/repo-metadata';
import { getSandboxEnvironment } from '@/lib/sandbox-client';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { markJournalCheckpoint, type RunJournalEntry } from '@/lib/run-journal';
import { summarizeQueuedInputPreview } from '@/lib/queued-follow-up-utils';
import {
  createMutationFailureTracker,
  type MutationFailureTracker,
} from '@push/lib/agent-loop-utils';
import {
  createSimilarityLoopDetector,
  type SimilarityLoopDetector,
} from '@push/lib/loop-detection';
import { createId } from '@push/lib/id-utils';
import { type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ChatMessage, ReasoningBlock, RunEventInput } from '@/types';
import {
  createLoopLadderState,
  type LoopLadderState,
  processAssistantTurn,
  streamAssistantRound,
  type SendLoopContext,
} from './chat-send';
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
  draftAssistant: {
    accumulated: string;
    thinkingAccumulated: string;
    reasoningBlocks: ReasoningBlock[];
  } | null;
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
    const { accumulated, thinkingAccumulated, reasoningBlocks } = draftAssistant;
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
            reasoningBlocks: reasoningBlocks.length > 0 ? reasoningBlocks : undefined,
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
              ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
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

/**
 * Finalize a partial assistant message after abort.
 *
 * `chat-stream-round.ts` writes accumulator tokens into the last
 * assistant message as they arrive. When abort fires mid-stream, the
 * function just returns — the message stays with whatever partial
 * content + `status: 'streaming'` it had at the cancel point. Without
 * finalization, two things go wrong:
 *
 *   1. The UI shows a "still streaming" spinner forever for that
 *      message because status never transitions to a terminal value.
 *   2. On the next send, `toLLMMessages` rebuilds the wire history
 *      from `conversation.messages` and the partial assistant turn
 *      (possibly a half-emitted tool call) rides forward as
 *      assistant context. Cancellation invariant: "nothing partial
 *      reaches history" — see Hermes #6 follow-up.
 *
 * Fix: flip `status` to 'done' so the UI treats it terminal, and
 * set `visibleToModel: false` so the existing `filterVisibleStage`
 * in `lib/context-transformer.ts` drops it from the wire prefix.
 * The message stays in the UI (the user can see what the model was
 * starting to say before they hit Stop), but it never crosses the
 * LLM boundary again.
 *
 * Idempotent on conversation shape: bails when the last message
 * isn't a streaming assistant turn, so spurious post-abort calls or
 * already-finalized messages are safe.
 */
function markPartialAssistantInvisibleOnAbort(loopCtx: SendLoopContext): void {
  const { chatId } = loopCtx;
  loopCtx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = [...conv.messages];
    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx];
    if (!last || last.role !== 'assistant' || last.status !== 'streaming') return prev;
    msgs[lastIdx] = {
      ...last,
      status: 'done',
      visibleToModel: false,
    };
    loopCtx.dirtyConversationIdsRef.current.add(chatId);
    return { ...prev, [chatId]: { ...conv, messages: msgs } };
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
  outerLoopCtx: SendLoopContext,
  initial: RunRoundLoopInitial,
  deps: RunRoundLoopDeps,
): Promise<RunRoundLoopResult> {
  const { chatId, abortRef } = outerLoopCtx;
  const { runJournalEntryRef, persistRunJournal, dequeuePendingSteer, pendingSteersByChatRef } =
    deps;

  let apiMessages = initial.apiMessages;
  let toolCallRecoveryState = initial.recoveryState;
  const tracker: MutationFailureTracker = createMutationFailureTracker();
  // One near-duplicate detector per run, threaded alongside the tracker so its
  // per-path window survives across rounds. Feeds the shared loop-detection
  // oracle in `checkLoopBreaker`.
  const loopDetector: SimilarityLoopDetector = createSimilarityLoopDetector();
  // Run-level escalation state for the near-duplicate ladder (block → compact →
  // abort across turns). Threaded into `processAssistantTurn` → `checkLoopBreaker`
  // alongside the detector so its counters survive the round loop.
  const loopLadder: LoopLadderState = createLoopLadderState();
  let loopCompletedNormally = false;

  // Track events fired during the current round so the workspace-patch
  // capture seam can read them (looking for `subagent.completed` with
  // `agent: 'coder'` today; future tools can switch to a precise
  // mutation flag). Resets at the top of each iteration.
  let roundEvents: RunEventInput[] = [];
  const loopCtx: SendLoopContext = {
    ...outerLoopCtx,
    appendRunEvent: (cid, event) => {
      roundEvents.push(event);
      outerLoopCtx.appendRunEvent(cid, event);
    },
  };

  const findLatestToolCallMessageId = (): string | null => {
    const messages = outerLoopCtx.conversationsRef.current[chatId]?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.isToolCall) return m.id;
    }
    return null;
  };

  const fireWorkspacePatchCapture = (
    round: number,
    outcome: 'continued' | 'completed' | 'aborted' | 'error' | 'steered',
  ): void => {
    const capture = outerLoopCtx.captureWorkspacePatchAtRoundEnd;
    if (!capture) return;
    // Snapshot the target message id synchronously — capture itself is
    // fire-and-forget, so re-scanning at resolve time would let a later
    // round's tool-call message hijack attribution.
    const assistantToolCallMessageId = findLatestToolCallMessageId();
    void capture({
      chatId,
      round,
      outcome,
      roundEvents: [...roundEvents],
      assistantToolCallMessageId,
    }).catch(() => {
      // Hook owns its own error logging (console.debug). Swallow here
      // so a throwing capture never breaks the round loop.
    });
  };

  for (let round = 0; ; round++) {
    roundEvents = [];
    if (abortRef.current) break;
    fileLedger.advanceRound();

    loopCtx.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: Date.now(), round });
    loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_start', round });

    if (round > 0) appendStreamingAssistantDraft(loopCtx);

    let phase = 'Responding...';
    if (round === 0) {
      // Drive the thinking verb off real repo signals: GitHub topics state the
      // domain, the sandbox's boot-time manifest probe tells us the language,
      // and the name is the fallback for both. Both reads are synchronous cache
      // lookups (null when the repo list or sandbox hasn't populated yet, in
      // which case the classifier degrades to the name alone).
      const sandboxEnv = getSandboxEnvironment(loopCtx.sandboxIdRef.current ?? undefined);
      const repoMeta = getRepoMetadata(loopCtx.repoRef.current);
      phase = getVibeVerb({
        fullName: loopCtx.repoRef.current,
        topics: repoMeta?.topics ?? null,
        projectMarkers: sandboxEnv?.project_markers ?? null,
        language: repoMeta?.language ?? null,
      });
    }

    loopCtx.updateAgentStatus({ active: true, phase }, { chatId });

    const { accumulated, thinkingAccumulated, reasoningBlocks, error } = await streamAssistantRound(
      round,
      apiMessages,
      loopCtx,
    );

    if (abortRef.current) {
      markPartialAssistantInvisibleOnAbort(loopCtx);
      loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'aborted' });
      fireWorkspacePatchCapture(round, 'aborted');
      break;
    }

    if (error) {
      loopCtx.emitRunEngineEvent({
        type: 'LOOP_FAILED',
        timestamp: Date.now(),
        reason: error.message,
      });
      loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'error' });
      fireWorkspacePatchCapture(round, 'error');
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
      {
        round,
        apiMessages,
        draftAssistant: { accumulated, thinkingAccumulated, reasoningBlocks },
      },
      { loopCtx, dequeuePendingSteer, pendingSteersByChatRef },
    );
    if (beforeToolsDrain.drained) {
      apiMessages = beforeToolsDrain.nextApiMessages;
      fireWorkspacePatchCapture(round, 'steered');
      continue;
    }

    loopCtx.emitRunEngineEvent({ type: 'TOOLS_STARTED', timestamp: Date.now() });
    loopCtx.flushCheckpoint();
    markJournalCheckpointIfPresent(runJournalEntryRef, persistRunJournal);

    const turnResult = await processAssistantTurn(
      round,
      accumulated,
      thinkingAccumulated,
      reasoningBlocks,
      apiMessages,
      loopCtx,
      toolCallRecoveryState,
      tracker,
      loopDetector,
      loopLadder,
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
      fireWorkspacePatchCapture(round, 'steered');
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
    fireWorkspacePatchCapture(round, turnOutcome);
    if (turnResult.loopAction === 'break') break;
    loopCtx.emitRunEngineEvent({ type: 'TURN_CONTINUED', timestamp: Date.now() });
  }

  return { loopCompletedNormally };
}
