import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, VerificationRuntimeState } from '@/types';
import { setApprovalMode } from '@/lib/approval-mode';

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

function makeVerificationState(overrides: Partial<VerificationRuntimeState> = {}): VerificationRuntimeState {
  return {
    policyName: 'Test',
    backendTouched: false,
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
    scratchpadRef: { current: undefined },
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

    mockStreamChat.mockImplementation(
      (
        _messages,
        onToken,
        onDone,
        _onError,
        onThinkingToken,
      ) => {
        onThinkingToken?.('Need to inspect');
        onToken('Hello');
        onToken(' world');
        onDone({ inputTokens: 11, outputTokens: 7 });
      },
    );

    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'Hi', status: 'done' })],
      ctx,
    );

    expect(result).toEqual({
      accumulated: 'Hello world',
      thinkingAccumulated: 'Need to inspect',
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
      getVerificationState: () => makeVerificationState({
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
      [makeMessage({ id: 'user-1', role: 'user', content: 'Clean up the workspace', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    expect(result.nextApiMessages.at(-1)?.content).toContain('Approval Required');
    expect(result.nextApiMessages.at(-1)?.content).toContain('ask_user');
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.content).toContain('Approval Required');
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
      [makeMessage({ id: 'user-1', role: 'user', content: 'Trace auth bug', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    expect(result.nextApiMessages.at(-1)?.content).toContain('Stop tool use and summarize');
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.content).toContain('Stop tool use and summarize');
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
      makeMessage({ id: 'tool-result', role: 'user', content: '[Tool Result — delegate_coder]\nModified 3 files.', status: 'done' }),
    ];

    const result = await processAssistantTurn(
      0,
      'The task is done.',
      '',
      apiMessages,
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    // Should complete normally — grounded by delegation result
    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
  });
});
