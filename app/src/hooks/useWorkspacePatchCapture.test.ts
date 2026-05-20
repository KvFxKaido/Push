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

function makeAssistantToolCall(): ChatMessage {
  return {
    id: 'asst-1',
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

    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    const cards = conversations['chat-1'].messages[0].cards ?? [];
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

  it('does not attach a card when the diff is empty', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({ diff: '', truncated: false });
    mockExecInSandbox.mockResolvedValue({ stdout: 'abc\n', exitCode: 0 });

    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    expect(conversations['chat-1'].messages[0].cards ?? []).toHaveLength(0);
  });

  it('skips capture entirely when shouldCapture is false (no Coder this round)', async () => {
    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [],
    });

    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
    expect(mockExecInSandbox).not.toHaveBeenCalled();
    expect(conversations['chat-1'].messages[0].cards ?? []).toHaveLength(0);
  });

  it('skips capture when no sandbox is bound', async () => {
    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: null },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
    expect(conversations['chat-1'].messages[0].cards ?? []).toHaveLength(0);
  });

  it('skips capture in scratch mode (no repo or no branch)', async () => {
    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: null },
      branchInfoRef: { current: undefined },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    expect(mockFetchSandboxDiffWithMeta).not.toHaveBeenCalled();
  });

  it('logs but does not attach a card when capture throws', async () => {
    mockFetchSandboxDiffWithMeta.mockRejectedValue(new Error('sandbox is gone'));
    mockExecInSandbox.mockResolvedValue({ stdout: 'abc\n', exitCode: 0 });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('[WorkspacePatchCapture] capture failed'),
      expect.any(Error),
      expect.objectContaining({ chatId: 'chat-1', round: 0 }),
    );
    expect(conversations['chat-1'].messages[0].cards ?? []).toHaveLength(0);

    debug.mockRestore();
  });

  it('logs and skips when git rev-parse produces empty output', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({
      diff: 'diff --git a/x b/x\n+new\n',
      truncated: false,
    });
    mockExecInSandbox.mockResolvedValue({ stdout: '', exitCode: 0 });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('git rev-parse HEAD produced no output'),
      expect.objectContaining({ chatId: 'chat-1', round: 0 }),
    );
    expect(conversations['chat-1'].messages[0].cards ?? []).toHaveLength(0);

    debug.mockRestore();
  });

  it('preserves the truncated flag from the diff capture', async () => {
    mockFetchSandboxDiffWithMeta.mockResolvedValue({
      diff: 'truncated diff content',
      truncated: true,
    });
    mockExecInSandbox.mockResolvedValue({ stdout: 'sha\n', exitCode: 0 });

    let conversations: Record<string, Conversation> = {
      'chat-1': makeConversation([makeAssistantToolCall()]),
    };
    const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
      sandboxIdRef: { current: 'sb-1' },
      repoRef: { current: 'kvfxkaido/push' },
      branchInfoRef: { current: { currentBranch: 'feature/x' } },
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
    });

    await captureWorkspacePatchAtRoundEnd({
      chatId: 'chat-1',
      round: 0,
      outcome: 'completed',
      roundEvents: [coderCompletedEvent()],
    });

    const card = conversations['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.truncated).toBe(true);
  });
});
