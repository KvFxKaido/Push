import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { AgentStatus, ChatMessage, Conversation, QueuedFollowUp } from '@/types';
import {
  acquireRunSession,
  finalizeRunSession,
  type AcquireRunSessionCallbacks,
  type AcquireRunSessionRefs,
  type FinalizeRunSessionCallbacks,
  type FinalizeRunSessionRefs,
} from './chat-run-session';
import { type RunEngineEvent, type RunEngineState } from '@/lib/run-engine';

const {
  mockClearRunCheckpoint,
  mockReleaseRunTabLock,
  mockAcquireRunTabLock,
  mockHeartbeatRunTabLock,
} = vi.hoisted(() => ({
  mockClearRunCheckpoint: vi.fn(),
  mockReleaseRunTabLock: vi.fn(),
  mockAcquireRunTabLock: vi.fn(),
  mockHeartbeatRunTabLock: vi.fn(),
}));

vi.mock('@/lib/checkpoint-manager', () => ({
  clearRunCheckpoint: (...args: unknown[]) => mockClearRunCheckpoint(...args),
  releaseRunTabLock: (...args: unknown[]) => mockReleaseRunTabLock(...args),
  acquireRunTabLock: (...args: unknown[]) => mockAcquireRunTabLock(...args),
  heartbeatRunTabLock: (...args: unknown[]) => mockHeartbeatRunTabLock(...args),
}));

vi.mock('./chat-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-persistence')>();
  return {
    ...actual,
    createId: vi.fn(() => 'test-run-id'),
  };
});

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

// ---------------------------------------------------------------------------
// acquireRunSession
// ---------------------------------------------------------------------------

interface AcquireCaptured {
  emittedEvents: RunEngineEvent[];
  setIsStreamingCalls: boolean[];
  agentStatusCalls: Array<{ status: AgentStatus; opts?: { chatId?: string } }>;
  conversationsAfter: Record<string, Conversation>;
}

function makeAcquireRefs(overrides: Partial<AcquireRunSessionRefs> = {}): AcquireRunSessionRefs {
  return {
    dirtyConversationIdsRef: { current: new Set<string>() },
    tabLockIntervalRef: { current: null },
    checkpointApiMessagesRef: { current: [] },
    ...overrides,
  } as AcquireRunSessionRefs;
}

interface AcquireHarness {
  callbacks: AcquireRunSessionCallbacks;
  captured: AcquireCaptured;
}

function makeAcquireCallbacks(
  initialConversations: Record<string, Conversation> = {},
): AcquireHarness {
  // Mutate captured in place — Object.assign-style returns risk
  // capturing a stale `conversationsAfter` reference because reassigning
  // a property on `captured` doesn't update the merged object.
  const captured: AcquireCaptured = {
    emittedEvents: [],
    setIsStreamingCalls: [],
    agentStatusCalls: [],
    conversationsAfter: { ...initialConversations },
  };
  const callbacks: AcquireRunSessionCallbacks = {
    emitRunEngineEvent: (event) => captured.emittedEvents.push(event),
    setIsStreaming: (next) =>
      captured.setIsStreamingCalls.push(typeof next === 'function' ? next(false) : next),
    updateAgentStatus: (status, opts) => captured.agentStatusCalls.push({ status, opts }),
    updateConversations: (updater) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: Record<string, Conversation>) => Record<string, Conversation>)(
              captured.conversationsAfter,
            )
          : updater;
      captured.conversationsAfter = next;
    },
  };
  return { callbacks, captured };
}

function makeStreamingConversation(): Record<string, Conversation> {
  const streamingMsg: ChatMessage = {
    id: 'asst-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'streaming',
  };
  const userMsg: ChatMessage = {
    id: 'user-1',
    role: 'user',
    content: 'hi',
    timestamp: 1,
    status: 'done',
  };
  return {
    'chat-1': {
      id: 'chat-1',
      title: 'T',
      messages: [userMsg, streamingMsg],
      createdAt: 1,
      lastMessageAt: 1,
    },
  };
}

beforeEach(() => {
  mockAcquireRunTabLock.mockReset();
  mockHeartbeatRunTabLock.mockReset();
});

