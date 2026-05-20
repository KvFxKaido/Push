import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage, Conversation, RunEventInput } from '@/types';

const { mockExecInSandbox, mockFetchSandboxDiffWithMeta } = vi.hoisted(() => ({
  mockExecInSandbox: vi.fn(),
  mockFetchSandboxDiffWithMeta: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

vi.mock('@/lib/sandbox-client', () => ({
  execInSandbox: (...args: unknown[]) => mockExecInSandbox(...args),
  fetchSandboxDiffWithMeta: (...args: unknown[]) => mockFetchSandboxDiffWithMeta(...args),
}));

const { shouldCaptureWorkspacePatch, useWorkspacePatchCapture } = await import(
  './useWorkspacePatchCapture'
);

function makeConversation(messages: ChatMessage[]): Conversation {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages,
    createdAt: 1,
    lastMessageAt: 1,
  };
}

function makeAssistantToolCall(id = 'asst-1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'done',
    isToolCall: true,
    cards: [],
  };
}

function coderCompletedEvent(): RunEventInput {
  return {
    type: 'subagent.completed',
    executionId: 'exec-1',
    agent: 'coder',
    summary: 'done',
  };
}

interface HarnessOptions {
  initialMessages?: ChatMessage[];
  sandboxId?: string | null;
  repoFullName?: string | null;
  branch?: string;
}

function makeHarness(opts: HarnessOptions = {}) {
  let conversations: Record<string, Conversation> = {
    'chat-1': makeConversation(opts.initialMessages ?? [makeAssistantToolCall()]),
  };
  const dirtyConversationIdsRef = { current: new Set<string>() };
  // eslint-disable-next-line react-hooks/rules-of-hooks -- test harness invokes the hook outside React; the mocked `useCallback` makes this safe.
  const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
    sandboxIdRef: { current: opts.sandboxId === undefined ? 'sb-1' : opts.sandboxId },
    repoRef: { current: opts.repoFullName === undefined ? 'kvfxkaido/push' : opts.repoFullName },
    branchInfoRef: {
      current:
        opts.branch === undefined ? { currentBranch: 'feature/x' } : { currentBranch: opts.branch },
    },
    setConversations: (updater) => {
      conversations = typeof updater === 'function' ? updater(conversations) : updater;
    },
    dirtyConversationIdsRef,
  });
  return {
    captureWorkspacePatchAtRoundEnd,
    getConversations: () => conversations,
    dirtyConversationIdsRef,
  };
}

afterEach(() => {
  mockExecInSandbox.mockReset();
  mockFetchSandboxDiffWithMeta.mockReset();
});

describe('shouldCaptureWorkspacePatch', () => {
  it('returns true when the round emitted subagent.completed with agent=coder', () => {
    expect(
      shouldCaptureWorkspacePatch({
        chatId: 'chat-1',
        round: 0,
        outcome: 'completed',
        roundEvents: [coderCompletedEvent()],
        assistantToolCallMessageId: 'asst-1',
      }),
    ).toBe(true);
  });

  it('returns false when no coder subagent completed during the round', () => {
    expect(
      shouldCaptureWorkspacePatch({
        chatId: 'chat-1',
        round: 0,
        outcome: 'completed',
        roundEvents: [
          { type: 'subagent.completed', executionId: 'x', agent: 'explorer', summary: 'done' },
          { type: 'assistant.turn_end', round: 0, outcome: 'completed' },
        ],
        assistantToolCallMessageId: 'asst-1',
      }),
    ).toBe(false);
  });

  it('returns false on an empty event list', () => {
    expect(
      shouldCaptureWorkspacePatch({
        chatId: 'chat-1',
        round: 0,
        outcome: 'completed',
        roundEvents: [],
        assistantToolCallMessageId: 'asst-1',
      }),
    ).toBe(false);
  });
});

