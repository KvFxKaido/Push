/**
 * cli/github-runtime.ts — CLI adapter for the shared GitHub tool core.
 *
 * `lib/github-tool-core.ts` is runtime-agnostic: it executes every GitHub tool
 * against an injected `GitHubCoreRuntime` (fetch + headers + base64 + sensitive
 * redaction). The web Worker injects one runtime, the MCP server another; this
 * is the CLI/daemon's. It mirrors the MCP server's Node injection
 * (`mcp/github-server/src/github-client.ts`): env-token auth, retrying fetch,
 * Buffer base64.
 *
 * Auth resolution (first non-empty wins), see `resolveGitHubToken`:
 *   1. PUSH_GITHUB_TOKEN
 *   2. GITHUB_TOKEN
 *   3. GH_TOKEN
 *   4. `gh auth token` (the GitHub CLI), if installed and logged in
 *
 * When no token resolves, GitHub tools are not advertised and the dispatch
 * path returns a structured GITHUB_NO_TOKEN error rather than hitting the API
 * unauthenticated.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

import type { GitHubCoreRuntime } from '../lib/github-tool-core.js';
import { isSensitivePath } from '../lib/sensitive-paths.js';

const execFileAsync = promisify(execFile);

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;

// Env vars checked in order. PUSH_-prefixed wins so a Push-specific token can
// override an ambient GITHUB_TOKEN (e.g. one CI injects for other purposes).
const GITHUB_TOKEN_ENV_VARS = ['PUSH_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

let cachedGhCliToken: string | null | undefined;

function readEnvToken(): string {
  for (const name of GITHUB_TOKEN_ENV_VARS) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Best-effort `gh auth token` lookup. Memoized per-process (the result of a
 * subprocess spawn shouldn't change within a run, and we don't want to spawn
 * `gh` on every tool call). Returns '' when the GitHub CLI is absent or not
 * logged in — never throws.
 */
async function readGhCliToken(): Promise<string> {
  if (cachedGhCliToken !== undefined) return cachedGhCliToken ?? '';
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5_000,
      maxBuffer: 64_000,
    });
    const token = stdout.trim();
    cachedGhCliToken = token || null;
    return token;
  } catch {
    // gh not installed, not on PATH, or not authenticated — all non-fatal.
    cachedGhCliToken = null;
    return '';
  }
}

/** Reset the memoized `gh` token. Test seam only. */
export function resetGhCliTokenCache(): void {
  cachedGhCliToken = undefined;
}

/**
 * Resolve a GitHub token from env, then fall back to the GitHub CLI. Async
 * because the `gh` fallback spawns a subprocess. Returns '' when nothing
 * resolves.
 */
export async function resolveGitHubToken(): Promise<string> {
  const envToken = readEnvToken();
  if (envToken) return envToken;
  return readGhCliToken();
}

/**
 * Synchronous token presence check used at advertise-time (building the tool
 * protocol) and for the capability `remoteGitHubAvailable` flag. Only consults
 * env vars — the `gh` fallback is async and resolved lazily at execution time.
 * A configured env token is the durable signal that "a remote is available";
 * the `gh` fallback still works at call time even if this returns false.
 */
export function hasEnvGitHubToken(): boolean {
  return readEnvToken().length > 0;
}

// --- Sensitive-text redaction --------------------------------------------
// `isSensitivePath` is shared in lib/sensitive-paths.ts; the content-redaction
// + error-formatting helpers are not yet promoted to lib/ (the web app and MCP
// server each carry a copy). Mirror them here rather than add a cross-package
// import; deduping the three into lib/ is a separate cleanup.

function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let next = text;
  let redacted = false;
  const apply = (
    pattern: RegExp,
    replacement: string | ((substring: string, ...groups: string[]) => string),
  ): void => {
    const before = next;
    next = next.replace(pattern, replacement as (substring: string, ...args: unknown[]) => string);
    if (next !== before) redacted = true;
  };

  apply(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  );
  apply(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED GITHUB TOKEN]');
  apply(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]');
  apply(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, '[REDACTED GOOGLE API KEY]');
  apply(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS ACCESS KEY]');
  apply(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}\b/gi, (_m, scheme) => `${scheme} [REDACTED TOKEN]`);
  apply(
    /((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*)([A-Za-z0-9/+=]{20,})/g,
    (_m, prefix) => `${prefix}[REDACTED]`,
  );

  return { text: next, redacted };
}

function formatSensitivePathToolError(path: string): string {
  return `Access denied — "${path}" looks like a secret or credential file. Ask the user directly for the value or use a safer source.`;
}

// --- Retrying fetch (mirrors mcp/github-server/src/github-client.ts) -------

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  if (response && response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const parsed = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(parsed)) return (parsed + 1) * 1_000;
    }
  }
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function githubFetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok && isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt + 1)));
        continue;
      }
      return response;
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      lastError = new Error(
        isTimeout
          ? `GitHub API timed out after ${GITHUB_TIMEOUT_MS / 1000}s`
          : err instanceof Error
            ? err.message
            : String(err),
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`GitHub API failed after ${MAX_RETRIES} retries`);
}

/**
 * Build a `GitHubCoreRuntime` bound to a resolved token. The token is captured
 * at construction so `buildHeaders` (a sync method on the runtime contract)
 * doesn't need to re-resolve; callers resolve it once via `resolveGitHubToken`
 * and pass it in.
 */
export function createCliGitHubRuntime(token: string): GitHubCoreRuntime {
  return {
    githubFetch: githubFetchWithRetry,
    buildHeaders: (accept = 'application/vnd.github.v3+json') => {
      const headers: Record<string, string> = {
        Accept: accept,
        'User-Agent': 'PushCLI/1.0',
      };
      if (token) headers['Authorization'] = `token ${token}`;
      return headers;
    },
    buildApiUrl: (path) => `${GITHUB_API_BASE}${path.startsWith('/') ? path : `/${path}`}`,
    decodeBase64: (content) => Buffer.from(content, 'base64').toString('utf8'),
    isSensitivePath,
    redactSensitiveText,
    formatSensitivePathToolError,
  };
}
