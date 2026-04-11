import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';
import { conversationBelongsToWorkspace } from './chat-management';

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
    verificationPolicy: getDefaultVerificationPolicy(),
    ...overrides,
  };
}

describe('chat-management workspace scoping', () => {
  it('treats chat mode as a separate unscoped lane', () => {
    const chatConversation = makeConversation({ mode: 'chat' });
    const scratchConversation = makeConversation({ id: 'chat-2', mode: 'scratch' });
    const legacyConversation = makeConversation({ id: 'chat-3' });

    expect(conversationBelongsToWorkspace(chatConversation, null, 'chat')).toBe(true);
    expect(conversationBelongsToWorkspace(scratchConversation, null, 'chat')).toBe(false);
    expect(conversationBelongsToWorkspace(legacyConversation, null, 'chat')).toBe(false);
  });

  it('keeps scratch workspace scoped to scratch and legacy unscoped chats', () => {
    const chatConversation = makeConversation({ mode: 'chat' });
    const scratchConversation = makeConversation({ id: 'chat-2', mode: 'scratch' });
    const legacyConversation = makeConversation({ id: 'chat-3' });

    expect(conversationBelongsToWorkspace(chatConversation, null, 'scratch')).toBe(false);
    expect(conversationBelongsToWorkspace(scratchConversation, null, 'scratch')).toBe(true);
    expect(conversationBelongsToWorkspace(legacyConversation, null, 'scratch')).toBe(true);
  });

  it('continues to scope repo chats by repo identity', () => {
    const repoConversation = makeConversation({ repoFullName: 'owner/repo-a', mode: 'repo' });
    const otherRepoConversation = makeConversation({
      id: 'chat-2',
      repoFullName: 'owner/repo-b',
      mode: 'repo',
    });
    const chatConversation = makeConversation({ id: 'chat-3', mode: 'chat' });

    expect(conversationBelongsToWorkspace(repoConversation, 'owner/repo-a', 'repo')).toBe(true);
    expect(conversationBelongsToWorkspace(otherRepoConversation, 'owner/repo-a', 'repo')).toBe(
      false,
    );
    expect(conversationBelongsToWorkspace(chatConversation, 'owner/repo-a', 'repo')).toBe(false);
  });
});
