import { afterEach, describe, expect, it, vi } from 'vitest';

const { githubFetchMock } = vi.hoisted(() => ({ githubFetchMock: vi.fn() }));
vi.mock('./github-tool-executor', async (importActual) => {
  const actual = await importActual<typeof import('./github-tool-executor')>();
  return { ...actual, githubFetch: (...args: unknown[]) => githubFetchMock(...args) };
});

import {
  createReviewCheckRun,
  decodeGitHubBase64Utf8,
  detectStrandedMergedPR,
  detectToolCall,
  executePostPRReview,
  findMergedPRForBranch,
  fetchCheckRunsForSha,
  fetchReviewGuidance,
} from './github-tools';
import type { ReviewResult } from '@/types';

function createStorageMock(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

function stubGitHubToken(token = 'ghs-test-token') {
  vi.stubGlobal('window', {
    localStorage: createStorageMock({ github_app_token: token }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectToolCall delegation validation', () => {
  it('trims delegation strings and drops blank entries', () => {
    const result = detectToolCall(
      '```json\n{"tool":"delegate_coder","args":{"task":"   ","tasks":["  inspect auth  ","   "],"files":[" src/auth.ts ",""],"intent":" tighten handoff flow ","deliverable":" a concise summary ","knownContext":[" existing note ","   "],"constraints":[" keep the API stable "," "],"declaredCapabilities":["repo:read","repo:write","not:a-real-capability"]}}\n```',
    );

    expect(result).toEqual({
      tool: 'delegate_coder',
      args: {
        task: undefined,
        tasks: ['inspect auth'],
        files: ['src/auth.ts'],
        intent: 'tighten handoff flow',
        deliverable: 'a concise summary',
        knownContext: ['existing note'],
        constraints: ['keep the API stable'],
        declaredCapabilities: ['repo:read', 'repo:write'],
      },
    });
  });
});

describe('decodeGitHubBase64Utf8', () => {
  it('decodes UTF-8 GitHub file content without mojibake', () => {
    const utf8Base64 = 'Y2Fmw6kg8J+agA==';

    expect(decodeGitHubBase64Utf8(utf8Base64)).toBe('café 🚀');
  });
});

describe('injected GitHub auth', () => {
  it('threads an explicit token into the request headers (server-side path)', async () => {
    githubFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ type: 'file', content: btoa('# REVIEW.md') }), { status: 200 }),
    );

    const result = await fetchReviewGuidance('octo/repo', 'main', { token: 'install-token-xyz' });

    expect(result).toBe('# REVIEW.md');
    const [, init] = githubFetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('token install-token-xyz');
    expect(headers['User-Agent']).toBeTruthy();
  });
});

describe('fetchCheckRunsForSha', () => {
  const checkRun = (id: number) => ({
    id,
    name: `check-${id}`,
    status: 'completed',
    conclusion: 'success',
    app: { id: 42 },
  });

  it('paginates until the complete check-run set has been read', async () => {
    githubFetchMock.mockReset();
    githubFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 101,
            check_runs: Array.from({ length: 100 }, (_, i) => checkRun(i + 1)),
          }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 101, check_runs: [checkRun(101)] }), {
          status: 200,
        }),
      );

    const result = await fetchCheckRunsForSha('octo/repo', 'sha-1', { token: 'tok' });

    expect(result).toHaveLength(101);
    expect(githubFetchMock).toHaveBeenCalledTimes(2);
    expect(githubFetchMock.mock.calls[1]?.[0]).toContain('page=2');
  });

  it('fails closed when a successful response is malformed or contains an unidentifiable run', async () => {
    githubFetchMock.mockReset();
    githubFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 0 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 1,
            check_runs: [
              { name: 'failure-without-an-id', status: 'completed', conclusion: 'failure' },
            ],
          }),
          { status: 200 },
        ),
      );

    await expect(fetchCheckRunsForSha('octo/repo', 'sha-1')).resolves.toBeNull();
    await expect(fetchCheckRunsForSha('octo/repo', 'sha-1')).resolves.toBeNull();
  });

  it('returns null after transport retries are exhausted instead of throwing', async () => {
    githubFetchMock.mockReset();
    githubFetchMock.mockRejectedValueOnce(new Error('transport down'));

    await expect(fetchCheckRunsForSha('octo/repo', 'sha-1')).resolves.toBeNull();
  });

  it('fails closed when the endpoint cap leaves the check-run set potentially truncated', async () => {
    githubFetchMock.mockReset();
    githubFetchMock.mockImplementation(async () => {
      const page = githubFetchMock.mock.calls.length;
      return new Response(
        JSON.stringify({
          total_count: 1000,
          check_runs: Array.from({ length: 100 }, (_, i) => checkRun(page * 100 + i)),
        }),
        { status: 200 },
      );
    });

    await expect(fetchCheckRunsForSha('octo/repo', 'sha-1')).resolves.toBeNull();
    expect(githubFetchMock).toHaveBeenCalledTimes(10);
  });
});

