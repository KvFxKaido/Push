import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatMessage, Conversation, ToolExecutionResult } from '@/types';
import {
  buildPostPushCIContent,
  fetchPostPushCIStatus,
  schedulePostPushCIStatus,
  POST_PUSH_CI_DELAY_MS,
  type PostPushCIDeps,
} from './chat-post-push-ci';
import { executeToolCall } from '@/lib/github-tools';

vi.mock('@/lib/github-tools', () => ({
  executeToolCall: vi.fn(),
}));

const mockedExecute = vi.mocked(executeToolCall);

const CI_CARD: ChatCard = {
  type: 'ci-status',
  data: {
    type: 'ci-status',
    repo: 'owner/repo',
    ref: 'abc1234',
    checks: [],
    overall: 'pending',
    fetchedAt: '2026-07-02T00:00:00.000Z',
  },
} as unknown as ChatCard;

const CHECKS_TEXT = [
  '[Tool Result — fetch_checks]',
  'CI Status for owner/repo@abc1234: PENDING',
  '  ⏳ build: in_progress',
  '  ✓ lint: success',
].join('\n');

function checksResult(overrides?: Partial<ToolExecutionResult>): ToolExecutionResult {
  return { text: CHECKS_TEXT, card: CI_CARD, ...overrides };
}

function makeDeps(): { deps: PostPushCIDeps; conversations: Record<string, Conversation> } {
  const conversations: Record<string, Conversation> = {
    'chat-1': {
      id: 'chat-1',
      messages: [] as ChatMessage[],
      branch: 'feat/x',
    } as unknown as Conversation,
  };
  const deps: PostPushCIDeps = {
    chatId: 'chat-1',
    repo: 'owner/repo',
    setConversations: vi.fn((updater) => {
      const next = typeof updater === 'function' ? updater(conversations) : updater;
      Object.assign(conversations, next);
    }),
    dirtyConversationIdsRef: { current: new Set<string>() },
    branchInfoRef: { current: { currentBranch: 'feat/x', defaultBranch: 'main' } },
  };
  return { deps, conversations };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('buildPostPushCIContent', () => {
  it('strips the tool-result envelope header and keeps the per-check summary', () => {
    expect(buildPostPushCIContent(CHECKS_TEXT)).toBe(
      [
        'CI status after push:',
        'CI Status for owner/repo@abc1234: PENDING',
        '  ⏳ build: in_progress',
        '  ✓ lint: success',
      ].join('\n'),
    );
  });

  it('falls back to the bare lead line when the body is empty', () => {
    expect(buildPostPushCIContent('[Tool Result — fetch_checks]\n')).toBe('CI status after push:');
  });
});

describe('fetchPostPushCIStatus', () => {
  it('returns model-visible content plus the ci-status card', async () => {
    mockedExecute.mockResolvedValueOnce(checksResult());
    const status = await fetchPostPushCIStatus('owner/repo');
    expect(mockedExecute).toHaveBeenCalledWith(
      { tool: 'fetch_checks', args: { repo: 'owner/repo', ref: 'HEAD' } },
      'owner/repo',
    );
    expect(status?.content).toContain('CI status after push:');
    expect(status?.content).toContain('CI Status for owner/repo@abc1234: PENDING');
    expect(status?.card).toBe(CI_CARD);
  });

  it('still returns the summary content when no card came back', async () => {
    mockedExecute.mockResolvedValueOnce(checksResult({ card: undefined }));
    const status = await fetchPostPushCIStatus('owner/repo');
    expect(status?.content).toContain('CI Status for owner/repo@abc1234: PENDING');
    expect(status?.card).toBeNull();
  });

  it('returns null on a tool-error result', async () => {
    mockedExecute.mockResolvedValueOnce({ text: '[Tool Error] rate limited' });
    expect(await fetchPostPushCIStatus('owner/repo')).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    mockedExecute.mockRejectedValueOnce(new Error('network down'));
    expect(await fetchPostPushCIStatus('owner/repo')).toBeNull();
  });
});

describe('schedulePostPushCIStatus', () => {
  it('waits for the delay, then injects a branch-stamped assistant message with summary + card', async () => {
    mockedExecute.mockResolvedValueOnce(checksResult());
    const { deps, conversations } = makeDeps();

    schedulePostPushCIStatus(deps);
    expect(mockedExecute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POST_PUSH_CI_DELAY_MS);

    const messages = conversations['chat-1'].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('CI status after push:');
    expect(messages[0].content).toContain('✓ lint: success');
    expect(messages[0].cards).toEqual([CI_CARD]);
    expect(messages[0].branch).toBe('feat/x');
    expect(deps.dirtyConversationIdsRef.current.has('chat-1')).toBe(true);
  });

  it('injects the text summary even when the result carried no card', async () => {
    mockedExecute.mockResolvedValueOnce(checksResult({ card: undefined }));
    const { deps, conversations } = makeDeps();

    schedulePostPushCIStatus(deps);
    await vi.advanceTimersByTimeAsync(POST_PUSH_CI_DELAY_MS);

    const messages = conversations['chat-1'].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('CI Status for owner/repo@abc1234: PENDING');
    expect(messages[0].cards).toBeUndefined();
  });

  it('drops out without touching chat state when the fetch fails', async () => {
    mockedExecute.mockRejectedValueOnce(new Error('boom'));
    const { deps, conversations } = makeDeps();

    schedulePostPushCIStatus(deps);
    await vi.advanceTimersByTimeAsync(POST_PUSH_CI_DELAY_MS);

    expect(conversations['chat-1'].messages).toHaveLength(0);
    expect(deps.dirtyConversationIdsRef.current.size).toBe(0);
  });

  it('no-ops when the conversation is gone by fire time', async () => {
    mockedExecute.mockResolvedValueOnce(checksResult());
    const { deps, conversations } = makeDeps();
    delete conversations['chat-1'];

    schedulePostPushCIStatus(deps);
    await vi.advanceTimersByTimeAsync(POST_PUSH_CI_DELAY_MS);

    expect(conversations['chat-1']).toBeUndefined();
  });
});
