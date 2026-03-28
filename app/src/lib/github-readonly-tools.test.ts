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
    decodeBase64: (content) => atob(content),
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

  it('formats a PR list result with list card metadata', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.includes('/pulls?state=open')) {
        return Response.json([
          {
            number: 7,
            title: 'Ship worker bridge',
            created_at: '2026-03-28T14:00:00.000Z',
            user: { login: 'ishaw' },
            additions: 18,
            deletions: 4,
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'list_prs',
      args: { repo: 'owner/repo', state: 'open' },
    });

    expect(result.card?.type).toBe('pr-list');
    if (!result.card || result.card.type !== 'pr-list') {
      throw new Error('expected PR list card');
    }
    expect(result.card.data.prs).toHaveLength(1);
    expect(result.card.data.prs[0].number).toBe(7);
    expect(result.text).toContain('Ship worker bridge');
  });

  it('formats CI checks with computed overall status', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.includes('/check-runs?per_page=50')) {
        return Response.json({
          check_runs: [
            { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://example.test/build' },
            { name: 'lint', status: 'in_progress', conclusion: null, html_url: 'https://example.test/lint' },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'fetch_checks',
      args: { repo: 'owner/repo', ref: 'feature/bridge' },
    });

    expect(result.card?.type).toBe('ci-status');
    if (!result.card || result.card.type !== 'ci-status') {
      throw new Error('expected CI status card');
    }
    expect(result.card.data.overall).toBe('pending');
    expect(result.card.data.checks).toHaveLength(2);
    expect(result.text).toContain('CI Status for owner/repo@feature/bridge: PENDING');
  });

  it('reads a file range with numbered lines', async () => {
    const content = btoa('first line\nsecond line\nthird line');
    const runtime = createRuntime(async (url) => {
      if (url.includes('/contents/src%2Fdemo.ts')) {
        return Response.json({
          type: 'file',
          size: 33,
          content,
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'read_file',
      args: { repo: 'owner/repo', path: 'src/demo.ts', start_line: 2, end_line: 3 },
    });

    expect(result.card?.type).toBe('editor');
    if (!result.card || result.card.type !== 'editor') {
      throw new Error('expected editor card');
    }
    expect(result.card.data.language).toBe('typescript');
    expect(result.text).toContain('2\tsecond line');
    expect(result.text).toContain('3\tthird line');
  });

  it('lists visible directory entries and hides sensitive ones', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.endsWith('/contents/src')) {
        return Response.json([
          { name: 'components', type: 'dir' },
          { name: 'index.ts', type: 'file', size: 120 },
          { name: '.env', type: 'file', size: 24 },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'list_directory',
      args: { repo: 'owner/repo', path: 'src' },
    });

    expect(result.card?.type).toBe('file-list');
    if (!result.card || result.card.type !== 'file-list') {
      throw new Error('expected file list card');
    }
    expect(result.card.data.entries).toHaveLength(2);
    expect(result.text).toContain('1 sensitive entry hidden');
    expect(result.text).toContain('DIR components/');
  });

  it('lists commit files with totals', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.endsWith('/commits/abc123')) {
        return Response.json({
          sha: 'abc123456789',
          author: { login: 'ishaw' },
          commit: {
            message: 'Refactor shared core\n\nbody',
            author: { name: 'Shawn', date: '2026-03-28T18:00:00.000Z' },
          },
          files: [
            { filename: 'lib/github-readonly-tools.ts', status: 'modified', additions: 25, deletions: 4 },
            { filename: 'app/src/worker/worker-github-tools.ts', status: 'added', additions: 10, deletions: 0 },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubReadonlyTool(runtime, {
      tool: 'list_commit_files',
      args: { repo: 'owner/repo', ref: 'abc123' },
    });

    expect(result.card?.type).toBe('commit-files');
    if (!result.card || result.card.type !== 'commit-files') {
      throw new Error('expected commit files card');
    }
    expect(result.card.data.totalChanges).toEqual({ additions: 35, deletions: 4 });
    expect(result.text).toContain('Total: +35 -4');
  });
});
