import { describe, expect, it, vi } from 'vitest';
import type { BranchSwitchPayload, ChatMessage, Conversation } from '@/types';
import type { BranchForkMigrationContext } from './branch-fork-migration';
import { applyBranchSwitchPayload } from './branch-fork-migration';

function message(id: string, branch = 'main'): ChatMessage {
  return {
    id,
    role: 'user',
    content: id,
    timestamp: 1,
    branch,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [message('m1')],
    createdAt: 1,
    lastMessageAt: 1,
    repoFullName: 'owner/repo',
    branch: 'main',
    ...overrides,
  };
}

function makeContext(conversations: Record<string, Conversation>): BranchForkMigrationContext & {
  onBranchSwitch: ReturnType<typeof vi.fn>;
} {
  const state = { current: conversations };
  const onBranchSwitch = vi.fn();
  return {
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef: state,
    branchInfoRef: { current: { currentBranch: 'main', defaultBranch: 'main' } },
    setConversations: (updater) => {
      state.current = typeof updater === 'function' ? updater(state.current) : updater;
    },
    dirtyConversationIdsRef: { current: new Set<string>() },
    runtimeHandlersRef: { current: { onBranchSwitch } },
    onBranchSwitch,
  };
}

describe('applyBranchSwitchPayload', () => {
  it.each<{ payload: BranchSwitchPayload; momentKind: ChatMessage['kind'] | null }>([
    {
      payload: { name: 'feature/new', kind: 'forked', source: 'sandbox_create_branch' },
      momentKind: 'branch_forked',
    },
    {
      payload: {
        name: 'feature/existing',
        kind: 'switched',
        previous: 'main',
        source: 'sandbox_switch_branch',
      },
      momentKind: null,
    },
    {
      payload: { name: 'main', kind: 'merged', from: 'feature/old', source: 'ui-merge' },
      momentKind: 'branch_merged',
    },
  ])('warm-follows, updates branch, and appends the right moment for $payload.kind', ({
    payload,
    momentKind,
  }) => {
    const initialBranch = payload.name === 'main' ? 'feature/old' : 'main';
    const ctx = makeContext({ 'chat-1': conversation({ branch: initialBranch }) });

    applyBranchSwitchPayload(payload, ctx);

    expect(ctx.onBranchSwitch).toHaveBeenCalledWith(payload.name);
    const updated = ctx.conversationsRef.current['chat-1'];
    expect(updated.branch).toBe(payload.name);
    expect(ctx.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);

    if (momentKind === null) {
      // A plain switch (incl. desync reconcile) leaves no divider.
      expect(updated.messages).toEqual([message('m1')]);
    } else {
      // forked / merged append a passive timeline moment on the new branch.
      expect(updated.messages).toHaveLength(2);
      expect(updated.messages[0]).toEqual(message('m1'));
      expect(updated.messages[1].kind).toBe(momentKind);
      expect(updated.messages[1].branch).toBe(payload.name);
    }
  });

  it('does not dirty or rewrite when the active conversation already has the branch', () => {
    const ctx = makeContext({ 'chat-1': conversation({ branch: 'feature/existing' }) });
    const before = ctx.conversationsRef.current;

    applyBranchSwitchPayload({ name: 'feature/existing', kind: 'switched' }, ctx);

    expect(ctx.onBranchSwitch).toHaveBeenCalledWith('feature/existing');
    expect(ctx.conversationsRef.current).toBe(before);
    expect(ctx.dirtyConversationIdsRef.current.size).toBe(0);
  });

  it('only warm-follows when there is no active conversation to update', () => {
    const ctx = makeContext({});

    applyBranchSwitchPayload({ name: 'feature/new', kind: 'forked' }, ctx);

    expect(ctx.onBranchSwitch).toHaveBeenCalledWith('feature/new');
    expect(ctx.conversationsRef.current).toEqual({});
    expect(ctx.dirtyConversationIdsRef.current.size).toBe(0);
  });
});
