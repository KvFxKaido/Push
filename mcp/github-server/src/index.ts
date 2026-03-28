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
import { redactSensitiveText } from './sensitive-data-guard.js';

const SERVER_NAME = 'push-github-mcp';
const SERVER_VERSION = '0.1.0';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const TOOL_GITHUB_SERVER_INFO = 'github_server_info';
const TOOL_GITHUB_API_PROBE = 'github_api_probe';

function getGitHubToken(): string {
  return process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';
}

function getGitHubApiUrl(): string {
  return process.env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL;
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
    tools: [TOOL_GITHUB_SERVER_INFO, TOOL_GITHUB_API_PROBE],
    status:
      'GitHub tool migration is in progress. This scaffold is now runnable and exposes runtime diagnostics while the full tool surface is ported over.',
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
