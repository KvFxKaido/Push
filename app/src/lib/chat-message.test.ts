import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@/types';
import {
  createBranchForkedMessage,
  backfillConversationMessageBranches,
  createCompactionMessage,
  createMessage,
  effectiveMessageBranch,
  filterModelVisibleMessages,
  nextCompactionCount,
  resolveMessageWriteBranch,
} from './chat-message';

describe('createMessage', () => {
  it('stamps the provided current branch', () => {
    const msg = createMessage({
      role: 'user',
      content: 'hello',
      currentBranch: 'feature/foo',
    });
    expect(msg.branch).toBe('feature/foo');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
    expect(typeof msg.id).toBe('string');
    expect(typeof msg.timestamp).toBe('number');
  });

  it('omits branch when currentBranch is undefined', () => {
    const msg = createMessage({
      role: 'assistant',
      content: 'reply',
      currentBranch: undefined,
    });
    expect(msg.branch).toBeUndefined();
  });

  it('honors id and timestamp overrides', () => {
    const msg = createMessage({
      role: 'user',
      content: 'x',
      currentBranch: 'main',
      id: 'fixed-id',
      timestamp: 1234567890,
    });
    expect(msg.id).toBe('fixed-id');
    expect(msg.timestamp).toBe(1234567890);
  });

  it('passes through extra fields verbatim', () => {
    const msg = createMessage({
      role: 'assistant',
      content: 'tool',
      currentBranch: 'main',
      extra: { isToolCall: true, status: 'streaming' },
    });
    expect(msg.isToolCall).toBe(true);
    expect(msg.status).toBe('streaming');
  });
});

describe('createBranchForkedMessage', () => {
  it('produces a non-model-visible event stamped with the new branch', () => {
    const msg = createBranchForkedMessage({
      from: 'main',
      to: 'feature/foo',
      sha: 'abc1234',
      source: 'sandbox_create_branch',
    });
    expect(msg.kind).toBe('branch_forked');
    expect(msg.visibleToModel).toBe(false);
    expect(msg.branch).toBe('feature/foo');
    expect(msg.branchForkedMeta).toEqual({
      from: 'main',
      to: 'feature/foo',
      sha: 'abc1234',
      source: 'sandbox_create_branch',
    });
  });

  it('omits optional fields when not provided', () => {
    const msg = createBranchForkedMessage({ from: 'main', to: 'feature/foo' });
    expect(msg.branchForkedMeta).toEqual({ from: 'main', to: 'feature/foo' });
  });

  it('uses assistant role and empty content (transcript metadata)', () => {
    const msg = createBranchForkedMessage({ from: 'main', to: 'feature/foo' });
    // The codebase doesn't model a 'system' role on ChatMessage; the
    // visibleToModel flag is what makes this transcript-only.
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('');
  });
});

