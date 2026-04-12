/**
 * tui-input.ts — Raw mode key handling and composer for Push TUI.
 * Zero dependencies. Parses terminal escape sequences into structured key events.
 */

// ── Key sequence parsing ────────────────────────────────────────────

function codePointCharLength(str: string, index: number): number {
  const cp = str.codePointAt(index);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

function readEscapeSequence(str: string, start: number): string | null {
  if (str[start] !== '\x1b') return null;
  const rest = str.slice(start);

  // SGR mouse reporting: ESC [ < button ; x ; y M/m
  const sgrMouseMatch = rest.match(/^\x1b\[<\d+;\d+;\d+[mM]/);
  if (sgrMouseMatch) return sgrMouseMatch[0];

  // Legacy xterm mouse reporting: ESC [ M Cb Cx Cy
  if (rest.startsWith('\x1b[M')) {
    if (rest.length >= 6) return rest.slice(0, 6);
    return null;
  }

  // CSI sequence: ESC [ ... final-byte
  // We split on any complete CSI final byte, even if parseKey() later classifies
  // it as unknown. This keeps concatenated sequences tokenized correctly.
  const csiMatch = rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
  if (csiMatch) return csiMatch[0];

  // SS3 sequence: ESC O X
  if (rest.startsWith('\x1bO')) {
    if (rest.length >= 3) return rest.slice(0, 3);
    return null; // incomplete
  }

  // Alt/meta + next code point (same ambiguity as parseKey on ESC-prefixed input).
  if (rest.length >= 2) {
    const len = codePointCharLength(rest, 1);
    if (rest.length >= 1 + len) return rest.slice(0, 1 + len);
  }

  // Lone ESC (e.g. user pressed Escape)
  return '\x1b';
}

/**
 * Split a raw stdin chunk into key-sized string units when it is safe to do so.
 *
 * This handles:
 * - multi-char printable chunks from automation layers (e.g. terminal-mcp `type`)
 * - concatenated escape sequences in one write (e.g. two arrows)
 *
 * Incomplete CSI/SS3 sequences are left intact as a single chunk.
 */
export function splitRawInputChunk(str: string): string[] {
  if (!str) return [];

  const out: string[] = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const esc = readEscapeSequence(str, i);
      if (!esc) {
        // Incomplete escape sequence at end of chunk; keep it intact.
        out.push(str.slice(i));
        break;
      }
      out.push(esc);
      i += esc.length;
      continue;
    }

    const len = codePointCharLength(str, i);
    out.push(str.slice(i, i + len));
    i += len;
  }

  return out;
}

// ── Parsed key structure ────────────────────────────────────────────

export interface ParsedKey {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
  ch: string;
}

/**
 * Parse a raw stdin buffer into a structured key object.
 * Returns { name, ctrl, shift, meta, sequence, ch }
 */
