/**
 * tui-renderer.ts — Terminal rendering primitives for Push TUI.
 * Zero dependencies. Handles alternate screen, cursor, box drawing,
 * text wrapping, and throttled batched writes.
 */
import type { Theme } from './tui-theme.js';

// ── ANSI escape helpers ─────────────────────────────────────────────

export const ESC = {
  altScreenOn: '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  cursorTo: (row: number, col: number): string => `\x1b[${row};${col}H`,
  clearScreen: '\x1b[2J',
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[0J',
  reset: '\x1b[0m',
  // Mouse tracking + SGR coordinates for wheel scroll in alternate screen.
  mouseOn: '\x1b[?1000h\x1b[?1006h',
  mouseOff: '\x1b[?1006l\x1b[?1000l',
  // Bracketed paste mode
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
};

/**
 * Build an OSC 52 escape that pushes `text` to the terminal's system clipboard.
 * `c` selects the clipboard buffer; BEL (\x07) terminator is the most broadly
 * compatible (tmux/kitty/iTerm/Windows Terminal all accept it).
 * Support depends on the terminal — no way to probe success from here.
 */
export function osc52Copy(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${b64}\x07`;
}

// ── Terminal size ───────────────────────────────────────────────────

export interface TermSize {
  rows: number;
  cols: number;
}

export function getTermSize(): TermSize {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

// ── Text utilities ──────────────────────────────────────────────────

/** Strip ANSI escape sequences from a string (for width calculation). */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Get terminal display width of a single Unicode codepoint.
 * Returns 2 for fullwidth/CJK, 0 for combining marks, 1 for everything else.
 */
export function charWidth(cp: number): number {
  // Combining marks (zero width)
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // Variation Selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) || // Combining Half Marks
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    // Variation Selectors Supplement
    return 0;
  }
  // Fullwidth and wide characters (width 2)
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Kangxi, CJK Symbols
    (cp >= 0x3041 && cp <= 0x33bf) || // Hiragana, Katakana, Bopomofo, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ext A
    (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK Unified, Yi Syllables/Radicals
    (cp >= 0xa960 && cp <= 0xa97c) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms + Small Forms
    (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth ASCII variants
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // Misc Symbols & Pictographs, Emoticons, etc.
    (cp >= 0x20000 && cp <= 0x2fa1f)
  ) {
    // CJK Ext B-F, CJK Compat Ideographs Supp
    return 2;
  }
  return 1;
}

/** Get visible width of a string (excluding ANSI escapes, CJK-aware). */
export function visibleWidth(str: string): number {
  const stripped = stripAnsi(str);
  let w = 0;
  for (const ch of stripped) {
    w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}

/** Truncate a string to maxWidth visible columns, adding ellipsis if needed. */
export function truncate(str: string, maxWidth: number, ellipsis: string = '…'): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(str) <= maxWidth) return str;

  // Walk through original string, tracking visible columns (CJK-aware)
  let visible = 0;
  let result = '';
  const ellW = visibleWidth(ellipsis);
  const target = maxWidth - ellW;
  let inEsc = false;

  for (const ch of str) {
    if (ch === '\x1b') {
      inEsc = true;
      result += ch;
      continue;
    }
    if (inEsc) {
      result += ch;
      if (/[a-zA-Z]/.test(ch)) inEsc = false;
      continue;
    }
    const w = charWidth(ch.codePointAt(0)!);
    if (visible + w > target) break;
    result += ch;
    visible += w;
  }

  return result + '\x1b[0m' + ellipsis;
}

/**
 * Word-wrap text to fit within maxWidth columns.
 * Preserves existing newlines. Returns array of lines.
 * Handles ANSI escapes correctly (they don't count toward width).
 */
export function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [''];
  const inputLines = text.split('\n');
  const result: string[] = [];

  for (const inputLine of inputLines) {
    if (visibleWidth(inputLine) <= maxWidth) {
      result.push(inputLine);
      continue;
    }

    // Simple greedy word-wrap (breaks at spaces)
    const words = inputLine.split(' ');
    let current = '';
    let currentWidth = 0;

    for (const word of words) {
      const wWidth = visibleWidth(word);
      if (currentWidth === 0) {
        // First word on line — accept it even if too long
        if (wWidth > maxWidth) {
          // Hard break long word (CJK-aware)
          const stripped = stripAnsi(word);
          let chunk = '';
          let chunkW = 0;
          for (const ch of stripped) {
            const cw = charWidth(ch.codePointAt(0)!);
            if (chunkW + cw > maxWidth && chunk) {
              result.push(chunk);
              chunk = '';
              chunkW = 0;
            }
            chunk += ch;
            chunkW += cw;
          }
          if (chunk) result.push(chunk);
          current = '';
          currentWidth = 0;
        } else {
          current = word;
          currentWidth = wWidth;
        }
      } else if (currentWidth + 1 + wWidth <= maxWidth) {
        current += ' ' + word;
        currentWidth += 1 + wWidth;
      } else {
        result.push(current);
        if (wWidth > maxWidth) {
          const stripped = stripAnsi(word);
          let chunk = '';
          let chunkW = 0;
          for (const ch of stripped) {
            const cw = charWidth(ch.codePointAt(0)!);
            if (chunkW + cw > maxWidth && chunk) {
              result.push(chunk);
              chunk = '';
              chunkW = 0;
            }
            chunk += ch;
            chunkW += cw;
          }
          if (chunk) result.push(chunk);
          current = '';
          currentWidth = 0;
        } else {
          current = word;
          currentWidth = wWidth;
        }
      }
    }
    if (current || currentWidth === 0) {
      result.push(current);
    }
  }

  return result;
}

/**
 * Pad or truncate a string to exactly `width` visible characters.
 * Useful for rendering fixed-width cells.
 */
export function padTo(
  str: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  const w = visibleWidth(str);
  if (w >= width) return truncate(str, width);
  const pad = ' '.repeat(width - w);
  if (align === 'right') return pad + str;
  if (align === 'center') {
    const left = Math.floor((width - w) / 2);
    const right = width - w - left;
    return ' '.repeat(left) + str + ' '.repeat(right);
  }
  return str + pad;
}

// ── Box drawing ─────────────────────────────────────────────────────

export interface BoxGlyphs {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

export type { Theme } from './tui-theme.js';

/**
 * Draw a bordered box. Returns array of strings (one per row).
 * @param contentLines - Lines to display inside the box
 * @param width - Total width including borders
 * @param glyphs - Glyph set from theme
 * @param theme - Theme for coloring borders
 */
export function drawBox(
  contentLines: string[],
  width: number,
  glyphs: BoxGlyphs,
  theme: Theme,
): string[] {
  const innerWidth = width - 2; // subtract border chars
  const borderColor = (s: string): string => theme.style('border.default', s);

  const topBorder = borderColor(
    glyphs.topLeft + glyphs.horizontal.repeat(innerWidth) + glyphs.topRight,
  );
  const bottomBorder = borderColor(
    glyphs.bottomLeft + glyphs.horizontal.repeat(innerWidth) + glyphs.bottomRight,
  );

  const rows: string[] = [topBorder];
  for (const line of contentLines) {
    const padded = padTo(line, innerWidth);
    rows.push(borderColor(glyphs.vertical) + padded + borderColor(glyphs.vertical));
  }
  rows.push(bottomBorder);
  return rows;
}

/**
 * Draw a horizontal divider line.
 */
export function drawDivider(width: number, glyphs: BoxGlyphs, theme: Theme): string {
  return theme.style('border.default', glyphs.horizontal.repeat(width));
}

// ── Screen buffer ───────────────────────────────────────────────────

export interface ScreenBuffer {
  moveTo: (row: number, col: number) => void;
  write: (text: string) => void;
  writeLine: (row: number, col: number, text: string) => void;
  writeFullLine: (row: number, col: number, text: string, totalWidth: number) => void;
  clearRegion: (startRow: number, startCol: number, height: number, width: number) => void;
  flush: () => void;
  clear: () => void;
}

type LineEntry = { row: number; col: number; text: string };
type Op = { kind: 'raw'; text: string } | ({ kind: 'line' } & LineEntry);

/**
 * Create a screen buffer that diffs each frame's line-positioned writes
 * against the previously flushed frame. On flush, only changed lines emit
 * cursor-positioning + text; unchanged lines are skipped, and lines that
 * existed in the previous frame but not the current are blanked.
 *
 * Raw writes (cursor positioning, SGR resets, clearScreen, theme.bg) are
 * passed through in order. A clearScreen escape forces a full re-emit
 * regardless of diff state, since the terminal is wiped.
 *
 * The public API is unchanged from the prior string-buffer implementation;
 * `clear()` drops pending ops without invalidating the previous-frame
 * baseline, so an aborted partial frame still produces correct diffs on
 * the next flush.
 */
export function createScreenBuffer(): ScreenBuffer {
  let ops: Op[] = [];
  let prevLines = new Map<string, LineEntry>();

  function moveTo(row: number, col: number): void {
    ops.push({ kind: 'raw', text: ESC.cursorTo(row, col) });
  }

  function write(text: string): void {
    ops.push({ kind: 'raw', text });
  }

  function writeLine(row: number, col: number, text: string): void {
    ops.push({ kind: 'line', row, col, text });
  }

  /** Write text at position, clearing the rest of the line. */
  function writeFullLine(row: number, col: number, text: string, totalWidth: number): void {
    const w = visibleWidth(text);
    const pad = totalWidth - col - w + 1;
    const padded = pad > 0 ? text + ' '.repeat(pad) : text;
    ops.push({ kind: 'line', row, col, text: padded });
  }

  /** Clear a rectangular region (row-by-row). */
  function clearRegion(startRow: number, startCol: number, height: number, width: number): void {
    const blank = ' '.repeat(width);
    for (let r = 0; r < height; r++) {
      ops.push({ kind: 'line', row: startRow + r, col: startCol, text: blank });
    }
  }

  function flush(): void {
    if (ops.length === 0) return;

    // A clearScreen anywhere in the frame forces every line to re-emit; the
    // terminal will be wiped, so prevLines is no longer a valid baseline.
    let forceFullFrame = false;
    for (const op of ops) {
      if (op.kind === 'raw' && op.text.includes('\x1b[2J')) {
        forceFullFrame = true;
        break;
      }
    }

    let out = '';
    const newLines = new Map<string, LineEntry>();

    for (const op of ops) {
      if (op.kind === 'raw') {
        out += op.text;
      } else {
        const key = `${op.row}|${op.col}`;
        const entry: LineEntry = { row: op.row, col: op.col, text: op.text };
        newLines.set(key, entry);
        const prev = prevLines.get(key);
        if (forceFullFrame || !prev || prev.text !== op.text) {
          out += ESC.cursorTo(op.row, op.col) + op.text;
        }
      }
    }

    // Blank lines that existed in the previous frame but are absent now,
    // unless we already wiped via clearScreen.
    if (!forceFullFrame) {
      for (const [key, prev] of prevLines) {
        if (!newLines.has(key)) {
          out += ESC.cursorTo(prev.row, prev.col) + ' '.repeat(visibleWidth(prev.text));
        }
      }
    }

    if (out) process.stdout.write(out);
    prevLines = newLines;
    ops = [];
  }

  function clear(): void {
    ops = [];
  }

  return { moveTo, write, writeLine, writeFullLine, clearRegion, flush, clear };
}

// ── Render scheduler (throttled) ────────────────────────────────────

const FRAME_MS = 16; // ~60 FPS

export interface RenderScheduler {
  schedule: () => void;
  flush: () => void;
  destroy: () => void;
}

/**
 * Create a throttled render scheduler.
 * Calls renderFn at most once per FRAME_MS.
 */
export function createRenderScheduler(renderFn: () => void): RenderScheduler {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRender = 0;

  function schedule(): void {
    if (pending) return;
    const now = Date.now();
    const elapsed = now - lastRender;

    if (elapsed >= FRAME_MS) {
      // Render immediately
      pending = false;
      lastRender = now;
      renderFn();
    } else {
      // Defer to next frame
      pending = true;
      timer = setTimeout(() => {
        pending = false;
        lastRender = Date.now();
        renderFn();
        timer = null;
      }, FRAME_MS - elapsed);
    }
  }

  /** Force an immediate render (bypass throttle). */
  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
    lastRender = Date.now();
    renderFn();
  }

  function destroy(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  }

  return { schedule, flush, destroy };
}

// ── Layout computation ──────────────────────────────────────────────

export interface PaneRegion {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface LayoutOptions {
  toolPaneOpen?: boolean;
  composerLines?: number;
}

export interface Layout {
  innerWidth: number;
  innerLeft: number;
  header: PaneRegion;
  transcript: PaneRegion;
  toolPane: PaneRegion | null;
  composer: PaneRegion;
  footer: PaneRegion;
}

/**
 * Compute pane regions given terminal size and state.
 * Returns { header, transcript, toolPane, composer, footer } with
 * { top, left, width, height } for each.
 */
export function computeLayout(
  rows: number,
  cols: number,
  { toolPaneOpen = false, composerLines = 1 }: LayoutOptions = {},
): Layout {
  const outerMarginRow = 1;
  const outerMarginCol = 2;

  const innerWidth = cols - outerMarginCol * 2;
  const innerLeft = outerMarginCol + 1; // 1-indexed for ANSI

  const headerHeight = 4; // product line, model, directory, hint
  const footerHeight = 2; // status bar + keybind hints
  const composerHeight = Math.max(3, Math.min(7, composerLines + 2)); // +2 for border

  const headerTop = outerMarginRow + 1; // 1-indexed
  const footerTop = rows - outerMarginRow - footerHeight + 1;
  const composerTop = footerTop - composerHeight;

  const transcriptTop = headerTop + headerHeight + 1; // +1 gap
  const transcriptHeight = composerTop - transcriptTop - 1; // -1 gap

  let transcriptWidth: number;
  let toolPaneWidth: number;
  let toolPaneLeft: number;
  if (toolPaneOpen) {
    toolPaneWidth = Math.floor(innerWidth * 0.37);
    transcriptWidth = innerWidth - toolPaneWidth - 1; // -1 for divider
    toolPaneLeft = innerLeft + transcriptWidth + 1;
  } else {
    transcriptWidth = innerWidth;
    toolPaneWidth = 0;
    toolPaneLeft = 0;
  }

  return {
    innerWidth,
    innerLeft,
    header: {
      top: headerTop,
      left: innerLeft,
      width: innerWidth,
      height: headerHeight,
    },
    transcript: {
      top: transcriptTop,
      left: innerLeft,
      width: transcriptWidth,
      height: Math.max(1, transcriptHeight),
    },
    toolPane: toolPaneOpen
      ? {
          top: transcriptTop,
          left: toolPaneLeft,
          width: toolPaneWidth,
          height: Math.max(1, transcriptHeight),
        }
      : null,
    composer: {
      top: composerTop,
      left: innerLeft,
      width: innerWidth,
      height: composerHeight,
    },
    footer: {
      top: footerTop,
      left: innerLeft,
      width: innerWidth,
      height: footerHeight,
    },
  };
}
