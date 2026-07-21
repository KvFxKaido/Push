/**
 * Composer prompt-history navigation (#1563 item 1).
 *
 * Maps Up/Down pressed at the composer's buffer edge onto the input-history
 * ring (`createInputHistory`). The entry list is captured lazily at the START
 * of each navigation run — the Up that begins recall — so it always reflects
 * the live session source (resume, daemon echo, a just-submitted prompt)
 * without any mount-time seeding race. A run ends when the caller resets
 * (user edit, submit, session switch) or when Down walks past the newest
 * entry back to the stashed draft; the next Up re-captures.
 */
import { createInputHistory } from './tui-input.ts';

export type ComposerHistoryDirection = 'up' | 'down';

export interface ComposerHistoryNav {
  /**
   * Handle Up/Down pressed at the composer's buffer boundary. Returns the
   * text to load into the composer, or null when the key should keep its
   * normal cursor behavior (no entries, already at the oldest, or Down while
   * not navigating). Down past the newest entry returns the draft stashed at
   * the first Up — possibly the empty string, which is a real recall.
   */
  recall(direction: ComposerHistoryDirection, currentText: string): string | null;
  /** True while a navigation run is active (a history entry is loaded). */
  isNavigating(): boolean;
  /** End the run so the next Up re-captures entries and re-stashes the draft. */
  reset(): void;
}

export function createComposerHistoryNav(
  getEntries: () => readonly string[],
  maxSize?: number,
): ComposerHistoryNav {
  // Invariant: non-null only while a run is active (ring.isNavigating()).
  // Dropping the ring the moment navigation ends is what makes the next Up
  // re-capture — a kept-but-idle ring would replay a stale entry list.
  let ring: ReturnType<typeof createInputHistory> | null = null;

  return {
    recall(direction, currentText) {
      if (direction === 'down' && ring === null) return null;
      if (ring === null) {
        const captured = createInputHistory(maxSize);
        for (const entry of getEntries()) captured.push(entry);
        ring = captured;
      }
      const result = direction === 'up' ? ring.up(currentText) : ring.down(currentText);
      if (!ring.isNavigating()) ring = null;
      return result;
    },
    isNavigating: () => ring !== null && ring.isNavigating(),
    reset() {
      ring = null;
    },
  };
}
