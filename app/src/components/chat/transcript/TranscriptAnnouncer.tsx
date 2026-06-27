import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/types';
import { nextAnnouncement, type AnnouncerSnapshot } from './transcript-announce';

/**
 * Visually-hidden `aria-live` region that announces assistant turn boundaries to
 * screen readers — shadcn point 15, "be accessible without the noise". The
 * transcript is otherwise silent to assistive tech: tokens stream into the DOM
 * with no announcement, so a non-sighted reader can't tell a response started,
 * finished, or failed.
 *
 * Deliberately low-noise: we announce only on *boundary* transitions (a turn
 * begins, completes, or errors), never per token. `polite` queues the
 * announcement behind whatever the reader is already hearing rather than barging
 * in. These are turn-status phrases, not role/phase labels, so they don't go
 * through `role-display.ts` (which governs named-actor / phase vocabulary).
 *
 * Consecutive announcements never repeat verbatim — every turn passes through
 * "Responding…" before "Response ready.", so the live region's text always
 * changes and the SR re-announces (identical back-to-back text is swallowed).
 */
export function TranscriptAnnouncer({ lastMessage }: { lastMessage: ChatMessage | null }) {
  const [announcement, setAnnouncement] = useState('');
  const prevRef = useRef<AnnouncerSnapshot>(null);

  const id = lastMessage?.id ?? null;
  const role = lastMessage?.role ?? null;
  const status = lastMessage?.status;

  useEffect(() => {
    if (!lastMessage || role !== 'assistant') {
      prevRef.current = null;
      return;
    }
    const phrase = nextAnnouncement(prevRef.current, lastMessage);
    if (phrase) setAnnouncement(phrase);
    prevRef.current = { id: lastMessage.id, status };
    // Keyed on id/status, not content, so the effect skips per-token churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, role, status]);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}
