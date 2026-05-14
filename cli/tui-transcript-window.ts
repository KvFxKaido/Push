/**
 * tui-transcript-window.ts — Pure helpers for the TUI transcript viewport.
 *
 * Extracted from tui.ts so the binary search and scroll-clamp logic can be
 * exercised directly. No imports from tui.ts; tui.ts imports from here.
 */

export type TranscriptBlockBounds = {
  readonly startLine: number;
  readonly endLine: number;
};

/**
 * Returns the index of the first block whose `endLine` is strictly greater
 * than `targetLine` — i.e. the first block that intersects or sits past the
 * target line. Returns `blocks.length` when every block ends at or before
 * the target.
 *
 * Treats a block with a nullish (`undefined` / `null`) `endLine` as if it
 * ended at line 0 — matches the historical `?? 0` fallback in tui.ts:
 * corrupt blocks fall to the left of any positive target so the search
 * continues rightward. NaN / Infinity are not normalized; the comparison
 * does whatever IEEE-754 ordering produces (NaN compares false either
 * way, so the search behaves as if the block ended past the target).
 */
export function findFirstIntersectingBlock(
  blocks: readonly TranscriptBlockBounds[],
  targetLine: number,
): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const end = blocks[mid]?.endLine ?? 0;
    if (end <= targetLine) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Returns the index of the first block whose `startLine` is greater than or
 * equal to `targetLine`. Returns `blocks.length` when every block starts
 * before the target. Use this to compute an exclusive upper bound for the
 * visible window.
 */
export function findFirstBlockStartingAtOrAfter(
  blocks: readonly TranscriptBlockBounds[],
  targetLine: number,
): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const start = blocks[mid]?.startLine ?? 0;
    if (start < targetLine) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type TranscriptViewport = {
  /** Largest scrollOffset that is meaningful — pinning the top to line 0. */
  readonly maxScroll: number;
  /** scrollOffset clamped into [0, maxScroll]. */
  readonly effectiveOffset: number;
  /** First visible line index in the transcript. */
  readonly startIdx: number;
  /** Exclusive upper bound for visible line indices (startIdx + height). */
  readonly endIdxExclusive: number;
};

/**
 * Compute the visible-line window for the transcript pane.
 *
 * Convention: `scrollOffset = 0` pins the view to the bottom (the live tail);
 * larger `scrollOffset` scrolls upward. When `scrollOffset` exceeds
 * `maxScroll` the window clamps to the top instead of going negative.
 *
 * When the transcript is shorter than the viewport (`totalLineCount <
 * viewportHeight`), `startIdx` is 0 and `endIdxExclusive` is the viewport
 * height — i.e. the caller still walks `viewportHeight` slots, but only the
 * first `totalLineCount` of them have content.
 *
 * Negative inputs are treated as zero. Non-integer inputs are not
 * normalized; callers in tui.ts pass integers.
 */
export function computeTranscriptViewport(opts: {
  totalLineCount: number;
  viewportHeight: number;
  scrollOffset: number;
}): TranscriptViewport {
  const totalLineCount = Math.max(0, opts.totalLineCount);
  const viewportHeight = Math.max(0, opts.viewportHeight);
  const scrollOffset = Math.max(0, opts.scrollOffset);

  const maxScroll = Math.max(0, totalLineCount - viewportHeight);
  const effectiveOffset = Math.min(scrollOffset, maxScroll);
  const startIdx = Math.max(0, maxScroll - effectiveOffset);
  const endIdxExclusive = startIdx + viewportHeight;

  return { maxScroll, effectiveOffset, startIdx, endIdxExclusive };
}
