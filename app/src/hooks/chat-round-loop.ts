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
import { getVibeVerbs } from '@/lib/repo-vibe-verbs';
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
import type { ResponsesReasoningItem } from '@push/lib/provider-contract';
import { resolveMessageWriteBranch } from '@/lib/chat-message';
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
    responsesReasoningItems: ResponsesReasoningItem[];
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
  const currentWriteBranch = resolveMessageWriteBranch(
    loopCtx.branchInfoRef.current,
    loopCtx.conversationsRef.current[chatId]?.branch,
  );

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
    currentWriteBranch,
  );

  let nextApiMessages: ChatMessage[];

  if (draftAssistant) {
    const { accumulated, thinkingAccumulated, reasoningBlocks, responsesReasoningItems } =
      draftAssistant;
    const shouldKeepAssistantDraft =
      accumulated.trim().length > 0 || responsesReasoningItems.length > 0;

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
            responsesReasoningItems:
              responsesReasoningItems.length > 0 ? responsesReasoningItems : undefined,
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
              ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
              ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
              ...(responsesReasoningItems.length > 0
                ? { responsesReasoningItems: [...responsesReasoningItems] }
                : {}),
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
  loopCtx.flushCheckpoint('turn');
  loopCtx.emitRunEngineEvent({ type: 'TURN_STEERED', timestamp: Date.now() });
  loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'steered' });

  return { drained: true, nextApiMessages };
}

function appendStreamingAssistantDraft(loopCtx: SendLoopContext): void {
  const { chatId } = loopCtx;
  const currentWriteBranch = resolveMessageWriteBranch(
    loopCtx.branchInfoRef.current,
    loopCtx.conversationsRef.current[chatId]?.branch,
  );
  const newAssistant: ChatMessage = {
    id: createId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: 'streaming',
    ...(currentWriteBranch !== undefined ? { branch: currentWriteBranch } : {}),
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

  // Vibe-verb pool for the spinner — repo-derived and stable for the turn, so
  // resolve once and rotate it through BOTH openings: the thinking dead air
  // (round 0) and the responding stream (later rounds + streamAssistantRound's
  // per-token updates). Synchronous cache lookups (null when the repo list /
  // sandbox haven't populated; the classifier degrades to the name alone).
  const sandboxEnv = getSandboxEnvironment(loopCtx.sandboxIdRef.current ?? undefined);
  const repoMeta = getRepoMetadata(loopCtx.repoRef.current);
  const vibeVerbs = getVibeVerbs({
    fullName: loopCtx.repoRef.current,
    topics: repoMeta?.topics ?? null,
    projectMarkers: sandboxEnv?.project_markers ?? null,
    language: repoMeta?.language ?? null,
  });

  for (let round = 0; ; round++) {
    roundEvents = [];
    // Wall-clock for this round, so a failure can be attributed: a stream that
    // dies at ~120s during 'Responding...'/'Thinking…' with no tool calls is an
    // LLM request / round wall-clock timeout (worker-side 120s), NOT the sandbox
    // container (which only sleeps after 1h). Logged on the error path below.
    const roundStartedAt = Date.now();
    if (abortRef.current) break;
    fileLedger.advanceRound();

    loopCtx.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: Date.now(), round });
    loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_start', round });

    if (round > 0) appendStreamingAssistantDraft(loopCtx);

    // Round 0 is pre-response dead air ("Thinking…"); later rounds stream the
    // answer ("Responding..."). The vibe verbs rotate through both openings —
    // `phase` is the static event-log fallback the bar shows when not rotating.
    const phase = round === 0 ? 'Thinking…' : 'Responding...';
    loopCtx.updateAgentStatus({ active: true, phase, verbs: vibeVerbs }, { chatId });

    const {
      accumulated,
      thinkingAccumulated,
      reasoningBlocks,
      responsesReasoningItems = [],
      nativeToolCalls,
      error,
    } = await streamAssistantRound(round, apiMessages, loopCtx, vibeVerbs);

    if (abortRef.current) {
      markPartialAssistantInvisibleOnAbort(loopCtx);
      loopCtx.appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'aborted' });
      fireWorkspacePatchCapture(round, 'aborted');
      break;
    }

    if (error) {
      // Diagnostic for the "killed after ~2 min of no edits" report. This fires
      // on the client (→ device logcat via Capacitor/Console), capturing the one
      // bit that splits the causes: `elapsedMs` near 120000 + UNCHANGED `sandboxId`
      // ⇒ an LLM request / round wall-clock timeout (the turn died, the container
      // is fine). A `reason` mentioning NOT_FOUND / a null-or-changed `sandboxId`
      // ⇒ real container loss. Anything else is a genuine stream error.
      // `streamedChars` is the honest "was it past dead-air" signal: `phase` is
      // only the round's OPENING label (round 0 shows 'Thinking…' even if the
      // stream had moved to responding), so a non-zero `streamedChars` at ~120s
      // means it died mid-generation regardless of the static phase.
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'round_stream_failed',
          chatId,
          round,
          phase,
          streamedChars: (accumulated?.length ?? 0) + (thinkingAccumulated?.length ?? 0),
          elapsedMs: Date.now() - roundStartedAt,
          sandboxId: loopCtx.sandboxIdRef.current ?? null,
          reason: error.message?.slice(0, 200),
        }),
      );
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
        draftAssistant: {
          accumulated,
          thinkingAccumulated,
          reasoningBlocks,
          responsesReasoningItems,
        },
      },
      { loopCtx, dequeuePendingSteer, pendingSteersByChatRef },
    );
    if (beforeToolsDrain.drained) {
      apiMessages = beforeToolsDrain.nextApiMessages;
      fireWorkspacePatchCapture(round, 'steered');
      continue;
    }

    loopCtx.emitRunEngineEvent({ type: 'TOOLS_STARTED', timestamp: Date.now() });
    // 'turn': the streamed assistant turn is in the transcript and tools are
    // about to run — the adoption-grade capture point. If the client dies
    // during tool execution, an adopted run resumes by re-running the batch.
    loopCtx.flushCheckpoint('turn');
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
      nativeToolCalls,
      responsesReasoningItems,
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
    // Turn boundary, continuing rounds only: tool results are in the
    // transcript, so an adopted run restarts the next round without
    // re-running tools. Breaking turns skip the capture — the run is over
    // (finalize clears the checkpoint on normal completion), and the no-tool
    // completion path returns apiMessages WITHOUT the final assistant
    // answer, so a capture here would overwrite the record with a stale
    // transcript (Codex P2 on #874).
    loopCtx.flushCheckpoint('turn');
    loopCtx.emitRunEngineEvent({ type: 'TURN_CONTINUED', timestamp: Date.now() });
  }

  return { loopCompletedNormally };
}
