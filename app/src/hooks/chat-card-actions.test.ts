import { describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage, Conversation } from '@/types';

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

describe('chat-card-actions', () => {
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

    expect(sendMessage).toHaveBeenCalledWith(
      'Answer to your question "Pick a color": Blue',
    );
    expect(conversations['chat-1'].messages[0].cards?.[0]).toMatchObject({
      type: 'ask-user',
      data: {
        responseText: 'Blue',
        selectedOptionIds: ['blue'],
      },
    });
    expect(dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
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
            diff: { diff: 'old diff', filesChanged: 1, additions: 1, deletions: 0, truncated: false },
            auditVerdict: { verdict: 'safe', summary: 'safe', risks: [], filesReviewed: 1 },
            commitMessage: 'fix: initial',
            status: 'pending',
          },
        },
      ],
    };
    let conversations = makeConversation([sourceMessage]);
    const dirtyConversationIdsRef = { current: new Set<string>() };
    const updateAgentStatus = vi.fn();

    mockExecuteSandboxToolCall.mockResolvedValue({
      text: '[Tool Result — sandbox_prepare_commit]\nReady for review.',
      card: {
        type: 'commit-review',
        data: {
          diff: { diff: 'new diff', filesChanged: 2, additions: 3, deletions: 1, truncated: false },
          auditVerdict: { verdict: 'safe', summary: 'still safe', risks: [], filesReviewed: 2 },
          commitMessage: 'fix: polished',
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
      { tool: 'sandbox_prepare_commit', args: { message: 'fix: polished' } },
      'sb-1',
      { auditorProviderOverride: undefined, auditorModelOverride: null },
    );
    expect(conversations['chat-1'].messages[0].cards?.[0]).toMatchObject({
      type: 'commit-review',
      data: {
        commitMessage: 'fix: polished',
        diff: { diff: 'new diff' },
        auditVerdict: { summary: 'still safe' },
      },
    });
    expect(updateAgentStatus).toHaveBeenCalledWith(
      { active: true, phase: 'Refreshing commit review...' },
      { chatId: 'chat-1', source: 'system' },
    );
  });
});
