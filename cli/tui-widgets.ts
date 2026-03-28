/**
 * tui-widgets.ts — Small composable render helpers for TUI widgets/modals.
 */

import { drawBox } from './tui-renderer.js';
import type { Theme } from './tui-theme.js';

export interface ScreenBuffer {
  writeLine(row: number, col: number, text: string): void;
}

export type { Theme } from './tui-theme.js';

export interface ModalRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CenteredModalOptions {
  minTop?: number;
  minLeft?: number;
}

export interface WindowedListRange {
  start: number;
  end: number;
}

export function getCenteredModalRect(
  rows: number,
  cols: number,
  width: number,
  height: number,
  { minTop = 0, minLeft = 0 }: CenteredModalOptions = {},
): ModalRect {
  const top = Math.max(minTop, Math.floor((rows - height) / 2));
  const left = Math.max(minLeft, Math.floor((cols - width) / 2));
  return { top, left, width, height };
}

export function drawModalBoxAt(
  buf: ScreenBuffer,
  theme: Theme,
  top: number,
  left: number,
  width: number,
  lines: string[],
): number {
  const boxLines: string[] = drawBox(lines, width, theme.glyphs, theme);
  for (let i = 0; i < boxLines.length; i++) {
    buf.writeLine(top + i, left, boxLines[i]);
  }
  return boxLines.length;
}

export function renderCenteredModalBox(
  buf: ScreenBuffer,
  theme: Theme,
  rows: number,
  cols: number,
  width: number,
  lines: string[],
  opts: CenteredModalOptions = {},
): ModalRect {
  const height = lines.length + 2;
  const rect = getCenteredModalRect(rows, cols, width, height, opts);
  drawModalBoxAt(buf, theme, rect.top, rect.left, width, lines);
  return rect;
}

/**
 * Compute a centered scrolling window for list-like UIs.
 * Returns { start, end } where end is exclusive.
 */
export function getWindowedListRange(
  count: number,
  cursor: number,
  windowSize: number,
): WindowedListRange {
  const total = Math.max(0, Number(count) || 0);
  const size = Math.max(0, Number(windowSize) || 0);
  if (total === 0 || size === 0) return { start: 0, end: 0 };
  if (total <= size) return { start: 0, end: total };

  const cur = Math.max(0, Math.min(total - 1, Number(cursor) || 0));
  let start = Math.max(0, cur - Math.floor(size / 2));
  start = Math.min(start, total - size);
  return { start, end: Math.min(total, start + size) };
}
