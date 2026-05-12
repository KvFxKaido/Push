import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, PendingSteerRequest } from '@/types';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { RunJournalEntry } from '@/lib/run-journal';

const { mockStreamAssistantRound, mockProcessAssistantTurn } = vi.hoisted(() => ({
  mockStreamAssistantRound: vi.fn(),
  mockProcessAssistantTurn: vi.fn(),
}));

vi.mock('./chat-send', async () => {
  const actual = await vi.importActual<typeof import('./chat-send')>('./chat-send');
  return {
    ...actual,
    streamAssistantRound: (...args: unknown[]) => mockStreamAssistantRound(...args),
    processAssistantTurn: (...args: unknown[]) => mockProcessAssistantTurn(...args),
  };
});

import { runRoundLoop } from './chat-round-loop';
import type { SendLoopContext } from './chat-send';
import type { PendingSteersByChat } from './usePendingSteer';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'streaming',
    ...overrides,
  };
}

function makeConversations(messages: ChatMessage[]): Record<string, Conversation> {
  return {
    'chat-1': {
      id: 'chat-1',
      title: 'Chat',
      messages,
      createdAt: 1,
      lastMessageAt: 1,
    },
  };
}

interface Harness {
  loopCtx: SendLoopContext;
  conversationsRef: { current: Record<string, Conversation> };
  dirtyRef: { current: Set<string> };
  pendingSteersByChatRef: { current: PendingSteersByChat };
  dequeuePendingSteer: ReturnType<typeof vi.fn<(chatId: string) => PendingSteerRequest | null>>;
  runJournalEntryRef: { current: RunJournalEntry | null };
  persistRunJournal: ReturnType<
    typeof vi.fn<(entry: RunJournalEntry | null, options?: { prune?: boolean }) => void>
  >;
  emitRunEngineEvent: ReturnType<typeof vi.fn>;
  appendRunEvent: ReturnType<typeof vi.fn>;
  flushCheckpoint: ReturnType<typeof vi.fn>;
}

function makeHarness(initialMessages: ChatMessage[] = [makeMessage()]): Harness {
  const conversationsRef = { current: makeConversations(initialMessages) };
  const dirtyRef = { current: new Set<string>() };
  const pendingSteersByChatRef = { current: {} as PendingSteersByChat };
  const runJournalEntryRef: { current: RunJournalEntry | null } = { current: null };

  const emitRunEngineEvent = vi.fn();
  const appendRunEvent = vi.fn();
  const flushCheckpoint = vi.fn();
  const persistRunJournal =
    vi.fn<(entry: RunJournalEntry | null, options?: { prune?: boolean }) => void>();
  const dequeuePendingSteer = vi.fn<(chatId: string) => PendingSteerRequest | null>(() => null);

  const loopCtx: SendLoopContext = {
    chatId: 'chat-1',
    lockedProvider: 'openrouter',
    resolvedModel: undefined,
    abortRef: { current: false },
    abortControllerRef: { current: null },
    sandboxIdRef: { current: null },
    ensureSandboxRef: { current: null },
    localDaemonBindingRef: { current: null },
    scratchpadRef: { current: undefined },
    todoRef: { current: undefined },
    usageHandlerRef: { current: undefined },
    workspaceContextRef: { current: null },
    runtimeHandlersRef: { current: undefined },
    repoRef: { current: null },
    isMainProtectedRef: { current: false },
    branchInfoRef: { current: undefined },
    checkpointRefs: { apiMessages: { current: [] } },
    processedContentRef: { current: new Set<string>() },
    lastCoderStateRef: { current: null },
    skipAutoCreateRef: { current: null },
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef,
    setConversations: (updater) => {
      conversationsRef.current =
        typeof updater === 'function' ? updater(conversationsRef.current) : updater;
    },
    dirtyConversationIdsRef: dirtyRef,
    updateAgentStatus: vi.fn(),
    appendRunEvent,
    emitRunEngineEvent,
    flushCheckpoint,
    getVerificationState: vi.fn(),
    updateVerificationState: vi.fn(),
    executeDelegateCall: vi.fn(),
  };

  return {
    loopCtx,
    conversationsRef,
    dirtyRef,
    pendingSteersByChatRef,
    dequeuePendingSteer,
    runJournalEntryRef,
    persistRunJournal,
    emitRunEngineEvent,
    appendRunEvent,
    flushCheckpoint,
  };
}

const emptyRecovery: ToolCallRecoveryState = { diagnosisRetries: 0, recoveryAttempted: false };

function emittedTypes(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls.map(([event]) => (event as { type: string }).type);
}

