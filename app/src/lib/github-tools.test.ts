import { describe, expect, it, vi } from 'vitest';

const { githubFetchMock } = vi.hoisted(() => ({ githubFetchMock: vi.fn() }));
vi.mock('./github-tool-executor', async (importActual) => {
  const actual = await importActual<typeof import('./github-tool-executor')>();
  return { ...actual, githubFetch: (...args: unknown[]) => githubFetchMock(...args) };
});

import { decodeGitHubBase64Utf8, detectToolCall, fetchReviewGuidance } from './github-tools';

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
