import { describe, expect, it } from 'vitest';
import { parseGitHubCoreToolCall } from '@push/lib/github-tool-parser';

describe('parseGitHubCoreToolCall', () => {
  const REPO = 'owner/repo';

  it('returns null when repo is missing', () => {
    expect(parseGitHubCoreToolCall('fetch_pr', { pr: 1 })).toBeNull();
  });

  it('returns null for an unknown tool name', () => {
    expect(parseGitHubCoreToolCall('unknown_tool', { repo: REPO })).toBeNull();
  });

  describe('fetch_pr', () => {
    it('parses required args', () => {
      expect(parseGitHubCoreToolCall('fetch_pr', { repo: REPO, pr: 42 })).toEqual({
        tool: 'fetch_pr',
        args: { repo: REPO, pr: 42 },
      });
    });
    it('coerces string pr to number', () => {
      expect(parseGitHubCoreToolCall('fetch_pr', { repo: REPO, pr: '42' })).toEqual({
        tool: 'fetch_pr',
        args: { repo: REPO, pr: 42 },
      });
    });
    it('returns null when pr is missing', () => {
      expect(parseGitHubCoreToolCall('fetch_pr', { repo: REPO })).toBeNull();
    });
  });

  describe('list_prs', () => {
    it('parses without optional state', () => {
      expect(parseGitHubCoreToolCall('list_prs', { repo: REPO })).toEqual({
        tool: 'list_prs',
        args: { repo: REPO, state: undefined },
      });
    });
    it('parses with state', () => {
      expect(parseGitHubCoreToolCall('list_prs', { repo: REPO, state: 'open' })).toEqual({
        tool: 'list_prs',
        args: { repo: REPO, state: 'open' },
      });
    });
  });

  describe('list_commits', () => {
    it('parses without count', () => {
      expect(parseGitHubCoreToolCall('list_commits', { repo: REPO })).toEqual({
        tool: 'list_commits',
        args: { repo: REPO, count: undefined },
      });
    });
    it('parses with count', () => {
      expect(parseGitHubCoreToolCall('list_commits', { repo: REPO, count: 10 })).toEqual({
        tool: 'list_commits',
        args: { repo: REPO, count: 10 },
      });
    });
  });

  describe('read_file', () => {
    it('parses required args', () => {
      expect(parseGitHubCoreToolCall('read_file', { repo: REPO, path: 'src/foo.ts' })).toEqual({
        tool: 'read_file',
        args: {
          repo: REPO,
          path: 'src/foo.ts',
          branch: undefined,
          start_line: undefined,
          end_line: undefined,
        },
      });
    });
    it('parses with line range', () => {
      expect(
        parseGitHubCoreToolCall('read_file', {
          repo: REPO,
          path: 'src/foo.ts',
          start_line: 10,
          end_line: 20,
        }),
      ).toEqual({
        tool: 'read_file',
        args: { repo: REPO, path: 'src/foo.ts', branch: undefined, start_line: 10, end_line: 20 },
      });
    });
    it('returns null when path is missing', () => {
      expect(parseGitHubCoreToolCall('read_file', { repo: REPO })).toBeNull();
    });
  });

  describe('grep_file', () => {
    it('parses required args', () => {
      expect(
        parseGitHubCoreToolCall('grep_file', { repo: REPO, path: 'src/foo.ts', pattern: 'foo' }),
      ).toEqual({
        tool: 'grep_file',
        args: { repo: REPO, path: 'src/foo.ts', pattern: 'foo', branch: undefined },
      });
    });
    it('returns null when pattern is missing', () => {
      expect(parseGitHubCoreToolCall('grep_file', { repo: REPO, path: 'src/foo.ts' })).toBeNull();
    });
  });

  describe('list_directory', () => {
    it('parses without optional path', () => {
      expect(parseGitHubCoreToolCall('list_directory', { repo: REPO })).toEqual({
        tool: 'list_directory',
        args: { repo: REPO, path: undefined, branch: undefined },
      });
    });
  });

  describe('list_branches', () => {
    it('parses without maxBranches', () => {
      expect(parseGitHubCoreToolCall('list_branches', { repo: REPO })).toEqual({
        tool: 'list_branches',
        args: { repo: REPO, maxBranches: undefined },
      });
    });
  });

  describe('fetch_checks', () => {
    it('parses without ref', () => {
      expect(parseGitHubCoreToolCall('fetch_checks', { repo: REPO })).toEqual({
        tool: 'fetch_checks',
        args: { repo: REPO, ref: undefined },
      });
    });
  });

  describe('search_files', () => {
    it('parses required query', () => {
      expect(parseGitHubCoreToolCall('search_files', { repo: REPO, query: 'foo' })).toEqual({
        tool: 'search_files',
        args: { repo: REPO, query: 'foo', path: undefined, branch: undefined },
      });
    });
    it('returns null when query is missing', () => {
      expect(parseGitHubCoreToolCall('search_files', { repo: REPO })).toBeNull();
    });
  });

  describe('list_commit_files', () => {
    it('parses required ref', () => {
      expect(parseGitHubCoreToolCall('list_commit_files', { repo: REPO, ref: 'abc123' })).toEqual({
        tool: 'list_commit_files',
        args: { repo: REPO, ref: 'abc123' },
      });
    });
    it('returns null when ref is missing', () => {
      expect(parseGitHubCoreToolCall('list_commit_files', { repo: REPO })).toBeNull();
    });
  });

  describe('trigger_workflow', () => {
    it('parses required workflow', () => {
      expect(
        parseGitHubCoreToolCall('trigger_workflow', { repo: REPO, workflow: 'ci.yml' }),
      ).toEqual({
        tool: 'trigger_workflow',
        args: { repo: REPO, workflow: 'ci.yml', ref: undefined, inputs: undefined },
      });
    });
    it('parses with inputs record', () => {
      const result = parseGitHubCoreToolCall('trigger_workflow', {
        repo: REPO,
        workflow: 'ci.yml',
        inputs: { env: 'prod' },
      });
      expect(result).toEqual({
        tool: 'trigger_workflow',
        args: { repo: REPO, workflow: 'ci.yml', ref: undefined, inputs: { env: 'prod' } },
      });
    });
    it('returns null when workflow is missing', () => {
      expect(parseGitHubCoreToolCall('trigger_workflow', { repo: REPO })).toBeNull();
    });
  });

  describe('get_workflow_runs', () => {
    it('parses without optional fields', () => {
      expect(parseGitHubCoreToolCall('get_workflow_runs', { repo: REPO })).toEqual({
        tool: 'get_workflow_runs',
        args: {
          repo: REPO,
          workflow: undefined,
          branch: undefined,
          status: undefined,
          count: undefined,
        },
      });
    });
  });

  describe('get_workflow_logs', () => {
    it('parses required run_id', () => {
      expect(parseGitHubCoreToolCall('get_workflow_logs', { repo: REPO, run_id: 999 })).toEqual({
        tool: 'get_workflow_logs',
        args: { repo: REPO, run_id: 999 },
      });
    });
    it('returns null when run_id is missing', () => {
      expect(parseGitHubCoreToolCall('get_workflow_logs', { repo: REPO })).toBeNull();
    });
  });

  describe('create_pr', () => {
    it('parses required args', () => {
      expect(
        parseGitHubCoreToolCall('create_pr', {
          repo: REPO,
          title: 'Fix',
          body: 'desc',
          head: 'feat',
          base: 'main',
        }),
      ).toEqual({
        tool: 'create_pr',
        args: { repo: REPO, title: 'Fix', body: 'desc', head: 'feat', base: 'main' },
      });
    });
    it('defaults body to empty string when absent', () => {
      const result = parseGitHubCoreToolCall('create_pr', {
        repo: REPO,
        title: 'Fix',
        head: 'feat',
        base: 'main',
      });
      expect(result).toEqual({
        tool: 'create_pr',
        args: { repo: REPO, title: 'Fix', body: '', head: 'feat', base: 'main' },
      });
    });
    it('returns null when required arg is missing', () => {
      expect(
        parseGitHubCoreToolCall('create_pr', { repo: REPO, title: 'Fix', head: 'feat' }),
      ).toBeNull();
    });
  });

  describe('merge_pr', () => {
    it('parses required pr_number', () => {
      expect(parseGitHubCoreToolCall('merge_pr', { repo: REPO, pr_number: 7 })).toEqual({
        tool: 'merge_pr',
        args: { repo: REPO, pr_number: 7, merge_method: undefined },
      });
    });
    it('returns null when pr_number is missing', () => {
      expect(parseGitHubCoreToolCall('merge_pr', { repo: REPO })).toBeNull();
    });
  });

  describe('delete_branch', () => {
    it('parses required branch_name', () => {
      expect(
        parseGitHubCoreToolCall('delete_branch', { repo: REPO, branch_name: 'feat/old' }),
      ).toEqual({ tool: 'delete_branch', args: { repo: REPO, branch_name: 'feat/old' } });
    });
    it('returns null when branch_name is missing', () => {
      expect(parseGitHubCoreToolCall('delete_branch', { repo: REPO })).toBeNull();
    });
  });

  describe('check_pr_mergeable', () => {
    it('parses required pr_number', () => {
      expect(parseGitHubCoreToolCall('check_pr_mergeable', { repo: REPO, pr_number: 3 })).toEqual({
        tool: 'check_pr_mergeable',
        args: { repo: REPO, pr_number: 3 },
      });
    });
  });

  describe('find_existing_pr', () => {
    it('parses required head_branch', () => {
      expect(
        parseGitHubCoreToolCall('find_existing_pr', { repo: REPO, head_branch: 'feat/x' }),
      ).toEqual({
        tool: 'find_existing_pr',
        args: { repo: REPO, head_branch: 'feat/x', base_branch: undefined },
      });
    });
    it('returns null when head_branch is missing', () => {
      expect(parseGitHubCoreToolCall('find_existing_pr', { repo: REPO })).toBeNull();
    });
  });
});
