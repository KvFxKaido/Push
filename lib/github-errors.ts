/**
 * Classify GitHub's 403 responses from the signals GitHub actually sends.
 *
 * GitHub answers both "you may not do this" and "slow down" with 403, so the
 * status alone cannot tell an auth failure from a rate limit. A message that
 * guesses ("may lack permissions, or you have hit API rate limits") leaves ops
 * unable to say which one stopped the autonomous reviewer. GitHub's headers
 * and its JSON `message` field do say which:
 *
 * - primary rate limit: `x-ratelimit-remaining: 0` (reset in `x-ratelimit-reset`)
 * - secondary rate limit: a `retry-after` header, or a message naming it
 * - suspended GitHub App installation: a message saying so
 * - missing permission: anything else with a message, e.g.
 *   "Resource not accessible by integration"
 *
 * Shared by the web Worker (`app/src/lib/github-tools.ts`) and the CLI /
 * GitHub MCP core (`lib/github-tool-core.ts`).
 */

export type GitHubForbiddenKind =
  | 'rate_limit'
  | 'secondary_rate_limit'
  | 'suspended'
  | 'permission'
  | 'unknown';

export interface GitHubErrorDetail {
  /** GitHub's JSON `message`, sanitized to one short line. */
  message?: string;
  rateLimitRemaining?: string;
  /** Epoch seconds when the primary limit resets. */
  rateLimitReset?: string;
  /** Seconds to wait, from `retry-after`. */
  retryAfter?: string;
}

/** Longest upstream message carried into an error string. */
const MAX_MESSAGE_CHARS = 200;

/**
 * Reduce GitHub's `message` to one short line of plain text, so upstream
 * content never reaches the UI verbatim.
 */
export function sanitizeGitHubMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const oneLine = raw
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return undefined;
  return oneLine.length > MAX_MESSAGE_CHARS
    ? `${oneLine.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : oneLine;
}

/**
 * Read the classification signals from a failed response. Reads a clone when
 * the response supports one, so the caller's body stays unread; a runtime that
 * hands back a minimal Response-like object without `clone` has its body read
 * directly. Never throws: a body that is not JSON (an HTML error page, say)
 * contributes no message.
 */
export async function readGitHubErrorDetail(res: Response): Promise<GitHubErrorDetail> {
  const header = (name: string) => res.headers?.get(name) ?? undefined;
  let message: string | undefined;
  try {
    const source = typeof res.clone === 'function' ? res.clone() : res;
    const parsed = JSON.parse(await source.text()) as { message?: unknown };
    message = sanitizeGitHubMessage(parsed?.message);
  } catch {
    message = undefined;
  }
  return {
    message,
    rateLimitRemaining: header('x-ratelimit-remaining'),
    rateLimitReset: header('x-ratelimit-reset'),
    retryAfter: header('retry-after'),
  };
}

export function classifyGitHubForbidden(detail: GitHubErrorDetail): GitHubForbiddenKind {
  const message = detail.message ?? '';
  if (detail.rateLimitRemaining === '0') return 'rate_limit';
  if (detail.retryAfter || /secondary rate limit/i.test(message)) return 'secondary_rate_limit';
  if (/rate limit/i.test(message)) return 'rate_limit';
  if (/suspended/i.test(message)) return 'suspended';
  if (message) return 'permission';
  return 'unknown';
}

function formatReset(epochSeconds: string | undefined): string | undefined {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return `${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC`;
}

/**
 * The 403 sentence for `context`. Rate-limit kinds say "Rate limited (403…)"
 * so callers that classify by message text (the PR-review job's
 * `classifyError`) can tell them from auth failures.
 */
export function describeGitHubForbidden(detail: GitHubErrorDetail, context: string): string {
  const kind = classifyGitHubForbidden(detail);
  const says = detail.message ? ` GitHub says: "${detail.message}"` : '';
  switch (kind) {
    case 'rate_limit': {
      const reset = formatReset(detail.rateLimitReset);
      return `Rate limited (403, primary rate limit exhausted${reset ? `; resets at ${reset}` : ''}) for ${context}.${says}`;
    }
    case 'secondary_rate_limit': {
      const wait = detail.retryAfter ? `; retry after ${detail.retryAfter}s` : '';
      return `Rate limited (403, secondary rate limit${wait}) for ${context}.${says}`;
    }
    case 'suspended':
      return `Access forbidden (403) for ${context}: the GitHub App installation is suspended.${says}`;
    case 'permission':
      return `Access forbidden (403) for ${context}: the token lacks permission for this request.${says}`;
    default:
      return `Access forbidden (403) for ${context}. GitHub gave no reason; the token may lack permissions, or you have hit API rate limits.`;
  }
}
