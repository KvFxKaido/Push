/**
 * GitHub REST API client with retry, timeout, and rate-limit handling.
 */

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

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
      if (!isNaN(delay)) return (delay + 1) * 1000;
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
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      return response;
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      const errorMsg = isTimeout
        ? `GitHub API timed out after ${GITHUB_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);

      lastError = new Error(errorMsg);

      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`GitHub API failed after ${MAX_RETRIES} retries`);
}

export function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return headers;
}

export async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
  return fetchWithRetry(url, options);
}

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

export function formatGitHubError(status: number, context: string, branch?: string): string {
  switch (status) {
    case 404: {
      const branchHint = branch ? ` on branch "${branch}"` : '';
      return `Not found: ${context}${branchHint}. The file may not exist, the path might be incorrect, or the branch may be different. Try list_directory to browse, or list_branches to see available branches.`;
    }
    case 403:
      return `Access forbidden (403) for ${context}. Your GitHub token may lack permissions, or you have hit API rate limits.`;
    case 429:
      return `Rate limited (429) for ${context}. GitHub is throttling requests — retry shortly.`;
    case 401:
      return `Unauthorized (401) for ${context}. Your GitHub token is invalid or expired.`;
    case 500:
    case 502:
    case 503:
      return `GitHub server error (${status}) for ${context}. This is temporary — retry shortly.`;
    default:
      return `GitHub API returned ${status} for ${context}`;
  }
}
