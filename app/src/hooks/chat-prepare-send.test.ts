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
  };
});

vi.mock('@/lib/first-prompt-branch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/first-prompt-branch')>();
  return { ...actual, maybeBranchOnFirstPrompt: vi.fn(async () => ({ branched: false })) };
});

import { setLastUsedProvider } from '@/lib/providers';
import { maybeBranchOnFirstPrompt } from '@/lib/first-prompt-branch';
import type { FirstPromptBranchDeps } from './chat-prepare-send';

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

  it('always prewarms when a sandbox can be ensured (start-mode setting removed)', async () => {
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
    // The prewarm is silent — no "Starting sandbox..." agent event (it would
    // pollute chat-mode history, where ensureSandbox resolves to null).
    expect(
      callbacks.capturedAgentStatusCalls.some((c) => c.status.phase === 'Starting sandbox...'),
    ).toBe(false);
  });

  it('prewarms silently even when ensureSandbox resolves null (chat mode — no phantom status)', async () => {
    const ensure = vi.fn(async () => null);
    const refs = refsWithEnsure(ensure);
    const callbacks = makeCallbacks();

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(ensure).toHaveBeenCalledOnce();
    expect(refs.sandboxIdRef.current).toBeNull();
    expect(
      callbacks.capturedAgentStatusCalls.some((c) => c.status.phase === 'Starting sandbox...'),
    ).toBe(false);
  });

  it('does not prewarm when no ensureSandbox is wired (e.g. pure chat)', async () => {
    const refs = makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation() } },
      sandboxIdRef: { current: null },
      ensureSandboxRef: { current: null },
    });
    const callbacks = makeCallbacks();

    await prepareSendContext(
      { trimmedText: 'x', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      callbacks,
    );

    expect(refs.sandboxIdRef.current).toBeNull();
  });

  it('skips prewarm when sandbox already exists', async () => {
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

describe('prepareSendContext — branch-on-first-prompt wiring', () => {
  function makeBranchDeps(
    branchInfo: { currentBranch?: string; defaultBranch?: string } = {
      currentBranch: 'main',
      defaultBranch: 'main',
    },
  ): FirstPromptBranchDeps {
    return {
      repoFullName: 'owner/repo',
      branchInfoRef: { current: branchInfo },
      skipAutoCreateRef: { current: null },
      runtimeHandlersRef: { current: undefined },
    };
  }

  it('invokes maybeBranchOnFirstPrompt with the post-prewarm sandbox id on a first message', async () => {
    const refs = makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation({ messages: [] }) } },
      ensureSandboxRef: { current: vi.fn(async () => 'sb-99') },
    });
    await prepareSendContext(
      {
        trimmedText: 'Add a feature',
        attachments: undefined,
        options: undefined,
        chatId: 'chat-1',
      },
      refs,
      makeCallbacks(),
      makeBranchDeps(),
    );
    expect(maybeBranchOnFirstPrompt).toHaveBeenCalledTimes(1);
    const [input, migrationCtx] = vi.mocked(maybeBranchOnFirstPrompt).mock.calls[0];
    expect(input.isFirstMessage).toBe(true);
    expect(input.sandboxId).toBe('sb-99'); // resolved by the prewarm above
    expect(input.promptText).toBe('Add a feature');
    expect(input.repoFullName).toBe('owner/repo');
    // Migration targets THIS send's chat, not whatever activeChatIdRef holds.
    expect(migrationCtx.activeChatIdRef.current).toBe('chat-1');
  });

  it('passes isFirstMessage:false for a follow-up so the helper no-ops', async () => {
    const existing: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'done',
    };
    const refs = makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation({ messages: [existing] }) } },
      ensureSandboxRef: { current: vi.fn(async () => 'sb-99') },
    });
    await prepareSendContext(
      { trimmedText: 'second', attachments: undefined, options: undefined, chatId: 'chat-1' },
      refs,
      makeCallbacks(),
      makeBranchDeps(),
    );
    expect(vi.mocked(maybeBranchOnFirstPrompt).mock.calls[0][0].isFirstMessage).toBe(false);
  });

  it('appends the streaming placeholder after the branch divider, not before (P1)', async () => {
    const refs = makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation({ messages: [] }) } },
      ensureSandboxRef: { current: vi.fn(async () => 'sb-99') },
    });
    const callbacks = makeCallbacks();
    // Simulate a successful fork: the migration appends a `branch_forked`
    // divider as the last message, the way applyBranchSwitchPayload would.
    vi.mocked(maybeBranchOnFirstPrompt).mockImplementationOnce(async (_input, ctx) => {
      ctx.setConversations((prev) => {
        const conv = prev['chat-1'];
        const divider: ChatMessage = {
          id: 'divider',
          role: 'assistant',
          content: '',
          timestamp: 2,
          status: 'done',
        };
        return { ...prev, 'chat-1': { ...conv, messages: [...conv.messages, divider] } };
      });
      return { branched: true, name: 'owner-repo/add-a-feature' };
    });

    await prepareSendContext(
      {
        trimmedText: 'Add a feature',
        attachments: undefined,
        options: undefined,
        chatId: 'chat-1',
      },
      refs,
      callbacks,
      makeBranchDeps(),
    );

    const msgs = callbacks.capturedConversations['chat-1'].messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    // The divider is not last; the streaming placeholder is, so the stream
    // writes deltas into the placeholder rather than the divider.
    expect(msgs[1].id).toBe('divider');
    expect(msgs[msgs.length - 1].status).toBe('streaming');
  });

  it('keeps the immediate streaming placeholder when starting on a non-default branch', async () => {
    // A session started on an existing branch (currentBranch unknown here) must
    // not defer its placeholder: the fork won't fire, so deferring would leave
    // an empty spinner with no divider ever arriving.
    const refs = makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation({ messages: [] }) } },
      ensureSandboxRef: { current: vi.fn(async () => 'sb-99') },
    });
    const callbacks = makeCallbacks();
    await prepareSendContext(
      {
        trimmedText: 'Add a feature',
        attachments: undefined,
        options: undefined,
        chatId: 'chat-1',
      },
      refs,
      callbacks,
      makeBranchDeps({ currentBranch: undefined, defaultBranch: 'main' }),
    );
    // user + immediately-appended streaming assistant placeholder.
    const msgs = callbacks.capturedConversations['chat-1'].messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[msgs.length - 1].status).toBe('streaming');
  });

  it('skips branching entirely when no branchDeps are provided', async () => {
    const refs = makeRefs({
      conversationsRef: { current: { 'chat-1': makeConversation({ messages: [] }) } },
      ensureSandboxRef: { current: vi.fn(async () => 'sb-99') },
    });
    await prepareSendContext(
      {
        trimmedText: 'Add a feature',
        attachments: undefined,
        options: undefined,
        chatId: 'chat-1',
      },
      refs,
      makeCallbacks(),
    );
    expect(maybeBranchOnFirstPrompt).not.toHaveBeenCalled();
  });
});
