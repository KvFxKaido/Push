/**
 * Shared GitHub tool argument parsing.
 *
 * Runtime-agnostic. Exports primitive coercion helpers and a single
 * parseGitHubCoreToolCall function that maps raw unknown arguments onto the
 * typed GitHubCoreToolCall union.
 *
 * Both the Worker bridge and the MCP server use this shared parser so that
 * adding or changing a tool requires one edit here, not two.
 */

import type { GitHubCoreToolCall } from './github-tool-core.js';

// --- Primitive coercions ---

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function asPositiveInt(value: unknown): number | undefined {
  const n = asPositiveNumber(value);
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

export function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

// --- Shared tool-arg parser ---

/**
 * Map a tool name and raw args object onto the typed GitHubCoreToolCall union.
 * Returns null for unknown tools or missing required args.
 *
 * Callers are responsible for extracting tool name and args from their
 * runtime-specific request envelopes before calling this function.
 */
export function parseGitHubCoreToolCall(
  name: string,
  args: Record<string, unknown>,
): GitHubCoreToolCall | null {
  const repo = asString(args.repo);
  if (!repo) return null;

  if (name === 'fetch_pr') {
    const pr = asPositiveNumber(args.pr);
    return pr ? { tool: 'fetch_pr', args: { repo, pr } } : null;
  }
  if (name === 'list_prs') {
    return { tool: 'list_prs', args: { repo, state: asString(args.state) } };
  }
  if (name === 'list_commits') {
    return { tool: 'list_commits', args: { repo, count: asPositiveNumber(args.count) } };
  }
  if (name === 'read_file') {
    const path = asString(args.path);
    if (!path) return null;
    return {
      tool: 'read_file',
      args: {
        repo,
        path,
        branch: asString(args.branch),
        start_line: asPositiveInt(args.start_line),
        end_line: asPositiveInt(args.end_line),
      },
    };
  }
  if (name === 'grep_file') {
    const path = asString(args.path);
    const pattern = asString(args.pattern);
    if (!path || !pattern) return null;
    return {
      tool: 'grep_file',
      args: { repo, path, pattern, branch: asString(args.branch) },
    };
  }
  if (name === 'list_directory') {
    return {
      tool: 'list_directory',
      args: { repo, path: asString(args.path), branch: asString(args.branch) },
    };
  }
  if (name === 'list_branches') {
    return {
      tool: 'list_branches',
      args: { repo, maxBranches: asPositiveNumber(args.maxBranches) },
    };
  }
  if (name === 'fetch_checks') {
    return { tool: 'fetch_checks', args: { repo, ref: asString(args.ref) } };
  }
  if (name === 'search_files') {
    const query = asString(args.query);
    if (!query) return null;
    return {
      tool: 'search_files',
      args: { repo, query, path: asString(args.path), branch: asString(args.branch) },
    };
  }
  if (name === 'list_commit_files') {
    const ref = asString(args.ref);
    return ref ? { tool: 'list_commit_files', args: { repo, ref } } : null;
  }
  if (name === 'trigger_workflow') {
    const workflow = asString(args.workflow);
    if (!workflow) return null;
    return {
      tool: 'trigger_workflow',
      args: { repo, workflow, ref: asString(args.ref), inputs: asStringRecord(args.inputs) },
    };
  }
  if (name === 'get_workflow_runs') {
    return {
      tool: 'get_workflow_runs',
      args: {
        repo,
        workflow: asString(args.workflow),
        branch: asString(args.branch),
        status: asString(args.status),
        count: asPositiveNumber(args.count),
      },
    };
  }
  if (name === 'get_workflow_logs') {
    const runId = asPositiveNumber(args.run_id);
    return runId ? { tool: 'get_workflow_logs', args: { repo, run_id: runId } } : null;
  }
  if (name === 'create_pr') {
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base);
    if (!title || !head || !base) return null;
    return {
      tool: 'create_pr',
      args: { repo, title, body: asString(args.body) ?? '', head, base },
    };
  }
  if (name === 'merge_pr') {
    const prNumber = asPositiveNumber(args.pr_number);
    return prNumber
      ? {
          tool: 'merge_pr',
          args: { repo, pr_number: prNumber, merge_method: asString(args.merge_method) },
        }
      : null;
  }
  if (name === 'delete_branch') {
    const branchName = asString(args.branch_name);
    return branchName ? { tool: 'delete_branch', args: { repo, branch_name: branchName } } : null;
  }
  if (name === 'check_pr_mergeable') {
    const prNumber = asPositiveNumber(args.pr_number);
    return prNumber ? { tool: 'check_pr_mergeable', args: { repo, pr_number: prNumber } } : null;
  }
  if (name === 'find_existing_pr') {
    const headBranch = asString(args.head_branch);
    return headBranch
      ? {
          tool: 'find_existing_pr',
          args: { repo, head_branch: headBranch, base_branch: asString(args.base_branch) },
        }
      : null;
  }
  if (name === 'get_job_logs') {
    const runId = asPositiveInt(args.run_id);
    const jobId = asPositiveInt(args.job_id);
    // Need at least one target; the executor disambiguates job_id vs run_id.
    if (runId === undefined && jobId === undefined) return null;
    return {
      tool: 'get_job_logs',
      args: {
        repo,
        run_id: runId,
        job_id: jobId,
        failed_only: asBoolean(args.failed_only),
        tail_lines: asPositiveInt(args.tail_lines),
      },
    };
  }
  if (name === 'list_issues') {
    return {
      tool: 'list_issues',
      args: {
        repo,
        state: asString(args.state),
        labels: asString(args.labels),
        count: asPositiveInt(args.count),
      },
    };
  }
  if (name === 'get_issue') {
    const issueNumber = asPositiveInt(args.issue_number);
    return issueNumber ? { tool: 'get_issue', args: { repo, issue_number: issueNumber } } : null;
  }
  if (name === 'add_issue_comment') {
    const issueNumber = asPositiveInt(args.issue_number);
    const body = asString(args.body);
    if (!issueNumber || !body) return null;
    return { tool: 'add_issue_comment', args: { repo, issue_number: issueNumber, body } };
  }
  if (name === 'create_issue') {
    const title = asString(args.title);
    if (!title) return null;
    return {
      tool: 'create_issue',
      args: { repo, title, body: asString(args.body), labels: asStringArray(args.labels) },
    };
  }
  if (name === 'update_issue') {
    const issueNumber = asPositiveInt(args.issue_number);
    if (!issueNumber) return null;
    return {
      tool: 'update_issue',
      args: {
        repo,
        issue_number: issueNumber,
        title: asString(args.title),
        body: asString(args.body),
        state: asString(args.state),
        // Preserve an explicit empty array so "remove all labels" is expressible:
        // asStringArray([]) is undefined, which the executor reads as "unchanged".
        labels: Array.isArray(args.labels) ? (asStringArray(args.labels) ?? []) : undefined,
      },
    };
  }
  if (name === 'update_pull_request') {
    const prNumber = asPositiveInt(args.pr_number);
    if (!prNumber) return null;
    return {
      tool: 'update_pull_request',
      args: {
        repo,
        pr_number: prNumber,
        title: asString(args.title),
        body: asString(args.body),
        base: asString(args.base),
        state: asString(args.state),
      },
    };
  }
  if (name === 'rerun_failed_jobs') {
    const runId = asPositiveInt(args.run_id);
    return runId ? { tool: 'rerun_failed_jobs', args: { repo, run_id: runId } } : null;
  }
  if (name === 'cancel_workflow_run') {
    const runId = asPositiveInt(args.run_id);
    return runId ? { tool: 'cancel_workflow_run', args: { repo, run_id: runId } } : null;
  }
  if (name === 'list_code_scanning_alerts') {
    return {
      tool: 'list_code_scanning_alerts',
      args: { repo, state: asString(args.state), ref: asString(args.ref) },
    };
  }
  if (name === 'list_dependabot_alerts') {
    return { tool: 'list_dependabot_alerts', args: { repo, state: asString(args.state) } };
  }
  if (name === 'list_secret_scanning_alerts') {
    return { tool: 'list_secret_scanning_alerts', args: { repo, state: asString(args.state) } };
  }

  return null;
}