export function parseKey(buf: Buffer): ParsedKey {
  const seq = buf.toString('utf8');
  const key: ParsedKey = {
    name: '',
    ctrl: false,
    shift: false,
    meta: false,
    sequence: seq,
    ch: '',
  };

  // Single byte
  if (buf.length === 1) {
    const code = buf[0];

    // Tab, Enter, Return — these are in the ctrl range (0x09, 0x0a, 0x0d)
    // but are functionally their own keys, not ctrl combos.
    if (code === 0x09) {
      key.name = 'tab';
      return key;
    }
    if (code === 0x0a) {
      key.name = 'return';
      return key;
    }
    if (code === 0x0d) {
      key.name = 'return';
      return key;
    }

    // Ctrl+A through Ctrl+Z (0x01–0x1a), excluding tab/enter above
    if (code >= 0x01 && code <= 0x1a) {
      key.ctrl = true;
      key.name = String.fromCharCode(code + 0x60); // a-z
      return key;
    }

    // Escape
    if (code === 0x1b) {
      key.name = 'escape';
      return key;
    }

    // Backspace (0x7f)
    if (code === 0x7f) {
      key.name = 'backspace';
      return key;
    }

    // Backspace alt (0x08)
    if (code === 0x08) {
      key.name = 'backspace';
      key.ctrl = true;
      return key;
    }

    // Regular printable character
    if (code >= 0x20 && code <= 0x7e) {
      key.name = seq;
      key.ch = seq;
      return key;
    }

    key.name = 'unknown';
    return key;
  }

  // Multi-byte: Meta (Alt) + char: ESC followed by single byte
  if (buf.length === 2 && buf[0] === 0x1b) {
    key.meta = true;
    const inner = parseKey(buf.slice(1));
    key.name = inner.name;
    key.ctrl = inner.ctrl;
    key.ch = inner.ch;
    return key;
  }

  // CSI sequences: ESC [ ...
  if (seq.startsWith('\x1b[')) {
    const body = seq.slice(2);

    // SGR mouse wheel: button bit 64 marks wheel, low bits encode direction.
    const sgrMouse = body.match(/^<(\d+);\d+;\d+([mM])$/);
    if (sgrMouse) {
      const button = Number(sgrMouse[1]);
      const action = sgrMouse[2];
      if (action === 'M' && (button & 64) === 64) {
        const direction = button & 3;
        if (direction === 0) {
          key.name = 'wheelup';
          return key;
        }
        if (direction === 1) {
          key.name = 'wheeldown';
          return key;
        }
      }
      key.name = 'mouse';
      return key;
    }

    // Legacy xterm mouse reporting: ESC [ M Cb Cx Cy
    if (seq.startsWith('\x1b[M') && buf.length >= 6) {
      const button = seq.charCodeAt(3) - 32;
      if ((button & 64) === 64) {
        const direction = button & 3;
        if (direction === 0) {
          key.name = 'wheelup';
          return key;
        }
        if (direction === 1) {
          key.name = 'wheeldown';
          return key;
        }
      }
      key.name = 'mouse';
      return key;
    }

    // Arrow keys
    if (body === 'A') {
      key.name = 'up';
      return key;
    }
    if (body === 'B') {
      key.name = 'down';
      return key;
    }
    if (body === 'C') {
      key.name = 'right';
      return key;
    }
    if (body === 'D') {
      key.name = 'left';
      return key;
    }

    // Home / End
    if (body === 'H') {
      key.name = 'home';
      return key;
    }
    if (body === 'F') {
      key.name = 'end';
      return key;
    }
    if (body === '1~') {
      key.name = 'home';
      return key;
    }
    if (body === '4~') {
      key.name = 'end';
      return key;
    }

    // Page Up / Down
    if (body === '5~') {
      key.name = 'pageup';
      return key;
    }
    if (body === '6~') {
      key.name = 'pagedown';
      return key;
    }

    // Delete
    if (body === '3~') {
      key.name = 'delete';
      return key;
    }

    // Insert
    if (body === '2~') {
      key.name = 'insert';
      return key;
    }

    // Shift+Arrow
    if (body === '1;2A') {
      key.name = 'up';
      key.shift = true;
      return key;
    }
    if (body === '1;2B') {
      key.name = 'down';
      key.shift = true;
      return key;
    }
    if (body === '1;2C') {
      key.name = 'right';
      key.shift = true;
      return key;
    }
    if (body === '1;2D') {
      key.name = 'left';
      key.shift = true;
      return key;
    }

    // Ctrl+Arrow
    if (body === '1;5A') {
      key.name = 'up';
      key.ctrl = true;
      return key;
    }
    if (body === '1;5B') {
      key.name = 'down';
      key.ctrl = true;
      return key;
    }
    if (body === '1;5C') {
      key.name = 'right';
      key.ctrl = true;
      return key;
    }
    if (body === '1;5D') {
      key.name = 'left';
      key.ctrl = true;
      return key;
    }

    // Shift+Tab (backtab): ESC[Z
    if (body === 'Z') {
      key.name = 'tab';
      key.shift = true;
      return key;
    }

    // Kitty keyboard protocol: Shift+Enter = ESC[13;2u
    if (body === '13;2u') {
      key.name = 'return';
      key.shift = true;
      return key;
    }

    key.name = 'unknown';
    return key;
  }

  // SS3 sequences: ESC O ...  (some terminals use this for arrows)
  if (seq.startsWith('\x1bO')) {
    const ch = seq[2];
    if (ch === 'A') {
      key.name = 'up';
      return key;
    }
    if (ch === 'B') {
      key.name = 'down';
      return key;
    }
    if (ch === 'C') {
      key.name = 'right';
      return key;
    }
    if (ch === 'D') {
      key.name = 'left';
      return key;
    }
    if (ch === 'H') {
      key.name = 'home';
      return key;
    }
    if (ch === 'F') {
      key.name = 'end';
      return key;
    }
  }

  // Multi-byte UTF-8 character
  if (buf[0] >= 0x80) {
    key.name = seq;
    key.ch = seq;
    return key;
  }

  key.name = 'unknown';
  return key;
}

