import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, VerificationRuntimeState } from '@/types';
import { setApprovalMode } from '@/lib/approval-mode';
import type { TodoItem } from '@/lib/todo-tools';
import type { TodoHandlers } from './chat-send';
import { createRuntimeContext } from '@push/lib/runtime-context';

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
    workspaceContextRef: { current: null },
    runtimeHandlersRef: { current: undefined },
    repoRef: { current: null },
    isMainProtectedRef: { current: false },
    branchInfoRef: { current: undefined },
    runtimeContext: createRuntimeContext({ correlation: { surface: 'web', chatId: 'chat-1' } }),
    checkpointRefs: {
      apiMessages: { current: [] },
    },
    processedContentRef: { current: new Set<string>() },
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
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

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
      ['Thinking…', 'Reasoning…'],
    );

    expect(result).toEqual({
      accumulated: 'Hello world',
      thinkingAccumulated: 'Need to inspect',
      reasoningBlocks: [],
      nativeToolCalls: [],
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
  });

  it('collects provider-native tool calls separately from streamed text', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage()]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    mockStreamChat.mockImplementation((...args: unknown[]) => {
      const onDone = args[2] as (usage?: unknown) => void;
      const onNativeToolCall = args.at(-1) as
        | ((call: { id: string; name: string; args: Record<string, unknown> }) => void)
        | undefined;
      onNativeToolCall?.({
        id: 'call_1',
        name: 'sandbox_read_file',
        args: { path: 'README.md' },
      });
      onDone({ inputTokens: 5, outputTokens: 2 });
    });

    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'Read README', status: 'done' })],
      ctx,
      ['Thinking…'],
    );

    expect(result).toEqual({
      accumulated: '',
      thinkingAccumulated: '',
      reasoningBlocks: [],
      nativeToolCalls: [{ id: 'call_1', name: 'sandbox_read_file', args: { path: 'README.md' } }],
      error: null,
    });
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({
      content: '',
      status: 'streaming',
    });
  });

  it('promotes a reasoning-only answer to content (stranded-answer salvage)', async () => {
    // Kimi-k2.7 (Workers AI) failure mode: the entire final answer lands on the
    // reasoning channel with empty response content. Without promotion the turn
    // finalizes blank and the answer is dropped. The stream layer promotes it.
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const answer = 'Short answer: yes, but Ollama is a different beast.';
    mockStreamChat.mockImplementation((_messages, _onToken, onDone, _onError, onThinkingToken) => {
      onThinkingToken?.(answer);
      onDone({ inputTokens: 5, outputTokens: 9 });
    });

    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'does ollama work?', status: 'done' })],
      ctx,
      ['Thinking…'],
    );

    expect(result.accumulated).toBe(answer);
    expect(result.thinkingAccumulated).toBe('');
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({ content: answer });
  });

  it('does NOT promote a tool call emitted in the reasoning channel', async () => {
    // A `{"tool": ...}` call placed in reasoning must NOT be promoted into
    // content — promoting it would feed it to the dispatcher and execute an
    // untrusted reasoning-channel call. It stays in `thinkingAccumulated` so
    // `detectAnyToolCall(accumulated)` is null downstream and processNoToolPath's
    // buried-call recovery nudges TOOL_CALL_IN_REASONING instead of running it.
    // Uses sandbox_exec — a web-recognized, side-effecting tool — so this is the
    // meaningful case the guard exists to prevent (an unrecognized tool name
    // would be inert prose either way).
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const reasoningCall = '```json\n{"tool":"sandbox_exec","args":{"command":"npm test"}}\n```';
    mockStreamChat.mockImplementation((_messages, _onToken, onDone, _onError, onThinkingToken) => {
      onThinkingToken?.(reasoningCall);
      onDone({ inputTokens: 5, outputTokens: 9 });
    });

    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'read the readme', status: 'done' })],
      ctx,
      ['Thinking…'],
    );

    expect(result.accumulated).toBe('');
    expect(result.thinkingAccumulated).toBe(reasoningCall);
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
      ['Thinking…', 'Reasoning…'],
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
      ['Thinking…', 'Reasoning…'],
    );
    warnSpy.mockRestore();

    expect(result).toEqual({
      accumulated: 'Here is the full answer, accidentally on the reasoning channel.',
      thinkingAccumulated: '',
      reasoningBlocks: [],
      nativeToolCalls: [],
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

  it('does NOT promote reasoning when the turn carried a native tool call (preserves thinking)', async () => {
    // DeepSeek thinking + a native tool call emits reasoning and NO prose, so
    // `accumulated` is empty — but that's "the call is in nativeToolCalls", not
    // "the answer is stranded in reasoning". Promoting here would mislabel the
    // reasoning as the answer AND clear `thinking`, dropping the reasoning_content
    // DeepSeek requires on the next tool-result turn → 400. (Codex P1, #1193.)
    const conversationsRef = { current: makeConversation([makeMessage()]) };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const reasoning = 'I should read the file before answering.';
    mockStreamChat.mockImplementation((...args: unknown[]) => {
      const onDone = args[2] as (usage?: unknown) => void;
      const onThinkingToken = args[4] as ((t: string | null) => void) | undefined;
      const onNativeToolCall = args.at(-1) as
        | ((call: { id: string; name: string; args: Record<string, unknown> }) => void)
        | undefined;
      onThinkingToken?.(reasoning);
      onNativeToolCall?.({ id: 'call_1', name: 'sandbox_read_file', args: { path: 'README.md' } });
      onDone({ inputTokens: 5, outputTokens: 2 });
    });

    const result = await streamAssistantRound(
      0,
      [makeMessage({ id: 'user-1', role: 'user', content: 'Read README', status: 'done' })],
      ctx,
      ['Thinking…'],
    );

    // Reasoning stays in thinking (not promoted to content) so it's available to
    // replay as reasoning_content on the next turn.
    expect(result.accumulated).toBe('');
    expect(result.thinkingAccumulated).toBe(reasoning);
    expect(result.nativeToolCalls).toEqual([
      { id: 'call_1', name: 'sandbox_read_file', args: { path: 'README.md' } },
    ]);
    expect(conversationsRef.current['chat-1'].messages.at(-1)).toMatchObject({
      thinking: reasoning,
    });
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
        ['Thinking…', 'Reasoning…'],
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

  it('nudges and continues when the turn announces an action but emits no tool call', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);
    const apiMessages: ChatMessage[] = [
      makeMessage({ id: 'user-1', role: 'user', content: 'Audit the docs', status: 'done' }),
    ];

    const result = await processAssistantTurn(
      0,
      "The docs look healthy.\n\nLet's read docs/decisions/README.md to check the status labels.",
      '',
      [],
      apiMessages,
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    const lastMsg = result.nextApiMessages.at(-1);
    expect(lastMsg?.role).toBe('user');
    expect(lastMsg?.content).toContain('ANNOUNCED_NO_ACTION');
    // Counter advances so the loop can't spin forever on a narrating model.
    expect(result.nextRecoveryState.trailingIntentNudges).toBe(1);
    // Assistant message is finalized, not left streaming.
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.status).toBe('done');
  });

  it('stops nudging announced-action turns once the per-run cap is reached', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const result = await processAssistantTurn(
      0,
      "Let's read docs/decisions/README.md to check the status labels.",
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'Audit the docs', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false, trailingIntentNudges: 3 },
    );

    // Cap reached — let the turn break instead of looping forever.
    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
  });

  it('does NOT nudge a plain prose conclusion with no announced action', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const result = await processAssistantTurn(
      0,
      'The documentation is healthy and nothing needs updating right now.',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'Audit the docs', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
  });

  it('nudges and continues when a tool call is buried in the reasoning channel', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);
    const apiMessages: ChatMessage[] = [
      makeMessage({
        id: 'user-1',
        role: 'user',
        content: 'What changed recently?',
        status: 'done',
      }),
    ];

    const result = await processAssistantTurn(
      0,
      // Content has no tool call — just a narrated (ungrounded) summary.
      'Here is a summary of recent activity.',
      // The actual tool call is buried in the reasoning channel, which the
      // dispatcher never scans (the Kimi K2.x failure mode).
      'Let me check the project state. {"tool":"sandbox_read_file","args":{"path":"TODO.md"}}',
      [],
      apiMessages,
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('continue');
    expect(result.loopCompletedNormally).toBe(false);
    const lastMsg = result.nextApiMessages.at(-1);
    expect(lastMsg?.role).toBe('user');
    expect(lastMsg?.content).toContain('TOOL_CALL_IN_REASONING');
    // Counter advances so a model that keeps burying calls can't spin forever.
    expect(result.nextRecoveryState.reasoningToolCallNudges).toBe(1);
    // Assistant message is finalized, not left streaming.
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.status).toBe('done');
  });

  it('stops nudging reasoning-channel tool calls once the per-run cap is reached', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const result = await processAssistantTurn(
      0,
      'Here is a summary of recent activity.',
      'Let me check. {"tool":"sandbox_read_file","args":{"path":"TODO.md"}}',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'What changed?', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false, reasoningToolCallNudges: 2 },
    );

    // Cap reached — let the turn break instead of looping forever.
    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
  });

  it('does NOT nudge when the reasoning channel has no tool call', async () => {
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef);

    const result = await processAssistantTurn(
      0,
      'Here is the final answer.',
      // Plain reasoning prose — no tool-call shape, so the guard must not fire.
      'I considered reading TODO.md but I already have enough context.',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'What changed?', status: 'done' })],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    expect(result.loopAction).toBe('break');
    expect(result.loopCompletedNormally).toBe(true);
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

  it('allows sandbox_exec from the orchestrator chat path (Coder Delegation Collapse)', async () => {
    // The orchestrator is the single capable lead now (lib/capabilities.ts):
    // sandbox:exec is in its grant, so the role-capability kernel gate no longer
    // blocks the call. It proceeds past the role check (to the approval/exec
    // path) instead of returning ROLE_CAPABILITY_DENIED — the lead runs commands
    // itself rather than delegating.
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      sandboxIdRef: { current: 'sb-123' },
    });

    const result = await processAssistantTurn(
      0,
      '```json\n{"tool":"sandbox_exec","args":{"command":"npm test"}}\n```',
      '',
      [],
      [
        makeMessage({
          id: 'user-1',
          role: 'user',
          content: 'Run the tests',
          status: 'done',
        }),
      ],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    // No role-capability denial: the lead is allowed to exec.
    const lastApiMsg = result.nextApiMessages.at(-1)?.content ?? '';
    expect(lastApiMsg).not.toContain('ROLE_CAPABILITY_DENIED');
    expect(conversationsRef.current['chat-1'].messages.at(-1)?.content ?? '').not.toContain(
      'ROLE_CAPABILITY_DENIED',
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

  it('carries the turn thinking onto the wire assistant tool-call message (DeepSeek reasoning_content replay)', async () => {
    // DeepSeek thinking mode 400s the tool-result continuation request unless
    // the assistant turn that made the call echoes its `reasoning_content`. The
    // orchestrator emits that from `msg.thinking` on the route-gated DeepSeek
    // path — so the tool-call message pushed into nextApiMessages must carry
    // `thinking`, not just the displayed copy. It previously carried only the
    // signed `reasoningBlocks` sidecar, dropping plain reasoning → the wire
    // turn was `tool_calls` without `reasoning_content` (the 400 culprit).
    const conversationsRef = {
      current: makeConversation([makeMessage({ content: 'streaming...' })]),
    };
    const dirtyRef = { current: new Set<string>() };
    const ctx = makeLoopContext(conversationsRef, dirtyRef, {
      executeDelegateCall: vi.fn().mockResolvedValue({
        text: '[Tool Result — delegate_explorer]\nFound the relevant files.',
      }),
    });

    const reasoning = 'Let me inspect the recent commits before answering.';
    const result = await processAssistantTurn(
      0,
      '```json\n{"tool":"delegate_explorer","args":{"task":"trace the auth flow"}}\n```',
      reasoning,
      [],
      [
        makeMessage({
          id: 'user-1',
          role: 'user',
          content: 'What changed recently?',
          status: 'done',
        }),
      ],
      ctx,
      { diagnosisRetries: 0, recoveryAttempted: false },
    );

    const wireAssistant = result.nextApiMessages.find(
      (m) => m.role === 'assistant' && (m.toolUses?.length ?? 0) > 0,
    );
    expect(wireAssistant?.thinking).toBe(reasoning);
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
