import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { asRecord, streamWithTimeout } from '@push/lib/stream-utils';
import type { JsonRecord } from '@push/lib/stream-utils';

export { asRecord, streamWithTimeout };
export type { JsonRecord };

export {
  detectToolFromText,
  diagnoseJsonSyntaxError,
  extractBareToolJsonObjects,
  repairToolJson,
  detectTruncatedToolCall,
} from '@push/lib/tool-call-parsing';
export type { JsonSyntaxDiagnosis } from '@push/lib/tool-call-parsing';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

export const CARD_SHELL_CLASS =
  'my-2.5 max-w-full overflow-hidden rounded-[20px] border border-push-edge/80 bg-[linear-gradient(180deg,rgba(11,15,22,0.96)_0%,rgba(6,9,14,0.98)_100%)] shadow-[0_16px_36px_rgba(0,0,0,0.4),0_3px_10px_rgba(0,0,0,0.2)] backdrop-blur-xl';

export const CARD_PANEL_CLASS =
  'rounded-[18px] border border-push-edge/70 bg-[linear-gradient(180deg,rgba(9,13,19,0.88)_0%,rgba(5,8,13,0.94)_100%)] shadow-[0_12px_26px_rgba(0,0,0,0.26),0_2px_8px_rgba(0,0,0,0.14)]';

export const CARD_PANEL_SUBTLE_CLASS = 'rounded-[16px] border border-push-edge/70 bg-black/10';

export const CARD_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-push-edge-subtle bg-push-grad-input px-3 text-push-sm font-medium text-push-fg-secondary shadow-[0_10px_24px_rgba(0,0,0,0.26),0_2px_8px_rgba(0,0,0,0.14)] backdrop-blur-xl transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const CARD_ICON_BUTTON_CLASS =
  'inline-flex items-center justify-center rounded-full border border-push-edge-subtle bg-push-grad-input text-push-fg-dim shadow-[0_10px_24px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.12)] backdrop-blur-xl transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const CARD_INPUT_CLASS =
  'w-full rounded-[18px] border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-push-base text-push-fg font-mono placeholder:text-push-fg-dim shadow-[0_10px_24px_rgba(0,0,0,0.22)] outline-none transition-all focus:border-push-sky/50';

// ---------------------------------------------------------------------------
// Card status palette — shared across card components
// ---------------------------------------------------------------------------

export const CARD_TEXT_SUCCESS = 'text-push-status-success';
export const CARD_TEXT_ERROR = 'text-push-status-error';
export const CARD_TEXT_WARNING = 'text-push-status-warning';

/** Pill badge (opacity /15) — inline status tags e.g. "Open", "SAFE". */
export const CARD_BADGE_SUCCESS = 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
export const CARD_BADGE_ERROR = 'border border-red-500/20 bg-red-500/10 text-red-300';
export const CARD_BADGE_WARNING = 'border border-yellow-500/20 bg-yellow-500/10 text-yellow-300';
export const CARD_BADGE_INFO = 'border border-push-edge/70 bg-black/10 text-[#9db8df]';

/** Header background band (opacity /10) — used for card header rows. */
export const CARD_HEADER_BG_SUCCESS =
  'bg-[linear-gradient(180deg,rgba(17,61,42,0.18)_0%,rgba(8,28,20,0.34)_100%)]';
export const CARD_HEADER_BG_ERROR =
  'bg-[linear-gradient(180deg,rgba(70,23,23,0.18)_0%,rgba(31,11,11,0.34)_100%)]';
export const CARD_HEADER_BG_WARNING =
  'bg-[linear-gradient(180deg,rgba(68,52,16,0.18)_0%,rgba(31,23,8,0.34)_100%)]';
export const CARD_HEADER_BG_INFO =
  'bg-[linear-gradient(180deg,rgba(20,34,52,0.18)_0%,rgba(9,18,31,0.34)_100%)]';

/** Divider list container — applies divide-y/border token in one constant. */
export const CARD_LIST_CLASS = 'divide-y divide-push-edge/80';

// ---------------------------------------------------------------------------
// Network error detection (previously duplicated in auth hooks)
// ---------------------------------------------------------------------------

export function isNetworkFetchError(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message);
}

// ---------------------------------------------------------------------------
// GitHub token validation (previously duplicated in auth hooks)
// ---------------------------------------------------------------------------

export async function validateGitHubToken(
  token: string,
): Promise<{ login: string; avatar_url: string } | null> {
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
    case 'success':
      return 'text-push-status-success';
    case 'failure':
      return 'text-push-status-error';
    case 'pending':
      return 'text-push-status-warning';
    default:
      return 'text-push-fg-secondary';
  }
}

export function ciStatusBg(status: string | null): string {
  switch (status) {
    case 'success':
      return CARD_HEADER_BG_SUCCESS;
    case 'failure':
      return CARD_HEADER_BG_ERROR;
    case 'pending':
      return CARD_HEADER_BG_WARNING;
    default:
      return CARD_HEADER_BG_INFO;
  }
}

// ---------------------------------------------------------------------------
// Miscellaneous helpers
// ---------------------------------------------------------------------------

/** Format milliseconds into a human-friendly duration string (e.g. "1m 23s"). */
export function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
