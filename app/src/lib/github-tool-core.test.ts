import { describe, expect, it, vi } from 'vitest';
import {
  executeGitHubCoreTool,
  fetchRepoBranchesData,
  type GitHubCoreRuntime,
} from '@push/lib/github-tool-core';

function createRuntime(
  fetchImpl: (url: string, options?: RequestInit) => Promise<Response>,
): GitHubCoreRuntime {
  return {
    githubFetch: fetchImpl,
    buildHeaders: (accept = 'application/vnd.github.v3+json') => ({
      Accept: accept,
      Authorization: 'token test-token',
    }),
    buildApiUrl: (path) => `https://api.github.com${path}`,
    decodeBase64: (content) => atob(content),
    isSensitivePath: (path) => path.includes('.env'),
    redactSensitiveText: (text) => ({ text, redacted: false }),
    formatSensitivePathToolError: (path) => `blocked: ${path}`,
  };
}

describe('github-tool-core shared core', () => {
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
    expect(result.branches[1]).toEqual({
      name: 'feature/demo',
      isDefault: false,
      isProtected: false,
    });
  });

  it('blocks sensitive search paths before making a request', async () => {
    const fetchSpy = vi.fn<GitHubCoreRuntime['githubFetch']>().mockResolvedValue(Response.json({}));
    const runtime = createRuntime(fetchSpy);

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'search_files',
      args: { repo: 'owner/repo', query: 'token', path: '.env' },
    });

    expect(result.text).toBe('blocked: .env');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats a PR result with card metadata and review comments', async () => {
    const runtime = createRuntime(async (url, options) => {
      if (
        url.endsWith('/pulls/42') &&
        options?.headers &&
        (options.headers as Record<string, string>).Accept === 'application/vnd.github.v3+json'
      ) {
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
          {
            sha: 'abcdef123456',
            commit: { message: 'Add worker bridge', author: { name: 'Shawn' } },
          },
        ]);
      }
      if (
        url.endsWith('/pulls/42') &&
        options?.headers &&
        (options.headers as Record<string, string>).Accept === 'application/vnd.github.v3.diff'
      ) {
        return new Response('diff --git a/file b/file');
      }
      if (url.endsWith('/pulls/42/files')) {
        return Response.json([
          { filename: 'app/worker.ts', status: 'modified', additions: 10, deletions: 2 },
        ]);
      }
      if (url.includes('/pulls/42/comments')) {
        expect(url).toContain('direction=desc');
        expect(url).toContain('per_page=20');
        // Simulate GitHub returning newest-first; the tool should reverse so
        // the display order stays chronological (oldest -> newest).
        return Response.json([
          {
            user: { login: 'reviewer' },
            path: 'app/worker.ts',
            line: 17,
            body: 'third (newest) comment',
          },
          {
            user: { login: 'reviewer' },
            path: 'app/worker.ts',
            line: 12,
            body: 'second comment',
          },
          {
            user: { login: 'reviewer' },
            path: 'app/worker.ts',
            line: 9,
            body: 'first (oldest) comment',
          },
        ]);
      }
      if (url.includes('/issues/42/comments')) {
        expect(url).toContain('per_page=10');
        return Response.json([
          {
            user: { login: 'pm' },
            body: 'Looks good, ship it!',
            created_at: '2026-03-28T13:00:00.000Z',
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'fetch_pr',
      args: { repo: 'owner/repo', pr: 42 },
    });

    expect(result.card?.type).toBe('pr');
    if (!result.card || result.card.type !== 'pr') {
      throw new Error('expected PR card');
    }
    expect(result.card.data.title).toBe('Add worker bridge');
    expect(result.text).toContain('Linked Issues');
    expect(result.text).toContain('Inline Review Comments (3)');
    expect(result.text).toContain('@reviewer on app/worker.ts:17');
    expect(result.text).toContain('Conversation (1)');
    expect(result.text).toContain('@pm: Looks good, ship it!');
    expect(result.card.data.reviewComments).toHaveLength(3);
    // Desc fetch is reversed so display stays chronological (oldest -> newest).
    expect(result.card.data.reviewComments?.map((c) => c.body)).toEqual([
      'first (oldest) comment',
      'second comment',
      'third (newest) comment',
    ]);
    const oldestIdx = result.text.indexOf('first (oldest) comment');
    const newestIdx = result.text.indexOf('third (newest) comment');
    expect(oldestIdx).toBeGreaterThan(-1);
    expect(newestIdx).toBeGreaterThan(oldestIdx);
    expect(result.card.data.issueComments).toHaveLength(1);
  });

  it('formats a PR result gracefully when review comments are absent', async () => {
    const runtime = createRuntime(async (url, options) => {
      if (
        url.endsWith('/pulls/7') &&
        options?.headers &&
        (options.headers as Record<string, string>).Accept === 'application/vnd.github.v3+json'
      ) {
        return Response.json({
          title: 'Tiny fix',
          additions: 1,
          deletions: 1,
          changed_files: 1,
          created_at: '2026-03-28T12:00:00.000Z',
          merged: false,
          state: 'open',
          user: { login: 'ishaw' },
          head: { ref: 'fix/tiny' },
          base: { ref: 'main' },
        });
      }
      if (url.endsWith('/pulls/7/commits')) {
        return Response.json([]);
      }
      if (
        url.endsWith('/pulls/7') &&
        options?.headers &&
        (options.headers as Record<string, string>).Accept === 'application/vnd.github.v3.diff'
      ) {
        return new Response('');
      }
      if (url.endsWith('/pulls/7/files')) {
        return Response.json([]);
      }
      if (url.includes('/pulls/7/comments')) {
        return Response.json([]);
      }
      if (url.includes('/issues/7/comments')) {
        return Response.json([]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'fetch_pr',
      args: { repo: 'owner/repo', pr: 7 },
    });

    expect(result.card?.type).toBe('pr');
    if (!result.card || result.card.type !== 'pr') {
      throw new Error('expected PR card');
    }
    expect(result.card.data.reviewComments).toBeUndefined();
    expect(result.card.data.issueComments).toBeUndefined();
    expect(result.text).not.toContain('Inline Review Comments');
    expect(result.text).not.toContain('Conversation (');
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

    const result = await executeGitHubCoreTool(runtime, {
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
            {
              name: 'build',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://example.test/build',
            },
            {
              name: 'lint',
              status: 'in_progress',
              conclusion: null,
              html_url: 'https://example.test/lint',
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
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

    const result = await executeGitHubCoreTool(runtime, {
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

    const result = await executeGitHubCoreTool(runtime, {
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
            {
              filename: 'lib/github-tool-core.ts',
              status: 'modified',
              additions: 25,
              deletions: 4,
            },
            {
              filename: 'app/src/worker/worker-github-tools.ts',
              status: 'added',
              additions: 10,
              deletions: 0,
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
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

  it('dispatches a workflow using the repo default branch when ref is omitted', async () => {
    const fetchSpy = vi.fn<GitHubCoreRuntime['githubFetch']>(async (url, options) => {
      if (url.endsWith('/repos/owner/repo')) {
        return Response.json({ default_branch: 'develop' });
      }
      if (url.includes('/actions/workflows/ci.yml/dispatches')) {
        expect(options?.method).toBe('POST');
        expect(options?.body).toBe(
          JSON.stringify({ ref: 'develop', inputs: { environment: 'staging' } }),
        );
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const runtime = createRuntime(fetchSpy);

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'trigger_workflow',
      args: { repo: 'owner/repo', workflow: 'ci.yml', inputs: { environment: 'staging' } },
    });

    expect(result.card).toBeUndefined();
    expect(result.text).toContain('Workflow "ci.yml" dispatched on owner/repo (ref: develop).');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('formats workflow runs into a workflow-runs card', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.includes('/actions/runs?per_page=2')) {
        return Response.json({
          total_count: 5,
          workflow_runs: [
            {
              id: 101,
              name: 'CI',
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              event: 'push',
              created_at: '2026-03-28T16:00:00.000Z',
              updated_at: '2026-03-28T16:05:00.000Z',
              html_url: 'https://example.test/runs/101',
              run_number: 88,
              actor: { login: 'ishaw' },
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'get_workflow_runs',
      args: { repo: 'owner/repo', count: 2 },
    });

    expect(result.card?.type).toBe('workflow-runs');
    if (!result.card || result.card.type !== 'workflow-runs') {
      throw new Error('expected workflow runs card');
    }
    expect(result.card.data.truncated).toBe(true);
    expect(result.card.data.runs[0].runNumber).toBe(88);
    expect(result.text).toContain('#88 CI');
  });

  it('formats workflow logs with job and step details', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.endsWith('/actions/runs/77')) {
        return Response.json({
          name: 'Deploy',
          run_number: 77,
          status: 'completed',
          conclusion: 'failure',
          head_branch: 'release',
          event: 'workflow_dispatch',
          html_url: 'https://example.test/runs/77',
        });
      }
      if (url.includes('/actions/runs/77/jobs?per_page=50')) {
        return Response.json({
          jobs: [
            {
              name: 'deploy',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://example.test/jobs/1',
              steps: [
                { name: 'Checkout', status: 'completed', conclusion: 'success', number: 1 },
                { name: 'Deploy', status: 'completed', conclusion: 'failure', number: 2 },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'get_workflow_logs',
      args: { repo: 'owner/repo', run_id: 77 },
    });

    expect(result.card?.type).toBe('workflow-logs');
    if (!result.card || result.card.type !== 'workflow-logs') {
      throw new Error('expected workflow logs card');
    }
    expect(result.card.data.jobs[0].steps).toHaveLength(2);
    expect(result.text).toContain('Run: Deploy #77');
    expect(result.text).toContain('2. Deploy');
  });

  it('creates a pull request through the shared tool core', async () => {
    const runtime = createRuntime(async (url, options) => {
      if (url.endsWith('/pulls')) {
        expect(options?.method).toBe('POST');
        expect(options?.body).toBe(
          JSON.stringify({
            title: 'Bridge GitHub tools',
            body: 'Ports the last legacy GitHub tools.',
            head: 'feature/bridge',
            base: 'main',
          }),
        );
        return Response.json({
          number: 55,
          title: 'Bridge GitHub tools',
          html_url: 'https://example.test/pulls/55',
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'create_pr',
      args: {
        repo: 'owner/repo',
        title: 'Bridge GitHub tools',
        body: 'Ports the last legacy GitHub tools.',
        head: 'feature/bridge',
        base: 'main',
      },
    });

    expect(result.text).toContain('PR #55 created on owner/repo.');
    expect(result.text).toContain('URL: https://example.test/pulls/55');
  });

  it('checks PR mergeability with CI details', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.endsWith('/pulls/12')) {
        return Response.json({
          title: 'Merge the bridge',
          state: 'open',
          mergeable: true,
          mergeable_state: 'clean',
          head: { ref: 'feature/bridge', sha: 'abc123' },
          base: { ref: 'main' },
        });
      }
      if (url.includes('/commits/abc123/check-runs?per_page=50')) {
        return Response.json({
          check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'check_pr_mergeable',
      args: { repo: 'owner/repo', pr_number: 12 },
    });

    expect(result.text).toContain('Mergeable: yes');
    expect(result.text).toContain('CI status: SUCCESS');
    expect(result.text).toContain('This PR is eligible for merge.');
  });

  it('finds an existing PR for a branch pair', async () => {
    const runtime = createRuntime(async (url) => {
      if (url.includes('/pulls?head=owner%3Afeature%2Fbridge')) {
        return Response.json([
          {
            number: 91,
            title: 'Existing bridge PR',
            html_url: 'https://example.test/pulls/91',
            head: { ref: 'feature/bridge' },
            base: { ref: 'main' },
            user: { login: 'ishaw' },
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await executeGitHubCoreTool(runtime, {
      tool: 'find_existing_pr',
      args: { repo: 'owner/repo', head_branch: 'feature/bridge', base_branch: 'main' },
    });

    expect(result.text).toContain('Found existing PR #91 on owner/repo.');
    expect(result.text).toContain('Author: ishaw');
  });
});
