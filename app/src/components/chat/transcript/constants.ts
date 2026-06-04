/**
 * Transcript rendering tunables, shared by the plain and virtualized paths so
 * both stick-to-bottom implementations agree on what "at the bottom" means.
 */

// Distance from the bottom (px) within which streaming output is allowed to
// keep auto-scrolling. Past this, the user is considered to have scrolled away
// and we stop yanking them down.
export const AUTO_SCROLL_THRESHOLD_PX = 150;

// Distance from the bottom (px) at which the scroll-to-bottom affordance hides
// and `isAtBottom` flips true. Mirrors Virtuoso's `atBottomThreshold`.
export const AT_BOTTOM_THRESHOLD_PX = 48;

// Settled-segment count at or above which the transcript switches to the
// Virtuoso-backed virtualized list. Below this the original non-virtualized
// path renders verbatim, keeping the common (short-chat) case untouched.
export const VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS = 80;

/**
 * Single source of truth for the plain-vs-virtualized decision. Kept pure (and
 * separate from the component) so the threshold contract is unit-testable
 * without rendering either list container.
 */
export function isVirtualizedTranscript(segmentCount: number): boolean {
  return segmentCount >= VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS;
}
