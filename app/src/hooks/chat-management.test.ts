import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';
import {
  conversationBelongsToWorkspace,
  resolveDaemonChatAction,
  resolveWorkspaceChatAction,
} from './chat-management';

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

describe('resolveWorkspaceChatAction', () => {
  const repoConversation = makeConversation({
    id: 'chat-repo',
    repoFullName: 'owner/repo-a',
    mode: 'repo',
  });

  it('defers all actions until conversations are hydrated', () => {
    // Regression: running against the pre-hydration localStorage seed could
    // find no workspace match and mint a throwaway chat — the "new chat" flash
    // before the real chat loads, which can also tear down the sandbox.
    expect(
      resolveWorkspaceChatAction({
        conversations: {},
        activeChatId: 'missing',
        repoFullName: 'owner/repo-a',
        workspaceMode: 'repo',
        conversationsLoaded: false,
        hasPendingResume: false,
        hasPendingNewChat: false,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('creates a chat once hydrated when no workspace chat matches', () => {
    expect(
      resolveWorkspaceChatAction({
        conversations: {},
        activeChatId: 'missing',
        repoFullName: 'owner/repo-a',
        workspaceMode: 'repo',
        conversationsLoaded: true,
        hasPendingResume: false,
        hasPendingNewChat: false,
      }),
    ).toEqual({ kind: 'create' });
  });

  it('switches to the most recent matching chat once hydrated', () => {
    const older = makeConversation({
      id: 'chat-old',
      repoFullName: 'owner/repo-a',
      mode: 'repo',
      lastMessageAt: 1,
    });
    const newer = makeConversation({
      id: 'chat-new',
      repoFullName: 'owner/repo-a',
      mode: 'repo',
      lastMessageAt: 2,
    });
    expect(
      resolveWorkspaceChatAction({
        conversations: { [older.id]: older, [newer.id]: newer },
        activeChatId: 'missing',
        repoFullName: 'owner/repo-a',
        workspaceMode: 'repo',
        conversationsLoaded: true,
        hasPendingResume: false,
        hasPendingNewChat: false,
      }),
    ).toEqual({ kind: 'switch', chatId: 'chat-new' });
  });

  it('keeps the active chat when it already belongs to the workspace', () => {
    expect(
      resolveWorkspaceChatAction({
        conversations: { [repoConversation.id]: repoConversation },
        activeChatId: repoConversation.id,
        repoFullName: 'owner/repo-a',
        workspaceMode: 'repo',
        conversationsLoaded: true,
        hasPendingResume: false,
        hasPendingNewChat: false,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('defers to the resume and drain owners when their work is pending', () => {
    const base = {
      conversations: {},
      activeChatId: 'missing',
      repoFullName: 'owner/repo-a' as string | null,
      workspaceMode: 'repo' as const,
      conversationsLoaded: true,
    };
    expect(
      resolveWorkspaceChatAction({ ...base, hasPendingResume: true, hasPendingNewChat: false }),
    ).toEqual({ kind: 'noop' });
    expect(
      resolveWorkspaceChatAction({ ...base, hasPendingResume: false, hasPendingNewChat: true }),
    ).toEqual({ kind: 'noop' });
  });
});

describe('resolveDaemonChatAction', () => {
  // Regression (2026-07-03): Connected sessions / tap-to-resume can target N
  // distinct daemon sessions, but the mount effect used to scope only by
  // `mode` — every tap collapsed onto whichever relay chat happened to
  // already be active, since `activeChatId` persists across the remount a
  // target switch causes.
  it('creates a session-scoped chat when no local chat mirrors this target yet', () => {
    expect(
      resolveDaemonChatAction({
        conversations: {},
        activeChatId: 'missing',
        mode: 'relay',
        targetSessionId: 'daemon-session-a',
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'create', daemonSessionId: 'daemon-session-a' });
  });

  it('switches to the existing chat scoped to this target session', () => {
    const scoped = makeConversation({
      id: 'chat-a',
      mode: 'relay',
      daemonSessionId: 'daemon-session-a',
    });
    expect(
      resolveDaemonChatAction({
        conversations: { [scoped.id]: scoped },
        activeChatId: 'missing',
        mode: 'relay',
        targetSessionId: 'daemon-session-a',
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'switch', chatId: 'chat-a' });
  });

  it("does not collapse onto a DIFFERENT session's chat — the actual bug", () => {
    // Two distinct daemon sessions, each with its own local mirror chat.
    // Tapping session B while chat A (the more recently used one) is
    // active must resolve to chat B, not silently stay on/reuse chat A.
    const chatA = makeConversation({
      id: 'chat-a',
      mode: 'relay',
      daemonSessionId: 'daemon-session-a',
      lastMessageAt: 100,
    });
    const chatB = makeConversation({
      id: 'chat-b',
      mode: 'relay',
      daemonSessionId: 'daemon-session-b',
      lastMessageAt: 1,
    });
    expect(
      resolveDaemonChatAction({
        conversations: { [chatA.id]: chatA, [chatB.id]: chatB },
        activeChatId: chatA.id,
        mode: 'relay',
        targetSessionId: 'daemon-session-b',
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'switch', chatId: 'chat-b' });
  });

  it('keeps the active chat when it already mirrors this target session', () => {
    const scoped = makeConversation({
      id: 'chat-a',
      mode: 'relay',
      daemonSessionId: 'daemon-session-a',
    });
    expect(
      resolveDaemonChatAction({
        conversations: { [scoped.id]: scoped },
        activeChatId: 'chat-a',
        mode: 'relay',
        targetSessionId: 'daemon-session-a',
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('falls back to most-recent-chat-of-this-mode for an untargeted relay screen', () => {
    const older = makeConversation({ id: 'chat-old', mode: 'relay', lastMessageAt: 1 });
    const newer = makeConversation({ id: 'chat-new', mode: 'relay', lastMessageAt: 2 });
    expect(
      resolveDaemonChatAction({
        conversations: { [older.id]: older, [newer.id]: newer },
        activeChatId: 'missing',
        mode: 'relay',
        targetSessionId: null,
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'switch', chatId: 'chat-new' });
  });

  it('local-pc has no picker — always most-recent-chat-of-this-mode, unaffected by targetSessionId', () => {
    const chat = makeConversation({ id: 'chat-lp', mode: 'local-pc' });
    expect(
      resolveDaemonChatAction({
        conversations: { [chat.id]: chat },
        activeChatId: 'missing',
        mode: 'local-pc',
        targetSessionId: 'daemon-session-a',
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'switch', chatId: 'chat-lp' });
  });

  it('creates an unscoped chat when no mode chats exist and there is no target', () => {
    expect(
      resolveDaemonChatAction({
        conversations: {},
        activeChatId: 'missing',
        mode: 'local-pc',
        targetSessionId: null,
        conversationsLoaded: true,
      }),
    ).toEqual({ kind: 'create' });
  });

  it('defers until conversations are hydrated', () => {
    expect(
      resolveDaemonChatAction({
        conversations: {},
        activeChatId: 'missing',
        mode: 'relay',
        targetSessionId: 'daemon-session-a',
        conversationsLoaded: false,
      }),
    ).toEqual({ kind: 'noop' });
  });
});
