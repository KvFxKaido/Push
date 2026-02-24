/**
 * tui-renderer.mjs — Terminal rendering primitives for Push TUI.
 * Zero dependencies. Handles alternate screen, cursor, box drawing,
 * text wrapping, and throttled batched writes.
 */

// ── ANSI escape helpers ─────────────────────────────────────────────

export const ESC = {
  altScreenOn:    '\x1b[?1049h',
  altScreenOff:   '\x1b[?1049l',
  cursorHide:     '\x1b[?25l',
  cursorShow:     '\x1b[?25h',
  cursorTo:       (row, col) => `\x1b[${row};${col}H`,
  clearScreen:    '\x1b[2J',
  clearLine:      '\x1b[2K',
  clearToEnd:     '\x1b[0J',
  reset:          '\x1b[0m',
  // Mouse tracking (not used in Phase 1 but reserved)
  mouseOn:        '\x1b[?1000h',
  mouseOff:       '\x1b[?1000l',
  // Bracketed paste mode
  bracketedPasteOn:  '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
};

// ── Terminal size ───────────────────────────────────────────────────

export function getTermSize() {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

// ── Text utilities ──────────────────────────────────────────────────

/** Strip ANSI escape sequences from a string (for width calculation). */
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Get terminal display width of a single Unicode codepoint.
 * Returns 2 for fullwidth/CJK, 0 for combining marks, 1 for everything else.
 */
export function charWidth(cp) {
  // Combining marks (zero width)
  if ((cp >= 0x0300 && cp <= 0x036F) ||   // Combining Diacritical Marks
      (cp >= 0x1AB0 && cp <= 0x1AFF) ||   // Combining Diacritical Marks Extended
      (cp >= 0x1DC0 && cp <= 0x1DFF) ||   // Combining Diacritical Marks Supplement
      (cp >= 0x20D0 && cp <= 0x20FF) ||   // Combining Diacritical Marks for Symbols
      (cp >= 0xFE00 && cp <= 0xFE0F) ||   // Variation Selectors
      (cp >= 0xFE20 && cp <= 0xFE2F) ||   // Combining Half Marks
      (cp >= 0xE0100 && cp <= 0xE01EF)) { // Variation Selectors Supplement
    return 0;
  }
  // Fullwidth and wide characters (width 2)
  if ((cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK Radicals, Kangxi, CJK Symbols
      (cp >= 0x3041 && cp <= 0x33BF) ||   // Hiragana, Katakana, Bopomofo, CJK Compat
      (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Unified Ext A
      (cp >= 0x4E00 && cp <= 0xA4CF) ||   // CJK Unified, Yi Syllables/Radicals
      (cp >= 0xA960 && cp <= 0xA97C) ||   // Hangul Jamo Extended-A
      (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
      (cp >= 0xFE30 && cp <= 0xFE6F) ||   // CJK Compatibility Forms + Small Forms
      (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth ASCII variants
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth signs
      (cp >= 0x1F300 && cp <= 0x1F9FF) || // Misc Symbols & Pictographs, Emoticons, etc.
      (cp >= 0x20000 && cp <= 0x2FA1F)) { // CJK Ext B-F, CJK Compat Ideographs Supp
    return 2;
  }
  return 1;
}

/** Get visible width of a string (excluding ANSI escapes, CJK-aware). */
export function visibleWidth(str) {
  const stripped = stripAnsi(str);
  let w = 0;
  for (const ch of stripped) {
    w += charWidth(ch.codePointAt(0));
  }
  return w;
}

/** Truncate a string to maxWidth visible columns, adding ellipsis if needed. */
export function truncate(str, maxWidth, ellipsis = '…') {
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
    const w = charWidth(ch.codePointAt(0));
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
export function wordWrap(text, maxWidth) {
  if (maxWidth <= 0) return [''];
  const inputLines = text.split('\n');
  const result = [];

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
            const cw = charWidth(ch.codePointAt(0));
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
            const cw = charWidth(ch.codePointAt(0));
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
export function padTo(str, width, align = 'left') {
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

/**
 * Draw a bordered box. Returns array of strings (one per row).
 * @param {string[]} contentLines - Lines to display inside the box
 * @param {number} width - Total width including borders
 * @param {object} glyphs - Glyph set from theme
 * @param {object} theme - Theme for coloring borders
 */
export function drawBox(contentLines, width, glyphs, theme) {
  const innerWidth = width - 2; // subtract border chars
  const borderColor = (s) => theme.style('border.default', s);

  const topBorder = borderColor(
    glyphs.topLeft + glyphs.horizontal.repeat(innerWidth) + glyphs.topRight
  );
  const bottomBorder = borderColor(
    glyphs.bottomLeft + glyphs.horizontal.repeat(innerWidth) + glyphs.bottomRight
  );

  const rows = [topBorder];
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
export function drawDivider(width, glyphs, theme) {
  return theme.style('border.default', glyphs.horizontal.repeat(width));
}

// ── Screen buffer ───────────────────────────────────────────────────

/**
 * Create a screen buffer that collects writes and flushes them in one batch.
 * This minimizes flicker by writing to stdout in a single call per frame.
 */
export function createScreenBuffer() {
  let buf = '';

  function moveTo(row, col) {
    buf += ESC.cursorTo(row, col);
  }

  function write(text) {
    buf += text;
  }

  function writeLine(row, col, text) {
    buf += ESC.cursorTo(row, col) + text;
  }

  /** Write text at position, clearing the rest of the line. */
  function writeFullLine(row, col, text, totalWidth) {
    const w = visibleWidth(text);
    const pad = totalWidth - col - w + 1;
    buf += ESC.cursorTo(row, col) + text + (pad > 0 ? ' '.repeat(pad) : '');
  }

  /** Clear a rectangular region (row-by-row). */
  function clearRegion(startRow, startCol, height, width) {
    const blank = ' '.repeat(width);
    for (let r = 0; r < height; r++) {
      buf += ESC.cursorTo(startRow + r, startCol) + blank;
    }
  }

  function flush() {
    if (buf) {
      process.stdout.write(buf);
      buf = '';
    }
  }

  function clear() {
    buf = '';
  }

  return { moveTo, write, writeLine, writeFullLine, clearRegion, flush, clear };
}

// ── Render scheduler (throttled) ────────────────────────────────────

const FRAME_MS = 16; // ~60 FPS

/**
 * Create a throttled render scheduler.
 * Calls renderFn at most once per FRAME_MS.
 */
export function createRenderScheduler(renderFn) {
  let pending = false;
  let timer = null;
  let lastRender = 0;

  function schedule() {
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
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
    lastRender = Date.now();
    renderFn();
  }

  function destroy() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  }

  return { schedule, flush, destroy };
}

// ── Layout computation ──────────────────────────────────────────────

/**
 * Compute pane regions given terminal size and state.
 * Returns { header, transcript, toolPane, composer, footer } with
 * { top, left, width, height } for each.
 */
export function computeLayout(rows, cols, { toolPaneOpen = false, composerLines = 1 } = {}) {
  const outerMarginRow = 1;
  const outerMarginCol = 2;

  const innerWidth = cols - (outerMarginCol * 2);
  const innerLeft = outerMarginCol + 1; // 1-indexed for ANSI

  const headerHeight = 4;   // product line, model, directory, hint
  const footerHeight = 2;   // status bar + keybind hints
  const composerHeight = Math.max(3, Math.min(7, composerLines + 2)); // +2 for border

  const headerTop = outerMarginRow + 1; // 1-indexed
  const footerTop = rows - outerMarginRow - footerHeight + 1;
  const composerTop = footerTop - composerHeight;

  const transcriptTop = headerTop + headerHeight + 1; // +1 gap
  const transcriptHeight = composerTop - transcriptTop - 1; // -1 gap

  let transcriptWidth, toolPaneWidth, toolPaneLeft;
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
    toolPane: toolPaneOpen ? {
      top: transcriptTop,
      left: toolPaneLeft,
      width: toolPaneWidth,
      height: Math.max(1, transcriptHeight),
    } : null,
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
