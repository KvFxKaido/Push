import type { ChatMessage } from '@/types';

/** Minimal turn snapshot the announcer remembers between renders. */
export type AnnouncerSnapshot = { id: string; status: ChatMessage['status'] } | null;

/**
 * Pure boundary-transition decision for the transcript's `aria-live` announcer
 * (shadcn point 15, "be accessible without the noise"). Split out from the
 * component so it's unit-testable without a DOM — the app's vitest runs in the
 * `node` environment — and so the component file stays component-only for React
 * Fast Refresh.
 *
 * Returns the phrase to announce, or `null` when nothing changed at a turn
 * boundary; the caller skips the state write on `null`, so streaming tokens
 * never re-announce. These are turn-status phrases, not role/phase labels, so
 * they don't go through `role-display.ts` (which governs actor/phase vocabulary).
 *
 * Consecutive announcements never repeat verbatim — every turn passes through
 * "Responding…" before "Response ready.", so the live region's text always
 * changes and the SR re-announces (identical back-to-back text is swallowed).
 */
export function nextAnnouncement(
  prev: AnnouncerSnapshot,
  message: Pick<ChatMessage, 'id' | 'role' | 'status'> | null,
): string | null {
  // Only the assistant's turns are announced; the reader authored their own.
  if (!message || message.role !== 'assistant') return null;
  const sameTurn = prev?.id === message.id;
  const responding = message.status === 'streaming' || message.status === 'sending';
  const wasResponding = sameTurn && (prev?.status === 'streaming' || prev?.status === 'sending');
  if (responding && !wasResponding) return 'Responding…';
  if (message.status === 'done' && !(sameTurn && prev?.status === 'done')) return 'Response ready.';
  if (message.status === 'error' && !(sameTurn && prev?.status === 'error'))
    return 'Response failed.';
  return null;
}
