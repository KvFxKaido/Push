import { describe, expect, it, vi } from 'vitest';
import {
  executeGitHubReadonlyTool,
  fetchRepoBranchesData,
  type GitHubReadonlyRuntime,
} from '@push/lib/github-readonly-tools';

function createRuntime(fetchImpl: (url: string, options?: RequestInit) => Promise<Response>): GitHubReadonlyRuntime {
  return {
    githubFetch: fetchImpl,
    buildHeaders: (accept = 'application/vnd.github.v3+json') => ({ Accept: accept, Authorization: 'token test-token' }),
    buildApiUrl: (path) => `https://api.github.com${path}`,
    isSensitivePath: (path) => path.includes('.env'),
    redactSensitiveText: (text) => ({ text, redacted: false }),
    formatSensitivePathToolError: (path) => `blocked: ${path}`,
  };
}

describe('github-readonly-tools shared core', () => {
  it('fetches branches with default branch ordering', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.endsWith('/repos/owner/repo')) {
        return Response.json({ default_branch: 'main' });
      }
      if (url.includes('/branches?')) {
        return Response.json([
          { name: 'feature/demo', protected: false },
          { name: 'main', protected: true },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await fetchRepoBranchesData(runtime, 'owner/repo', 50);

    expect(result.defaultBranch).toBe('main');
    expect(result.branches[0]).toEqual({ name: 'main', isDefault: true, isProtected: true });
    expect(result.branches[1]).toEqual({ name: 'feature/demo', isDefault: false, isProtected: false });
  });

  it('blocks sensitive search paths before making a request', async () => {
    const fetchSpy = vi.fn<GitHubReadonlyRuntime['githubFetch']>().mockResolvedValue(Response.json({}));
    const runtime = createRuntime(fetchSpy);

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'search_files',
      args: { repo: 'owner/repo', query: 'token', path: '.env' },
    });

    expect(result.text).toBe('blocked: .env');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats a PR result with card metadata', async () => {
    const runtime = createRuntime(async (url, options) => {
      if (url.endsWith('/pulls/42') && options?.headers && (options.headers as Record<string, string>).Accept === 'application/vnd.github.v3+json') {
        return Response.json({
          title: 'Add worker bridge',
          body: 'Fixes #12',
          additions: 10,
          deletions: 2,
          changed_files: 1,
          created_at: '2026-03-28T12:00:00.000Z',
          merged: false,
          state: 'open',
          user: { login: 'ishaw' },
          head: { ref: 'feature/bridge' },
          base: { ref: 'main' },
        });
      }
      if (url.endsWith('/issues/12')) {
        return Response.json({ title: 'Track worker bridge' });
      }
      if (url.endsWith('/pulls/42/commits')) {
        return Response.json([
          { sha: 'abcdef123456', commit: { message: 'Add worker bridge', author: { name: 'Shawn' } } },
        ]);
      }
      if (url.endsWith('/pulls/42') && options?.headers && (options.headers as Record<string, string>).Accept === 'application/vnd.github.v3.diff') {
        return new Response('diff --git a/file b/file');
      }
      if (url.endsWith('/pulls/42/files')) {
        return Response.json([{ filename: 'app/worker.ts', status: 'modified', additions: 10, deletions: 2 }]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'fetch_pr',
      args: { repo: 'owner/repo', pr: 42 },
    });

    expect(result.card?.type).toBe('pr');
    if (!result.card || result.card.type !== 'pr') {
      throw new Error('expected PR card');
    }
    expect(result.card.data.title).toBe('Add worker bridge');
    expect(result.text).toContain('Linked Issues');
  });
});
