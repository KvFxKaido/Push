import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { AgentStatus, AttachmentData, ChatMessage, Conversation } from '@/types';
import {
  buildRuntimeUserMessage,
  prepareSendContext,
  type PrepareSendCallbacks,
  type PrepareSendRefs,
} from './chat-prepare-send';
import type { SendMessageOptions } from './useChat';

vi.mock('@/lib/sandbox-start-mode', () => ({
  getSandboxStartMode: vi.fn(() => 'off'),
}));
vi.mock('@/lib/orchestrator', () => ({
  getActiveProvider: vi.fn(() => 'cloudflare'),
  isProviderAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    setLastUsedProvider: vi.fn(),
  };
});
vi.mock('@/lib/verification-policy', () => ({
  getDefaultVerificationPolicy: () => ({ mode: 'auto' }),
}));
vi.mock('./chat-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-persistence')>();
  return {
    ...actual,
    createId: vi.fn(() => 'fixed-id'),
    generateTitle: vi.fn((messages: ChatMessage[]) => `Title from ${messages.length} msgs`),
    shouldPrewarmSandbox: vi.fn(() => false),
  };
});

import { getSandboxStartMode } from '@/lib/sandbox-start-mode';
import { setLastUsedProvider } from '@/lib/providers';
import { shouldPrewarmSandbox } from './chat-persistence';

function makeRefs(initial: Partial<PrepareSendRefs> = {}): PrepareSendRefs {
  return {
    conversationsRef: { current: {} },
    dirtyConversationIdsRef: { current: new Set<string>() },
    sandboxIdRef: { current: null },
    ensureSandboxRef: { current: null },
    abortRef: { current: false },
    abortControllerRef: { current: null },
    ...initial,
  } as PrepareSendRefs;
}

function makeCallbacks(): PrepareSendCallbacks & {
  capturedConversations: Record<string, Conversation>;
  capturedAgentStatusCalls: Array<{ status: AgentStatus; opts?: { chatId?: string } }>;
  setIsStreamingCalls: boolean[];
} {
  const capturedConversations: Record<string, Conversation> = {};
  const capturedAgentStatusCalls: Array<{
    status: AgentStatus;
    opts?: { chatId?: string };
  }> = [];
  const setIsStreamingCalls: boolean[] = [];
  const callbacks: PrepareSendCallbacks = {
    updateConversations: (updater) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: Record<string, Conversation>) => Record<string, Conversation>)(
              capturedConversations,
            )
          : updater;
      Object.assign(capturedConversations, next);
    },
    setIsStreaming: (next) => {
      setIsStreamingCalls.push(typeof next === 'function' ? next(false) : next);
    },
    updateAgentStatus: (status, opts) => {
      capturedAgentStatusCalls.push({ status, opts });
    },
  };
  return Object.assign(callbacks, {
    capturedConversations,
    capturedAgentStatusCalls,
    setIsStreamingCalls,
  });
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'chat-1',
    title: 'Existing',
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSandboxStartMode).mockReturnValue('off');
  vi.mocked(shouldPrewarmSandbox).mockReturnValue(false);
});

describe('buildRuntimeUserMessage', () => {
  it('builds a user message with trimmed content', () => {
    const msg = buildRuntimeUserMessage('  hello  ');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
    expect(msg.status).toBe('done');
    expect(msg.attachments).toBeUndefined();
    expect(msg.displayContent).toBeUndefined();
  });

  it('preserves a displayContent that differs from the trimmed text', () => {
    const msg = buildRuntimeUserMessage('foo', undefined, 'rendered foo');
    expect(msg.displayContent).toBe('rendered foo');
  });

  it('omits displayContent when it matches the trimmed text', () => {
    const msg = buildRuntimeUserMessage('foo', undefined, '  foo  ');
    expect(msg.displayContent).toBeUndefined();
  });

  it('attaches non-empty attachments and drops empty arrays', () => {
    const att: AttachmentData[] = [
      {
        id: 'att-1',
        type: 'image',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        content: 'data',
      },
    ];
    expect(buildRuntimeUserMessage('x', att).attachments).toBe(att);
    expect(buildRuntimeUserMessage('x', []).attachments).toBeUndefined();
  });
});