describe('acquireRunSession — happy path', () => {
  it('pins the checkpoint seed, emits RUN_STARTED, acquires the tab lock, and starts the heartbeat', () => {
    mockAcquireRunTabLock.mockReturnValue('tab-xyz');
    const refs = makeAcquireRefs();
    const { callbacks, captured } = makeAcquireCallbacks();
    const apiMessages: ChatMessage[] = [
      { id: 'u', role: 'user', content: 'hi', timestamp: 1, status: 'done' },
    ];

    const result = acquireRunSession(
      {
        chatId: 'chat-1',
        lockedProvider: 'cloudflare',
        resolvedModel: 'cf-model',
        apiMessages,
      },
      refs,
      callbacks,
    );

    expect(result.acquired).toBe(true);
    expect(refs.checkpointApiMessagesRef.current).toBe(apiMessages);

    const types = captured.emittedEvents.map((e) => e.type);
    expect(types).toEqual(['RUN_STARTED', 'TAB_LOCK_ACQUIRED']);
    const runStarted = captured.emittedEvents[0];
    if (runStarted.type === 'RUN_STARTED') {
      expect(runStarted.chatId).toBe('chat-1');
      expect(runStarted.provider).toBe('cloudflare');
      expect(runStarted.model).toBe('cf-model');
      expect(runStarted.baseMessageCount).toBe(1);
      expect(runStarted.runId).toBe('test-run-id');
    }

    expect(mockAcquireRunTabLock).toHaveBeenCalledWith('chat-1');
    expect(refs.tabLockIntervalRef.current).not.toBeNull();
    if (refs.tabLockIntervalRef.current) clearInterval(refs.tabLockIntervalRef.current);
  });

  it('emits an empty model string when resolvedModel is null', () => {
    mockAcquireRunTabLock.mockReturnValue('tab-1');
    const refs = makeAcquireRefs();
    const { callbacks, captured } = makeAcquireCallbacks();

    acquireRunSession(
      {
        chatId: 'chat-1',
        lockedProvider: 'cloudflare',
        resolvedModel: null,
        apiMessages: [],
      },
      refs,
      callbacks,
    );

    const runStarted = captured.emittedEvents[0];
    if (runStarted.type === 'RUN_STARTED') {
      expect(runStarted.model).toBe('');
    }
    if (refs.tabLockIntervalRef.current) clearInterval(refs.tabLockIntervalRef.current);
  });

  it('clears any pre-existing heartbeat interval before scheduling a new one', () => {
    mockAcquireRunTabLock.mockReturnValue('tab-1');
    const stale = setInterval(() => {}, 60_000);
    const refs = makeAcquireRefs({ tabLockIntervalRef: { current: stale } });
    const { callbacks } = makeAcquireCallbacks();

    acquireRunSession(
      { chatId: 'chat-1', lockedProvider: 'cloudflare', resolvedModel: null, apiMessages: [] },
      refs,
      callbacks,
    );

    expect(refs.tabLockIntervalRef.current).not.toBe(stale);
    expect(refs.tabLockIntervalRef.current).not.toBeNull();
    if (refs.tabLockIntervalRef.current) clearInterval(refs.tabLockIntervalRef.current);
  });
});

describe('acquireRunSession — denial', () => {
  it('returns acquired:false and finishes cleanup when the tab lock is denied', () => {
    mockAcquireRunTabLock.mockReturnValue(null);
    const conversations = makeStreamingConversation();
    const refs = makeAcquireRefs();
    const { callbacks, captured } = makeAcquireCallbacks(conversations);

    const result = acquireRunSession(
      {
        chatId: 'chat-1',
        lockedProvider: 'cloudflare',
        resolvedModel: null,
        apiMessages: [],
      },
      refs,
      callbacks,
    );

    expect(result.acquired).toBe(false);

    // RUN_STARTED still fires before the lock attempt; TAB_LOCK_DENIED
    // follows so the engine sees a complete (denied) lifecycle.
    const types = captured.emittedEvents.map((e) => e.type);
    expect(types).toEqual(['RUN_STARTED', 'TAB_LOCK_DENIED']);

    expect(captured.setIsStreamingCalls).toEqual([false]);
    expect(captured.agentStatusCalls).toEqual([
      { status: { active: false, phase: '' }, opts: undefined },
    ]);

    // Streaming assistant message is replaced with the tab-locked notice.
    const conv = captured.conversationsAfter['chat-1'];
    expect(conv.messages[1].status).toBe('done');
    expect(conv.messages[1].content).toContain('active in another tab');
    expect(refs.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);

    // No heartbeat scheduled on denial.
    expect(refs.tabLockIntervalRef.current).toBeNull();
  });

  it('leaves a missing conversation alone (defensive against post-delete races)', () => {
    mockAcquireRunTabLock.mockReturnValue(null);
    const refs = makeAcquireRefs();
    const { callbacks, captured } = makeAcquireCallbacks(); // no conversations

    const result = acquireRunSession(
      { chatId: 'chat-1', lockedProvider: 'cloudflare', resolvedModel: null, apiMessages: [] },
      refs,
      callbacks,
    );

    expect(result.acquired).toBe(false);
    // Updater no-ops when prev[chatId] is missing — no crash, no change.
    expect(captured.conversationsAfter).toEqual({});
  });
});
