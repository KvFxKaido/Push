import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage, CommitReviewCardData, Conversation } from '@/types';
import type { ChatCardActionsParams } from './chat-card-actions';
import { registerApproval } from '@/lib/approval-bridge';

const {
  mockExecInSandbox,
  mockExecuteSandboxToolCall,
  mockWriteToSandbox,
  mockExecuteToolCall,
  mockRecordMutation,
} = vi.hoisted(() => ({
  mockExecInSandbox: vi.fn(),
  mockExecuteSandboxToolCall: vi.fn(),
  mockWriteToSandbox: vi.fn(),
  mockExecuteToolCall: vi.fn(),
  mockRecordMutation: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
}));

vi.mock('@/lib/sandbox-client', () => ({
  execInSandbox: (...args: unknown[]) => mockExecInSandbox(...args),
  writeToSandbox: (...args: unknown[]) => mockWriteToSandbox(...args),
}));

vi.mock('@/lib/github-tools', () => ({
  executeToolCall: (...args: unknown[]) => mockExecuteToolCall(...args),
}));

vi.mock('@/lib/sandbox-tools', () => ({
  executeSandboxToolCall: (...args: unknown[]) => mockExecuteSandboxToolCall(...args),
}));

vi.mock('@/lib/file-awareness-ledger', () => ({
  fileLedger: {
    recordMutation: (...args: unknown[]) => mockRecordMutation(...args),
  },
}));

const { useChatCardActions } = await import('./chat-card-actions');

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

function makeApprovalCard(approvalId: string): ChatCard {
  return {
    type: 'approval',
    data: {
      approvalId,
      toolName: 'sandbox_exec',
      category: 'destructive_sandbox',
      summary: 'held for approval',
      reason: 'destructive · supervised',
      status: 'pending',
    },
  };
}