// ── Keybind registry ────────────────────────────────────────────────

export interface KeybindMap {
  bind: (combo: string, action: string) => void;
  lookup: (key: ParsedKey) => string | null;
  serializeKey: (key: ParsedKey) => string;
}

/**
 * Create a keybind manager. Maps key combos to action names.
 */
export function createKeybindMap(): KeybindMap {
  // Internal storage: Map<string, string> where key = serialized combo, value = action name
  const bindings = new Map<string, string>();

  function serializeKey(key: ParsedKey): string {
    const parts: string[] = [];
    if (key.ctrl) parts.push('C');
    if (key.meta) parts.push('M');
    if (key.shift) parts.push('S');
    parts.push(key.name);
    return parts.join('-');
  }

  function bind(combo: string, action: string): void {
    bindings.set(combo, action);
  }

  function lookup(key: ParsedKey): string | null {
    return bindings.get(serializeKey(key)) || null;
  }

  // Phase 1 default bindings
  bind('return', 'send');
  bind('S-return', 'newline'); // Shift+Enter (kitty protocol)
  bind('M-return', 'newline'); // Alt+Enter (universal fallback)
  bind('C-c', 'cancel_or_exit');
  bind('C-t', 'toggle_tools');
  bind('C-o', 'toggle_tool_json_payloads');
  bind('C-g', 'toggle_reasoning');
  bind('C-l', 'clear_viewport');
  bind('C-r', 'reattach');
  bind('C-y', 'approve');
  bind('C-n', 'deny');
  bind('C-p', 'provider_switcher');
  bind('escape', 'close_modal');

  // Composer editing (Emacs-style)
  bind('C-a', 'line_start');
  bind('C-e', 'line_end');
  bind('C-u', 'kill_line_backward');
  bind('C-k', 'kill_line_forward');
  bind('C-w', 'kill_word_backward');
  bind('C-d', 'delete_or_exit');

  // Word navigation
  bind('C-left', 'word_left');
  bind('C-right', 'word_right');

  // Scrollback
  bind('pageup', 'scroll_up');
  bind('pagedown', 'scroll_down');
  bind('wheelup', 'scroll_up');
  bind('wheeldown', 'scroll_down');

  return { bind, lookup, serializeKey };
}

// ── Input history ───────────────────────────────────────────────────

export interface InputHistory {
  push: (text: string) => void;
  up: (currentText: string) => string | null;
  down: (currentText: string) => string | null;
  reset: () => void;
  isNavigating: () => boolean;
}

/**
 * Create an input history ring.
 * Remembers past inputs and supports up/down recall with stashed current text.
 */
