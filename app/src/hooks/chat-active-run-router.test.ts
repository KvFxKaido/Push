import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_RUN_STATE, type RunEngineState } from '@/lib/run-engine';
import type { PendingSteerRequest, QueuedFollowUp, RunEventInput } from '@/types';
import {
  routeActiveRunInput,
  type ActiveRunRouterContext,
  type ActiveRunRouterInput,
} from './chat-active-run-router';

// Minimal RunEngineState builder. The router only reads `chatId`, `round`,
// and the phase fields that isRunActive() inspects — so a full runtime
// shape isn't needed.
function activeRunState(overrides: Partial<RunEngineState> = {}): RunEngineState {
  return {
    ...IDLE_RUN_STATE,
    runId: 'run-1',
    chatId: 'chat-1',
    round: 3,
    phase: 'starting',
    ...overrides,
  };
}

interface Captured {
  steers: Array<{ chatId: string; req: PendingSteerRequest }>;
  follows: Array<{ chatId: string; fu: QueuedFollowUp }>;
  engineEvents: Parameters<ActiveRunRouterContext['emitRunEngineEvent']>[0][];
  runEvents: Array<{ chatId: string; event: RunEventInput }>;
}

interface HarnessOverrides {
  runState?: RunEngineState;
  activeChatId?: string;
  queue?: Record<string, QueuedFollowUp[]>;
}

function makeContext(overrides: HarnessOverrides = {}): {
  ctx: ActiveRunRouterContext;
  captured: Captured;
} {
  const captured: Captured = {
    steers: [],
    follows: [],
    engineEvents: [],
    runEvents: [],
  };
  const ctx: ActiveRunRouterContext = {
    runEngineStateRef: {
      current: overrides.runState ?? IDLE_RUN_STATE,
    } as React.MutableRefObject<RunEngineState>,
    activeChatIdRef: {
      current: overrides.activeChatId ?? '',
    } as React.MutableRefObject<string>,
    queuedFollowUpsRef: {
      current: overrides.queue ?? {},
    } as React.MutableRefObject<Record<string, QueuedFollowUp[]>>,
    enqueuePendingSteer: (chatId, req) => captured.steers.push({ chatId, req }),
    enqueueQueuedFollowUp: (chatId, fu) => captured.follows.push({ chatId, fu }),
    emitRunEngineEvent: (event) => captured.engineEvents.push(event),
    appendRunEvent: (chatId, event) => captured.runEvents.push({ chatId, event }),
  };
  return { ctx, captured };
}

