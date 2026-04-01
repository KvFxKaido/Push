/**
 * GitHub tool execution layer.
 *
 * Owns the local fetch/retry runtime, the Worker/local fallback dispatch,
 * and the top-level executeToolCall entry point.
 */

import type { BranchListCardData, ToolExecutionResult } from '@/types';
import { getGitHubAuthHeaders as getGitHubHeaders } from './github-auth';
import {
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard';
import {
  executeGitHubCoreTool as executeGitHubToolCore,
  fetchRepoBranchesData,
  type GitHubCoreRuntime as GitHubToolCoreRuntime,
  type GitHubCoreToolCall as GitHubToolCoreCall,
} from '@push/lib/github-tool-core';
import {
  executeGitHubToolViaWorker,
  fetchRepoBranchesViaWorker,
  getGitHubToolBackend,
  supportsWorkerGitHubTool,
  type WorkerGitHubToolCall,
} from './github-tool-transport';
import type { ToolCall } from './github-tool-protocol';

// --- Fetch with timeout and retry ---

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export function decodeGitHubBase64Utf8(content: string): string {
  const binary = atob(content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
      if (!isNaN(delay)) {
        console.log(`[Push] Rate limited. Waiting ${delay + 1}s (Retry-After header + 1s buffer)`);
        return (delay + 1) * 1000;
      }
    }
  }
  return BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

      if (!response.ok && isRetryableError(null, response.status)) {
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(response, attempt + 1);
          console.log(`[Push] GitHub API retry ${attempt + 1}/${MAX_RETRIES}: ${response.status} ${response.statusText}, waiting ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      return response;
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      const errorMsg = isTimeout
        ? `GitHub API timed out after ${GITHUB_TIMEOUT_MS / 1000}s — check your connection.`
        : err instanceof Error ? err.message : String(err);

      lastError = new Error(errorMsg);

      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[Push] GitHub API retry ${attempt + 1}/${MAX_RETRIES}: ${errorMsg}, waiting ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`GitHub API failed after ${MAX_RETRIES} retries`);
}

export async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
  return fetchWithRetry(url, options);
}

// --- Local runtime ---

function createLocalGitHubToolRuntime(): GitHubToolCoreRuntime {
  return {
    githubFetch,
    buildHeaders: (accept = 'application/vnd.github.v3+json') => {
      const headers = getGitHubHeaders();
      headers.Accept = accept;
      return headers;
    },
    buildApiUrl: (path) => `https://api.github.com${path.startsWith('/') ? path : `/${path}`}`,
    decodeBase64: decodeGitHubBase64Utf8,
    isSensitivePath,
    redactSensitiveText,
    formatSensitivePathToolError,
  };
}

async function executeGitHubToolLocally(call: GitHubToolCoreCall): Promise<ToolExecutionResult> {
  const result = await executeGitHubToolCore(createLocalGitHubToolRuntime(), call);
  return result as unknown as ToolExecutionResult;
}

async function fetchRepoBranchesLocally(
  repo: string,
  maxBranches: number = 500,
): Promise<{ defaultBranch: string; branches: BranchListCardData['branches'] }> {
  const data = await fetchRepoBranchesData(createLocalGitHubToolRuntime(), repo, maxBranches);
  return { defaultBranch: data.defaultBranch, branches: data.branches };
}

function logGitHubWorkerFallback(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[Push] GitHub worker backend failed for ${action}; falling back to legacy.`, message);
}

export async function fetchRepoBranches(
  repo: string,
  maxBranches: number = 500,
): Promise<{ defaultBranch: string; branches: BranchListCardData['branches'] }> {
  if (getGitHubToolBackend() === 'worker') {
    try {
      return await fetchRepoBranchesViaWorker(repo, maxBranches);
    } catch (error) {
      logGitHubWorkerFallback('list_branches', error);
    }
  }
  return fetchRepoBranchesLocally(repo, maxBranches);
}

// --- Execution with Worker/local fallback ---

export async function executeGitHubToolWithFallback(
  call: WorkerGitHubToolCall,
  allowedRepo: string,
): Promise<ToolExecutionResult> {
  if (getGitHubToolBackend() === 'worker') {
    try {
      return await executeGitHubToolViaWorker(call, allowedRepo);
    } catch (error) {
      logGitHubWorkerFallback(call.tool, error);
    }
  }

  return executeGitHubToolLocally(call);
}

// --- Top-level tool dispatch ---

function normalizeRepoName(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function isWorkerGitHubToolCall(call: ToolCall): call is WorkerGitHubToolCall {
  return supportsWorkerGitHubTool(call.tool);
}

async function executeToolCallLegacy(call: ToolCall, allowedRepo: string): Promise<ToolExecutionResult> {
  if (call.tool === 'delegate_coder' || call.tool === 'delegate_explorer') {
    return { text: `[${call.tool}] Handled by tool-dispatch layer.` };
  }

  const allowedNormalized = normalizeRepoName(allowedRepo || '');
  const requestedNormalized = normalizeRepoName(call.args.repo || '');
  if (!allowedNormalized || !requestedNormalized || requestedNormalized !== allowedNormalized) {
    console.debug('[Tool Error] Access denied — repo mismatch', { allowed: allowedRepo || '(empty)', requested: call.args.repo || '(empty)' });
    return { text: `[Tool Error] Access denied — can only query the active repo "${allowedRepo || 'none'}" (requested: "${call.args.repo || 'none'}")` };
  }

  try {
    if (!isWorkerGitHubToolCall(call)) {
      return { text: `[Tool Error] Unknown tool: ${String((call as { tool?: unknown }).tool ?? 'unknown')}` };
    }

    return await executeGitHubToolLocally(call);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Push] Tool execution error:`, msg);
    return { text: `[Tool Error] ${msg}` };
  }
}

export async function executeToolCall(call: ToolCall, allowedRepo: string): Promise<ToolExecutionResult> {
  if (getGitHubToolBackend() === 'worker' && isWorkerGitHubToolCall(call)) {
    try {
      return await executeGitHubToolViaWorker(call, allowedRepo);
    } catch (error) {
      logGitHubWorkerFallback(call.tool, error);
    }
  }

  return executeToolCallLegacy(call, allowedRepo);
}
