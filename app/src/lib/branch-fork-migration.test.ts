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

  it('clears the cross-tab marker after writes settle (not the in-tab guard)', () => {
    const ctx = makeContext();
    const payload: BranchSwitchPayload = {
      name: 'feature/foo',
      kind: 'forked',
      source: 'sandbox_create_branch',
    };

    applyBranchSwitchPayload(payload, ctx);

    // Cross-tab marker cleared immediately (try/finally).
    expect(getMigrationMarker()).toBeNull();
    // In-tab guard remains set — useChat's state-observed effect releases it.
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

  it('stale-capture avoidance: uses activeChatIdRef.current at resolution time', () => {
    // Simulate the chat being switched between dispatch and the migration
    // call: activeChatIdRef.current points at chat-2, conversations only
    // has chat-1. Migration finds no conversation under chat-2 and the
    // setConversations updater returns prev unchanged.
    const ctx = makeContext();
    ctx.activeChatIdRef.current = 'chat-2'; // switched away

    applyBranchSwitchPayload(
      { name: 'feature/foo', kind: 'forked', source: 'sandbox_create_branch' },
      ctx,
    );

    // setConversations is still invoked (the updater handles the missing
    // conv internally), but chat-1 stays unchanged.
    expect(ctx.conversations['chat-1'].branch).toBe('main');
    expect(ctx.conversations['chat-1'].messages).toHaveLength(0);
  });
});