function makeInput(overrides: Partial<ActiveRunRouterInput> = {}): ActiveRunRouterInput {
  return {
    trimmedText: 'hello',
    attachments: undefined,
    hasAttachments: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('routeActiveRunInput', () => {
  it('returns handled:false when no run is active so the caller falls through to a fresh turn', () => {
    const { ctx, captured } = makeContext();
    const result = routeActiveRunInput(makeInput(), ctx);

    expect(result.handled).toBe(false);
    expect(captured.steers).toHaveLength(0);
    expect(captured.follows).toHaveLength(0);
    expect(captured.engineEvents).toHaveLength(0);
    expect(captured.runEvents).toHaveLength(0);
  });

  it('drops the input silently when target chat differs from the running chat', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-running' }),
      activeChatId: 'chat-other',
    });
    const result = routeActiveRunInput(makeInput(), ctx);

    expect(result.handled).toBe(true);
    expect(captured.follows).toHaveLength(0);
    expect(captured.engineEvents).toHaveLength(0);
  });

  it('drops the input when the active run has no chatId', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: '' }),
      activeChatId: 'chat-1',
    });
    const result = routeActiveRunInput(makeInput(), ctx);

    expect(result.handled).toBe(true);
    expect(captured.follows).toHaveLength(0);
  });

  it('queues a follow-up when run is active, target matches, and streamingBehavior is omitted', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-1', round: 5 }),
      activeChatId: 'chat-1',
    });
    const result = routeActiveRunInput(
      makeInput({ trimmedText: 'follow up', options: { displayText: 'Follow Up Display' } }),
      ctx,
    );

    expect(result.handled).toBe(true);
    expect(captured.follows).toHaveLength(1);
    expect(captured.follows[0]).toMatchObject({
      chatId: 'chat-1',
      fu: {
        text: 'follow up',
        options: { displayText: 'Follow Up Display' },
      },
    });
    expect(captured.engineEvents[0]).toMatchObject({ type: 'FOLLOW_UP_ENQUEUED' });
    expect(captured.runEvents[0]).toMatchObject({
      chatId: 'chat-1',
      event: {
        type: 'user.follow_up_queued',
        round: 5,
        position: 1,
        preview: 'Follow Up Display',
      },
    });
  });

  it('appends to existing queue with correct position rather than replacing', () => {
    const existing: QueuedFollowUp[] = [
      { text: 'a', queuedAt: 1 },
      { text: 'b', queuedAt: 2 },
    ];
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-1' }),
      activeChatId: 'chat-1',
      queue: { 'chat-1': existing },
    });
    routeActiveRunInput(makeInput({ trimmedText: 'c' }), ctx);

    expect(captured.runEvents[0].event).toMatchObject({
      type: 'user.follow_up_queued',
      position: 3,
    });
  });

  it('routes a steer request when streamingBehavior is "steer"', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-1', round: 2 }),
      activeChatId: 'chat-1',
    });
    routeActiveRunInput(
      makeInput({
        trimmedText: 'redirect',
        options: { streamingBehavior: 'steer' },
      }),
      ctx,
    );

    expect(captured.steers).toHaveLength(1);
    expect(captured.steers[0]).toMatchObject({
      chatId: 'chat-1',
      req: { text: 'redirect' },
    });
    expect(captured.follows).toHaveLength(0);
    expect(captured.engineEvents[0]).toMatchObject({ type: 'STEER_SET' });
    expect(captured.runEvents[0].event).toMatchObject({
      type: 'user.follow_up_steered',
      round: 2,
      replacedPending: false,
    });
  });

  it('honors options.chatId over activeChatIdRef when resolving the target chat', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-1' }),
      activeChatId: 'chat-other',
    });
    const result = routeActiveRunInput(makeInput({ options: { chatId: 'chat-1' } }), ctx);

    expect(result.handled).toBe(true);
    expect(captured.follows).toHaveLength(1);
    expect(captured.follows[0].chatId).toBe('chat-1');
  });

  it('falls back to runningChatId when neither options.chatId nor activeChatIdRef is set', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-running' }),
      activeChatId: '',
    });
    const result = routeActiveRunInput(makeInput(), ctx);

    expect(result.handled).toBe(true);
    expect(captured.follows[0]?.chatId).toBe('chat-running');
  });

  it('passes attachments through only when hasAttachments is true', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-1' }),
      activeChatId: 'chat-1',
    });
    const attachments = [
      {
        id: 'att-1',
        type: 'image' as const,
        filename: 'pic.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        content: 'data:image/png;base64,AA',
      },
    ];

    routeActiveRunInput(makeInput({ attachments, hasAttachments: false }), ctx);
    expect(captured.follows[0].fu.attachments).toBeUndefined();

    captured.follows.length = 0;
    routeActiveRunInput(makeInput({ attachments, hasAttachments: true }), ctx);
    expect(captured.follows[0].fu.attachments).toEqual(attachments);
  });

  it('truncates the preview using summarizeQueuedInputPreview', () => {
    const { ctx, captured } = makeContext({
      runState: activeRunState({ chatId: 'chat-1' }),
      activeChatId: 'chat-1',
    });
    const longText = 'x'.repeat(200);

    routeActiveRunInput(makeInput({ trimmedText: longText }), ctx);

    const preview = (
      captured.runEvents[0].event as Extract<RunEventInput, { type: 'user.follow_up_queued' }>
    ).preview;
    expect(preview.length).toBeLessThanOrEqual(96);
    expect(preview.endsWith('...')).toBe(true);
  });
});
