import type { Env } from './worker-middleware';
import {
  validateOrigin,
  getClientIp,
  readBodyText,
  wlog,
} from './worker-middleware';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from '../lib/request-id';
import {
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from '../lib/sensitive-data-guard';
import {
  executeGitHubReadonlyTool,
  normalizeGitHubRepoName,
  type GitHubReadonlyRuntime,
  type GitHubReadonlyToolCall,
} from '@push/lib/github-readonly-tools';
import type {
  ToolExecutionResult,
} from '../types';

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

type GitHubToolPayload = GitHubReadonlyToolCall & { allowedRepo: string };

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

function asPositiveInt(value: unknown): number | undefined {
  const parsed = asPositiveNumber(value);
  return typeof parsed === 'number' && Number.isInteger(parsed) ? parsed : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getGitHubHeaders(request: Request, accept: string = 'application/vnd.github.v3+json'): Record<string, string> {
  const authorization = request.headers.get('Authorization');
  const headers: Record<string, string> = { Accept: accept };
  if (authorization) {
    headers.Authorization = authorization;
  }
  return headers;
}

function isRetryableError(_error: unknown, status?: number): boolean {
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  return true;
}

function getRetryDelay(response: Response | undefined, attempt: number): number {
  if (response && response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const delay = parseInt(retryAfter, 10);
      if (!Number.isNaN(delay)) return (delay + 1) * 1000;
    }
  }
  return BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok && isRetryableError(null, response.status) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(response, attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return response;
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';
      lastError = new Error(
        isTimeout
          ? `GitHub API timed out after ${GITHUB_TIMEOUT_MS / 1000}s`
          : error instanceof Error ? error.message : String(error),
      );

      if (attempt < MAX_RETRIES && isRetryableError(error)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error(`GitHub API failed after ${MAX_RETRIES} retries`);
}
function parseToolPayload(value: unknown): GitHubToolPayload | null {
  const payload = asRecord(value);
  const tool = asString(payload?.tool);
  const args = asRecord(payload?.args);
  const allowedRepo = asString(payload?.allowedRepo);
  if (!tool || !args || !allowedRepo) return null;

  const repo = asString(args.repo);
  if (!repo) return null;

  if (tool === 'fetch_pr') {
    const pr = asPositiveNumber(args.pr);
    return pr ? { tool, args: { repo, pr }, allowedRepo } : null;
  }
  if (tool === 'list_prs') {
    return { tool, args: { repo, state: asString(args.state) }, allowedRepo };
  }
  if (tool === 'list_commits') {
    return { tool, args: { repo, count: asPositiveNumber(args.count) }, allowedRepo };
  }
  if (tool === 'read_file') {
    const path = asString(args.path);
    if (!path) return null;
    return {
      tool,
      args: {
        repo,
        path,
        branch: asString(args.branch),
        start_line: asPositiveInt(args.start_line),
        end_line: asPositiveInt(args.end_line),
      },
      allowedRepo,
    };
  }
  if (tool === 'grep_file') {
    const path = asString(args.path);
    const pattern = asString(args.pattern);
    if (!path || !pattern) return null;
    return {
      tool,
      args: { repo, path, pattern, branch: asString(args.branch) },
      allowedRepo,
    };
  }
  if (tool === 'list_directory') {
    return {
      tool,
      args: { repo, path: asString(args.path), branch: asString(args.branch) },
      allowedRepo,
    };
  }
  if (tool === 'list_branches') {
    const maxBranches = asPositiveNumber(args.maxBranches);
    return { tool, args: { repo, maxBranches }, allowedRepo };
  }
  if (tool === 'fetch_checks') {
    return { tool, args: { repo, ref: asString(args.ref) }, allowedRepo };
  }
  if (tool === 'search_files') {
    const query = asString(args.query);
    if (!query) return null;
    return {
      tool,
      args: {
        repo,
        query,
        path: asString(args.path),
        branch: asString(args.branch),
      },
      allowedRepo,
    };
  }
  if (tool === 'list_commit_files') {
    const ref = asString(args.ref);
    return ref ? { tool, args: { repo, ref }, allowedRepo } : null;
  }
  if (tool === 'trigger_workflow') {
    const workflow = asString(args.workflow);
    if (!workflow) return null;
    return {
      tool,
      args: {
        repo,
        workflow,
        ref: asString(args.ref),
        inputs: asStringRecord(args.inputs),
      },
      allowedRepo,
    };
  }
  if (tool === 'get_workflow_runs') {
    return {
      tool,
      args: {
        repo,
        workflow: asString(args.workflow),
        branch: asString(args.branch),
        status: asString(args.status),
        count: asPositiveNumber(args.count),
      },
      allowedRepo,
    };
  }
  if (tool === 'get_workflow_logs') {
    const runId = asPositiveNumber(args.run_id);
    return runId ? { tool, args: { repo, run_id: runId }, allowedRepo } : null;
  }
  if (tool === 'create_pr') {
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base);
    if (!title || !head || !base) return null;
    return {
      tool,
      args: {
        repo,
        title,
        body: asString(args.body) || '',
        head,
        base,
      },
      allowedRepo,
    };
  }
  if (tool === 'merge_pr') {
    const prNumber = asPositiveNumber(args.pr_number);
    return prNumber ? {
      tool,
      args: { repo, pr_number: prNumber, merge_method: asString(args.merge_method) },
      allowedRepo,
    } : null;
  }
  if (tool === 'delete_branch') {
    const branchName = asString(args.branch_name);
    return branchName ? {
      tool,
      args: { repo, branch_name: branchName },
      allowedRepo,
    } : null;
  }
  if (tool === 'check_pr_mergeable') {
    const prNumber = asPositiveNumber(args.pr_number);
    return prNumber ? {
      tool,
      args: { repo, pr_number: prNumber },
      allowedRepo,
    } : null;
  }
  if (tool === 'find_existing_pr') {
    const headBranch = asString(args.head_branch);
    return headBranch ? {
      tool,
      args: { repo, head_branch: headBranch, base_branch: asString(args.base_branch) },
      allowedRepo,
    } : null;
  }

  return null;
}

export async function handleGitHubTools(request: Request, env: Env): Promise<Response> {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'github-tools');
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', { requestId, path: 'api/github/tools', ip: getClientIp(request) });
    return Response.json({ error: 'Rate limit exceeded. Try again later.' }, {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  }

  const bodyResult = await readBodyText(request, 64 * 1024);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let parsed: GitHubToolPayload | null = null;
  try {
    parsed = parseToolPayload(JSON.parse(bodyResult.text));
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!parsed) {
    return Response.json({ error: 'Invalid GitHub tool payload' }, { status: 400 });
  }

  const allowedNormalized = normalizeGitHubRepoName(parsed.allowedRepo);
  const requestedNormalized = normalizeGitHubRepoName(parsed.args.repo);
  if (!allowedNormalized || !requestedNormalized || allowedNormalized !== requestedNormalized) {
    return Response.json({
      error: `Access denied — can only query the active repo "${parsed.allowedRepo}"`,
    }, { status: 403 });
  }

  try {
    const runtime: GitHubReadonlyRuntime = {
      githubFetch,
      buildHeaders: (accept = 'application/vnd.github.v3+json') => getGitHubHeaders(request, accept),
      buildApiUrl: (path) => `https://api.github.com${path.startsWith('/') ? path : `/${path}`}`,
      decodeBase64: (content) => atob(content),
      isSensitivePath,
      redactSensitiveText,
      formatSensitivePathToolError,
    };
    const result = await executeGitHubReadonlyTool(runtime, parsed) as ToolExecutionResult;

    return Response.json({ result }, {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    wlog('error', 'github_tool_error', { requestId, tool: parsed.tool, message });
    return Response.json({ error: message }, {
      status: 502,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  }
}
