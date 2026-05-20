import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage, Conversation } from '@/types';
import type { WorkspacePatchApplyState } from '@push/lib/protocol-schema';

const { mockReplayWorkspacePatch } = vi.hoisted(() => ({
  mockReplayWorkspacePatch: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

vi.mock('@/lib/sandbox-patch', () => ({
  replayWorkspacePatch: (...args: unknown[]) => mockReplayWorkspacePatch(...args),
}));

// We don't need real sandbox-client behavior for these tests — only the
// replay engine matters here. Stub the imports so the module loads.
vi.mock('@/lib/sandbox-client', () => ({
  execInSandbox: vi.fn(),
  fetchSandboxDiffWithMeta: vi.fn(),
}));

const { useWorkspacePatchReplay } = await import('./useWorkspacePatchCapture');

function workspacePatchCard(
  overrides: Partial<Extract<ChatCard, { type: 'workspace-patch' }>['data']> = {},
): ChatCard {
  return {
    type: 'workspace-patch',
    data: {
      schemaVersion: 1,
      repoFullName: 'kvfxkaido/push',
      branch: 'feature/x',
      baseSha: 'base-sha-001',
      diffBytes: 'diff --git a/x b/x\n+new\n',
      truncated: false,
      capturedAt: 1_712_345_678_901,
      applyState: { kind: 'pending' },
      ...overrides,
    },
  };
}

function assistantMessageWithCards(id: string, cards: ChatCard[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'done',
    isToolCall: true,
    cards,
  };
}

function makeHarness(initialMessages: ChatMessage[]) {
  let conversations: Record<string, Conversation> = {
    'chat-1': {
      id: 'chat-1',
      title: 'Chat',
      messages: initialMessages,
      createdAt: 1,
      lastMessageAt: 1,
    },
  };
  const dirtyConversationIdsRef = { current: new Set<string>() };
  // eslint-disable-next-line react-hooks/rules-of-hooks -- test harness invokes the hook outside React; the mocked `useCallback` makes this safe.
  const { replayOnFreshSandbox } = useWorkspacePatchReplay({
    setConversations: (updater) => {
      conversations = typeof updater === 'function' ? updater(conversations) : updater;
    },
    dirtyConversationIdsRef,
  });
  return {
    replayOnFreshSandbox,
    getConversations: () => conversations,
    dirtyConversationIdsRef,
  };
}

afterEach(() => {
  mockReplayWorkspacePatch.mockReset();
});

describe('useWorkspacePatchReplay', () => {
  it('transitions the latest pending card to applied on success', async () => {
    const appliedState: WorkspacePatchApplyState = { kind: 'applied', appliedAt: 1234 };
    mockReplayWorkspacePatch.mockResolvedValue(appliedState);

    const harness = makeHarness([assistantMessageWithCards('asst-1', [workspacePatchCard()])]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    const card = harness.getConversations()['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.applyState).toEqual(appliedState);
    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
  });

  it("preserves the 'already-applied' note when the reverse-check guard hits", async () => {
    mockReplayWorkspacePatch.mockResolvedValue({
      kind: 'applied',
      appliedAt: 1234,
      note: 'already-applied',
    });

    const harness = makeHarness([assistantMessageWithCards('asst-1', [workspacePatchCard()])]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    const card = harness.getConversations()['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.applyState).toMatchObject({ kind: 'applied', note: 'already-applied' });
  });

  it('transitions to refused on base-mismatch', async () => {
    mockReplayWorkspacePatch.mockResolvedValue({ kind: 'refused', reason: 'base-mismatch' });

    const harness = makeHarness([assistantMessageWithCards('asst-1', [workspacePatchCard()])]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    const card = harness.getConversations()['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.applyState).toEqual({ kind: 'refused', reason: 'base-mismatch' });
  });

  it('transitions to conflict when the replay engine reports one', async () => {
    mockReplayWorkspacePatch.mockResolvedValue({
      kind: 'conflict',
      detail: 'with conflicts on file.ts',
    });

    const harness = makeHarness([assistantMessageWithCards('asst-1', [workspacePatchCard()])]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    const card = harness.getConversations()['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.applyState).toMatchObject({ kind: 'conflict' });
  });

  it('targets the latest pending card *within* a single message (not the first)', async () => {
    // Codex/Copilot review on #597: the reverse-scan finds the latest
    // pending card but a forward `find` would re-target the *first*
    // one if multiple pending cards live on one message. Index-based
    // targeting must keep them aligned.
    mockReplayWorkspacePatch.mockResolvedValue({ kind: 'applied', appliedAt: 1234 });

    const olderOnSameMsg = workspacePatchCard({ baseSha: 'older' });
    const newerOnSameMsg = workspacePatchCard({ baseSha: 'newer' });
    const harness = makeHarness([
      assistantMessageWithCards('asst-1', [olderOnSameMsg, newerOnSameMsg]),
    ]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    expect(mockReplayWorkspacePatch).toHaveBeenCalledTimes(1);
    const calledWithCard = mockReplayWorkspacePatch.mock.calls[0][1] as { baseSha: string };
    expect(calledWithCard.baseSha).toBe('newer');

    const cards = harness.getConversations()['chat-1'].messages[0].cards ?? [];
    expect((cards[0] as Extract<ChatCard, { type: 'workspace-patch' }>).data.applyState).toEqual({
      kind: 'pending',
    });
    expect(
      (cards[1] as Extract<ChatCard, { type: 'workspace-patch' }>).data.applyState,
    ).toMatchObject({
      kind: 'applied',
    });
  });

  it('targets the most recent pending card across multiple messages', async () => {
    mockReplayWorkspacePatch.mockResolvedValue({ kind: 'applied', appliedAt: 1234 });

    // Two patches across two messages — the latest pending should win.
    const olderCard = workspacePatchCard({ baseSha: 'older' });
    const newerCard = workspacePatchCard({ baseSha: 'newer' });
    const harness = makeHarness([
      assistantMessageWithCards('asst-old', [olderCard]),
      assistantMessageWithCards('asst-new', [newerCard]),
    ]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    // Engine should have been called with the *newer* card data.
    expect(mockReplayWorkspacePatch).toHaveBeenCalledTimes(1);
    const calledWithCard = mockReplayWorkspacePatch.mock.calls[0][1] as { baseSha: string };
    expect(calledWithCard.baseSha).toBe('newer');

    // Only the newer message's card should have transitioned.
    const messages = harness.getConversations()['chat-1'].messages;
    expect(
      (messages[0].cards?.[0] as Extract<ChatCard, { type: 'workspace-patch' }>).data.applyState,
    ).toEqual({
      kind: 'pending',
    });
    expect(
      (messages[1].cards?.[0] as Extract<ChatCard, { type: 'workspace-patch' }>).data.applyState,
    ).toMatchObject({
      kind: 'applied',
    });
  });

  it('skips cards that are already non-pending (applied / refused / conflict)', async () => {
    const harness = makeHarness([
      assistantMessageWithCards('asst-1', [
        workspacePatchCard({ applyState: { kind: 'applied', appliedAt: 1 } }),
      ]),
    ]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    expect(mockReplayWorkspacePatch).not.toHaveBeenCalled();
    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(false);
  });

  it('is a no-op when chatId is null', async () => {
    const harness = makeHarness([assistantMessageWithCards('asst-1', [workspacePatchCard()])]);
    await harness.replayOnFreshSandbox('sb-1', null, harness.getConversations());

    expect(mockReplayWorkspacePatch).not.toHaveBeenCalled();
  });

  it('is a no-op when the active conversation has no workspace-patch cards', async () => {
    const harness = makeHarness([assistantMessageWithCards('asst-1', [])]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    expect(mockReplayWorkspacePatch).not.toHaveBeenCalled();
  });

  it('logs and skips when the replay engine throws', async () => {
    mockReplayWorkspacePatch.mockRejectedValue(new Error('sandbox unreachable'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const harness = makeHarness([assistantMessageWithCards('asst-1', [workspacePatchCard()])]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('[WorkspacePatchReplay] replay failed'),
      expect.any(Error),
      expect.objectContaining({ chatId: 'chat-1' }),
    );
    // No state mutation on engine failure.
    const card = harness.getConversations()['chat-1'].messages[0].cards?.[0] as Extract<
      ChatCard,
      { type: 'workspace-patch' }
    >;
    expect(card.data.applyState).toEqual({ kind: 'pending' });
    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(false);

    debug.mockRestore();
  });

  it('does not double-apply if the card was mutated between scan and commit', async () => {
    // Simulate a parallel transition (e.g. another replay won the race).
    // The mutation guard checks `kind === 'pending'` at write time so the
    // second commit must be a no-op.
    mockReplayWorkspacePatch.mockImplementation(async () => ({
      kind: 'applied',
      appliedAt: 1234,
    }));

    const harness = makeHarness([
      assistantMessageWithCards('asst-1', [
        workspacePatchCard({ applyState: { kind: 'applied', appliedAt: 999 } }),
      ]),
    ]);
    await harness.replayOnFreshSandbox('sb-1', 'chat-1', harness.getConversations());

    expect(mockReplayWorkspacePatch).not.toHaveBeenCalled();
    expect(harness.dirtyConversationIdsRef.current.has('chat-1')).toBe(false);
  });
});
