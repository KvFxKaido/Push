import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeGitHubToolViaWorker, fetchRepoBranchesViaWorker, supportsWorkerGitHubTool } from './github-tool-transport';
import * as githubAuth from './github-auth';

describe('github-tool-transport', () => {
  beforeEach(() => {
    vi.spyOn(githubAuth, 'getGitHubAuthHeaders').mockReturnValue({
      Authorization: 'token test-token',
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('recognizes the worker-backed tool subset', () => {
    expect(supportsWorkerGitHubTool('fetch_pr')).toBe(true);
    expect(supportsWorkerGitHubTool('list_prs')).toBe(true);
    expect(supportsWorkerGitHubTool('list_commits')).toBe(true);
    expect(supportsWorkerGitHubTool('read_file')).toBe(true);
    expect(supportsWorkerGitHubTool('grep_file')).toBe(true);
    expect(supportsWorkerGitHubTool('list_directory')).toBe(true);
    expect(supportsWorkerGitHubTool('list_branches')).toBe(true);
    expect(supportsWorkerGitHubTool('fetch_checks')).toBe(true);
    expect(supportsWorkerGitHubTool('search_files')).toBe(true);
    expect(supportsWorkerGitHubTool('list_commit_files')).toBe(true);
    expect(supportsWorkerGitHubTool('trigger_workflow')).toBe(true);
    expect(supportsWorkerGitHubTool('get_workflow_runs')).toBe(true);
    expect(supportsWorkerGitHubTool('get_workflow_logs')).toBe(true);
    expect(supportsWorkerGitHubTool('create_pr')).toBe(true);
    expect(supportsWorkerGitHubTool('merge_pr')).toBe(true);
    expect(supportsWorkerGitHubTool('delete_branch')).toBe(true);
    expect(supportsWorkerGitHubTool('check_pr_mergeable')).toBe(true);
    expect(supportsWorkerGitHubTool('find_existing_pr')).toBe(true);
    expect(supportsWorkerGitHubTool('delegate_coder')).toBe(false);
  });

  it('returns a parsed branch list payload from the worker', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      result: {
        text: '[Tool Result — list_branches]',
        card: {
          type: 'branch-list',
          data: {
            repo: 'owner/repo',
            defaultBranch: 'main',
            branches: [
              { name: 'main', isDefault: true, isProtected: true },
              { name: 'feature/demo', isDefault: false, isProtected: false },
            ],
          },
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await fetchRepoBranchesViaWorker('owner/repo', 50);

    expect(result.defaultBranch).toBe('main');
    expect(result.branches).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith('/api/github/tools', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'token test-token',
        'Content-Type': 'application/json',
      }),
    }));
  });

  it('surfaces worker errors as exceptions', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: 'Access denied — can only query the active repo "owner/repo"',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(executeGitHubToolViaWorker(
      { tool: 'fetch_pr', args: { repo: 'owner/repo', pr: 42 } },
      'owner/repo',
    )).rejects.toThrow('Access denied');
  });
});
