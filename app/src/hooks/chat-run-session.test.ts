import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { AgentStatus, QueuedFollowUp } from '@/types';
import {
  finalizeRunSession,
  type FinalizeRunSessionCallbacks,
  type FinalizeRunSessionRefs,
} from './chat-run-session';
import { type RunEngineEvent, type RunEngineState } from '@/lib/run-engine';

const { mockClearRunCheckpoint, mockReleaseRunTabLock } = vi.hoisted(() => ({
  mockClearRunCheckpoint: vi.fn(),
  mockReleaseRunTabLock: vi.fn(),
}));

vi.mock('@/lib/checkpoint-manager', () => ({
  clearRunCheckpoint: (...args: unknown[]) => mockClearRunCheckpoint(...args),
  releaseRunTabLock: (...args: unknown[]) => mockReleaseRunTabLock(...args),
}));

function makeRunState(overrides: Partial<RunEngineState> = {}): RunEngineState {
  return {
    phase: 'streaming_llm',
    chatId: 'chat-1',
    runId: 'run-1',
    round: 0,
    tabLockId: 'tab-1',
    abortToken: null,
    journal: [],
    ...overrides,
  } as RunEngineState;
}

interface CapturedState {
  emittedEvents: RunEngineEvent[];
  agentStatusCalls: Array<{ status: AgentStatus; opts?: { chatId?: string } }>;
  setIsStreamingCalls: boolean[];
  clearPendingSteerCalls: string[];
  clearQueuedFollowUpsCalls: string[];
  dequeueQueuedFollowUpCalls: string[];
}

function makeRefs(overrides: Partial<FinalizeRunSessionRefs> = {}): FinalizeRunSessionRefs {
  return {
    runEngineStateRef: { current: makeRunState() },
    cancelStatusTimerRef: { current: null },
    abortControllerRef: { current: new AbortController() },
    tabLockIntervalRef: { current: null },
    activeChatIdRef: { current: 'chat-1' },
    queuedFollowUpsRef: { current: {} },
    ...overrides,
  } as FinalizeRunSessionRefs;
}

function makeCallbacks(
  opts: { pendingSteerHits?: Set<string>; queuedFollowUps?: Record<string, QueuedFollowUp[]> } = {},
): FinalizeRunSessionCallbacks & CapturedState {
  const captured: CapturedState = {
    emittedEvents: [],
    agentStatusCalls: [],
    setIsStreamingCalls: [],
    clearPendingSteerCalls: [],
    clearQueuedFollowUpsCalls: [],
    dequeueQueuedFollowUpCalls: [],
  };
  const queues = opts.queuedFollowUps ?? {};
  const callbacks: FinalizeRunSessionCallbacks = {
    emitRunEngineEvent: (event) => {
      captured.emittedEvents.push(event);
    },
    setIsStreaming: (next) => {
      captured.setIsStreamingCalls.push(typeof next === 'function' ? next(false) : next);
    },
    updateAgentStatus: (status, opts) => {
      captured.agentStatusCalls.push({ status, opts });
    },
    clearPendingSteer: (chatId) => {
      captured.clearPendingSteerCalls.push(chatId);
      return opts.pendingSteerHits?.has(chatId) ?? false;
    },
    dequeueQueuedFollowUp: (chatId) => {
      captured.dequeueQueuedFollowUpCalls.push(chatId);
      const queue = queues[chatId];
      if (!queue || queue.length === 0) return null;
      return queue.shift() ?? null;
    },
    clearQueuedFollowUps: (chatId) => {
      captured.clearQueuedFollowUpsCalls.push(chatId);
      delete queues[chatId];
    },
  };
  return Object.assign(callbacks, captured);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('finalizeRunSession — terminal event', () => {
  it('emits LOOP_COMPLETED when the loop finished normally and the engine has not recorded a terminal phase', () => {
    const refs = makeRefs({
      runEngineStateRef: { current: makeRunState({ phase: 'streaming_llm' }) },
    });
    const callbacks = makeCallbacks();

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: true }, refs, callbacks);

    const terminal = callbacks.emittedEvents.find(
      (e) => e.type === 'LOOP_COMPLETED' || e.type === 'LOOP_ABORTED',
    );
    expect(terminal?.type).toBe('LOOP_COMPLETED');
  });

  it('emits LOOP_ABORTED when the loop did not complete normally', () => {
    const refs = makeRefs({
      runEngineStateRef: { current: makeRunState({ phase: 'streaming_llm' }) },
    });
    const callbacks = makeCallbacks();

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: false }, refs, callbacks);

    const terminal = callbacks.emittedEvents.find(
      (e) => e.type === 'LOOP_COMPLETED' || e.type === 'LOOP_ABORTED',
    );
    expect(terminal?.type).toBe('LOOP_ABORTED');
  });

  it('does not emit a duplicate terminal event when the engine is already in a terminal phase', () => {
    const refs = makeRefs({ runEngineStateRef: { current: makeRunState({ phase: 'completed' }) } });
    const callbacks = makeCallbacks();

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: true }, refs, callbacks);

    const terminal = callbacks.emittedEvents.find(
      (e) => e.type === 'LOOP_COMPLETED' || e.type === 'LOOP_ABORTED',
    );
    expect(terminal).toBeUndefined();
  });
});

