/**
 * tui-selection.ts — Pure helpers for app-owned transcript mouse selection.
 *
 * The TUI can run in either native terminal-selection mode or app mouse mode.
 * In app mode the terminal sends mouse events to Push, so Push must map
 * terminal coordinates back to visible transcript text and copy the selected
 * span itself.
 */

import { stripAnsi, visibleWidth } from './tui-renderer.js';

export type TuiMouseMode = 'native' | 'app';

export interface TranscriptMouseSnapshot {
  top: number;
  left: number;
  width: number;
  height: number;
  startLine: number;
  lines: readonly string[];
}

export interface TranscriptSelectionPoint {
  line: number;
  col: number;
}

export interface TranscriptSelection {
  anchor: TranscriptSelectionPoint;
  focus: TranscriptSelectionPoint;
}

export function freezeTranscriptMouseSnapshot(
  snapshot: TranscriptMouseSnapshot | null | undefined,
): TranscriptMouseSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    lines: [...snapshot.lines],
  };
}

export function resolveTuiMouseMode(
  value: unknown,
  fallback: TuiMouseMode = 'native',
): TuiMouseMode {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['app', 'mouse', 'on', 'true', '1'].includes(normalized)) return 'app';
  if (['native', 'terminal', 'off', 'false', '0'].includes(normalized)) return 'native';
  return fallback;
}

export function normalizeSelection(selection: TranscriptSelection): {
  start: TranscriptSelectionPoint;
  end: TranscriptSelectionPoint;
} {
  const { anchor, focus } = selection;
  if (anchor.line < focus.line || (anchor.line === focus.line && anchor.col <= focus.col)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

export function pointFromMouse(
  snapshot: TranscriptMouseSnapshot | null | undefined,
  x: number,
  y: number,
  opts: { clamp?: boolean } = {},
): TranscriptSelectionPoint | null {
  if (!snapshot) return null;
  const clamp = opts.clamp === true;

  let row = y - snapshot.top;
  let col = x - snapshot.left;

  if (clamp) {
    row = Math.max(0, Math.min(snapshot.height - 1, row));
    col = Math.max(0, Math.min(snapshot.width, col));
  } else if (row < 0 || row >= snapshot.height || col < 0 || col > snapshot.width) {
    return null;
  }

  const line = stripAnsi(snapshot.lines[row] ?? '');
  const lineWidth = visibleWidth(line);
  return {
    line: snapshot.startLine + row,
    col: Math.max(0, Math.min(lineWidth, col)),
  };
}

function stringIndexAtVisibleColumn(text: string, col: number): number {
  if (col <= 0) return 0;

  let visible = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    const len = ch.length;
    const w = Math.max(0, visibleWidth(ch));
    if (visible + w > col) return i;
    visible += w;
    i += len;
  }
  return text.length;
}

function stringIndexAfterVisibleColumn(text: string, col: number): number {
  if (col < 0) return 0;

  let visible = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    const len = ch.length;
    const w = Math.max(0, visibleWidth(ch));
    if (visible + w > col) return i + len;
    visible += w;
    i += len;
  }
  return text.length;
}

function ansiSequenceAt(text: string, index: number): string | null {
  if (text.charCodeAt(index) !== 0x1b) return null;
  const match = /^\x1b\[[0-9;]*[a-zA-Z]/.exec(text.slice(index));
  return match?.[0] ?? null;
}

function rawStringIndexAtVisibleColumn(text: string, col: number): number {
  if (col <= 0) return 0;

  let visible = 0;
  for (let i = 0; i < text.length; ) {
    const ansi = ansiSequenceAt(text, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }

    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    const len = ch.length;
    const w = Math.max(0, visibleWidth(ch));
    if (visible + w > col) return i;
    visible += w;
    i += len;
  }
  return text.length;
}

function rawStringIndexAfterVisibleColumn(text: string, col: number): number {
  if (col < 0) return 0;

  let visible = 0;
  for (let i = 0; i < text.length; ) {
    const ansi = ansiSequenceAt(text, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }

    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    const len = ch.length;
    const w = Math.max(0, visibleWidth(ch));
    if (visible + w > col) return i + len;
    visible += w;
    i += len;
  }
  return text.length;
}

function highlightAnsiVisibleText(text: string, highlight: (text: string) => string): string {
  let out = '';
  let visibleRun = '';

  for (let i = 0; i < text.length; ) {
    const ansi = ansiSequenceAt(text, i);
    if (ansi) {
      if (visibleRun) {
        out += highlight(visibleRun);
        visibleRun = '';
      }
      out += ansi;
      i += ansi.length;
      continue;
    }

    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    visibleRun += ch;
    i += ch.length;
  }

  if (visibleRun) out += highlight(visibleRun);
  return out;
}

function lineSegment(text: string, startCol: number, endCol: number): string {
  const start = stringIndexAtVisibleColumn(text, startCol);
  const end = stringIndexAfterVisibleColumn(text, endCol);
  return end > start ? text.slice(start, end) : '';
}

export function extractSelectedTranscriptText(
  snapshot: Pick<TranscriptMouseSnapshot, 'startLine' | 'lines'>,
  selection: TranscriptSelection,
): string {
  const { start, end } = normalizeSelection(selection);
  if (start.line === end.line && start.col === end.col) return '';

  const firstVisible = snapshot.startLine;
  const lastVisible = snapshot.startLine + snapshot.lines.length - 1;
  const firstLine = Math.max(start.line, firstVisible);
  const lastLine = Math.min(end.line, lastVisible);
  if (firstLine > lastLine) return '';

  const out: string[] = [];
  for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
    const text = stripAnsi(snapshot.lines[lineNo - snapshot.startLine] ?? '');
    const startCol = lineNo === start.line ? start.col : 0;
    const endCol = lineNo === end.line ? end.col : visibleWidth(text);
    out.push(lineSegment(text, startCol, endCol));
  }
  return out.join('\n');
}

export function highlightSelectedTranscriptLine(
  line: string,
  absoluteLine: number,
  selection: TranscriptSelection | null | undefined,
  highlight: (text: string) => string,
): string {
  if (!selection) return line;

  const { start, end } = normalizeSelection(selection);
  if (absoluteLine < start.line || absoluteLine > end.line) return line;
  if (start.line === end.line && start.col === end.col) return line;

  const plain = stripAnsi(line);
  const startCol = absoluteLine === start.line ? start.col : 0;
  const endCol = absoluteLine === end.line ? end.col : visibleWidth(plain);
  const startIdx = rawStringIndexAtVisibleColumn(line, startCol);
  const endIdx = rawStringIndexAfterVisibleColumn(line, endCol);
  if (endIdx <= startIdx) return line;

  return (
    line.slice(0, startIdx) +
    highlightAnsiVisibleText(line.slice(startIdx, endIdx), highlight) +
    line.slice(endIdx)
  );
}