describe('useWorkspacePatchCapture', () => {
  it('attaches a workspace-patch card when Coder ran and the diff is non-empty', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({
      diff: 'diff --git a/x b/x\n+new\n',
      truncated: false,
    });
    mockExecInSandbox.mockResolvedValue({
      stdout: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n',
      exitCode: 0,
    });

    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    const cards = harness.getConversations()['chat-1'].messages[0].cards ?? [];
    expect(cards).toHaveLength(1);
    const card = cards[0] as Extract<ChatCard, { type: 'workspace-patch' }>;
    expect(card.type).toBe('workspace-patch');
    expect(card.data).toMatchObject({
      schemaVersion: 1,
      repoFullName: 'kvfxkaido/push',
      branch: 'feature/x',
      baseSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      diffBytes: 'diff --git a/x b/x\n+new\n',
      truncated: false,
      applyState: { kind: 'pending' },
    });
    expect(card.data.capturedAt).toEqual(expect.any(Number));
  });

  it('marks the conversation dirty so persistence flushes the new card', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({ diff: 'd', truncated: false });
    mockExecInSandbox.mockResolvedValue({ stdout: 'sha\n', exitCode: 0 });

    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
  });

  it('targets the snapshotted message id even when a newer tool-call has been added', async () => {
    // The race Codex / Copilot flagged: capture is fire-and-forget. While
    // it awaits the diff, a later round appends a newer assistant tool-call.
    // The card must still land on the *original* round's message.
    mockFetchSandboxDiffWithMeta.mockResolvedValue({ diff: 'd', truncated: false });
    mockExecInSandbox.mockResolvedValue({ stdout: 'sha\n', exitCode: 0 });

    const original = makeAssistantToolCall('asst-original');
    const later = makeAssistantToolCall('asst-later');
    const harness = makeHarness({ initialMessages: [original, later] });

    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-original',
    });

    const messages = harness.getConversations()['chat-1'].messages;
    expect(messages[0].cards).toHaveLength(1);
    expect(messages[1].cards).toEqual([]);
  });

  it('skips silently when the target message has been deleted', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({ diff: 'd', truncated: false });
    mockExecInSandbox.mockResolvedValue({ stdout: 'sha\n', exitCode: 0 });

    const harness = makeHarness({ initialMessages: [makeAssistantToolCall('asst-still-here')] });

    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-gone',
    });

    const messages = harness.getConversations()['chat-1'].messages;
    expect(messages[0].cards).toEqual([]);
    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(false);
  });

  it('logs and skips when assistantToolCallMessageId is null', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const harness = makeHarness();

    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: null,
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('no assistant tool-call message id'),
      expect.objectContaining({ chatId: 'chat-1', round: 0 }),
    );
    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
    debug.mockRestore();
  });

  it('does not attach a card when the diff is empty', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({ diff: '', truncated: false });
    mockExecInSandbox.mockResolvedValue({ stdout: 'abc\n', exitCode: 0 });

    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(harness.getConversations()['chat-1'].messages[0].cards ?? []).toHaveLength(0);
    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(false);
  });

  it('skips capture entirely when shouldCapture is false (no Coder this round)', async () => {
    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
    expect(mockExecInSandbox).not.toHaveBeenCalled();
    expect(harness.getConversations()['chat-1'].messages[0].cards ?? []).toHaveLength(0);
  });

  it('skips capture when no sandbox is bound', async () => {
    const harness = makeHarness({ sandboxId: null });
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
    expect(harness.getConversations()['chat-1'].messages[0].cards ?? []).toHaveLength(0);
  });

  it('skips capture in scratch mode (no repo)', async () => {
    const harness = makeHarness({ repoFullName: null });
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
  });

  it('logs but does not attach a card when capture throws', async () => {
    mockFetchSandboxDiffWithMeta.mockRejectedValue(new Error('sandbox is gone'));
    mockExecInSandbox.mockResolvedValue({ stdout: 'abc\n', exitCode: 0 });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('[WorkspacePatchCapture] capture failed'),
      expect.any(Error),
      expect.objectContaining({ chatId: 'chat-1', round: 0 }),
    );
    expect(harness.getConversations()['chat-1'].messages[0].cards ?? []).toHaveLength(0);

    debug.mockRestore();
  });

  it('logs and skips when git rev-parse produces empty output', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({
      diff: 'diff --git a/x b/x\n+new\n',
      truncated: false,
    });
    mockExecInSandbox.mockResolvedValue({ stdout: '', exitCode: 0 });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('git rev-parse HEAD produced no output'),
      expect.objectContaining({ chatId: 'chat-1', round: 0 }),
    );
    expect(harness.getConversations()['chat-1'].messages[0].cards ?? []).toHaveLength(0);

    debug.mockRestore();
  });

  it('preserves the truncated flag from the diff capture', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({
      diff: 'truncated diff content',
      truncated: true,
    });
    mockExecInSandbox.mockResolvedValue({ stdout: 'sha\n', exitCode: 0 });

    const harness = makeHarness();
    await harness.captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
      assistantToolCallMessageId: 'asst-1',
    });

    const card = harness.getConversations()['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.truncated).toBe(true);
  });
});