describe('finalizeRunSession — cleanup side effects', () => {
  it('clears the streaming flag, agent status (when no cancel timer), abort controller, and tab lock', () => {
    const ctrl = new AbortController();
    const interval = setInterval(() => {}, 1_000);
    const refs = makeRefs({
      abortControllerRef: { current: ctrl } as MutableRefObject<AbortController | null>,
      tabLockIntervalRef: { current: interval },
    });
    const callbacks = makeCallbacks();

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: true }, refs, callbacks);

    expect(callbacks.setIsStreamingCalls).toEqual([false]);
    expect(callbacks.agentStatusCalls).toEqual([
      { status: { active: false, phase: '' }, opts: undefined },
    ]);
    expect(refs.abortControllerRef.current).toBeNull();
    expect(mockReleaseRunTabLock).toHaveBeenCalledWith('chat-1', 'tab-1');
    expect(refs.tabLockIntervalRef.current).toBeNull();
  });

  it('skips the agent-status reset when a cancel-status timer is pending', () => {
    const refs = makeRefs({ cancelStatusTimerRef: { current: 42 } });
    const callbacks = makeCallbacks();

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: true }, refs, callbacks);

    // The pending cancel-status timer will clear the agent status itself
    // when it fires; finalize must not stomp on it.
    expect(callbacks.agentStatusCalls).toEqual([]);
  });

  it('clears the run checkpoint only when loopCompletedNormally is true', () => {
    finalizeRunSession(
      { chatId: 'chat-1', loopCompletedNormally: true },
      makeRefs(),
      makeCallbacks(),
    );
    expect(mockClearRunCheckpoint).toHaveBeenCalledWith('chat-1');
    mockClearRunCheckpoint.mockClear();

    finalizeRunSession(
      { chatId: 'chat-1', loopCompletedNormally: false },
      makeRefs(),
      makeCallbacks(),
    );
    expect(mockClearRunCheckpoint).not.toHaveBeenCalled();
  });
});

describe('finalizeRunSession — queue handling when chat is no longer active', () => {
  it('drains the queue for the run chat and emits FOLLOW_UP_QUEUE_CLEARED when there were queued items', () => {
    const followUp: QueuedFollowUp = {
      text: 'queued',
      attachments: undefined,
      options: undefined,
      queuedAt: 1,
    };
    const refs = makeRefs({
      activeChatIdRef: { current: 'chat-2' },
      queuedFollowUpsRef: { current: { 'chat-1': [followUp] } },
    });
    const callbacks = makeCallbacks({
      pendingSteerHits: new Set(['chat-1']),
      queuedFollowUps: { 'chat-1': [followUp] },
    });

    const result = finalizeRunSession(
      { chatId: 'chat-1', loopCompletedNormally: true },
      refs,
      callbacks,
    );

    expect(callbacks.clearPendingSteerCalls).toEqual(['chat-1']);
    expect(callbacks.clearQueuedFollowUpsCalls).toEqual(['chat-1']);
    expect(result.nextFollowUp).toBeNull();
    expect(callbacks.emittedEvents.map((e) => e.type)).toContain('STEER_CLEARED');
    expect(callbacks.emittedEvents.map((e) => e.type)).toContain('FOLLOW_UP_QUEUE_CLEARED');
  });

  it('does not emit FOLLOW_UP_QUEUE_CLEARED when the queue was already empty', () => {
    const refs = makeRefs({ activeChatIdRef: { current: 'chat-2' } });
    const callbacks = makeCallbacks();

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: true }, refs, callbacks);

    expect(callbacks.emittedEvents.map((e) => e.type)).not.toContain('FOLLOW_UP_QUEUE_CLEARED');
  });
});

describe('finalizeRunSession — queue handling when chat is still active', () => {
  it('returns the dequeued follow-up so the caller can dispatch it', () => {
    const followUp: QueuedFollowUp = {
      text: 'next',
      attachments: undefined,
      options: undefined,
      queuedAt: 2,
    };
    const refs = makeRefs({ activeChatIdRef: { current: 'chat-1' } });
    const callbacks = makeCallbacks({ queuedFollowUps: { 'chat-1': [followUp] } });

    const result = finalizeRunSession(
      { chatId: 'chat-1', loopCompletedNormally: true },
      refs,
      callbacks,
    );

    expect(result.nextFollowUp).toEqual(followUp);
    expect(callbacks.emittedEvents.map((e) => e.type)).toContain('FOLLOW_UP_DEQUEUED');
    expect(callbacks.clearQueuedFollowUpsCalls).toEqual([]);
  });

  it('returns nextFollowUp: null when the queue is empty', () => {
    const refs = makeRefs({ activeChatIdRef: { current: 'chat-1' } });
    const callbacks = makeCallbacks();

    const result = finalizeRunSession(
      { chatId: 'chat-1', loopCompletedNormally: true },
      refs,
      callbacks,
    );

    expect(result.nextFollowUp).toBeNull();
    expect(callbacks.emittedEvents.map((e) => e.type)).not.toContain('FOLLOW_UP_DEQUEUED');
  });

  it('emits STEER_CLEARED only when the steer-clear actually had something to clear', () => {
    const refs = makeRefs({ activeChatIdRef: { current: 'chat-1' } });
    const callbacks = makeCallbacks({ pendingSteerHits: new Set(['chat-1']) });

    finalizeRunSession({ chatId: 'chat-1', loopCompletedNormally: true }, refs, callbacks);

    expect(callbacks.emittedEvents.map((e) => e.type)).toContain('STEER_CLEARED');

    callbacks.emittedEvents.length = 0;
    const callbacks2 = makeCallbacks();
    finalizeRunSession(
      { chatId: 'chat-1', loopCompletedNormally: true },
      makeRefs({ activeChatIdRef: { current: 'chat-1' } }),
      callbacks2,
    );
    expect(callbacks2.emittedEvents.map((e) => e.type)).not.toContain('STEER_CLEARED');
  });
});
