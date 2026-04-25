import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetProviderPushStream,
  mockBuildReviewerRuntimeContext,
  mockGetUserProfile,
  mockExecuteAnyToolCall,
  mockCreateExplorerToolHooks,
} = vi.hoisted(() => ({
  mockGetProviderPushStream: vi.fn(),
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
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

const baseDeepOptions = {
  provider: 'openrouter' as const,
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
  return actual;
});

vi.mock('./web-tool-execution-runtime', () => ({
  WebToolExecutionRuntime: class {
    execute(...args: unknown[]) {
      return mockExecuteAnyToolCall(...args);
    }
  },
}));

import { runDeepReviewer } from './deep-reviewer-agent';
import type { PushStream, PushStreamEvent } from '@push/lib/provider-contract';

/**
 * Build a PushStream whose round-by-round responses are computed by `respond`.
 * Each invocation increments the round counter and emits the event sequence
 * the function returns. Mirrors the legacy mockStreamFn pattern (per-call
 * branching) without coupling to the 12-arg callback shape.
 */
function makeRoundStream(respond: (round: number) => PushStreamEvent[]): {
  stream: PushStream;
  callCount: () => number;
} {
  let round = 0;
  const stream: PushStream = () => {
    const events = respond(round);
    round += 1;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  };
  return { stream, callCount: () => round };
}

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
    mockGetProviderPushStream.mockReset();
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
    const { stream } = makeRoundStream((round) => {
      if (round === 0) {
        return [
          {
            type: 'text_delta',
            text: '{"tool":"sandbox_read_file","args":{"path":"/workspace/src/large.ts"}}',
          },
          { type: 'done', finishReason: 'stop' },
        ];
      }
      return [
        { type: 'text_delta', text: '[REVIEW_COMPLETE]\n{"summary":"Looks good","comments":[]}' },
        { type: 'done', finishReason: 'stop' },
      ];
    });
    mockGetProviderPushStream.mockImplementation(() => stream);

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
    const { stream, callCount } = makeRoundStream((round) => {
      // Abort during the 7th round so the loop's own circuit breaker
      // (MAX_DEEP_REVIEW_ROUNDS=7) doesn't fire first; the kernel's pre-loop
      // signal check should reject before launching the forced-output call.
      if (round === 6) abortController.abort();
      return [
        { type: 'text_delta', text: 'Still investigating' },
        { type: 'done', finishReason: 'stop' },
      ];
    });
    mockGetProviderPushStream.mockImplementation(() => stream);

    await expect(
      runDeepReviewer(
        makeAddedFileDiff('src/example.ts', 'const value = 1;'),
        { ...baseDeepOptions, allowedRepo: 'KvFxKaido/Push' },
        { onStatus: () => {}, signal: abortController.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(callCount()).toBe(7);
  });
});
