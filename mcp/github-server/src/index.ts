#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { buildHeaders, githubFetch } from './github-client.js';
import {
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard.js';
import {
  executeGitHubCoreTool,
  type GitHubCoreToolResult,
  type GitHubCoreRuntime,
} from '../../../lib/github-tool-core.js';
import { asRecord, parseGitHubCoreToolCall } from '../../../lib/github-tool-parser.js';
import { sanitizeUntrustedSource } from '../../../lib/untrusted-content.js';

const SERVER_NAME = 'push-github-mcp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const TOOL_GITHUB_SERVER_INFO = 'github_server_info';
const TOOL_GITHUB_API_PROBE = 'github_api_probe';
const TOOL_FETCH_PR = 'fetch_pr';
const TOOL_LIST_PRS = 'list_prs';
const TOOL_LIST_COMMITS = 'list_commits';
const TOOL_READ_FILE = 'read_file';
const TOOL_GREP_FILE = 'grep_file';
const TOOL_LIST_DIRECTORY = 'list_directory';
const TOOL_LIST_BRANCHES = 'list_branches';
const TOOL_FETCH_CHECKS = 'fetch_checks';
const TOOL_SEARCH_FILES = 'search_files';
const TOOL_LIST_COMMIT_FILES = 'list_commit_files';
const TOOL_TRIGGER_WORKFLOW = 'trigger_workflow';
const TOOL_GET_WORKFLOW_RUNS = 'get_workflow_runs';
const TOOL_GET_WORKFLOW_LOGS = 'get_workflow_logs';
const TOOL_CREATE_PR = 'create_pr';
const TOOL_MERGE_PR = 'merge_pr';
const TOOL_DELETE_BRANCH = 'delete_branch';
const TOOL_CHECK_PR_MERGEABLE = 'check_pr_mergeable';
const TOOL_FIND_EXISTING_PR = 'find_existing_pr';
const TOOL_GET_JOB_LOGS = 'get_job_logs';
const TOOL_LIST_ISSUES = 'list_issues';
const TOOL_GET_ISSUE = 'get_issue';
const TOOL_ADD_ISSUE_COMMENT = 'add_issue_comment';
const TOOL_CREATE_ISSUE = 'create_issue';
const TOOL_UPDATE_ISSUE = 'update_issue';
const TOOL_UPDATE_PULL_REQUEST = 'update_pull_request';
const TOOL_RERUN_FAILED_JOBS = 'rerun_failed_jobs';
const TOOL_CANCEL_WORKFLOW_RUN = 'cancel_workflow_run';
const TOOL_LIST_CODE_SCANNING_ALERTS = 'list_code_scanning_alerts';
const TOOL_LIST_DEPENDABOT_ALERTS = 'list_dependabot_alerts';
const TOOL_LIST_SECRET_SCANNING_ALERTS = 'list_secret_scanning_alerts';

function getGitHubToken(): string {
  return process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';
}

function getGitHubApiUrl(): string {
  return process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL;
}

function buildGitHubHeaders(
  accept: string = 'application/vnd.github.v3+json',
): Record<string, string> {
  const headers = buildHeaders(getGitHubToken());
  headers.Accept = accept;
  return headers;
}

function formatTextResult(text: string) {
  const { text: safeText } = redactSensitiveText(text);
  // GitHub-API content (PR body, issue body, review comments, file content,
  // commit messages, branch names) is attacker-controlled. After credential
  // redaction, sanitize so a crafted PR body cannot break out of the agent's
  // [TOOL_RESULT] envelope, spoof a [meta]/[CODER_STATE] block, or embed an
  // echo-able JSON tool-call shape.
  const guardedText = sanitizeUntrustedSource(safeText);
  return {
    content: [
      {
        type: 'text' as const,
        text: guardedText,
      },
    ],
  };
}

function formatToolResult(result: GitHubCoreToolResult) {
  const base = formatTextResult(result.text);
  if (!result.card) {
    return base;
  }
  return {
    ...base,
    structuredContent: { card: result.card },
  };
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function getServerInfoText(): string {
  const summary = {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    githubApiUrl: getGitHubApiUrl(),
    githubTokenConfigured: Boolean(getGitHubToken()),
    tools: [
      TOOL_GITHUB_SERVER_INFO,
      TOOL_GITHUB_API_PROBE,
      TOOL_FETCH_PR,
      TOOL_LIST_PRS,
      TOOL_LIST_COMMITS,
      TOOL_READ_FILE,
      TOOL_GREP_FILE,
      TOOL_LIST_DIRECTORY,
      TOOL_LIST_BRANCHES,
      TOOL_FETCH_CHECKS,
      TOOL_SEARCH_FILES,
      TOOL_LIST_COMMIT_FILES,
      TOOL_TRIGGER_WORKFLOW,
      TOOL_GET_WORKFLOW_RUNS,
      TOOL_GET_WORKFLOW_LOGS,
      TOOL_CREATE_PR,
      TOOL_MERGE_PR,
      TOOL_DELETE_BRANCH,
      TOOL_CHECK_PR_MERGEABLE,
      TOOL_FIND_EXISTING_PR,
      TOOL_GET_JOB_LOGS,
      TOOL_LIST_ISSUES,
      TOOL_GET_ISSUE,
      TOOL_ADD_ISSUE_COMMENT,
      TOOL_CREATE_ISSUE,
      TOOL_UPDATE_ISSUE,
      TOOL_UPDATE_PULL_REQUEST,
      TOOL_RERUN_FAILED_JOBS,
      TOOL_CANCEL_WORKFLOW_RUN,
      TOOL_LIST_CODE_SCANNING_ALERTS,
      TOOL_LIST_DEPENDABOT_ALERTS,
      TOOL_LIST_SECRET_SCANNING_ALERTS,
    ],
    status:
      'Push now shares a common GitHub tool core across the app worker bridge and the MCP server.',
  };

  return JSON.stringify(summary, null, 2);
}

async function getGitHubProbeText(): Promise<string> {
  const token = getGitHubToken();
  const apiUrl = getGitHubApiUrl();
  const response = await githubFetch(`${apiUrl}/rate_limit`, {
    headers: buildHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`GitHub API probe failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    rate?: {
      limit?: number;
      remaining?: number;
      reset?: number;
      used?: number;
      resource?: string;
    };
  };

  const resetAt =
    typeof payload.rate?.reset === 'number'
      ? new Date(payload.rate.reset * 1000).toISOString()
      : null;

  return JSON.stringify(
    {
      server: SERVER_NAME,
      githubApiUrl: apiUrl,
      authenticated: Boolean(token),
      rateLimit: {
        resource: payload.rate?.resource ?? 'core',
        limit: payload.rate?.limit ?? null,
        remaining: payload.rate?.remaining ?? null,
        used: payload.rate?.used ?? null,
        resetAt,
      },
    },
    null,
    2,
  );
}

const githubTools = [
  {
    name: TOOL_FETCH_PR,
    description:
      'Fetch a pull request summary with linked issues, recent commits, changed files, inline review comments, conversation comments, and a truncated diff.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        pr: { type: 'number', description: 'Pull request number.' },
      },
      required: ['repo', 'pr'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_PRS,
    description: 'List recent pull requests for a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        state: { type: 'string', description: 'Optional pull request state filter.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_COMMITS,
    description: 'List recent commits for a repository with commit authors and dates.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        count: { type: 'number', description: 'Maximum number of commits to return.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_READ_FILE,
    description:
      'Read a repository file, with optional line range support and redaction-aware truncation.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        path: { type: 'string', description: 'Repository-relative file path.' },
        branch: { type: 'string', description: 'Optional branch or ref.' },
        start_line: { type: 'number', description: 'Optional 1-based start line.' },
        end_line: { type: 'number', description: 'Optional 1-based end line.' },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GREP_FILE,
    description: 'Search within a single repository file with line-numbered context.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        path: { type: 'string', description: 'Repository-relative file path.' },
        pattern: { type: 'string', description: 'Regex or substring pattern.' },
        branch: { type: 'string', description: 'Optional branch or ref.' },
      },
      required: ['repo', 'path', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_DIRECTORY,
    description: 'List files and directories for a repository path with sensitive entries hidden.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        path: { type: 'string', description: 'Optional repository-relative directory path.' },
        branch: { type: 'string', description: 'Optional branch or ref.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_BRANCHES,
    description: 'List repository branches, marking the default branch and protected branches.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        maxBranches: { type: 'number', description: 'Maximum number of branches to return.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_FETCH_CHECKS,
    description:
      'Fetch CI status for a repository ref, including check runs and combined status fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        ref: { type: 'string', description: 'Optional commit SHA or branch ref.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_SEARCH_FILES,
    description:
      'Search repository files with GitHub code search, including redaction and sensitive-path filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        query: { type: 'string', description: 'Code search query.' },
        path: { type: 'string', description: 'Optional path prefix filter.' },
        branch: { type: 'string', description: 'Optional branch/ref hint.' },
      },
      required: ['repo', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_COMMIT_FILES,
    description: 'List the files changed by a commit, including per-file and total change counts.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        ref: { type: 'string', description: 'Commit SHA or ref to inspect.' },
      },
      required: ['repo', 'ref'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_TRIGGER_WORKFLOW,
    description:
      'Dispatch a GitHub Actions workflow on a ref, with optional workflow_dispatch inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        workflow: {
          type: 'string',
          description: 'Workflow filename, ID, or name accepted by GitHub.',
        },
        ref: { type: 'string', description: 'Optional branch or ref to dispatch on.' },
        inputs: { type: 'object', description: 'Optional workflow_dispatch input values.' },
      },
      required: ['repo', 'workflow'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_WORKFLOW_RUNS,
    description:
      'List GitHub Actions workflow runs, optionally scoped by workflow, branch, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        workflow: { type: 'string', description: 'Optional workflow filename, ID, or name.' },
        branch: { type: 'string', description: 'Optional branch filter.' },
        status: { type: 'string', description: 'Optional status filter.' },
        count: { type: 'number', description: 'Maximum number of runs to return.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_WORKFLOW_LOGS,
    description: 'Fetch workflow job and step status details for a specific workflow run.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        run_id: { type: 'number', description: 'Workflow run ID.' },
      },
      required: ['repo', 'run_id'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_CREATE_PR,
    description: 'Create a pull request for a branch pair on the active repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_MERGE_PR,
    description: 'Merge a pull request using GitHub merge, squash, or rebase methods.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        pr_number: { type: 'number', description: 'Pull request number.' },
        merge_method: {
          type: 'string',
          description: 'Optional merge method: merge, squash, or rebase.',
        },
      },
      required: ['repo', 'pr_number'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_DELETE_BRANCH,
    description: 'Delete a branch ref from the active repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        branch_name: { type: 'string', description: 'Branch name to delete.' },
      },
      required: ['repo', 'branch_name'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_CHECK_PR_MERGEABLE,
    description: 'Check whether a pull request is currently mergeable and summarize CI status.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        pr_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['repo', 'pr_number'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_FIND_EXISTING_PR,
    description: 'Find an existing open pull request for a head branch and optional base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        head_branch: { type: 'string', description: 'Head branch name.' },
        base_branch: { type: 'string', description: 'Optional base branch name.' },
      },
      required: ['repo', 'head_branch'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_JOB_LOGS,
    description:
      "Fetch the actual CI log text for a workflow run's jobs (default: failed jobs only, last 200 lines each). Pass job_id to target a single job. Reveals why a check failed, not just that it did.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        run_id: { type: 'number', description: 'Workflow run ID (fetches its jobs).' },
        job_id: { type: 'number', description: 'Specific job ID to fetch logs for.' },
        failed_only: {
          type: 'boolean',
          description: 'When using run_id, only include failed jobs (default true).',
        },
        tail_lines: {
          type: 'number',
          description: 'Number of trailing log lines to keep per job (default 200, max 1000).',
        },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_ISSUES,
    description:
      'List repository issues (pull requests excluded), optionally filtered by state and labels.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
        labels: { type: 'string', description: 'Comma-separated label names to filter by.' },
        count: { type: 'number', description: 'Maximum number of issues to return.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_ISSUE,
    description: 'Read a single issue (or pull request) with its body and recent comments.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        issue_number: { type: 'number', description: 'Issue or pull request number.' },
      },
      required: ['repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_ADD_ISSUE_COMMENT,
    description: 'Post a comment on an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        issue_number: { type: 'number', description: 'Issue or pull request number.' },
        body: { type: 'string', description: 'Comment body (Markdown).' },
      },
      required: ['repo', 'issue_number', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_CREATE_ISSUE,
    description: 'Open a new issue on the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Optional issue body (Markdown).' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional label names to apply.',
        },
      },
      required: ['repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_UPDATE_ISSUE,
    description:
      "Edit an issue's title/body/labels, or open/close it. At least one field is required.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        issue_number: { type: 'number', description: 'Issue number.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body.' },
        state: { type: 'string', description: 'New state: open or closed.' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement label set.',
        },
      },
      required: ['repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_UPDATE_PULL_REQUEST,
    description:
      "Edit a pull request's title/body, retarget its base branch, or open/close it. At least one field is required.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        pr_number: { type: 'number', description: 'Pull request number.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body.' },
        base: { type: 'string', description: 'New base branch.' },
        state: { type: 'string', description: 'New state: open or closed.' },
      },
      required: ['repo', 'pr_number'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_RERUN_FAILED_JOBS,
    description: 'Re-run only the failed jobs of a workflow run (useful for flaky CI).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        run_id: { type: 'number', description: 'Workflow run ID.' },
      },
      required: ['repo', 'run_id'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_CANCEL_WORKFLOW_RUN,
    description: 'Cancel an in-progress workflow run.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        run_id: { type: 'number', description: 'Workflow run ID.' },
      },
      required: ['repo', 'run_id'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_CODE_SCANNING_ALERTS,
    description: 'List code scanning (CodeQL) alerts for the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        state: {
          type: 'string',
          description: 'Alert state filter: open, closed, dismissed, fixed.',
        },
        ref: { type: 'string', description: 'Optional git ref to scope alerts to.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_DEPENDABOT_ALERTS,
    description: 'List Dependabot vulnerability alerts for the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        state: {
          type: 'string',
          description: 'Alert state filter: open, dismissed, fixed, auto_dismissed.',
        },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_LIST_SECRET_SCANNING_ALERTS,
    description:
      'List secret scanning alerts for the repository (metadata only — secret values are never returned).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository in owner/repo form.' },
        state: { type: 'string', description: 'Alert state filter: open or resolved.' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
] as const;

const githubToolRuntime: GitHubCoreRuntime = {
  githubFetch,
  buildHeaders: buildGitHubHeaders,
  buildApiUrl: (path) =>
    `${getGitHubApiUrl().replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`,
  decodeBase64: (content) => Buffer.from(content, 'base64').toString('utf8'),
  isSensitivePath,
  redactSensitiveText,
  formatSensitivePathToolError,
};

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_GITHUB_SERVER_INFO,
      description:
        'Report runtime readiness for the Push GitHub MCP server, including auth and API base URL configuration.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: TOOL_GITHUB_API_PROBE,
      description:
        'Make a lightweight call to the GitHub rate-limit endpoint and report whether the server can reach the configured GitHub API.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    ...githubTools,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const githubToolCall = parseGitHubCoreToolCall(
    request.params.name,
    asRecord(request.params.arguments) ?? {},
  );
  if (githubToolCall) {
    const result = await executeGitHubCoreTool(githubToolRuntime, githubToolCall);
    return formatToolResult(result);
  }

  if (
    request.params.name === TOOL_FETCH_PR ||
    request.params.name === TOOL_LIST_PRS ||
    request.params.name === TOOL_LIST_COMMITS ||
    request.params.name === TOOL_READ_FILE ||
    request.params.name === TOOL_GREP_FILE ||
    request.params.name === TOOL_LIST_DIRECTORY ||
    request.params.name === TOOL_LIST_BRANCHES ||
    request.params.name === TOOL_FETCH_CHECKS ||
    request.params.name === TOOL_SEARCH_FILES ||
    request.params.name === TOOL_LIST_COMMIT_FILES ||
    request.params.name === TOOL_TRIGGER_WORKFLOW ||
    request.params.name === TOOL_GET_WORKFLOW_RUNS ||
    request.params.name === TOOL_GET_WORKFLOW_LOGS ||
    request.params.name === TOOL_CREATE_PR ||
    request.params.name === TOOL_MERGE_PR ||
    request.params.name === TOOL_DELETE_BRANCH ||
    request.params.name === TOOL_CHECK_PR_MERGEABLE ||
    request.params.name === TOOL_FIND_EXISTING_PR ||
    request.params.name === TOOL_GET_JOB_LOGS ||
    request.params.name === TOOL_LIST_ISSUES ||
    request.params.name === TOOL_GET_ISSUE ||
    request.params.name === TOOL_ADD_ISSUE_COMMENT ||
    request.params.name === TOOL_CREATE_ISSUE ||
    request.params.name === TOOL_UPDATE_ISSUE ||
    request.params.name === TOOL_UPDATE_PULL_REQUEST ||
    request.params.name === TOOL_RERUN_FAILED_JOBS ||
    request.params.name === TOOL_CANCEL_WORKFLOW_RUN ||
    request.params.name === TOOL_LIST_CODE_SCANNING_ALERTS ||
    request.params.name === TOOL_LIST_DEPENDABOT_ALERTS ||
    request.params.name === TOOL_LIST_SECRET_SCANNING_ALERTS
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for tool: ${request.params.name}`,
    );
  }

  switch (request.params.name) {
    case TOOL_GITHUB_SERVER_INFO:
      return formatTextResult(getServerInfoText());
    case TOOL_GITHUB_API_PROBE:
      return formatTextResult(await getGitHubProbeText());
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] ready on stdio`);
}

main().catch((error) => {
  const { text } = redactSensitiveText(serializeError(error));
  console.error(`[${SERVER_NAME}] fatal: ${text}`);
  process.exit(1);
});
