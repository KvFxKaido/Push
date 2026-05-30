import { describe, expect, it, vi } from 'vitest';

const { githubFetchMock } = vi.hoisted(() => ({ githubFetchMock: vi.fn() }));
vi.mock('./github-tool-executor', async (importActual) => {
  const actual = await importActual<typeof import('./github-tool-executor')>();
  return { ...actual, githubFetch: (...args: unknown[]) => githubFetchMock(...args) };
});

import {
  createReviewCheckRun,
  decodeGitHubBase64Utf8,
  detectToolCall,
  executePostPRReview,
  fetchReviewGuidance,
} from './github-tools';
import type { ReviewResult } from '@/types';

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
