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
    request.params.name === TOOL_FIND_EXISTING_PR
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
