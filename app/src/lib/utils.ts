import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ---------------------------------------------------------------------------
// JSON helpers (previously duplicated across 6 lib files)
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

// ---------------------------------------------------------------------------
// Relative time formatting (previously duplicated across 7 files)
// ---------------------------------------------------------------------------

/**
 * Format an ISO date string as a relative time label.
 * Includes "just now", minutes, hours, days, months, and falls back to locale date.
 */
export function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Compact variant for timestamps (epoch ms).
 * Omits "ago" suffix — used by chat/history UI.
 */
export function timeAgoCompact(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// ---------------------------------------------------------------------------
// Card shell — shared class string for all inline cards
// ---------------------------------------------------------------------------

export const CARD_SHELL_CLASS = 'my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-push-grad-card shadow-push-card';

// ---------------------------------------------------------------------------
// Network error detection (previously duplicated in auth hooks)
// ---------------------------------------------------------------------------

export function isNetworkFetchError(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message);
}

// ---------------------------------------------------------------------------
// GitHub token validation (previously duplicated in auth hooks)
// ---------------------------------------------------------------------------

export async function validateGitHubToken(token: string): Promise<{ login: string; avatar_url: string } | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { login: data.login, avatar_url: data.avatar_url };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CI / Workflow status colors (previously duplicated across 3 card files)
// ---------------------------------------------------------------------------

export function ciStatusColor(status: string | null): string {
  switch (status) {
    case 'success': return 'text-[#22c55e]';
    case 'failure': return 'text-[#ef4444]';
    case 'pending': return 'text-[#f59e0b]';
    default: return 'text-push-fg-secondary';
  }
}

export function ciStatusBg(status: string | null): string {
  switch (status) {
    case 'success': return 'bg-[#22c55e]/5';
    case 'failure': return 'bg-[#ef4444]/5';
    case 'pending': return 'bg-[#f59e0b]/5';
    default: return 'bg-push-fg-dim/10';
  }
}

// ---------------------------------------------------------------------------
// Bare JSON extraction (brace-counting, moved from tool-dispatch.ts)
// ---------------------------------------------------------------------------

/**
 * Extract bare JSON objects containing a "tool" key from text.
 * Uses brace-counting instead of regex so nested objects like
 * {"tool":"x","args":{"repo":"a/b","path":"c"}} are captured correctly.
 */
export function extractBareToolJsonObjects(text: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = braceIdx; j < text.length; j++) {
      const ch = text[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) {
      i = braceIdx + 1;
      continue;
    }

    const candidate = text.slice(braceIdx, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      const parsedObj = asRecord(parsed);
      if (parsedObj && typeof parsedObj.tool === 'string') {
        results.push(parsed);
      }
    } catch {
      // Not valid JSON — skip
    }

    i = end + 1;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fenced-JSON tool detection factory (previously duplicated 7+ times)
// ---------------------------------------------------------------------------

/**
 * Generic tool detection: scans text for fenced JSON blocks and bare JSON,
 * delegates validation to the provided `validate` function.
 */
export function detectToolFromText<T>(
  text: string,
  validate: (parsed: unknown) => T | null,
): T | null {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const result = validate(parsed);
      if (result) return result;
    } catch {
      // Not valid JSON
    }
  }

  for (const parsed of extractBareToolJsonObjects(text)) {
    const result = validate(parsed);
    if (result) return result;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Streaming timeout helper (previously duplicated in auditor/coder agents)
// ---------------------------------------------------------------------------

/**
 * Wraps a streaming call with a timeout. Returns an Error if timed out or
 * the stream errored, otherwise null.
 */
export function streamWithTimeout(
  timeoutMs: number,
  timeoutMessage: string,
  run: (
    onToken: (token: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ) => void,
): { promise: Promise<Error | null>; getAccumulated: () => string } {
  let accumulated = '';
  const promise = new Promise<Error | null>((resolve) => {
    let settled = false;
    const settle = (v: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(new Error(timeoutMessage)), timeoutMs);
    run(
      (token) => { accumulated += token; },
      () => settle(null),
      (error) => settle(error),
    );
  });
  return { promise, getAccumulated: () => accumulated };
}