describe('prepareSendContext — conversation update', () => {
  it('appends user + streaming-assistant messages to a new conversation and generates a title', async () => {
    const refs = makeRefs({ conversationsRef: { current: { 'chat-1': makeConversation() } } });
    const callbacks = makeCallbacks();

    const result = await prepareSendContext(
      {
        trimmedText: 'first message',
        attachments: undefined,
        options: undefined,
        chatId: 'chat-1',
      },
      refs,
      callbacks,
    );

    const conv = callbacks.capturedConversations['chat-1'];
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0].role).toBe('user');
    expect(conv.messages[0].content).toBe('first message');
    expect(conv.messages[1].role).toBe('assistant');
    expect(conv.messages[1].status).toBe('streaming');
    expect(conv.title).toBe('Title from 1 msgs');
    expect(refs.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
    // apiMessages contains user only — the streaming-assistant placeholder is
    // UI state, not part of the round loop's input.
    expect(result.apiMessages).toHaveLength(1);
    expect(result.apiMessages[0].content).toBe('first message');
  });

  it('skipStreamingPlaceholder=true suppresses the placeholder + isStreaming toggle', async () => {
    // PR #434 review fix: the bg-mode main-chat branch returns early
    // after prepareSendContext. Without this opt-out, the streaming
    // placeholder would shadow the JobCard the bg path inserts and
    // isStreaming would never reset — leaving the chat stuck in a
    // streaming state forever. The user message still gets inserted
    // (the bg path needs it in the transcript) and the title still
    // generates (first-message UX is the same regardless of mode).
    const refs = makeRefs({ conversationsRef: { current: { 'chat-1': makeConversation() } } });
    const callbacks = makeCallbacks();

    await prepareSendContext(
      {
        trimmedText: 'first message',
        attachments: undefined,
        options: undefined,
        chatId: 'chat-1',
        skipStreamingPlaceholder: true,
      },
      refs,
      callbacks,
    );

    const conv = callbacks.capturedConversations['chat-1'];
    // User message present, no streaming-assistant placeholder.
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].role).toBe('user');
    expect(conv.messages[0].content).toBe('first message');
    // First-message title generation still fires.
    expect(conv.title).toBe('Title from 1 msgs');
    // setIsStreaming is NOT called when the bg path opts out.
    expect(callbacks.setIsStreamingCalls).toEqual([]);
  });

  it('preserves an existing conversation title (no first-message regeneration)', async () => {
    const refs = makeRefs({
      conversationsRef: {
        current: {
          'chat-1': makeConversation({
            title: 'Keep me',
            messages: [
              { id: 'prior', role: 'user', content: 'prior', timestamp: 1, status: 'done' },
            ],
          }),
        },
      },
    });
    const callbacks = makeCallbacks();

    await prepareSendContext(
      { trimmedText: 'follow-up', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(callbacks.capturedConversations['chat-1'].title).toBe('Keep me');
  });

  it('honors titleOverride over both first-message generation and existing title', async () => {
    const refs = makeRefs({ conversationsRef: { current: { 'chat-1': makeConversation() } } });
    const callbacks = makeCallbacks();
    const options: SendMessageOptions = { titleOverride: 'Forced Title' };

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(callbacks.capturedConversations['chat-1'].title).toBe('Forced Title');
  });

  it('does not re-append when existingUserMessage is supplied (replay/regenerate path)', async () => {
    const replay: ChatMessage = {
      id: 'replay-id',
      role: 'user',
      content: 'replayed text',
      timestamp: 99,
      status: 'done',
    };
    const refs = makeRefs({
      conversationsRef: {
        current: {
          'chat-1': makeConversation({ messages: [replay] }),
        },
      },
    });
    const callbacks = makeCallbacks();
    const options: SendMessageOptions = { existingUserMessage: replay };

    const result = await prepareSendContext(
      { trimmedText: 'replayed text', attachments: undefined, options, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(result.apiMessages).toEqual([replay]);
    // Conversation stays at the prior message + the new streaming assistant —
    // no duplicate of the replayed user message.
    expect(callbacks.capturedConversations['chat-1'].messages).toHaveLength(2);
    expect(callbacks.capturedConversations['chat-1'].messages[0]).toBe(replay);
  });
});

describe('prepareSendContext — provider/model lock', () => {
  it('locks the active provider on a new conversation and persists the choice globally', async () => {
    const refs = makeRefs({ conversationsRef: { current: { 'chat-1': makeConversation() } } });
    const callbacks = makeCallbacks();

    const result = await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(result.lockedProvider).toBe('cloudflare');
    expect(callbacks.capturedConversations['chat-1'].provider).toBe('cloudflare');
    expect(setLastUsedProvider).toHaveBeenCalledWith('cloudflare');
  });

  it('preserves an existing conversation lock without writing to global preferred provider', async () => {
    const refs = makeRefs({
      conversationsRef: {
        current: {
          'chat-1': makeConversation({
            provider: 'openrouter',
            model: 'anthropic/claude-sonnet-4.6',
          }),
        },
      },
    });
    const callbacks = makeCallbacks();

    const result = await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(result.lockedProvider).toBe('openrouter');
    expect(result.resolvedModel).toBe('anthropic/claude-sonnet-4.6');
    // Existing lock stays as-is — no new write to global preferred provider.
    expect(setLastUsedProvider).not.toHaveBeenCalled();
  });
});

describe('prepareSendContext — side effects', () => {
  it('sets the streaming flag, resets abortRef, and assigns a fresh AbortController', async () => {
    const refs = makeRefs({
      abortRef: { current: true },
      abortControllerRef: { current: null },
      conversationsRef: { current: { 'chat-1': makeConversation() } },
    });
    const callbacks = makeCallbacks();

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(callbacks.setIsStreamingCalls).toEqual([true]);
    expect(refs.abortRef.current).toBe(false);
    expect(refs.abortControllerRef.current).toBeInstanceOf(AbortController);
  });
});

describe('prepareSendContext — sandbox prewarm', () => {
  function refsWithEnsure(ensureFn: () => Promise<string | null>) {
    return makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation() } },
      sandboxIdRef: { current: null },
      ensureSandboxRef: { current: ensureFn } as MutableRefObject<
        (() => Promise<string | null>) | null
      >,
    });
  }

  it('prewarms when start mode is "always"', async () => {
    vi.mocked(getSandboxStartMode).mockReturnValue('always');
    const ensure = vi.fn(async () => 'sbx-1');
    const refs = refsWithEnsure(ensure);
    const callbacks = makeCallbacks();

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(ensure).toHaveBeenCalledOnce();
    expect(refs.sandboxIdRef.current).toBe('sbx-1');
    expect(callbacks.capturedAgentStatusCalls[0]).toEqual({
      status: { active: true, phase: 'Starting sandbox...' },
      opts: { chatId: 'chat-1' },
    });
  });

  it('prewarms in "smart" mode only when shouldPrewarmSandbox returns true', async () => {
    vi.mocked(getSandboxStartMode).mockReturnValue('smart');
    vi.mocked(shouldPrewarmSandbox).mockReturnValue(true);
    const ensure = vi.fn(async () => 'sbx-2');
    const refs = refsWithEnsure(ensure);

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      makeCallbacks(),
    );

    expect(ensure).toHaveBeenCalledOnce();

    vi.mocked(shouldPrewarmSandbox).mockReturnValue(false);
    const ensure2 = vi.fn(async () => 'sbx-3');
    const refs2 = refsWithEnsure(ensure2);

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs2,
      makeCallbacks(),
    );

    expect(ensure2).not.toHaveBeenCalled();
  });

  it('skips prewarm when sandbox already exists', async () => {
    vi.mocked(getSandboxStartMode).mockReturnValue('always');
    const ensure = vi.fn(async () => 'sbx-new');
    const refs = refsWithEnsure(ensure);
    refs.sandboxIdRef.current = 'sbx-existing';

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      makeCallbacks(),
    );

    expect(ensure).not.toHaveBeenCalled();
    expect(refs.sandboxIdRef.current).toBe('sbx-existing');
  });

  it('tolerates a prewarm failure and continues', async () => {
    vi.mocked(getSandboxStartMode).mockReturnValue('always');
    const ensure = vi.fn(async () => {
      throw new Error('prewarm boom');
    });
    const refs = refsWithEnsure(ensure);

    const result = await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      makeCallbacks(),
    );

    expect(refs.sandboxIdRef.current).toBeNull();
    // Prepare still completes — caller can decide to lazy-ensure later.
    expect(result.apiMessages).toHaveLength(1);
  });
});
