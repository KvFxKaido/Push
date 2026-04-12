import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStreamFn,
  mockBuildReviewerRuntimeContext,
  mockGetUserProfile,
  mockExecuteAnyToolCall,
  mockCreateExplorerToolHooks,
} = vi.hoisted(() => ({
  mockStreamFn: vi.fn(),
  mockBuildReviewerRuntimeContext: vi.fn(),
  mockGetUserProfile: vi.fn(),
  mockExecuteAnyToolCall: vi.fn(),
  mockCreateExplorerToolHooks: vi.fn(),
}));

vi.mock('@/hooks/useUserProfile', () => ({
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
}));

vi.mock('./orchestrator', () => ({
  buildUserIdentityBlock: vi.fn(() => ''),
}));

/**
 * Shared deep-reviewer options used across tests. Providers now inject streamFn
 * and modelId, so tests pass them explicitly.
 */
const baseDeepOptions = {
  provider: 'openrouter' as const,
  streamFn: mockStreamFn as unknown as import('./orchestrator-provider-routing').StreamChatFn,
  modelId: 'default-reviewer-model',
};

vi.mock('./role-memory-context', () => ({
  buildReviewerRuntimeContext: (...args: unknown[]) => mockBuildReviewerRuntimeContext(...args),
}));

vi.mock('./explorer-agent', () => ({
  createExplorerToolHooks: (...args: unknown[]) => mockCreateExplorerToolHooks(...args),
}));

vi.mock('./web-search-tools', async () => {
  const actual = await vi.importActual<typeof import('./web-search-tools')>('./web-search-tools');
  return {
    ...actual,
    WEB_SEARCH_TOOL_PROTOCOL: '',
  };
});

vi.mock('./tool-dispatch', async () => {
  const actual = await vi.importActual<typeof import('./tool-dispatch')>('./tool-dispatch');
  return {
    ...actual,
    executeAnyToolCall: (...args: unknown[]) => mockExecuteAnyToolCall(...args),
  };
});

import { runDeepReviewer } from './deep-reviewer-agent';

function makeAddedFileDiff(path: string, addedContent: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${addedContent}`,
    '',
  ].join('\n');
}

describe('runDeepReviewer', () => {
  beforeEach(() => {
    mockStreamFn.mockReset();
    mockBuildReviewerRuntimeContext.mockReset();
    mockGetUserProfile.mockReset();
    mockExecuteAnyToolCall.mockReset();
    mockCreateExplorerToolHooks.mockReset();

    mockBuildReviewerRuntimeContext.mockResolvedValue('');
    mockGetUserProfile.mockReturnValue({ displayName: '', bio: '', githubLogin: undefined });
    mockCreateExplorerToolHooks.mockReturnValue({});
    mockExecuteAnyToolCall.mockResolvedValue({ text: '[Tool Result] ok' });
  });

  it('marks results truncated when diff chunking omits files', async () => {
    let streamCalls = 0;
    mockStreamFn.mockImplementation(
      (_messages: unknown, onToken: (token: string) => void, onDone: () => void) => {
        if (streamCalls === 0) {
          onToken('{"tool":"sandbox_read_file","args":{"path":"/workspace/src/large.ts"}}');
        } else {
          onToken('[REVIEW_COMPLETE]\n{"summary":"Looks good","comments":[]}');
        }
        streamCalls++;
        onDone();
        return Promise.resolve();
      },
    );

    const diff = [
      makeAddedFileDiff('src/large.ts', 'x'.repeat(45_000)),
      makeAddedFileDiff('src/small.ts', 'const small = true;'),
    ].join('');

    const result = await runDeepReviewer(
      diff,
      { ...baseDeepOptions, allowedRepo: 'KvFxKaido/Push', sandboxId: 'sb-123' },
      { onStatus: () => {} },
    );

    expect(result.filesReviewed).toBe(1);
    expect(result.totalFiles).toBe(2);
    expect(result.truncated).toBe(true);
    expect(mockExecuteAnyToolCall).toHaveBeenCalledOnce();
  });

  it('does not make a final forced-output call after cancellation', async () => {
    const abortController = new AbortController();
    let streamCalls = 0;

    mockStreamFn.mockImplementation(
      (_messages: unknown, onToken: (token: string) => void, onDone: () => void) => {
        streamCalls++;
        onToken('Still investigating');
        onDone();
        if (streamCalls === 7) abortController.abort();
        return Promise.resolve();
      },
    );

    await expect(
      runDeepReviewer(
        makeAddedFileDiff('src/example.ts', 'const value = 1;'),
        { ...baseDeepOptions, allowedRepo: 'KvFxKaido/Push' },
        { onStatus: () => {}, signal: abortController.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(mockStreamFn).toHaveBeenCalledTimes(7);
  });
});