export function createInputHistory(maxSize: number = 100): InputHistory {
  const entries: string[] = [];
  let index = -1; // -1 = not navigating
  let stashedText = ''; // current text saved on first Up

  /** Add an entry (dedup consecutive, cap at maxSize). */
  function push(text: string): void {
    if (!text) return;
    if (entries.length > 0 && entries[entries.length - 1] === text) return;
    entries.push(text);
    if (entries.length > maxSize) entries.shift();
  }

  /** Navigate up (older). Returns recalled text or null. */
  function up(currentText: string): string | null {
    if (entries.length === 0) return null;
    if (index === -1) {
      // First up: stash current text, start at newest
      stashedText = currentText;
      index = entries.length - 1;
    } else if (index > 0) {
      index--;
    } else {
      return null; // already at oldest
    }
    return entries[index];
  }

  /** Navigate down (newer). Returns recalled text, stashed text, or null. */
  function down(_currentText: string): string | null {
    if (index === -1) return null;
    if (index < entries.length - 1) {
      index++;
      return entries[index];
    }
    // Past newest → restore stashed
    index = -1;
    return stashedText;
  }

  /** Reset navigation state (call after sending). */
  function reset(): void {
    index = -1;
    stashedText = '';
  }

  /** Are we currently navigating history? */
  function isNavigating(): boolean {
    return index !== -1;
  }

  return { push, up, down, reset, isNavigating };
}

// ── Composer (multi-line text editor) ───────────────────────────────

export interface CursorPosition {
  line: number;
  col: number;
}

export interface Composer {
  getText: () => string;
  getLines: () => string[];
  getCursor: () => CursorPosition;
  clear: () => void;
  insertChar: (ch: string) => void;
  insertNewline: () => void;
  backspace: () => void;
  deleteForward: () => void;
  moveLeft: () => void;
  moveRight: () => void;
  moveUp: () => void;
  moveDown: () => void;
  moveHome: () => void;
  moveEnd: () => void;
  moveWordLeft: () => void;
  moveWordRight: () => void;
  killLineBackward: () => string;
  killLineForward: () => string;
  killWordBackward: () => string;
  insertText: (text: string) => void;
  setText: (text: string) => void;
  isEmpty: () => boolean;
}

/**
 * Create a composer state machine for text editing.
 * Lines are stored as an array of strings. Cursor tracks { line, col }.
 */
