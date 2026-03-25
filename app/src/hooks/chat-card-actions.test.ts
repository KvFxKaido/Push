import { describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage, Conversation } from '@/types';

const {
  mockExecInSandbox,
  mockWriteToSandbox,
  mockExecuteToolCall,
  mockRecordMutation,
} = vi.hoisted(() => ({
  mockExecInSandbox: vi.fn(),
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
});
