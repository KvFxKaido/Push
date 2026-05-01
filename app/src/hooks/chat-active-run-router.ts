import type React from 'react';
import { isRunActive, type RunEngineEvent, type RunEngineState } from '@/lib/run-engine';
import {
  summarizeQueuedInputPreview,
  toPendingSteerRequest,
  toQueuedFollowUp,
} from '@/lib/queued-follow-up-utils';
import type {
  AttachmentData,
  PendingSteerRequest,
  QueuedFollowUp,
  QueuedFollowUpOptions,
  RunEventInput,
} from '@/types';

// Subset of SendMessageOptions the router actually reads. Defined locally
// to avoid a circular import with useChat.ts (which exports the full
// SendMessageOptions type). Structurally compatible: any value typed as
// SendMessageOptions can be passed in without coercion.
export type ActiveRunRouterOptions = Partial<QueuedFollowUpOptions> & {
  chatId?: string;
  streamingBehavior?: 'queue' | 'steer';
};

export interface ActiveRunRouterInput {
  trimmedText: string;
  attachments: AttachmentData[] | undefined;
  hasAttachments: boolean;
  options?: ActiveRunRouterOptions;
}

export interface ActiveRunRouterContext {
  runEngineStateRef: React.MutableRefObject<RunEngineState>;
  activeChatIdRef: React.MutableRefObject<string>;
  queuedFollowUpsRef: React.MutableRefObject<Record<string, QueuedFollowUp[]>>;
  enqueuePendingSteer: (chatId: string, req: PendingSteerRequest) => void;
  enqueueQueuedFollowUp: (chatId: string, fu: QueuedFollowUp) => void;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
}

export interface ActiveRunRouterResult {
  handled: boolean;
}

// Routes user input that arrives while a run is in flight. Three outcomes,
// all discriminated by `handled`:
//   1. No active run            → handled: false (caller proceeds with fresh-turn flow)
//   2. Active run, target chat mismatches → handled: true, dropped silently
//   3. Active run, target matches         → handled: true, enqueued or steered
//
// FIFO is the contract for queued follow-ups; steer requests are also
// appended (never replace), so the `replacedPending` field on the run-event
// surface is always false — kept for backward-compatibility with downstream
// consumers (HubConsoleTab, run journal, tests).
export function routeActiveRunInput(
  input: ActiveRunRouterInput,
  ctx: ActiveRunRouterContext,
): ActiveRunRouterResult {
  if (!isRunActive(ctx.runEngineStateRef.current)) {
    return { handled: false };
  }

  const runningChatId = ctx.runEngineStateRef.current.chatId;
  const targetChatId = input.options?.chatId || ctx.activeChatIdRef.current || runningChatId;
  if (!runningChatId || (targetChatId && targetChatId !== runningChatId)) {
    return { handled: true };
  }

  const attachmentsForUtil = input.hasAttachments ? input.attachments : undefined;
  const inputPreview = summarizeQueuedInputPreview(
    input.trimmedText,
    attachmentsForUtil,
    input.options?.displayText,
  );
  const round = ctx.runEngineStateRef.current.round;

  if (input.options?.streamingBehavior === 'steer') {
    ctx.enqueuePendingSteer(
      runningChatId,
      toPendingSteerRequest(input.trimmedText, attachmentsForUtil, input.options),
    );
    ctx.emitRunEngineEvent({
      type: 'STEER_SET',
      timestamp: Date.now(),
      preview: inputPreview,
    });
    ctx.appendRunEvent(runningChatId, {
      type: 'user.follow_up_steered',
      round,
      preview: inputPreview,
      replacedPending: false,
    });
    return { handled: true };
  }

  const queuePosition = (ctx.queuedFollowUpsRef.current[runningChatId]?.length ?? 0) + 1;
  const queuedFollowUp = toQueuedFollowUp(input.trimmedText, attachmentsForUtil, input.options);
  ctx.enqueueQueuedFollowUp(runningChatId, queuedFollowUp);
  ctx.emitRunEngineEvent({
    type: 'FOLLOW_UP_ENQUEUED',
    timestamp: Date.now(),
    followUp: queuedFollowUp,
  });
  ctx.appendRunEvent(runningChatId, {
    type: 'user.follow_up_queued',
    round,
    position: queuePosition,
    preview: inputPreview,
  });
  return { handled: true };
}
