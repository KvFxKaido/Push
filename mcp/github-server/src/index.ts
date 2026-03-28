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
  executeGitHubReadonlyTool,
  type GitHubReadonlyToolResult,
  type GitHubReadonlyRuntime,
  type GitHubReadonlyToolCall,
} from '../../../lib/github-readonly-tools.js';

const SERVER_NAME = 'push-github-mcp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const TOOL_GITHUB_SERVER_INFO = 'github_server_info';
const TOOL_GITHUB_API_PROBE = 'github_api_probe';
const TOOL_FETCH_PR = 'fetch_pr';
const TOOL_LIST_PRS = 'list_prs';
const TOOL_LIST_COMMITS = 'list_commits';
const TOOL_LIST_BRANCHES = 'list_branches';
const TOOL_FETCH_CHECKS = 'fetch_checks';
const TOOL_SEARCH_FILES = 'search_files';

function getGitHubToken(): string {
  return process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';
}

function getGitHubApiUrl(): string {
  return process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL;
}

function buildGitHubHeaders(accept: string = 'application/vnd.github.v3+json'): Record<string, string> {
  const headers = buildHeaders(getGitHubToken());
  headers.Accept = accept;
  return headers;
}

function formatTextResult(text: string) {
  const { text: safeText } = redactSensitiveText(text);
  return {
    content: [
      {
        type: 'text' as const,
        text: safeText,
      },
    ],
  };
}

function formatToolResult(result: GitHubReadonlyToolResult) {
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
      TOOL_LIST_BRANCHES,
      TOOL_FETCH_CHECKS,
      TOOL_SEARCH_FILES,
    ],
    status:
      'GitHub tool migration is in progress. Read-only PR, branch, and code search tools now share the same core implementation as the Push worker bridge.',
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function parseReadonlyToolCall(name: string, rawArgs: unknown): GitHubReadonlyToolCall | null {
  const args = asRecord(rawArgs) ?? {};
  const repo = asString(args.repo);
  if (!repo) return null;

  if (name === TOOL_FETCH_PR) {
    const pr = asPositiveNumber(args.pr);
    return pr ? { tool: 'fetch_pr', args: { repo, pr } } : null;
  }
  if (name === TOOL_LIST_PRS) {
    return { tool: 'list_prs', args: { repo, state: asString(args.state) } };
  }
  if (name === TOOL_LIST_COMMITS) {
    return { tool: 'list_commits', args: { repo, count: asPositiveNumber(args.count) } };
  }
  if (name === TOOL_LIST_BRANCHES) {
    const maxBranches = asPositiveNumber(args.maxBranches);
    return { tool: 'list_branches', args: { repo, maxBranches } };
  }
  if (name === TOOL_FETCH_CHECKS) {
    return { tool: 'fetch_checks', args: { repo, ref: asString(args.ref) } };
  }
  if (name === TOOL_SEARCH_FILES) {
    const query = asString(args.query);
    if (!query) return null;
    return {
      tool: 'search_files',
      args: {
        repo,
        query,
        path: asString(args.path),
        branch: asString(args.branch),
      },
    };
  }

  return null;
}

const readonlyTools = [
  {
    name: TOOL_FETCH_PR,
    description:
      'Fetch a pull request summary with linked issues, recent commits, changed files, and a truncated diff.',
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
    description:
      'List recent pull requests for a repository, optionally filtered by state.',
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
    description:
      'List recent commits for a repository with commit authors and dates.',
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
    name: TOOL_LIST_BRANCHES,
    description:
      'List repository branches, marking the default branch and protected branches.',
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
] as const;

const readonlyRuntime: GitHubReadonlyRuntime = {
  githubFetch,
  buildHeaders: buildGitHubHeaders,
  buildApiUrl: (path) => `${getGitHubApiUrl().replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`,
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
    ...readonlyTools,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const readonlyToolCall = parseReadonlyToolCall(request.params.name, request.params.arguments);
  if (readonlyToolCall) {
    const result = await executeGitHubReadonlyTool(readonlyRuntime, readonlyToolCall);
    return formatToolResult(result);
  }

  if (
    request.params.name === TOOL_FETCH_PR
    || request.params.name === TOOL_LIST_PRS
    || request.params.name === TOOL_LIST_COMMITS
    || request.params.name === TOOL_LIST_BRANCHES
    || request.params.name === TOOL_FETCH_CHECKS
    || request.params.name === TOOL_SEARCH_FILES
  ) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool: ${request.params.name}`);
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
