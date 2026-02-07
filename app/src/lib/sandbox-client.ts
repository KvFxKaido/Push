/**
 * Thin HTTP client for the sandbox proxy at /api/sandbox/*.
 *
 * All calls go through the Cloudflare Worker which proxies to Modal.
 * No Modal SDK or gRPC — just plain fetch().
 */

// --- Types ---

export interface SandboxSession {
  sandboxId: string;
  status: 'ready' | 'error';
  error?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
  /** Raw `git status --porcelain` output for diagnostics */
  git_status?: string;
  error?: string;
}

// --- Error types ---

export interface SandboxError {
  error: string;
  code?: string;
  details?: string;
}

// User-friendly error messages for each error code
const ERROR_MESSAGES: Record<string, string> = {
  MODAL_NOT_CONFIGURED: 'Sandbox is not configured. Ask your admin to set up MODAL_SANDBOX_BASE_URL.',
  MODAL_URL_INVALID: 'Sandbox URL is misconfigured. The MODAL_SANDBOX_BASE_URL format is incorrect.',
  MODAL_URL_TRAILING_SLASH: 'Sandbox URL has a trailing slash. Remove it from MODAL_SANDBOX_BASE_URL.',
  MODAL_NOT_FOUND: 'Sandbox app not deployed. Run: cd sandbox && modal deploy app.py',
  MODAL_AUTH_FAILED: 'Modal authentication failed. Your Modal tokens may have expired.',
  MODAL_UNAVAILABLE: 'Sandbox is starting up. Try again in a few seconds.',
  MODAL_TIMEOUT: 'Sandbox operation timed out. Try a simpler command.',
  MODAL_NETWORK_ERROR: 'Cannot connect to the sandbox. Check your network or Modal status.',
  MODAL_UNKNOWN_ERROR: 'An unexpected sandbox error occurred.',
};

function formatSandboxError(status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body) as SandboxError;
    const code = parsed.code || 'UNKNOWN';
    const friendlyMessage = ERROR_MESSAGES[code] || parsed.error || 'Sandbox error';
    const details = parsed.details ? `\n\nDetails: ${parsed.details}` : '';
    return new Error(`${friendlyMessage} (${code})${details}`);
  } catch {
    // Body wasn't JSON, fall back to raw text
    return new Error(`Sandbox error (${status}): ${body.slice(0, 200)}`);
  }
}

// --- Helpers ---

const SANDBOX_BASE = '/api/sandbox';
const DEFAULT_TIMEOUT_MS = 30_000; // 30s for most operations
const EXEC_TIMEOUT_MS = 120_000;   // 120s for command execution

// --- Retry configuration ---

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000; // 2s, 4s, 8s, 16s exponential backoff

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines if an error is retryable (network issues, timeouts, 5xx errors).
 * Non-retryable: 4xx client errors, configuration errors.
 */
function isRetryableError(err: unknown, statusCode?: number): boolean {
  // Timeout errors are retryable (original AbortError)
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }

  // Timeout errors converted to generic Error (check message pattern)
  if (err instanceof Error && err.message.includes('timed out')) {
    return true;
  }

  // Network errors (fetch failed entirely) are retryable
  if (err instanceof TypeError && err.message.includes('fetch')) {
    return true;
  }

  // 5xx server errors are retryable
  if (statusCode && statusCode >= 500) {
    return true;
  }

  // 4xx client errors and other errors are not retryable
  return false;
}

/**
 * Wraps a fetch call with exponential backoff retry logic.
 * Retries up to MAX_RETRIES times with delays: 2s, 4s, 8s, 16s.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  endpoint: string,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check for statusCode property (attached in sandboxFetch) or extract from message
      const errWithStatus = err as Error & { statusCode?: number };
      let statusCode = errWithStatus.statusCode;
      if (!statusCode) {
        const statusMatch = lastError.message.match(/\((\d{3})\)/);
        statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(err, statusCode)) {
        throw lastError;
      }

      // Don't retry after the last attempt
      if (attempt === MAX_RETRIES) {
        break;
      }

      // Exponential backoff: 2s, 4s, 8s, 16s
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`[sandbox-client] ${endpoint} attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw new Error(`Sandbox ${endpoint} failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
}

async function sandboxFetch<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${SANDBOX_BASE}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Attach status code for retry logic
        const error = formatSandboxError(res.status, text);
        (error as Error & { statusCode?: number }).statusCode = res.status;
        throw error;
      }

      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Sandbox ${endpoint} timed out after ${Math.round(timeoutMs / 1000)}s — the server may be slow or unreachable.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, endpoint);
}

// --- Public API ---

export async function createSandbox(
  repo: string,
  branch?: string,
  githubToken?: string,
): Promise<SandboxSession> {
  const data = await sandboxFetch<{ sandbox_id: string | null; status?: string; error?: string }>(
    'create',
    { repo, branch: branch || 'main', github_token: githubToken || '' },
  );

  if (!data.sandbox_id) {
    return { sandboxId: '', status: 'error', error: data.error || 'Unknown error' };
  }

  return { sandboxId: data.sandbox_id, status: 'ready' };
}

export async function execInSandbox(
  sandboxId: string,
  command: string,
  workdir?: string,
): Promise<ExecResult> {
  // API returns snake_case, we need camelCase
  const raw = await sandboxFetch<{ stdout: string; stderr: string; exit_code: number; truncated: boolean }>(
    'exec',
    {
      sandbox_id: sandboxId,
      command,
      workdir: workdir || '/workspace',
    },
    EXEC_TIMEOUT_MS,
  );
  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exit_code,
    truncated: raw.truncated,
  };
}

export async function readFromSandbox(
  sandboxId: string,
  path: string,
): Promise<FileReadResult> {
  return sandboxFetch<FileReadResult>('read', {
    sandbox_id: sandboxId,
    path,
  });
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  bytes_written?: number;
}

export async function writeToSandbox(
  sandboxId: string,
  path: string,
  content: string,
): Promise<WriteResult> {
  return sandboxFetch<WriteResult>('write', {
    sandbox_id: sandboxId,
    path,
    content,
  });
}

export async function getSandboxDiff(
  sandboxId: string,
): Promise<DiffResult> {
  return sandboxFetch<DiffResult>('diff', {
    sandbox_id: sandboxId,
  });
}

export async function cleanupSandbox(
  sandboxId: string,
): Promise<{ ok: boolean }> {
  return sandboxFetch<{ ok: boolean }>('cleanup', {
    sandbox_id: sandboxId,
  });
}

// --- File browser operations ---

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}

export async function listDirectory(
  sandboxId: string,
  path: string = '/workspace',
): Promise<FileEntry[]> {
  const data = await sandboxFetch<{ entries: FileEntry[]; error?: string }>('list', {
    sandbox_id: sandboxId,
    path,
  });
  if (data.error) throw new Error(data.error);
  return data.entries;
}

export async function deleteFromSandbox(
  sandboxId: string,
  path: string,
): Promise<void> {
  const data = await sandboxFetch<{ ok: boolean; error?: string }>('delete', {
    sandbox_id: sandboxId,
    path,
  });
  if (!data.ok) throw new Error(data.error || 'Delete failed');
}

export async function renameInSandbox(
  _sandboxId: string,
  _oldPath: string,
  _newPath: string,
): Promise<void> {
  // Rename endpoint removed to fit Modal free tier (8 endpoint limit).
  // Re-add when plan is upgraded. The UI hides the rename action.
  throw new Error('Rename is not available on the current plan.');
}