describe('findMergedPRForBranch', () => {
  it('returns the most recent merged PR for a closed branch PR lookup', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            number: 1,
            title: 'Closed only',
            html_url: 'https://github.test/pr/1',
            merged_at: null,
          },
          {
            number: 2,
            title: 'Older merge',
            html_url: 'https://github.test/pr/2',
            merged_at: '2026-06-10T00:00:00Z',
            base: { ref: 'main' },
          },
          {
            number: 3,
            title: 'Newer merge',
            html_url: 'https://github.test/pr/3',
            merged_at: '2026-06-11T00:00:00Z',
            base: { ref: 'main' },
            head: { sha: 'sha-newer' },
          },
        ]),
        { status: 200 },
      ),
    );

    const result = await findMergedPRForBranch('octo/repo', 'feature/merged');

    expect(result).toEqual({
      number: 3,
      title: 'Newer merge',
      url: 'https://github.test/pr/3',
      mergedAt: '2026-06-11T00:00:00Z',
      baseBranch: 'main',
      headSha: 'sha-newer',
    });
    const [url, init] = githubFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/repos/octo/repo/pulls?state=closed&head=octo%3Afeature%2Fmerged',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('token ghs-test-token');
  });

  it('captures the real base branch so a non-default-base merge can be filtered', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            number: 7,
            title: 'Stacked onto develop',
            html_url: 'https://github.test/pr/7',
            merged_at: '2026-06-12T00:00:00Z',
            base: { ref: 'develop' },
          },
        ]),
        { status: 200 },
      ),
    );

    await expect(findMergedPRForBranch('octo/repo', 'feature/stacked')).resolves.toMatchObject({
      number: 7,
      baseBranch: 'develop',
    });
  });

  it('returns null when no closed PR for the branch was merged', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ number: 4, merged_at: null }]), { status: 200 }),
    );

    await expect(findMergedPRForBranch('octo/repo', 'feature/unmerged')).resolves.toBeNull();
    expect(githubFetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null silently when the API request fails', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 403 }));

    await expect(findMergedPRForBranch('octo/repo', 'feature/api-fail')).resolves.toBeNull();
  });

  it('caches positive hits only so misses re-check on the next open', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 8,
              title: 'Merged later',
              html_url: 'https://github.test/pr/8',
              merged_at: '2026-06-12T00:00:00Z',
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 9,
              title: 'Should not replace cache',
              html_url: 'https://github.test/pr/9',
              merged_at: '2026-06-13T00:00:00Z',
            },
          ]),
          { status: 200 },
        ),
      );

    await expect(findMergedPRForBranch('octo/repo', 'feature/cache-miss')).resolves.toBeNull();
    await expect(findMergedPRForBranch('octo/repo', 'feature/cache-miss')).resolves.toMatchObject({
      number: 8,
    });
    await expect(findMergedPRForBranch('octo/repo', 'feature/cache-miss')).resolves.toMatchObject({
      number: 8,
    });
    expect(githubFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('detectStrandedMergedPR — branch-freshness identity check', () => {
  function mergedListResponse(branch: string, headSha: string) {
    return new Response(
      JSON.stringify([
        {
          number: 21,
          title: `merged ${branch}`,
          html_url: 'https://github.test/pr/21',
          merged_at: '2026-06-12T00:00:00Z',
          base: { ref: 'main' },
          head: { sha: headSha },
        },
      ]),
      { status: 200 },
    );
  }

  it('returns the merged PR when the branch is gone (normal post-merge cleanup)', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock
      .mockResolvedValueOnce(mergedListResponse('feature/gone', 'sha-merged'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(detectStrandedMergedPR('octo/repo', 'feature/gone')).resolves.toMatchObject({
      number: 21,
    });
    // closed-PR lookup + branch-tip probe; no open-PR call when the branch is absent.
    expect(githubFetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the merged PR when the live tip still points at the merged commit', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock
      .mockResolvedValueOnce(mergedListResponse('feature/at-merge', 'sha-x'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { sha: 'sha-x' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await expect(detectStrandedMergedPR('octo/repo', 'feature/at-merge')).resolves.toMatchObject({
      number: 21,
    });
  });

  it('suppresses and evicts the cache when the branch tip diverged (reused name)', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock
      .mockResolvedValueOnce(mergedListResponse('feature/reused', 'sha-old'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { sha: 'sha-new' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(mergedListResponse('feature/reused', 'sha-old'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { sha: 'sha-new' } }), { status: 200 }),
      );

    await expect(detectStrandedMergedPR('octo/repo', 'feature/reused')).resolves.toBeNull();
    // Eviction means the next detection re-fetches the closed-PR list instead of
    // being served the shadowed stale positive from cache.
    await expect(detectStrandedMergedPR('octo/repo', 'feature/reused')).resolves.toBeNull();
    expect(githubFetchMock).toHaveBeenCalledTimes(4);
  });

  it('suppresses when the branch matches but a fresh open PR is in flight', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock
      .mockResolvedValueOnce(mergedListResponse('feature/reopened', 'sha-x'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { sha: 'sha-x' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { number: 99, title: 'new work', html_url: 'u', head: { sha: 'sha-x' } },
          ]),
          { status: 200 },
        ),
      );

    await expect(detectStrandedMergedPR('octo/repo', 'feature/reopened')).resolves.toBeNull();
  });

  it('suppresses without evicting when the tip cannot be verified', async () => {
    githubFetchMock.mockReset();
    stubGitHubToken();
    githubFetchMock
      .mockResolvedValueOnce(mergedListResponse('feature/unverifiable', 'sha-x'))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(detectStrandedMergedPR('octo/repo', 'feature/unverifiable')).resolves.toBeNull();
    // Second call: merged PR served from cache (not evicted), only the tip probe re-runs.
    await expect(detectStrandedMergedPR('octo/repo', 'feature/unverifiable')).resolves.toBeNull();
    expect(githubFetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('createReviewCheckRun', () => {
  it('posts a completed check run with the verdict, pinned to the head SHA, non-retrying', async () => {
    githubFetchMock.mockResolvedValue(new Response('{}', { status: 201 }));

    await createReviewCheckRun(
      'octo/repo',
      'sha-1',
      'failure',
      { title: 'Critical findings', summary: 'Found a critical issue.' },
      { token: 'tok' },
    );

    const [url, init, opts] = githubFetchMock.mock.lastCall as [string, RequestInit, unknown];
    expect(url).toBe('https://api.github.com/repos/octo/repo/check-runs');
    expect(opts).toEqual({ retry: false });
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      head_sha: 'sha-1',
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('throws on a non-ok response so the caller can log without aborting', async () => {
    githubFetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(
      createReviewCheckRun('octo/repo', 'sha-1', 'success', { title: 't', summary: 's' }),
    ).rejects.toThrow();
  });
});

describe('executePostPRReview — 422 inline-anchor salvage', () => {
  // Hunk: new-file lines 8 (context), 9 & 10 (added), 11 (context) are
  // anchorable on the RIGHT side; everything else (e.g. line 99) is not.
  const DIFF = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -8,2 +8,4 @@',
    ' const a = 1;',
    '+const b = 2;',
    '+const c = 3;',
    ' const d = 4;',
  ].join('\n');

  const result = (comments: ReviewResult['comments']): ReviewResult => ({
    summary: 'Summary text.',
    comments,
    filesReviewed: 1,
    totalFiles: 1,
    truncated: false,
    provider: 'zen',
    model: 'glm-5.1',
    reviewedAt: 0,
  });

  const bodyOf = (callIndex: number) =>
    JSON.parse((githubFetchMock.mock.calls[callIndex][1] as RequestInit).body as string) as {
      body: string;
      comments: Array<{ path: string; line: number }>;
    };

  it('posts all anchors in one request when none are rejected', async () => {
    githubFetchMock.mockReset();
    githubFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const posted = await executePostPRReview(
      'octo/repo',
      1,
      'sha',
      result([
        { file: 'src/app.ts', line: 9, severity: 'warning', comment: 'real bug' },
        { file: 'src/app.ts', line: 10, severity: 'note', comment: 'nit' },
      ]),
      { token: 'tkn' },
      DIFF,
    );

    expect(posted).toBe(2);
    expect(githubFetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).comments).toHaveLength(2);
  });

  it('on 422, retries with only the valid anchors and folds the rest into the body', async () => {
    githubFetchMock.mockReset();
    githubFetchMock
      .mockResolvedValueOnce(new Response('line must be part of the diff', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const posted = await executePostPRReview(
      'octo/repo',
      1,
      'sha',
      result([
        { file: 'src/app.ts', line: 9, severity: 'warning', comment: 'real bug' },
        { file: 'src/app.ts', line: 99, severity: 'note', comment: 'hallucinated line' },
      ]),
      { token: 'tkn' },
      DIFF,
    );

    // Only the in-hunk anchor survives inline; the bad one is reported in body.
    expect(posted).toBe(1);
    expect(githubFetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyOf(1);
    expect(retry.comments).toEqual([expect.objectContaining({ path: 'src/app.ts', line: 9 })]);
    expect(retry.body).toContain('hallucinated line');
    expect(retry.body).not.toContain('real bug'); // stayed inline, not duplicated to body
  });

  it('folds everything into the body when no anchor is salvageable', async () => {
    githubFetchMock.mockReset();
    githubFetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const posted = await executePostPRReview(
      'octo/repo',
      1,
      'sha',
      result([
        { file: 'src/app.ts', line: 99, severity: 'warning', comment: 'bad anchor one' },
        { file: 'src/app.ts', line: 100, severity: 'note', comment: 'bad anchor two' },
      ]),
      { token: 'tkn' },
      DIFF,
    );

    expect(posted).toBe(0);
    expect(githubFetchMock).toHaveBeenCalledTimes(2);
    const fallback = bodyOf(1);
    expect(fallback.comments).toEqual([]);
    expect(fallback.body).toContain('bad anchor one');
    expect(fallback.body).toContain('bad anchor two');
  });

  it('without a diff, keeps the blunt all-to-body fallback on 422', async () => {
    githubFetchMock.mockReset();
    githubFetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const posted = await executePostPRReview(
      'octo/repo',
      1,
      'sha',
      result([{ file: 'src/app.ts', line: 9, severity: 'warning', comment: 'real bug' }]),
      { token: 'tkn' },
      // no diff
    );

    expect(posted).toBe(0);
    expect(githubFetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).comments).toEqual([]);
  });

  it('falls back to body-only when the salvage retry itself 422s', async () => {
    githubFetchMock.mockReset();
    githubFetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 422 }))
      .mockResolvedValueOnce(new Response('still bad', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const posted = await executePostPRReview(
      'octo/repo',
      1,
      'sha',
      result([
        { file: 'src/app.ts', line: 9, severity: 'warning', comment: 'real bug' },
        { file: 'src/app.ts', line: 99, severity: 'note', comment: 'bad anchor' },
      ]),
      { token: 'tkn' },
      DIFF,
    );

    expect(posted).toBe(0);
    expect(githubFetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(2).comments).toEqual([]);
  });
});