export function createComposer(): Composer {
  let lines: string[] = [''];
  let cursor: CursorPosition = { line: 0, col: 0 };

  function getText(): string {
    return lines.join('\n');
  }

  function getLines(): string[] {
    return lines;
  }

  function getCursor(): CursorPosition {
    return { ...cursor };
  }

  function clear(): void {
    lines = [''];
    cursor = { line: 0, col: 0 };
  }

  function insertChar(ch: string): void {
    const line = lines[cursor.line];
    lines[cursor.line] = line.slice(0, cursor.col) + ch + line.slice(cursor.col);
    cursor.col += ch.length;
  }

  function insertNewline(): void {
    const line = lines[cursor.line];
    const before = line.slice(0, cursor.col);
    const after = line.slice(cursor.col);
    lines[cursor.line] = before;
    lines.splice(cursor.line + 1, 0, after);
    cursor.line += 1;
    cursor.col = 0;
  }

  function backspace(): void {
    if (cursor.col > 0) {
      const line = lines[cursor.line];
      lines[cursor.line] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
      cursor.col -= 1;
    } else if (cursor.line > 0) {
      // Merge with previous line
      const prevLen = lines[cursor.line - 1].length;
      lines[cursor.line - 1] += lines[cursor.line];
      lines.splice(cursor.line, 1);
      cursor.line -= 1;
      cursor.col = prevLen;
    }
  }

  function deleteForward(): void {
    const line = lines[cursor.line];
    if (cursor.col < line.length) {
      lines[cursor.line] = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
    } else if (cursor.line < lines.length - 1) {
      // Merge with next line
      lines[cursor.line] += lines[cursor.line + 1];
      lines.splice(cursor.line + 1, 1);
    }
  }

  function moveLeft(): void {
    if (cursor.col > 0) {
      cursor.col -= 1;
    } else if (cursor.line > 0) {
      cursor.line -= 1;
      cursor.col = lines[cursor.line].length;
    }
  }

  function moveRight(): void {
    const line = lines[cursor.line];
    if (cursor.col < line.length) {
      cursor.col += 1;
    } else if (cursor.line < lines.length - 1) {
      cursor.line += 1;
      cursor.col = 0;
    }
  }

  function moveUp(): void {
    if (cursor.line > 0) {
      cursor.line -= 1;
      cursor.col = Math.min(cursor.col, lines[cursor.line].length);
    }
  }

  function moveDown(): void {
    if (cursor.line < lines.length - 1) {
      cursor.line += 1;
      cursor.col = Math.min(cursor.col, lines[cursor.line].length);
    }
  }

  function moveHome(): void {
    cursor.col = 0;
  }

  function moveEnd(): void {
    cursor.col = lines[cursor.line].length;
  }

  /** Helper: is a character a "word" character (letter, digit, underscore). */
  function isWordChar(ch: string): boolean {
    return /[\w]/.test(ch);
  }

  /** Move cursor left by one word (skip non-word, then word chars). */
  function moveWordLeft(): void {
    // At start of line? Wrap to end of previous line
    if (cursor.col === 0 && cursor.line > 0) {
      cursor.line -= 1;
      cursor.col = lines[cursor.line].length;
      return;
    }
    const line = lines[cursor.line];
    let col = cursor.col;
    // Skip non-word characters (whitespace/punctuation) going left
    while (col > 0 && !isWordChar(line[col - 1])) col--;
    // Skip word characters going left
    while (col > 0 && isWordChar(line[col - 1])) col--;
    cursor.col = col;
  }

  /** Move cursor right by one word (skip word, then non-word chars). */
  function moveWordRight(): void {
    const line = lines[cursor.line];
    // At end of line? Wrap to start of next line
    if (cursor.col >= line.length && cursor.line < lines.length - 1) {
      cursor.line += 1;
      cursor.col = 0;
      return;
    }
    let col = cursor.col;
    // Skip word characters going right
    while (col < line.length && isWordChar(line[col])) col++;
    // Skip non-word characters going right
    while (col < line.length && !isWordChar(line[col])) col++;
    cursor.col = col;
  }

  /** Delete from cursor to start of current line. Returns killed text. */
  function killLineBackward(): string {
    const line = lines[cursor.line];
    const killed = line.slice(0, cursor.col);
    lines[cursor.line] = line.slice(cursor.col);
    cursor.col = 0;
    return killed;
  }

  /** Delete from cursor to end of current line. Returns killed text. */
  function killLineForward(): string {
    const line = lines[cursor.line];
    const killed = line.slice(cursor.col);
    lines[cursor.line] = line.slice(0, cursor.col);
    return killed;
  }

  /** Delete from cursor to previous word boundary. Returns killed text. */
  function killWordBackward(): string {
    const line = lines[cursor.line];
    const startCol = cursor.col;
    let col = cursor.col;
    // Skip non-word characters going left
    while (col > 0 && !isWordChar(line[col - 1])) col--;
    // Skip word characters going left
    while (col > 0 && isWordChar(line[col - 1])) col--;
    const killed = line.slice(col, startCol);
    lines[cursor.line] = line.slice(0, col) + line.slice(startCol);
    cursor.col = col;
    return killed;
  }

  /** Insert a text blob (possibly multi-line). Used for paste. */
  function insertText(text: string): void {
    // Normalize line endings: \r\n → \n, standalone \r → \n
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const ch of normalized) {
      if (ch === '\n') {
        insertNewline();
      } else {
        insertChar(ch);
      }
    }
  }

  function setText(text: string): void {
    lines = text.split('\n');
    cursor.line = lines.length - 1;
    cursor.col = lines[cursor.line].length;
  }

  function isEmpty(): boolean {
    return lines.length === 1 && lines[0] === '';
  }

  return {
    getText,
    getLines,
    getCursor,
    clear,
    insertChar,
    insertNewline,
    backspace,
    deleteForward,
    moveLeft,
    moveRight,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    moveWordLeft,
    moveWordRight,
    killLineBackward,
    killLineForward,
    killWordBackward,
    insertText,
    setText,
    isEmpty,
  };
}
