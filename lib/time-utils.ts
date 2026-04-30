/**
 * Render a past timestamp as a short relative-time phrase ("3m ago",
 * "yesterday", "2w ago"). Used by the resume pickers so operators can
 * eyeball session freshness without decoding an ISO string.
 *
 * `now` is injectable for deterministic tests. Future timestamps (clock
 * skew) fall back to "future" rather than printing a negative delta.
 */
export function formatRelativeTime(
  ms: number | string | Date,
  optionsOrNow: { now?: number; compact?: boolean } | number = {},
): string {
  const options = typeof optionsOrNow === 'number' ? { now: optionsOrNow } : optionsOrNow;
  const { now = Date.now(), compact = false } = options;
  const then = typeof ms === 'number' ? ms : new Date(ms).getTime();
  const delta = now - then;

  if (delta < 0) return 'future';

  const ago = compact ? '' : ' ago';

  if (delta < 60_000) return compact ? 'now' : 'just now';

  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m${ago}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${ago}`;

  const days = Math.floor(hours / 24);
  if (!compact && days === 1) return 'yesterday';
  if (days < 7) return `${days}d${ago}`;

  // Day-count cutoffs so band boundaries are unambiguous.
  if (days < 30) return `${Math.floor(days / 7)}w${ago}`;
  if (days < 365) return `${Math.floor(days / 30)}mo${ago}`;
  return `${Math.floor(days / 365)}y${ago}`;
}