describe('createCompactionMessage', () => {
  it('produces a non-model-visible compaction marker with the net token figures', () => {
    const msg = createCompactionMessage({
      beforeTokens: 88000,
      afterTokens: 42000,
      phase: 'digest_drop',
      messagesDropped: 12,
      branch: 'feature/foo',
    });
    expect(msg.kind).toBe('compaction');
    // Filtered from every prompt-pack path — the marker is transcript-only and
    // must never be read by the model as an instruction.
    expect(msg.visibleToModel).toBe(false);
    expect(msg.branch).toBe('feature/foo');
    expect(msg.compactionMeta).toEqual({
      beforeTokens: 88000,
      afterTokens: 42000,
      phase: 'digest_drop',
      messagesDropped: 12,
    });
  });

  it('uses assistant role and empty content (transcript metadata)', () => {
    const msg = createCompactionMessage({
      beforeTokens: 100,
      afterTokens: 50,
      phase: 'summarization',
      messagesDropped: 0,
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('');
    expect(msg.branch).toBeUndefined();
  });

  it('is stripped by filterModelVisibleMessages', () => {
    const marker = createCompactionMessage({
      beforeTokens: 100,
      afterTokens: 50,
      phase: 'hard_trim',
      messagesDropped: 3,
    });
    const messages = [{ id: 'a', visibleToModel: true }, marker, { id: 'b', visibleToModel: true }];
    const out = filterModelVisibleMessages(messages);
    expect(out.map((m) => (m as { id?: string }).id)).toEqual(['a', 'b']);
  });

  it('stores compactionCount when provided (drives the degradation nudge)', () => {
    const msg = createCompactionMessage({
      beforeTokens: 100,
      afterTokens: 50,
      phase: 'summarization',
      messagesDropped: 0,
      compactionCount: 3,
    });
    expect(msg.compactionMeta?.compactionCount).toBe(3);
  });
});

describe('nextCompactionCount', () => {
  it('returns the next 1-based ordinal across all prior compaction markers', () => {
    const plain = { id: 'p', role: 'user', content: '', timestamp: 0 } as ChatMessage;
    const mark = (): ChatMessage =>
      createCompactionMessage({
        beforeTokens: 1,
        afterTokens: 1,
        phase: 'summarization',
        messagesDropped: 0,
      });
    // Counts every `kind:'compaction'` marker regardless of which path created it,
    // so the LLM-handoff and heuristic-drain paths share one running total.
    expect(nextCompactionCount([])).toBe(1);
    expect(nextCompactionCount([plain, plain])).toBe(1);
    expect(nextCompactionCount([plain, mark(), plain])).toBe(2);
    expect(nextCompactionCount([mark(), plain, mark()])).toBe(3);
  });
});

describe('effectiveMessageBranch', () => {
  it('returns msg.branch when stamped', () => {
    expect(effectiveMessageBranch({ branch: 'feature/foo' }, 'main')).toBe('feature/foo');
  });

  it('does not fall back to conversation branch when message is unstamped', () => {
    expect(effectiveMessageBranch({}, 'feature/foo')).toBe('main');
  });

  it('falls back to "main" when both message and conversation branch are absent', () => {
    expect(effectiveMessageBranch({}, undefined)).toBe('main');
  });

  it('does not overwrite a stamped branch even when conversation differs', () => {
    // Critical for R12: after a conversation migrates from main to feature/foo,
    // old stamped messages must keep their original branch.
    expect(effectiveMessageBranch({ branch: 'main' }, 'feature/foo')).toBe('main');
  });
});

describe('backfillConversationMessageBranches', () => {
  it('stamps unstamped persisted messages with the conversation branch', () => {
    const stamped = { id: 'a', role: 'assistant', content: 'old', timestamp: 1, branch: 'main' };
    const unstamped = { id: 'b', role: 'user', content: 'new', timestamp: 2 };
    const result = backfillConversationMessageBranches({
      id: 'c1',
      title: 'Test',
      messages: [stamped, unstamped] as ChatMessage[],
      branch: 'feature/foo',
      lastMessageAt: 2,
    });

    expect(result.changed).toBe(true);
    expect(result.conversation.messages[0].branch).toBe('main');
    expect(result.conversation.messages[1].branch).toBe('feature/foo');
  });

  it('leaves legacy repo conversations with no stored branch unstamped', () => {
    const result = backfillConversationMessageBranches({
      id: 'c1',
      title: 'Test',
      messages: [{ id: 'a', role: 'user', content: 'hi', timestamp: 1 }] as ChatMessage[],
      repoFullName: 'owner/repo',
      lastMessageAt: 1,
    });

    expect(result.changed).toBe(false);
    expect(result.conversation.messages[0].branch).toBeUndefined();
  });
});

describe('resolveMessageWriteBranch', () => {
  it('prefers the conversation branch over a stale branchInfo currentBranch', () => {
    expect(
      resolveMessageWriteBranch(
        { currentBranch: 'main', defaultBranch: 'main' },
        'feature/new-head',
      ),
    ).toBe('feature/new-head');
  });

  it('uses branchInfo currentBranch when no conversation branch is available', () => {
    expect(resolveMessageWriteBranch({ currentBranch: 'feature/current' }, undefined)).toBe(
      'feature/current',
    );
  });

  it('falls back to defaultBranch only when neither conversation nor current branch is available', () => {
    expect(resolveMessageWriteBranch({ defaultBranch: 'main' }, undefined)).toBe('main');
  });
});

describe('filterModelVisibleMessages', () => {
  it('keeps messages with undefined visibleToModel (default visible)', () => {
    const messages: { id: string; visibleToModel?: boolean }[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    expect(filterModelVisibleMessages(messages)).toHaveLength(3);
  });

  it('keeps messages with explicit visibleToModel: true', () => {
    const messages: { id: string; visibleToModel?: boolean }[] = [
      { id: 'a', visibleToModel: true },
      { id: 'b', visibleToModel: true },
    ];
    expect(filterModelVisibleMessages(messages)).toHaveLength(2);
  });

  it('strips messages with explicit visibleToModel: false', () => {
    const messages: { id: string; visibleToModel?: boolean }[] = [
      { id: 'a' },
      { id: 'b', visibleToModel: false },
      { id: 'c' },
    ];
    const out = filterModelVisibleMessages(messages);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('strips a branch_forked transcript event', () => {
    // Real-world shape: createBranchForkedMessage produces visibleToModel: false.
    const event = createBranchForkedMessage({ from: 'main', to: 'feature/foo' });
    const messages = [
      createMessage({ role: 'user', content: 'hi', currentBranch: 'main' }),
      event,
      createMessage({ role: 'assistant', content: 'reply', currentBranch: 'feature/foo' }),
    ];
    const out = filterModelVisibleMessages(messages);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.id === event.id)).toBeUndefined();
  });
});
