/**
 * tui-widgets.mjs — Small composable render helpers for TUI widgets/modals.
 */

import { drawBox } from './tui-renderer.mjs';

export function getCenteredModalRect(rows, cols, width, height, {
  minTop = 0,
  minLeft = 0,
} = {}) {
  const top = Math.max(minTop, Math.floor((rows - height) / 2));
  const left = Math.max(minLeft, Math.floor((cols - width) / 2));
  return { top, left, width, height };
}

export function drawModalBoxAt(buf, theme, top, left, width, lines) {
  const boxLines = drawBox(lines, width, theme.glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(top + i, left, boxLines[i]);
  }
  return boxLines.length;
}

export function renderCenteredModalBox(buf, theme, rows, cols, width, lines, opts = {}) {
  const height = lines.length + 2;
  const rect = getCenteredModalRect(rows, cols, width, height, opts);
  drawModalBoxAt(buf, theme, rect.top, rect.left, width, lines);
  return rect;
}

/**
 * Compute a centered scrolling window for list-like UIs.
 * Returns { start, end } where end is exclusive.
 */
export function getWindowedListRange(count, cursor, windowSize) {
  const total = Math.max(0, Number(count) || 0);
  const size = Math.max(0, Number(windowSize) || 0);
  if (total === 0 || size === 0) return { start: 0, end: 0 };
  if (total <= size) return { start: 0, end: total };

  const cur = Math.max(0, Math.min(total - 1, Number(cursor) || 0));
  let start = Math.max(0, cur - Math.floor(size / 2));
  start = Math.min(start, total - size);
  return { start, end: Math.min(total, start + size) };
}

