/**
 * tui-render-frame.ts — Pure helpers for the TUI render-frame lifecycle.
 *
 * Extracted from tui.ts so the full-redraw decision can be exercised
 * directly without standing up the screen buffer, scheduler, or terminal.
 */

export type RenderFrameMeta = {
  /** Terminal rows captured at the end of the previous frame. */
  readonly rows: number;
  /** Terminal cols captured at the end of the previous frame. */
  readonly cols: number;
  /** Layout cache key captured at the end of the previous frame. */
  readonly layoutKey: string;
  /** True if the previous frame had any overlay drawn on top. */
  readonly hadOverlay: boolean;
  /** True if the previous frame bailed out via the min-size guard. */
  readonly tooSmall: boolean;
  /** False until the very first frame has been rendered successfully. */
  readonly initialized: boolean;
};

/**
 * Decide whether the next frame must clear and re-render every region
 * (full redraw) instead of touching only the regions in `dirty`.
 *
 * A full redraw is required when:
 *   - the frame has never rendered before (`prev.initialized === false`),
 *   - the previous frame bailed out of the min-size guard (`prev.tooSmall`),
 *   - the terminal was resized (rows/cols differ from `prev`),
 *   - the layout cache key changed (composer height, tool pane open, …),
 *   - the previous frame painted an overlay (so its alpha-blended region
 *     needs to be cleared cleanly even if no other region is dirty),
 *   - an overlay is currently active (so the modal box draws over a clean
 *     background instead of stale region content underneath), or
 *   - the caller has flagged everything dirty (`dirtyAll`, e.g. from
 *     `onResize`, theme switch, or a forced refresh).
 *
 * Otherwise the partial path is safe — only the dirty regions repaint.
 */
export function shouldFullRedraw(opts: {
  prev: RenderFrameMeta;
  rows: number;
  cols: number;
  layoutKey: string;
  dirtyAll: boolean;
  overlayActive: boolean;
}): boolean {
  const { prev, rows, cols, layoutKey, dirtyAll, overlayActive } = opts;
  return (
    dirtyAll ||
    !prev.initialized ||
    prev.tooSmall ||
    prev.rows !== rows ||
    prev.cols !== cols ||
    prev.layoutKey !== layoutKey ||
    prev.hadOverlay ||
    overlayActive
  );
}
