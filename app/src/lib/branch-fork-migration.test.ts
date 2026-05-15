/**
 * Tests for the conversation-fork migration logic in branch-fork-migration.ts.
 *
 * Covers the slice 2 D2 + R10 + R11 + R12 invariants in isolation. The
 * useChat-side state-observed clear is tested separately in useChat.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBranchSwitchPayload } from './branch-fork-migration';
import { clearMigrationMarker, getMigrationMarker } from './branch-migration-marker';

// Stub localStorage so the cross-tab marker (R10) can be set/read in tests.
// Mirrors the pattern in branch-migration-marker.test.ts.
function createStorageMock() {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => (data.has(key) ? (data.get(key) as string) : null)),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

let storageMock = createStorageMock();
vi.stubGlobal('window', {
  localStorage: storageMock,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

afterEach(() => {
  storageMock = createStorageMock();
  vi.stubGlobal('window', {
    localStorage: storageMock,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
import type { Dispatch, SetStateAction } from 'react';
import type { BranchSwitchPayload, ChatMessage, Conversation } from '@/types';
import type { MigrationGuard } from './chat-message';
import type { ChatRuntimeHandlers } from '@/hooks/chat-send';

type SetConversationsMock = Dispatch<SetStateAction<Record<string, Conversation>>> & {
  mock: ReturnType<typeof vi.fn>['mock'];
  mockImplementationOnce: ReturnType<typeof vi.fn>['mockImplementationOnce'];
};

interface MockContext {
  activeChatIdRef: { current: string | null };
  conversationsRef: { current: Record<string, Conversation> };
  branchInfoRef: {
    current: { currentBranch?: string; defaultBranch?: string } | undefined;
  };
  skipAutoCreateRef: { current: MigrationGuard | null };
  setConversations: SetConversationsMock;
  dirtyConversationIdsRef: { current: Set<string> };
  runtimeHandlersRef: { current: ChatRuntimeHandlers | undefined };
  conversations: Record<string, Conversation>;
  onBranchSwitchSpy: ReturnType<typeof vi.fn>;
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? `msg-${Math.random()}`,
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'chat-1',
    title: 'Test',
    messages: [],
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    repoFullName: 'owner/repo',
    branch: 'main',
    ...overrides,
  };
}

function makeContext(initialConv: Conversation = makeConversation()): MockContext {
  const onBranchSwitchSpy = vi.fn();
  const conversations: Record<string, Conversation> = { [initialConv.id]: initialConv };
  const setConversations = vi.fn(
    (
      value:
        | Record<string, Conversation>
        | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
    ) => {
      const next = typeof value === 'function' ? value(conversations) : value;
      Object.assign(conversations, next);
    },
  ) as unknown as SetConversationsMock;
  return {
    activeChatIdRef: { current: initialConv.id },
    conversationsRef: { current: conversations },
    branchInfoRef: { current: { currentBranch: initialConv.branch, defaultBranch: 'main' } },
    skipAutoCreateRef: { current: null },
    setConversations,
    dirtyConversationIdsRef: { current: new Set<string>() },
    runtimeHandlersRef: { current: { onBranchSwitch: onBranchSwitchSpy } },
    conversations,
    onBranchSwitchSpy,
  };
}

beforeEach(() => {
  // Each test starts with a clean cross-tab marker.
  clearMigrationMarker();
});

describe('applyBranchSwitchPayload — switched (or undefined kind)', () => {
  it('only triggers onBranchSwitch; does not migrate the conversation', () => {
    const ctx = makeContext();
    const payload: BranchSwitchPayload = {
      name: 'feature/foo',
      kind: 'switched',
      source: 'github_create_branch',
    };

    applyBranchSwitchPayload(payload, ctx);

    expect(ctx.onBranchSwitchSpy).toHaveBeenCalledWith('feature/foo');
    expect(ctx.setConversations).not.toHaveBeenCalled();
    expect(ctx.skipAutoCreateRef.current).toBeNull();
    expect(getMigrationMarker()).toBeNull();
  });
});

describe('applyBranchSwitchPayload — forked, no active chat', () => {
  it('syncs branch silently and does not set guards', () => {
    const ctx = makeContext();
    ctx.activeChatIdRef.current = null;
    const payload: BranchSwitchPayload = {
      name: 'feature/foo',
      kind: 'forked',
      source: 'sandbox_create_branch',
    };

    applyBranchSwitchPayload(payload, ctx);

    expect(ctx.onBranchSwitchSpy).toHaveBeenCalledWith('feature/foo');
    expect(ctx.setConversations).not.toHaveBeenCalled();
    expect(ctx.skipAutoCreateRef.current).toBeNull();
    expect(getMigrationMarker()).toBeNull();
  });
});

describe('applyBranchSwitchPayload — forked, with active chat', () => {
  it('sets both guards before any state update', () => {
    const ctx = makeContext();
    let guardAtSetConversations: MigrationGuard | null = null;
    let markerAtSetConversations: ReturnType<typeof getMigrationMarker> = null;
    ctx.setConversations.mockImplementationOnce((updater) => {
      guardAtSetConversations = ctx.skipAutoCreateRef.current;
      markerAtSetConversations = getMigrationMarker();
      Object.assign(ctx.conversations, updater(ctx.conversations));
    });
    const payload: BranchSwitchPayload = {
      name: 'feature/foo',
      kind: 'forked',
      source: 'sandbox_create_branch',
    };

    applyBranchSwitchPayload(payload, ctx);

    expect(guardAtSetConversations).toEqual({ chatId: 'chat-1', toBranch: 'feature/foo' });
    expect(markerAtSetConversations).toMatchObject({
      chatId: 'chat-1',
      fromBranch: 'main',
      toBranch: 'feature/foo',
    });
  });

  it('keeps both the cross-tab marker AND in-tab guard set after migration', () => {
    // PR #412 review (Copilot): clearing the marker in the migration
    // handler's `finally` raced with the async ~3s flushDirty cycle. Other
    // tabs could observe currentBranch changes before the migrated
    // conversation landed in IndexedDB. Both signals now release together
    // in `useBranchForkGuard`'s state-observed effect once the migration is
    // observable in render state — see useBranchForkGuard.ts comment block.
    const ctx = makeContext();
    const payload: BranchSwitchPayload = {
      name: 'feature/foo',
      kind: 'forked',
      source: 'sandbox_create_branch',
    };

    applyBranchSwitchPayload(payload, ctx);

    // Cross-tab marker stays set — released by useBranchForkGuard alongside
    // the in-tab guard once the migration is observable.
    expect(getMigrationMarker()).toMatchObject({
      chatId: 'chat-1',
      fromBranch: 'main',
      toBranch: 'feature/foo',
    });
    // In-tab guard also stays set, same release mechanism.
    expect(ctx.skipAutoCreateRef.current).toEqual({
      chatId: 'chat-1',
      toBranch: 'feature/foo',
    });
  });

  it('R12: backfills existing un-stamped messages with the OLD branch', () => {
    const oldMessages = [
      makeMessage({ id: 'm1', content: 'first' }),
      makeMessage({ id: 'm2', content: 'second' }),
    ];
    const conv = makeConversation({ branch: 'main', messages: oldMessages });
    const ctx = makeContext(conv);

    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );

    const updated = ctx.conversations['chat-1'];
    expect(updated.branch).toBe('feature/foo');
    // Two existing messages, each stamped with the OLD branch ('main'), plus
    // the new branch_forked event stamped with the NEW branch ('feature/foo').
    expect(updated.messages).toHaveLength(3);
    expect(updated.messages[0].branch).toBe('main');
    expect(updated.messages[1].branch).toBe('main');
    expect(updated.messages[2].branch).toBe('feature/foo');
    expect(updated.messages[2].kind).toBe('branch_forked');
    expect(updated.messages[2].visibleToModel).toBe(false);
  });

  it('R12: never overwrites already-stamped messages', () => {
    const stampedMessage = makeMessage({ id: 'm1', branch: 'feature/old-stamped' });
    const conv = makeConversation({ branch: 'main', messages: [stampedMessage] });
    const ctx = makeContext(conv);

    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );

    const updated = ctx.conversations['chat-1'];
    // Stamped message keeps its original branch — backfill only fills undefined.
    expect(updated.messages[0].branch).toBe('feature/old-stamped');
  });

  it('appends a branch_forked event with from/to/sha/source populated', () => {
    const ctx = makeContext();
    applyBranchSwitchPayload(
      {
        name: 'feature/foo',
        kind: 'forked',
        source: 'sandbox_create_branch',
        sha: 'abc1234',
      },
      ctx,
    );

    const updated = ctx.conversations['chat-1'];
    const event = updated.messages[updated.messages.length - 1];
    expect(event.kind).toBe('branch_forked');
    expect(event.branchForkedMeta).toEqual({
      from: 'main',
      to: 'feature/foo',
      sha: 'abc1234',
      source: 'sandbox_create_branch',
    });
  });

  it('uses payload.from when supplied, otherwise falls back to currentBranch', () => {
    const ctx = makeContext(makeConversation({ branch: 'develop' }));
    ctx.branchInfoRef.current = { currentBranch: 'develop', defaultBranch: 'main' };

    applyBranchSwitchPayload(
      {
        name: 'feature/foo',
        kind: 'forked',
        from: 'release-1.2',
        source: 'sandbox_create_branch',
      },
      ctx,
    );

    const event =
      ctx.conversations['chat-1'].messages[ctx.conversations['chat-1'].messages.length - 1];
    expect(event.branchForkedMeta?.from).toBe('release-1.2');
  });

  it('triggers onBranchSwitch with the new branch after the conversation update', () => {
    const ctx = makeContext();
    const callOrder: string[] = [];
    ctx.setConversations.mockImplementationOnce((updater) => {
      callOrder.push('setConversations');
      Object.assign(ctx.conversations, updater(ctx.conversations));
    });
    ctx.onBranchSwitchSpy.mockImplementation(() => callOrder.push('onBranchSwitch'));

    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );

    // setConversations runs before onBranchSwitch — preferred ordering even
    // though the guard is what enforces correctness.
    expect(callOrder).toEqual(['setConversations', 'onBranchSwitch']);
    expect(ctx.onBranchSwitchSpy).toHaveBeenCalledWith('feature/foo');
  });

  it('marks the migrated conversation as dirty for persistence', () => {
    const ctx = makeContext();
    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );
    expect(ctx.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
  });

  it('stale-capture / missing-conv: bails before setting any guards', () => {
    // PR #412 review (Codex P1 + Copilot converged): if the chat was
    // switched away or deleted between dispatch and resolution
    // (`activeChatIdRef.current` points at a chat not in conversations),
    // setting the in-tab guard before checking would leave it stuck — the
    // useBranchForkGuard state-observed clear can't fire because
    // `conversations[guard.chatId]` is undefined. Treat missing-conv same
    // as no-active-chat fallback: only sync the workspace branch.
    const ctx = makeContext();
    ctx.activeChatIdRef.current = 'chat-2'; // switched away

    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );

    // No guard set, no marker set, no setConversations call — the only
    // side effect is the workspace branch sync via onBranchSwitch.
    expect(ctx.skipAutoCreateRef.current).toBeNull();
    expect(getMigrationMarker()).toBeNull();
    expect(ctx.setConversations).not.toHaveBeenCalled();
    expect(ctx.onBranchSwitchSpy).toHaveBeenCalledWith('feature/foo');
    // chat-1 stays unchanged.
    expect(ctx.conversations['chat-1'].branch).toBe('main');
    expect(ctx.conversations['chat-1'].messages).toHaveLength(0);
  });

  it('merged: migrates the active chat like forked but emits a branch_merged event', () => {
    // The chat-on-merge contract: when a PR merges and the workspace swaps
    // to the default branch, the chat the user was just in should migrate
    // with the branch — same R10/R12 mitigations as the fork path — instead
    // of being filtered out and replaced by an auto-created chat.
    const oldMessages = [
      makeMessage({ id: 'm1', content: 'shipped this' }),
      makeMessage({ id: 'm2', content: 'looks good' }),
    ];
    const conv = makeConversation({ branch: 'feature/foo', messages: oldMessages });
    const ctx = makeContext(conv);
    ctx.branchInfoRef.current = { currentBranch: 'feature/foo', defaultBranch: 'main' };

    applyBranchSwitchPayload(
      {
        name: 'main',
        kind: 'merged',
        from: 'feature/foo',
        prNumber: 42,
        source: 'ui-merge',
      },
      ctx,
    );

    const updated = ctx.conversations['chat-1'];
    expect(updated.branch).toBe('main');
    expect(updated.messages).toHaveLength(3);
    expect(updated.messages[0].branch).toBe('feature/foo');
    expect(updated.messages[1].branch).toBe('feature/foo');
    const event = updated.messages[2];
    expect(event.kind).toBe('branch_merged');
    expect(event.branch).toBe('main');
    expect(event.visibleToModel).toBe(false);
    expect(event.branchMergedMeta).toEqual({
      from: 'feature/foo',
      to: 'main',
      prNumber: 42,
      source: 'ui-merge',
    });
    // Same guard mechanism as forked — auto-switch is suppressed until the
    // migration is observable.
    expect(ctx.skipAutoCreateRef.current).toEqual({ chatId: 'chat-1', toBranch: 'main' });
    expect(getMigrationMarker()).toMatchObject({
      chatId: 'chat-1',
      fromBranch: 'feature/foo',
      toBranch: 'main',
    });
    expect(ctx.onBranchSwitchSpy).toHaveBeenCalledWith('main');
    expect(ctx.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
  });

  it('merged with no active chat: syncs branch silently without setting guards', () => {
    const ctx = makeContext();
    ctx.activeChatIdRef.current = null;

    applyBranchSwitchPayload(
      { name: 'main', kind: 'merged', from: 'feature/foo', source: 'ui-merge' },
      ctx,
    );

    expect(ctx.onBranchSwitchSpy).toHaveBeenCalledWith('main');
    expect(ctx.setConversations).not.toHaveBeenCalled();
    expect(ctx.skipAutoCreateRef.current).toBeNull();
    expect(getMigrationMarker()).toBeNull();
  });

  it('R12 backfill: legacy conv with undefined branch falls back to fromBranch', () => {
    // PR #412 review (Codex P2): Conversation.branch is optional; legacy
    // chats from before per-conversation branches landed have it undefined.
    // Without the fallback, backfill would write `branch: undefined` onto
    // pre-fork messages — then conv.branch becomes the new branch and read-
    // side fallback (effectiveMessageBranch) attributes pre-fork messages
    // to the new branch, erasing provenance.
    const oldMessage = makeMessage({ id: 'm1', content: 'pre-fork message' });
    // Construct a conversation without a `branch` field (legacy shape).
    const legacyConv = {
      ...makeConversation({ messages: [oldMessage] }),
      branch: undefined,
    } as Conversation;
    const ctx = makeContext(legacyConv);
    // Workspace currentBranch is 'develop' — that's our fromBranch when the
    // payload doesn't supply one.
    ctx.branchInfoRef.current = { currentBranch: 'develop', defaultBranch: 'main' };

    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );

    const updated = ctx.conversations['chat-1'];
    // The pre-fork message gets stamped with 'develop' (the fromBranch),
    // not undefined. Read-side fallback now correctly attributes it.
    expect(updated.messages[0].branch).toBe('develop');
    // The branch_forked event itself stamps with the new branch.
    expect(updated.messages[1].branch).toBe('feature/foo');
    expect(updated.branch).toBe('feature/foo');
  });
});