describe('runRoundLoop', () => {
  beforeEach(() => {
    mockStreamAssistantRound.mockReset();
    mockProcessAssistantTurn.mockReset();
  });

  it('completes on the first round when the turn breaks normally', async () => {
    const h = makeHarness();
    mockStreamAssistantRound.mockResolvedValueOnce({
      accumulated: 'hello',
      thinkingAccumulated: '',
      reasoningBlocks: [],
      error: null,
    });
    mockProcessAssistantTurn.mockResolvedValueOnce({
      nextApiMessages: [makeMessage({ id: 'user', role: 'user', content: 'hi', status: 'done' })],
      nextRecoveryState: emptyRecovery,
      loopAction: 'break',
      loopCompletedNormally: true,
    });

    const result = await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    expect(result.loopCompletedNormally).toBe(true);
    expect(mockStreamAssistantRound).toHaveBeenCalledTimes(1);
    expect(mockProcessAssistantTurn).toHaveBeenCalledTimes(1);
    const types = emittedTypes(h.emitRunEngineEvent);
    expect(types).toEqual(['ROUND_STARTED', 'STREAMING_COMPLETED', 'TOOLS_STARTED']);
    const turnEnd = h.appendRunEvent.mock.calls
      .map(([, event]) => event as { type: string; outcome?: string })
      .find((e) => e.type === 'assistant.turn_end');
    expect(turnEnd?.outcome).toBe('completed');
  });

  it('runs multiple rounds when processAssistantTurn returns continue', async () => {
    const h = makeHarness();
    mockStreamAssistantRound
      .mockResolvedValueOnce({
        accumulated: 'r0',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      })
      .mockResolvedValueOnce({
        accumulated: 'r1',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      });
    mockProcessAssistantTurn
      .mockResolvedValueOnce({
        nextApiMessages: [],
        nextRecoveryState: emptyRecovery,
        loopAction: 'continue',
        loopCompletedNormally: false,
      })
      .mockResolvedValueOnce({
        nextApiMessages: [],
        nextRecoveryState: emptyRecovery,
        loopAction: 'break',
        loopCompletedNormally: true,
      });

    const result = await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    expect(result.loopCompletedNormally).toBe(true);
    expect(mockStreamAssistantRound).toHaveBeenCalledTimes(2);
    expect(emittedTypes(h.emitRunEngineEvent)).toContain('TURN_CONTINUED');
    // Round 1 (round > 0) should have appended a fresh streaming assistant draft.
    const messages = h.conversationsRef.current['chat-1'].messages;
    const streamingDrafts = messages.filter(
      (m) => m.role === 'assistant' && m.status === 'streaming',
    );
    expect(streamingDrafts.length).toBeGreaterThanOrEqual(1);
  });

  it('writes an error message and breaks when streaming returns an error', async () => {
    const h = makeHarness();
    mockStreamAssistantRound.mockResolvedValueOnce({
      accumulated: '',
      thinkingAccumulated: '',
      reasoningBlocks: [],
      error: new Error('boom'),
    });

    const result = await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    expect(result.loopCompletedNormally).toBe(false);
    expect(mockProcessAssistantTurn).not.toHaveBeenCalled();
    expect(emittedTypes(h.emitRunEngineEvent)).toContain('LOOP_FAILED');
    const lastMessage = h.conversationsRef.current['chat-1'].messages.at(-1);
    expect(lastMessage?.status).toBe('error');
    expect(lastMessage?.content).toBe('Something went wrong: boom');
    expect(h.dirtyRef.current.has('chat-1')).toBe(true);
  });

  it('breaks early when abort is set after streaming', async () => {
    const h = makeHarness();
    mockStreamAssistantRound.mockImplementationOnce(async () => {
      h.loopCtx.abortRef.current = true;
      return { accumulated: '', thinkingAccumulated: '', reasoningBlocks: [], error: null };
    });

    const result = await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    expect(result.loopCompletedNormally).toBe(false);
    expect(mockProcessAssistantTurn).not.toHaveBeenCalled();
    const turnEnd = h.appendRunEvent.mock.calls
      .map(([, event]) => event as { type: string; outcome?: string })
      .find((e) => e.type === 'assistant.turn_end');
    expect(turnEnd?.outcome).toBe('aborted');
  });

  it('drains a pending steer that arrives during streaming and continues', async () => {
    const h = makeHarness();
    const steer: PendingSteerRequest = {
      text: 'wait do this instead',
      requestedAt: 100,
    };
    h.dequeuePendingSteer.mockReturnValueOnce(steer).mockReturnValue(null);

    mockStreamAssistantRound
      .mockResolvedValueOnce({
        accumulated: 'partial',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      })
      .mockResolvedValueOnce({
        accumulated: 'final',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      });
    mockProcessAssistantTurn.mockResolvedValueOnce({
      nextApiMessages: [],
      nextRecoveryState: emptyRecovery,
      loopAction: 'break',
      loopCompletedNormally: true,
    });

    const result = await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    expect(result.loopCompletedNormally).toBe(true);
    expect(mockStreamAssistantRound).toHaveBeenCalledTimes(2);
    expect(emittedTypes(h.emitRunEngineEvent)).toContain('TURN_STEERED');
    // The drained steer kept the round-0 assistant draft (since accumulated had content)
    // and inserted the user steer after it. Round 1 then appended a fresh streaming draft,
    // so the steer user message is no longer the last message.
    const msgs = h.conversationsRef.current['chat-1'].messages;
    const steerUser = msgs.find((m) => m.role === 'user' && m.content === 'wait do this instead');
    expect(steerUser).toBeDefined();
    const partialDraft = msgs.find((m) => m.role === 'assistant' && m.content === 'partial');
    expect(partialDraft?.status).toBe('done');
  });

  it('drops an empty assistant draft when steered before tools', async () => {
    const h = makeHarness();
    const steer: PendingSteerRequest = { text: 'override', requestedAt: 100 };
    h.dequeuePendingSteer.mockReturnValueOnce(steer).mockReturnValue(null);

    mockStreamAssistantRound
      .mockResolvedValueOnce({
        accumulated: '   ',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      })
      .mockResolvedValueOnce({
        accumulated: 'done',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      });
    mockProcessAssistantTurn.mockResolvedValueOnce({
      nextApiMessages: [],
      nextRecoveryState: emptyRecovery,
      loopAction: 'break',
      loopCompletedNormally: true,
    });

    await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    const msgs = h.conversationsRef.current['chat-1'].messages;
    // The only assistant draft from round 0 was empty and should have been popped before the steer.
    const round0Draft = msgs.find((m) => m.role === 'assistant' && m.content === '   ');
    expect(round0Draft).toBeUndefined();
  });

  it('drains a pending steer that arrives after tool dispatch and continues', async () => {
    const h = makeHarness();
    const steer: PendingSteerRequest = { text: 'follow up', requestedAt: 100 };
    // First round: no steer pre-tools, steer post-turn. Second round: no steer.
    h.dequeuePendingSteer
      .mockReturnValueOnce(null) // before tools, round 0
      .mockReturnValueOnce(steer) // after turn, round 0
      .mockReturnValue(null);

    mockStreamAssistantRound
      .mockResolvedValueOnce({
        accumulated: 'r0',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      })
      .mockResolvedValueOnce({
        accumulated: 'r1',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      });
    mockProcessAssistantTurn
      .mockResolvedValueOnce({
        nextApiMessages: [],
        nextRecoveryState: emptyRecovery,
        loopAction: 'continue',
        loopCompletedNormally: false,
      })
      .mockResolvedValueOnce({
        nextApiMessages: [],
        nextRecoveryState: emptyRecovery,
        loopAction: 'break',
        loopCompletedNormally: true,
      });

    await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    expect(emittedTypes(h.emitRunEngineEvent)).toContain('TURN_STEERED');
    const userMessages = h.conversationsRef.current['chat-1'].messages.filter(
      (m: ChatMessage) => m.role === 'user',
    );
    expect(userMessages.at(-1)?.content).toBe('follow up');
  });

  it('emits STEER_SET with the next head when more steers remain queued', async () => {
    const h = makeHarness();
    const drained: PendingSteerRequest = { text: 'first', requestedAt: 100 };
    const remaining: PendingSteerRequest = { text: 'second', requestedAt: 200 };
    h.dequeuePendingSteer.mockReturnValueOnce(drained).mockReturnValue(null);
    h.pendingSteersByChatRef.current = { 'chat-1': [remaining] };

    mockStreamAssistantRound
      .mockResolvedValueOnce({
        accumulated: 'partial',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      })
      .mockResolvedValueOnce({
        accumulated: 'done',
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      });
    mockProcessAssistantTurn.mockResolvedValueOnce({
      nextApiMessages: [],
      nextRecoveryState: emptyRecovery,
      loopAction: 'break',
      loopCompletedNormally: true,
    });

    await runRoundLoop(
      h.loopCtx,
      { apiMessages: [], recoveryState: emptyRecovery },
      {
        runJournalEntryRef: h.runJournalEntryRef,
        persistRunJournal: h.persistRunJournal,
        dequeuePendingSteer: h.dequeuePendingSteer,
        pendingSteersByChatRef: h.pendingSteersByChatRef,
      },
    );

    const events = h.emitRunEngineEvent.mock.calls.map(([e]) => e);
    const steerSet = events.find((e: { type: string }) => e.type === 'STEER_SET');
    expect(steerSet).toMatchObject({ type: 'STEER_SET', preview: 'second' });
    expect(events.find((e: { type: string }) => e.type === 'STEER_CONSUMED')).toBeUndefined();
  });

  it('propagates exceptions thrown from streamAssistantRound', async () => {
    const h = makeHarness();
    mockStreamAssistantRound.mockRejectedValueOnce(new Error('network down'));

    await expect(
      runRoundLoop(
        h.loopCtx,
        { apiMessages: [], recoveryState: emptyRecovery },
        {
          runJournalEntryRef: h.runJournalEntryRef,
          persistRunJournal: h.persistRunJournal,
          dequeuePendingSteer: h.dequeuePendingSteer,
          pendingSteersByChatRef: h.pendingSteersByChatRef,
        },
      ),
    ).rejects.toThrow('network down');
  });
});
