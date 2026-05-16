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

  it('does not dispatch a partial tool call when abort fires mid-emission', async () => {
    // Cancellation invariant: "nothing partial reaches history."
    // Specifically: when streamAssistantRound returns with `accumulated`
    // containing a half-emitted fenced JSON tool-call block (no closing
    // braces, no fence terminator) AND abortRef is set, the loop must
    // NOT proceed to processAssistantTurn. The existing
    // "breaks early when abort is set" test pinned the empty-accumulator
    // case; this pins the more realistic shape where the model started
    // emitting a tool call and the user hit Stop before it finished.
    //
    // Without this pin, a future change that gates dispatch on
    // "accumulator has tool-shaped content" rather than "abort is false"
    // could regress the invariant silently — detectAllToolCalls would
    // happily return zero matches on the malformed JSON, but any
    // downstream code that tried to parse fenced blocks loosely could
    // still trigger a tool execution.
    const h = makeHarness();
    const partialToolCall =
      'Looking up the file.\n\n```json\n{"tool": "sandbox_write_file", "args": {';

    mockStreamAssistantRound.mockImplementationOnce(async () => {
      h.loopCtx.abortRef.current = true;
      return {
        accumulated: partialToolCall,
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      };
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
    // The load-bearing assertion: even with tool-shaped content in the
    // accumulator, no dispatch path was reached.
    expect(mockProcessAssistantTurn).not.toHaveBeenCalled();
    // Turn finalizes as aborted, not completed or errored — the
    // run-engine state machine consumes this outcome.
    const turnEnd = h.appendRunEvent.mock.calls
      .map(([, event]) => event as { type: string; outcome?: string })
      .find((e) => e.type === 'assistant.turn_end');
    expect(turnEnd?.outcome).toBe('aborted');
    // No tool-call-malformed event either — that path runs inside
    // processAssistantTurn for the multiple-mutations case, and the
    // invariant is "no tool side-effects of any shape after abort."
    const toolEvents = h.appendRunEvent.mock.calls
      .map(([, event]) => event as { type: string })
      .filter((e) => e.type === 'tool.call_malformed' || e.type === 'tool.call_started');
    expect(toolEvents).toEqual([]);
  });

  it('does not carry partial accumulator across an abort/resend boundary', async () => {
    // Cancellation invariant continuation: after an aborted turn, a
    // subsequent runRoundLoop call must start from a clean accumulator
    // and not inherit the partial content from the prior turn. The
    // accumulator lives inside streamAssistantRound (not on the loop
    // context), so the risk here is shared state on the loop context —
    // primarily `processedContentRef` and `checkpointRefs.apiMessages`.
    //
    // We invoke runRoundLoop twice on the same harness: first call
    // aborts mid-stream with partial tool-call content; second call
    // completes normally with a different content. The second turn's
    // processAssistantTurn must see ONLY the new round's accumulator —
    // not the abandoned partial from turn 1.
    const h = makeHarness();
    const partial = '```json\n{"tool": "sandbox_exec", "args": {';
    const cleanContent = 'Done — no tool needed.';

    mockStreamAssistantRound
      .mockImplementationOnce(async () => {
        h.loopCtx.abortRef.current = true;
        return {
          accumulated: partial,
          thinkingAccumulated: '',
          reasoningBlocks: [],
          error: null,
        };
      })
      .mockImplementationOnce(async () => ({
        accumulated: cleanContent,
        thinkingAccumulated: '',
        reasoningBlocks: [],
        error: null,
      }));
    mockProcessAssistantTurn.mockImplementationOnce(async (_round, accumulated) => ({
      nextApiMessages: [],
      nextRecoveryState: emptyRecovery,
      loopAction: 'break',
      loopCompletedNormally: true,
      // Echo so the assertion can see exactly what processAssistantTurn
      // received from the loop on the resend.
      _receivedAccumulated: accumulated,
    }));

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
    // The user "resends" — reset the abort flag the way the next
    // outer-loop iteration would and re-enter.
    h.loopCtx.abortRef.current = false;
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

    expect(mockProcessAssistantTurn).toHaveBeenCalledTimes(1);
    const [, accumulatedArg] = mockProcessAssistantTurn.mock.calls[0];
    expect(accumulatedArg).toBe(cleanContent);
    expect(accumulatedArg).not.toContain(partial);
    // Two turn_end events should appear: the first aborted, the second
    // completed. Pin both so a regression that drops the second turn
    // (or surfaces a phantom continuation) breaks the test.
    const turnEnds = h.appendRunEvent.mock.calls
      .map(([, event]) => event as { type: string; outcome?: string })
      .filter((e) => e.type === 'assistant.turn_end')
      .map((e) => e.outcome);
    expect(turnEnds).toEqual(['aborted', 'completed']);
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
