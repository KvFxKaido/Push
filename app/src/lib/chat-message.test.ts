import { describe, it, expect } from 'vitest';
import {
  createBranchForkedMessage,
  createMessage,
  effectiveMessageBranch,
  filterModelVisibleMessages,
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

describe('effectiveMessageBranch', () => {
  it('returns msg.branch when stamped', () => {
    expect(effectiveMessageBranch({ branch: 'feature/foo' }, 'main')).toBe('feature/foo');
  });

  it('falls back to conversation branch when message is unstamped', () => {
    expect(effectiveMessageBranch({}, 'main')).toBe('main');
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