describe('chat-card-actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards ask-user answers with the original question context', async () => {
    const sourceMessage: ChatMessage = {
      id: 'message-1',
      role: 'assistant',
      content: 'Question for you',
      timestamp: 1,
      status: 'done',
      cards: [
        {
          type: 'ask-user',
          data: {
            question: 'Pick a color',
            options: [{ id: 'blue', label: 'Blue' }],
          },
        },
      ],
    };
    let conversations = makeConversation([sourceMessage]);
    const dirtyConversationIdsRef = { current: new Set<string>() };
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const { handleCardAction } = useChatCardActions({
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
      dirtyConversationIdsRef,
      activeChatId: 'chat-1',
      sandboxIdRef: { current: null },
      isMainProtectedRef: { current: false },
      branchInfoRef: { current: undefined },
      repoRef: { current: null },
      updateAgentStatus: vi.fn(),
      sendMessageRef: { current: sendMessage },
      isStreaming: false,
      messages: conversations['chat-1'].messages,
    });

    await handleCardAction({
      type: 'ask-user-submit',
      messageId: 'message-1',
      cardIndex: 0,
      responseText: 'Blue',
      selectedOptionIds: ['blue'],
    });

    expect(sendMessage).toHaveBeenCalledWith('Answer to your question "Pick a color": Blue');
    expect(conversations['chat-1'].messages[0].cards?.[0]).toMatchObject({
      type: 'ask-user',
      data: {
        responseText: 'Blue',
        selectedOptionIds: ['blue'],
      },
    });
    expect(dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
  });

  it('approval-approve flips the card to approved when a waiter is released', async () => {
    void registerApproval('apv-ok');
    let conversations = makeConversation([
      {
        id: 'message-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'done',
        cards: [makeApprovalCard('apv-ok')],
      },
    ]);
    const { handleCardAction } = useChatCardActions({
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
      dirtyConversationIdsRef: { current: new Set<string>() },
      activeChatId: 'chat-1',
      sandboxIdRef: { current: null },
      isMainProtectedRef: { current: false },
      branchInfoRef: { current: undefined },
      repoRef: { current: null },
      updateAgentStatus: vi.fn(),
      sendMessageRef: { current: null },
      isStreaming: false,
      messages: conversations['chat-1'].messages,
    });
    await handleCardAction({
      type: 'approval-approve',
      messageId: 'message-1',
      cardIndex: 0,
      approvalId: 'apv-ok',
    });
    expect(conversations['chat-1'].messages[0].cards?.[0]).toMatchObject({
      type: 'approval',
      data: { status: 'approved' },
    });
  });

  it('approval-approve on an expired card (no waiter) marks expired, not approved', async () => {
    let conversations = makeConversation([
      {
        id: 'message-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'done',
        cards: [makeApprovalCard('apv-gone')],
      },
    ]);
    const { handleCardAction } = useChatCardActions({
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
      dirtyConversationIdsRef: { current: new Set<string>() },
      activeChatId: 'chat-1',
      sandboxIdRef: { current: null },
      isMainProtectedRef: { current: false },
      branchInfoRef: { current: undefined },
      repoRef: { current: null },
      updateAgentStatus: vi.fn(),
      sendMessageRef: { current: null },
      isStreaming: false,
      messages: conversations['chat-1'].messages,
    });
    await handleCardAction({
      type: 'approval-approve',
      messageId: 'message-1',
      cardIndex: 0,
      approvalId: 'apv-gone',
    });
    expect(conversations['chat-1'].messages[0].cards?.[0]).toMatchObject({
      type: 'approval',
      data: { status: 'expired' },
    });
  });

  it('ignores sandbox-state cards when injecting assistant card messages', () => {
    let conversations = makeConversation([]);
    const dirtyConversationIdsRef = { current: new Set<string>() };

    const { injectAssistantCardMessage } = useChatCardActions({
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
      dirtyConversationIdsRef,
      activeChatId: 'chat-1',
      sandboxIdRef: { current: null },
      isMainProtectedRef: { current: false },
      branchInfoRef: { current: undefined },
      repoRef: { current: null },
      updateAgentStatus: vi.fn(),
      sendMessageRef: { current: null },
      isStreaming: false,
      messages: conversations['chat-1'].messages,
    });

    const sandboxStateCard: ChatCard = {
      type: 'sandbox-state',
      data: {
        sandboxId: 'sb-1',
        repoPath: '/workspace',
        branch: 'feature/test',
        changedFiles: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        untrackedFiles: 0,
        preview: [],
        fetchedAt: '2026-03-25T00:00:00.000Z',
      },
    };

    injectAssistantCardMessage('chat-1', 'Should be ignored', sandboxStateCard);

    expect(conversations['chat-1'].messages).toHaveLength(0);
    expect(dirtyConversationIdsRef.current.size).toBe(0);
  });

  it('refreshes a prepared commit review in place', async () => {
    const sourceMessage: ChatMessage = {
      id: 'message-1',
      role: 'assistant',
      content: 'Review ready',
      timestamp: 1,
      status: 'done',
      cards: [
        {
          type: 'commit-review',
          data: {
            kind: 'push',
            diff: {
              diff: 'old diff',
              filesChanged: 1,
              additions: 1,
              deletions: 0,
              truncated: false,
            },
            auditVerdict: { verdict: 'safe', summary: 'safe', risks: [], filesReviewed: 1 },
            commitMessage: '',
            status: 'pending',
          },
        },
      ],
    };
    let conversations = makeConversation([sourceMessage]);
    const dirtyConversationIdsRef = { current: new Set<string>() };
    const updateAgentStatus = vi.fn();

    // Gate-at-Push Move A: refresh re-runs prepare_push and the result is a
    // fresh push-kind review card.
    mockExecuteSandboxToolCall.mockResolvedValue({
      text: '[Tool Result — prepare_push]\nReady to push.',
      card: {
        type: 'commit-review',
        data: {
          kind: 'push',
          diff: { diff: 'new diff', filesChanged: 2, additions: 3, deletions: 1, truncated: false },
          auditVerdict: { verdict: 'safe', summary: 'still safe', risks: [], filesReviewed: 2 },
          commitMessage: '',
          status: 'pending',
        },
      },
    });

    const { handleCardAction } = useChatCardActions({
      setConversations: (updater) => {
        conversations = typeof updater === 'function' ? updater(conversations) : updater;
      },
      dirtyConversationIdsRef,
      activeChatId: 'chat-1',
      sandboxIdRef: { current: 'sb-1' },
      isMainProtectedRef: { current: false },
      branchInfoRef: { current: undefined },
      repoRef: { current: 'owner/repo' },
      updateAgentStatus,
      sendMessageRef: { current: null },
      isStreaming: false,
      messages: conversations['chat-1'].messages,
    });

    await handleCardAction({
      type: 'commit-refresh',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: 'fix: polished',
    });

    expect(mockExecuteSandboxToolCall).toHaveBeenCalledWith(
      { tool: 'prepare_push', args: {} },
      'sb-1',
      { auditorProviderOverride: undefined, auditorModelOverride: null },
    );
    expect(conversations['chat-1'].messages[0].cards?.[0]).toMatchObject({
      type: 'commit-review',
      data: {
        kind: 'push',
        diff: { diff: 'new diff' },
        auditVerdict: { summary: 'still safe' },
      },
    });
    expect(updateAgentStatus).toHaveBeenCalledWith(
      { active: true, phase: 'Refreshing push review...' },
      { chatId: 'chat-1', source: 'system' },
    );
  });

  function pushReviewCard(overrides: Partial<CommitReviewCardData> = {}): {
    type: 'commit-review';
    data: CommitReviewCardData;
  } {
    return {
      type: 'commit-review',
      data: {
        kind: 'push',
        diff: {
          diff: 'diff --git a/x.ts b/x.ts',
          filesChanged: 1,
          additions: 1,
          deletions: 0,
          truncated: false,
        },
        auditVerdict: { verdict: 'safe', summary: 'safe', risks: [], filesReviewed: 1 },
        commitMessage: '',
        status: 'pending',
        auditedHeadSha: 'abc1234',
        auditedGitSurface: 'sandbox',
        auditedBranch: 'feature/reviewed',
        auditedUpstream: 'origin/feature/reviewed',
        auditedRemoteUrl: 'https://github.com/owner/repo.git',
        ...overrides,
      },
    };
  }

  function createPushReviewActionHarness(card = pushReviewCard()) {
    const sourceMessage: ChatMessage = {
      id: 'message-1',
      role: 'assistant',
      content: 'Review ready',
      timestamp: 1,
      status: 'done',
      cards: [card],
    };
    let conversations = makeConversation([sourceMessage]);
    const dirtyConversationIdsRef = { current: new Set<string>() };
    const updateAgentStatus = vi.fn();
    const setConversations: ChatCardActionsParams['setConversations'] = (updater) => {
      conversations = typeof updater === 'function' ? updater(conversations) : updater;
    };

    return {
      params: {
        setConversations,
        dirtyConversationIdsRef,
        activeChatId: 'chat-1',
        sandboxIdRef: { current: 'sb-1' },
        isMainProtectedRef: { current: false },
        branchInfoRef: { current: { currentBranch: 'feature/reviewed', defaultBranch: 'main' } },
        repoRef: { current: 'owner/repo' },
        updateAgentStatus,
        sendMessageRef: { current: null },
        isStreaming: false,
        messages: conversations['chat-1'].messages,
      },
      getCard: () => conversations['chat-1'].messages[0].cards?.[0],
      updateAgentStatus,
    };
  }

  it('refuses refresh when only a native scope is present but no git surface is ready', async () => {
    const harness = createPushReviewActionHarness();
    (harness.params.sandboxIdRef as { current: string | null }).current = null;

    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-refresh',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error: 'Sandbox expired. Start a new sandbox.',
      },
    });
    expect(mockExecuteSandboxToolCall).not.toHaveBeenCalled();
  });

  it('refuses push-kind approval when only a native scope is present but no git surface is ready', async () => {
    const harness = createPushReviewActionHarness();
    (harness.params.sandboxIdRef as { current: string | null }).current = null;

    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-approve',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error: 'Sandbox expired. Start a new sandbox.',
      },
    });
    expect(mockExecInSandbox).not.toHaveBeenCalled();
  });

  it('refuses push-kind approval when the sandbox branch changed since review', async () => {
    mockExecInSandbox.mockImplementation(async (_sandboxId, command) => {
      const cmd = String(command);
      if (cmd.includes("'rev-parse' 'HEAD'")) {
        return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'branch' '--show-current'")) {
        return { stdout: 'feature/other\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{u}'")) {
        return { stdout: 'origin/feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const harness = createPushReviewActionHarness();
    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-approve',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error: 'Branch destination changed since this review — refresh to re-audit before pushing.',
      },
    });
    expect(
      mockExecInSandbox.mock.calls.some(([, command]) => String(command).includes("'push'")),
    ).toBe(false);
  });

  it('refuses push-kind approval when the audited git surface changed since review', async () => {
    const harness = createPushReviewActionHarness(pushReviewCard({ auditedGitSurface: 'native' }));
    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-approve',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error: 'Git surface changed since this review; refresh to re-audit before pushing.',
      },
    });
    expect(mockExecInSandbox).not.toHaveBeenCalled();
  });

  it('refuses push-kind approval when the upstream changed since review', async () => {
    mockExecInSandbox.mockImplementation(async (_sandboxId, command) => {
      const cmd = String(command);
      if (cmd.includes("'rev-parse' 'HEAD'")) {
        return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'branch' '--show-current'")) {
        return { stdout: 'feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{u}'")) {
        return { stdout: 'origin/feature/other\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const harness = createPushReviewActionHarness();
    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-approve',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error: 'Branch destination changed since this review — refresh to re-audit before pushing.',
      },
    });
    expect(
      mockExecInSandbox.mock.calls.some(([, command]) => String(command).includes("'push'")),
    ).toBe(false);
  });

  it('refuses push-kind approval when origin was repointed since review', async () => {
    // HEAD, branch, and the upstream *ref* all still match — only origin's URL
    // moved (the `git remote set-url` evasion the ref pins can't catch).
    mockExecInSandbox.mockImplementation(async (_sandboxId, command) => {
      const cmd = String(command);
      if (cmd.includes("'rev-parse' 'HEAD'")) {
        return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'branch' '--show-current'")) {
        return { stdout: 'feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{u}'")) {
        return { stdout: 'origin/feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'remote' 'get-url' '--push' 'origin'")) {
        return { stdout: 'https://github.com/attacker/repo.git\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const harness = createPushReviewActionHarness();
    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-approve',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error:
          'Remote identity changed since this review — origin was repointed; refresh to re-audit before pushing.',
      },
    });
    expect(
      mockExecInSandbox.mock.calls.some(([, command]) => String(command).includes("'push'")),
    ).toBe(false);
  });

  it('refuses push-kind approval when origin moved since review (force-with-lease)', async () => {
    // Every other pin matches; only origin's live tip advanced since the lease
    // was captured — a teammate pushed between review and approval.
    mockExecInSandbox.mockImplementation(async (_sandboxId, command) => {
      const cmd = String(command);
      if (cmd.includes("'rev-parse' 'HEAD'")) {
        return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'branch' '--show-current'")) {
        return { stdout: 'feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{u}'")) {
        return { stdout: 'origin/feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'remote' 'get-url' '--push' 'origin'")) {
        return { stdout: 'https://github.com/owner/repo.git\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("'ls-remote'")) {
        // The remote tip advanced past the leased sha.
        return { stdout: 'movedsha\trefs/heads/feature/reviewed\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const harness = createPushReviewActionHarness(
      pushReviewCard({ auditedRemoteTipSha: 'leasedsha' }),
    );
    const { handleCardAction } = useChatCardActions(harness.params);
    await handleCardAction({
      type: 'commit-approve',
      messageId: 'message-1',
      cardIndex: 0,
      commitMessage: '',
    });

    expect(harness.getCard()).toMatchObject({
      type: 'commit-review',
      data: {
        status: 'error',
        error:
          'Origin moved since this review — the remote branch advanced; refresh to re-audit against the new base before pushing.',
      },
    });
    expect(
      mockExecInSandbox.mock.calls.some(([, command]) => String(command).includes("'push'")),
    ).toBe(false);
  });
});
