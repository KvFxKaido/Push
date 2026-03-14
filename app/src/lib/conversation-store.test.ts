import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation, ChatMessage } from '@/types';

// ---------------------------------------------------------------------------
// Mocks — isolate from IndexedDB and localStorage
// ---------------------------------------------------------------------------

const mockGetAll = vi.fn<(storeName: string) => Promise<Conversation[]>>().mockResolvedValue([]);
const mockPutMany = vi
  .fn<(storeName: string, conversations: Conversation[]) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('./app-db', () => ({
  STORE: { conversations: 'conversations' },
  getAll: mockGetAll,
  putMany: mockPutMany,
}));

let fakeStorage: Record<string, string> = {};

vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string) => fakeStorage[key] ?? null,
  safeStorageRemove: (key: string) => { delete fakeStorage[key]; },
  safeStorageSet: (key: string, value: string) => { fakeStorage[key] = value; },
}));

// Import after mocks are installed
const { migrateConversationsToIndexedDB } = await import('./conversation-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(id: string, messages: ChatMessage[]): Conversation {
  return {
    id,
    messages,
    title: 'Test',
    lastMessageAt: Date.now(),
    repoFullName: 'test/repo',
    branch: 'main',
  } as Conversation;
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'assistant',
    content: 'hello',
    ...overrides,
  } as ChatMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakeStorage = {};
  mockGetAll.mockReset().mockResolvedValue([]);
  mockPutMany.mockReset().mockResolvedValue(undefined);
});

describe('migrateConversationsToIndexedDB', () => {
  it('strips sandbox-state cards from legacy conversations', async () => {
    const conv = makeConversation('c1', [
      makeMessage({
        content: 'Here is the status',
        cards: [
          { type: 'sandbox-state', data: {} } as unknown as ChatMessage['cards'] extends (infer U)[] | undefined ? U : never,
          { type: 'diff-preview', data: {} } as unknown as ChatMessage['cards'] extends (infer U)[] | undefined ? U : never,
        ],
      }),
    ]);

    fakeStorage['diff_conversations'] = JSON.stringify({ c1: conv });

    const result = await migrateConversationsToIndexedDB();
    const cards = result['c1'].messages[0].cards!;

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('diff-preview');
  });

  it('drops sandbox-attached banner messages entirely', async () => {
    const conv = makeConversation('c1', [
      makeMessage({
        role: 'assistant',
        content: 'Sandbox attached on `abc123`.',
        cards: [
          { type: 'sandbox-state', data: {} } as unknown as ChatMessage['cards'] extends (infer U)[] | undefined ? U : never,
        ],
      }),
      makeMessage({ role: 'user', content: 'do something' }),
    ]);

    fakeStorage['diff_conversations'] = JSON.stringify({ c1: conv });

    const result = await migrateConversationsToIndexedDB();

    expect(result['c1'].messages).toHaveLength(1);
    expect(result['c1'].messages[0].content).toBe('do something');
  });

  it('writes sanitized data to IndexedDB', async () => {
    const conv = makeConversation('c1', [
      makeMessage({
        content: 'Sandbox attached on `abc123`.',
        cards: [{ type: 'sandbox-state', data: {} } as never],
      }),
      makeMessage({ role: 'user', content: 'ok' }),
    ]);

    fakeStorage['diff_conversations'] = JSON.stringify({ c1: conv });

    await migrateConversationsToIndexedDB();

    expect(mockPutMany).toHaveBeenCalledTimes(1);
    const writtenConvs = mockPutMany.mock.calls[0][1] as Conversation[];
    // The banner message should have been stripped before write
    expect(writtenConvs[0].messages).toHaveLength(1);
    expect(writtenConvs[0].messages[0].content).toBe('ok');
  });

  it('preserves messages without cards unchanged', async () => {
    const conv = makeConversation('c1', [
      makeMessage({ role: 'user', content: 'hello' }),
      makeMessage({ role: 'assistant', content: 'hi there' }),
    ]);

    fakeStorage['diff_conversations'] = JSON.stringify({ c1: conv });

    const result = await migrateConversationsToIndexedDB();

    expect(result['c1'].messages).toHaveLength(2);
    expect(result['c1'].messages[0].content).toBe('hello');
    expect(result['c1'].messages[1].content).toBe('hi there');
  });

  it('returns existing IndexedDB data when already migrated', async () => {
    const existing = makeConversation('c1', [
      makeMessage({ content: 'from idb' }),
    ]);
    mockGetAll.mockResolvedValue([existing]);

    const result = await migrateConversationsToIndexedDB();

    expect(result['c1'].messages[0].content).toBe('from idb');
    expect(mockPutMany).not.toHaveBeenCalled();
  });

  it('returns empty object when no legacy data exists', async () => {
    const result = await migrateConversationsToIndexedDB();
    expect(result).toEqual({});
    expect(mockPutMany).not.toHaveBeenCalled();
  });
});
