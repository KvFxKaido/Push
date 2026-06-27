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

// Gap (px) left above a newly-anchored turn's first message when it's scrolled
// near the top of the viewport. Leaves a sliver of the previous turn visible
// (shadcn point 6 — "keep part of the previous conversation in context") so the
// reader keeps their place, and stops the message sitting flush to the edge.
export const TURN_ANCHOR_TOP_GAP_PX = 72;

/**
 * Height (px) of the bottom spacer that lets the last turn's first message reach
 * the top of the viewport (shadcn points 4–5 — "start a new turn near the top,
 * then stream the answer into the available space below").
 *
 * The spacer fills only the slack the turn itself doesn't: once the turn is at
 * least a viewport tall (minus the top gap) the answer provides its own room and
 * the spacer collapses to 0, so there's no trailing blank space when reading a
 * long answer and `isAtBottom` stays meaningful. Pure and clamped so it's
 * unit-testable without a DOM.
 */
export function turnSpacerHeight(
  viewportHeight: number,
  turnHeight: number,
  topGap: number = TURN_ANCHOR_TOP_GAP_PX,
): number {
  return Math.max(0, viewportHeight - turnHeight - topGap);
}

/**
 * Single source of truth for the plain-vs-virtualized decision. Kept pure (and
 * separate from the component) so the threshold contract is unit-testable
 * without rendering either list container.
 */
export function isVirtualizedTranscript(segmentCount: number): boolean {
  return segmentCount >= VIRTUALIZED_TRANSCRIPT_MIN_SEGMENTS;
}
