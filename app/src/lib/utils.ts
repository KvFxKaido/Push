import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
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

/**
 * The project's custom font-size scale (`tailwind.config.js` → `theme.fontSize`).
 * Kept in sync with the config by `cn-tailwind-merge.test.ts` (a drift test
 * reads the config and asserts set-equality), so a new `push-*` size added
 * there without registering it here fails CI rather than silently misbehaving.
 */
export const PUSH_FONT_SIZE_TOKENS = [
  'push-2xs',
  'push-xs',
  'push-sm',
  'push-base',
  'push-lg',
  'push-xl',
  'push-2xl',
  'push-display',
] as const;

/**
 * tailwind-merge, taught the custom `text-push-*` font-size scale above.
 * Without this, vanilla tailwind-merge has no rule for `text-push-xs`/`-2xs`/…
 * and falls back to treating them as *colors* — so `cn('text-push-2xs',
 * 'text-push-fg-dim')` would drop the size (two "colors" collapse to the last)
 * while a baked `text-sm` from a shadcn primitive survived, silently.
 * Registering the scale in the built-in `font-size` group makes the sizes
 * dedupe against each other and against standard sizes, and stop colliding with
 * `text-push-*` colors.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...PUSH_FONT_SIZE_TOKENS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Relative time formatting (previously duplicated across 7 files)
// ---------------------------------------------------------------------------

import { formatRelativeTime } from '@push/lib/time-utils';

export function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  return formatRelativeTime(dateStr);
}

export function timeAgoCompact(timestamp: number): string {
  return formatRelativeTime(timestamp, { compact: true });
}

// ---------------------------------------------------------------------------
// Card shell — shared class string for all inline cards.
// Flat chrome (matches the HUB_* material): solid surface steps + 1px borders,
// no backdrop-blur / drop shadows / translucent gradients.
// ---------------------------------------------------------------------------

export const CARD_SHELL_CLASS =
  'my-2.5 max-w-full overflow-hidden rounded-[20px] border border-push-edge bg-push-surface-raised';

export const CARD_PANEL_CLASS =
  'rounded-[18px] border border-push-edge-subtle bg-push-surface-inset';

export const CARD_PANEL_SUBTLE_CLASS = 'rounded-[16px] border border-push-edge-subtle bg-black/10';

export const CARD_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-push-edge bg-push-surface-raised px-3 text-push-sm font-medium text-push-fg-secondary transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const CARD_ICON_BUTTON_CLASS =
  'inline-flex items-center justify-center rounded-full border border-push-edge bg-push-surface-raised text-push-fg-dim transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';

export const CARD_INPUT_CLASS =
  'w-full rounded-[18px] border border-push-edge-subtle bg-push-surface-inset px-3 py-2 text-push-base text-push-fg font-mono placeholder:text-push-fg-dim outline-none transition-all focus:border-push-sky/50';

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
export const CARD_BADGE_INFO = 'border border-push-edge/70 bg-black/10 text-push-fg-secondary';

/** Status-surface tint bands — the gradients live as `--push-surface-*` CSS
 *  vars in index.css (single source); these are the Tailwind class wrappers. */
export const CARD_HEADER_BG_SUCCESS = '[background-image:var(--push-surface-success)]';
export const CARD_HEADER_BG_ERROR = '[background-image:var(--push-surface-error)]';
export const CARD_HEADER_BG_WARNING = '[background-image:var(--push-surface-warning)]';
export const CARD_HEADER_BG_INFO = '[background-image:var(--push-surface-info)]';

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
