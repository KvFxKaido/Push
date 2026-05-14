import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, VerificationRuntimeState } from '@/types';
import { setApprovalMode } from '@/lib/approval-mode';
import type { TodoItem } from '@/lib/todo-tools';
import type { TodoHandlers } from './chat-send';

const { mockStreamChat } = vi.hoisted(() => ({
  mockStreamChat: vi.fn(),
}));

vi.mock('@/lib/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orchestrator')>('@/lib/orchestrator');
  return {
    ...actual,
    streamChat: (...args: unknown[]) => mockStreamChat(...args),
  };
});

import { processAssistantTurn, streamAssistantRound, type SendLoopContext } from './chat-send';
import {
  drainRecentContextMetrics,
  recordContextMetric,
  resetContextMetrics,
} from '@/lib/context-metrics';

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

function makeConversation(messages: ChatMessage[]): Record<string, Conversation> {
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

function makeVerificationState(
  overrides: Partial<VerificationRuntimeState> = {},
): VerificationRuntimeState {
  return {
    policyName: 'Test',
    backendTouched: false,
    mutationOccurred: false,
    requirements: [],
    lastUpdatedAt: 1,
    ...overrides,
  };
}

function makeLoopContext(
  conversationsRef: { current: Record<string, Conversation> },
  dirtyRef: { current: Set<string> },
  overrides: Partial<SendLoopContext> = {},
): SendLoopContext {
  const verificationStateRef = {
    current: makeVerificationState(),
  };

  return {
    chatId: 'chat-1',
    lockedProvider: 'openrouter',
    resolvedModel: 'anthropic/claude-sonnet-4.6:nitro',
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
    checkpointRefs: {
      apiMessages: { current: [] },
    },
    processedContentRef: { current: new Set<string>() },
    lastCoderStateRef: { current: null },
    setConversations: (updater) => {
      conversationsRef.current =
        typeof updater === 'function' ? updater(conversationsRef.current) : updater;
    },
    dirtyConversationIdsRef: dirtyRef,
    updateAgentStatus: vi.fn(),
    appendRunEvent: vi.fn(),
    emitRunEngineEvent: vi.fn(),
    flushCheckpoint: vi.fn(),
    getVerificationState: () => verificationStateRef.current,
    updateVerificationState: (_chatId, updater) => {
      verificationStateRef.current = updater(verificationStateRef.current);
      return verificationStateRef.current;
    },
    executeDelegateCall: vi.fn(),
    skipAutoCreateRef: { current: null },
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef,
    ...overrides,
  };
}

describe('chat-send', () => {
  beforeEach(() => {
    mockStreamChat.mockReset();
    setApprovalMode('supervised');
  });

  it('streams content/thinking into the latest assistant message and checkpoint refs', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage()]),
    };
    const dirtyRef = { current: new Set<string>() };
    const usageHandler = { trackUsage: vi.fn() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      usageHandlerRef: { current: usageHandler },
    });

    mockStreamChat.mockImplementation((_messages, onToken, onDone, _onError, onThinkingToken) => {
      onThinkingToken?.('Need to inspect');
      onToken('Hello');
      onToken(' world');
      onDone({ inputTokens: 11, outputTokens: 7 });
    });

    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'Hi', status: 'done' })],
      ctx,
    );

    expect(result).toEqual({
      accumulated: 'Hello world',
      thinkingAccumulated: 'Need to inspect',
      reasoningBlocks: [],
      error: null,
    });
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({
      content: 'Hello world',
      thinking: 'Need to inspect',
      status: 'streaming',
    });
    // Accumulation is now tracked via engine events, not checkpoint refs.
    // Verify the engine received ACCUMULATED_UPDATED events with final content.
    const engineCalls = (ctx.emitRunEngineEvent as ReturnType<typeof vi.fn>).mock.calls;
    const accumulatedEvents = engineCalls
      .map(([event]) => event)
      .filter((e: { type: string }) => e.type === 'ACCUMULATED_UPDATED');
    expect(accumulatedEvents.length).toBeGreaterThan(0);
    const lastAccumulated = accumulatedEvents.at(-1);
    expect(lastAccumulated.text).toBe('Hello world');
    expect(lastAccumulated.thinking).toBe('Need to inspect');
    expect(usageHandler.trackUsage).toHaveBeenCalledWith('k2p5', 11, 7);
  });

  it('drains context-compaction metrics into appendRunEvent after the stream resolves', async () => {
    // End-to-end coverage for the drain → run-event mapping in
    // chat-stream-round. If the loop stops emitting `context.compaction`
    // events or maps fields incorrectly, this test fails. Copilot on
    // PR #545.
    resetContextMetrics();
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    mockStreamChat.mockImplementation((_messages, _onToken, onDone) => {
      // Simulate compaction firing during the prompt build inside the
      // PushStream. The drain happens after `streamChat` resolves.
      recordContextMetric({
        phase: 'summarization',
        beforeTokens: 90_000,
        afterTokens: 60_000,
        provider: 'openrouter',
        cause: 'tool_output',
      });
      onDone({ inputTokens: 1, outputTokens: 1 });
    });

    await streamAssistantRound(
      3,
      [makeMessage({ id: 'user-1', role: 'user', content: 'Hi', status: 'done' })],
      ctx,
    );

    const appendRunEvent = ctx.appendRunEvent as ReturnType<typeof vi.fn>;
    const compactionCalls = appendRunEvent.mock.calls.filter(
      (call) => (call[1] as { type: string }).type === 'context.compaction',
    );
    expect(compactionCalls).toHaveLength(1);
    const chatId = compactionCalls[0][0] as string;
    const event = compactionCalls[0][1] as {
      type: string;
      round: number;
      phase: string;
      beforeTokens: number;
      afterTokens: number;
      messagesDropped: number;
      provider?: string;
      cause?: string;
    };
    expect(chatId).toBe('chat-1');
    expect(event.round).toBe(3);
    expect(event.phase).toBe('summarization');
    expect(event.beforeTokens).toBe(90_000);
    expect(event.afterTokens).toBe(60_000);
    expect(event.messagesDropped).toBe(0);
    expect(event.provider).toBe('openrouter');
    expect(event.cause).toBe('tool_output');

    // Buffer is drained — a subsequent peek returns nothing.
    expect(drainRecentContextMetrics()).toEqual([]);
  });

  it('promotes reasoning to content when the stream emits only thinking tokens', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage()]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    mockStreamChat.mockImplementation((_messages, _onToken, onDone, _onError, onThinkingToken) => {
      onThinkingToken?.('Here is the full answer, accidentally on the reasoning channel.');
      onDone({ inputTokens: 1, outputTokens: 1 });
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'Hi', status: 'done' })],
      ctx,
    );
    warnSpy.mockRestore();

    expect(result).toEqual({
      accumulated: 'Here is the full answer, accidentally on the reasoning channel.',
      thinkingAccumulated: '',
      reasoningBlocks: [],
      error: null,
    });
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({
      content: 'Here is the full answer, accidentally on the reasoning channel.',
      thinking: undefined,
      status: 'streaming',
    });

    const engineCalls = (ctx.emitRunEngineEvent as ReturnType<typeof vi.fn>).mock.calls;
    const lastAccumulated = engineCalls
      .map(([event]) => event)
      .filter((e: { type: string }) => e.type === 'ACCUMULATED_UPDATED')
      .at(-1);
    expect(lastAccumulated.text).toBe(
      'Here is the full answer, accidentally on the reasoning channel.',
    );
    expect(lastAccumulated.thinking).toBe('');
  });

  it('does not promote reasoning to content when the turn was aborted', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage()]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    mockStreamChat.mockImplementation((_messages, _onToken, onDone, _onError, onThinkingToken) => {
      onThinkingToken?.('Starting to think about this...');
      // Simulate user hitting Stop mid-reasoning. streamAssistantRound
      // resolves with error=null because abort isn't an error.
      ctx.abortRef.current = true;
      onDone();
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await streamAssistantRound(
        0,
        [makeMessage({ id: 'user-1', role: 'user', content: 'Hi', status: 'done' })],
        ctx,
      );

      // Partial reasoning stays in thinkingAccumulated and is NOT surfaced as
      // visible assistant content — the user's intent was to cancel the turn.
      expect(result.accumulated).toBe('');
      expect(result.thinkingAccumulated).toBe('Starting to think about this...');
      expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({
        content: '',
        thinking: 'Starting to think about this...',
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('finalizes plain-text assistant turns without tool calls', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'partial' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);
    const apiMessages: ChatMessage[] = [
      makeMessage({ id: 'user-1', role: 'user', content: 'Explain the bug', status: 'done' }),
    ];

    const result = await processAssistantTurn(
      0,
      'Here is the final answer.',
      'Reasoning summary',
      [],
      apiMessages,
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
    expect(result.nextApiMessages).toEqual(apiMessages);
    expect(result.nextRecoveryState).toEqual({
      diagnosisRetries: 0,
      recoveryAttempted: false,
    });
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({
      content: 'Here is the final answer.',
      thinking: 'Reasoning summary',
      status: 'done',
    });
    expect(dirtyRef.current.has('chat-1')).toBe(true);
  });

  it('injects corrective message and continues when orchestrator claims ungrounded completion', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);
    // No delegation results in the conversation — the "done" claim is ungrounded
    const apiMessages: ChatMessage[] = [
      makeMessage({ id: 'user-1', role: 'user', content: 'Fix the auth bug', status: 'done' }),
    ];

    const result = await processAssistantTurn(
      0,
      'Everything is done and completed.',
      '',
      [],
      apiMessages,
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    // Policy should inject a corrective message and continue the loop
    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);

    // nextApiMessages should include the policy's corrective message
    const lastMsg = result.nextApiMessages.at(-1);
    expect(lastMsg?.role).toBe('user');
    expect(lastMsg?.content).toContain('UNGROUNDED_COMPLETION');

    // Assistant message should be finalized (not stuck in streaming)
    const assistantMsg = conversationsRef.current['chat-1'].messages.at(-1);
    expect(assistantMsg?.status).toBe('done');

    // Conversation should be marked dirty
    expect(dirtyRef.current.has('chat-1')).toBe(true);
  });

  it('blocks completion with a runtime verification message when requirements are unmet', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      getVerificationState: () =>
        makeVerificationState({
          requirements: [
            {
              id: 'typecheck',
              label: 'Run typecheck before claiming done',
              scope: 'always',
              kind: 'command',
              command: 'npx tsc --noEmit',
              status: 'pending',
              updatedAt: 1,
            },
          ],
        }),
    });

    const result = await processAssistantTurn(
      0,
      'Everything is done and completed.',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'Fix the auth bug', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    const lastMsg = result.nextApiMessages.at(-1);
    expect(lastMsg?.role).toBe('user');
    expect(lastMsg?.content).toContain('VERIFICATION_BLOCK');
    expect(lastMsg?.content).toContain('npx tsc --noEmit');
  });

  it('surfaces approval-gated tool calls through the main chat tool path', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      sandboxIdRef: { current: 'sb-123' },
    });

    const result = await processAssistantTurn(
      0,
      '```json\n{"tool":"sandbox_exec","args":{"command":"rm -rf /workspace/tmp-cache"}}\n```',
      '',
      [],
      [
        makeMessage({
          id: 'user-1',
          role: 'user',
          content: 'Clean up the workspace',
          status: 'done',
        }),
      ],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    expect(result.nextApiMessages.at(-1)?.content).toContain('Approval Required');
    expect(result.nextApiMessages.at(-1)?.content).toContain('ask_user');
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.content).toContain(
      'Approval Required',
    );
  });

  it('appends post-tool inject messages to the conversation and next round context', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const injectMessage: ChatMessage = {
      id: 'inject-1',
      role: 'user',
      content: 'Please ground your next step in the structured delegation outcome.',
      timestamp: 2,
    };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      executeDelegateCall: vi.fn().mockResolvedValue({
        text: '[Tool Result — delegate_explorer]\nFound the relevant files.',
        postHookInject: injectMessage,
      }),
    });

    const result = await processAssistantTurn(
      0,
      '```json\n{"tool":"delegate_explorer","args":{"task":"trace the auth flow"}}\n```',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'Trace auth flow', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    expect(result.nextApiMessages.at(-1)).toEqual(injectMessage);
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toEqual(injectMessage);
  });

  it('turns post-tool halts into runtime follow-up messages for the next round', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      executeDelegateCall: vi.fn().mockResolvedValue({
        text: '[Tool Result — delegate_explorer]\nMade partial progress.',
        postHookHalt: 'Stop tool use and summarize what remains before continuing.',
      }),
    });

    const result = await processAssistantTurn(
      0,
      '```json\n{"tool":"delegate_explorer","args":{"task":"trace the auth bug"}}\n```',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'Trace auth bug', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    expect(result.nextApiMessages.at(-1)?.content).toContain('Stop tool use and summarize');
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.content).toContain(
      'Stop tool use and summarize',
    );
    expect(ctx.updateAgentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'Policy halt' }),
      { chatId: 'chat-1' },
    );
  });

  it('does NOT inject when completion is grounded by delegation result', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);
    // Delegation result is present in conversation
    const apiMessages: ChatMessage[] = [
      makeMessage({ id: 'user-1', role: 'user', content: 'Fix the auth bug', status: 'done' }),
      makeMessage({
        id: 'tool-result',
        role: 'user',
        content: '[Tool Result — delegate_coder]\nModified 3 files.',
        status: 'done',
      }),
    ];

    const result = await processAssistantTurn(0, 'The task is done.', '', [], apiMessages, ctx, {
      diagnosisRetries: 0,
      recoveryAttempted: false,
    });

    // Should complete normally — grounded by delegation result
    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // todo tool execution — routed through the chat-hook helper, not the runtime
  // ---------------------------------------------------------------------------

  function makeTodoRef(initial: TodoItem[] = []): {
    ref: { current: TodoHandlers | undefined };
    replaceCalls: TodoItem[][];
    clearCalls: number;
  } {
    const replaceCalls: TodoItem[][] = [];
    let clearCalls = 0;
    const handlers: TodoHandlers = {
      todos: initial,
      replace: (next) => {
        replaceCalls.push(next);
      },
      clear: () => {
        clearCalls += 1;
      },
    };
    return {
      ref: { current: handlers },
      replaceCalls,
      get clearCalls() {
        return clearCalls;
      },
    };
  }

  it('executes todo_write against the todo ref and syncs the canonical list', async () => {
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const todoHarness = makeTodoRef([]);
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      todoRef: todoHarness.ref,
    });

    const toolCall = [
      '```json',
      '{"tool": "todo_write", "todos": [',
      '  {"id": "fix-auth", "content": "Fix the auth bug", "activeForm": "Fixing the auth bug", "status": "in_progress"}',
      ']}',
      '```',
    ].join('\n');

    const result = await processAssistantTurn(
      0,
      toolCall,
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'plan it', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(todoHarness.replaceCalls).toHaveLength(1);
    expect(todoHarness.replaceCalls[0][0].id).toBe('fix-auth');
    // Ref should reflect the canonical list the executor persisted, not the raw args.
    expect(todoHarness.ref.current?.todos.map((t) => t.id)).toEqual(['fix-auth']);
    // Tool result message should appear in the conversation with the success text.
    const lastMsg = result.nextApiMessages.at(-1);
    expect(lastMsg?.content).toContain('Todo updated');
  });

  it('keeps todoRef in sync with the deduped list when the model sends duplicate ids', async () => {
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const todoHarness = makeTodoRef([]);
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      todoRef: todoHarness.ref,
    });

    const toolCall = [
      '```json',
      '{"tool": "todo_write", "todos": [',
      '  {"id": "fix", "content": "Fix A", "activeForm": "Fixing A", "status": "pending"},',
      '  {"id": "fix", "content": "Fix B", "activeForm": "Fixing B", "status": "pending"}',
      ']}',
      '```',
    ].join('\n');

    await processAssistantTurn(
      0,
      toolCall,
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'plan', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    // The ref must mirror what was persisted (suffixed), never the raw args.
    const refIds = todoHarness.ref.current?.todos.map((t) => t.id);
    expect(refIds).toEqual(['fix', 'fix-1']);
    expect(todoHarness.replaceCalls[0].map((t) => t.id)).toEqual(refIds);
  });

  it('clears the todo list via the chat-hook helper on todo_clear', async () => {
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const existing: TodoItem[] = [
      {
        id: 'fix',
        content: 'Fix A',
        activeForm: 'Fixing A',
        status: 'in_progress',
      },
    ];
    const todoHarness = makeTodoRef(existing);
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      todoRef: todoHarness.ref,
    });

    const result = await processAssistantTurn(
      0,
      '```json\n{"tool": "todo_clear"}\n```',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'ship', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(todoHarness.clearCalls).toBe(1);
    expect(result.nextApiMessages.at(-1)?.content).toContain('Todo list cleared');
  });

  it('surfaces an error when a todo tool fires without todoRef being initialized', async () => {
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      todoRef: { current: undefined },
    });

    const result = await processAssistantTurn(
      0,
      '```json\n{"tool": "todo_read"}\n```',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'list', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.nextApiMessages.at(-1)?.content).toContain('Todo list not available');
  });
});
