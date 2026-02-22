import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, createKeybindMap, createComposer } from '../tui-input.mjs';

// ─── parseKey ───────────────────────────────────────────────────

describe('parseKey', () => {
  it('parses printable ASCII characters', () => {
    const key = parseKey(Buffer.from('a'));
    assert.equal(key.name, 'a');
    assert.equal(key.ch, 'a');
    assert.equal(key.ctrl, false);
    assert.equal(key.meta, false);
  });

  it('parses space', () => {
    const key = parseKey(Buffer.from(' '));
    assert.equal(key.name, ' ');
    assert.equal(key.ch, ' ');
  });

  it('parses Ctrl+C', () => {
    const key = parseKey(Buffer.from([0x03]));
    assert.equal(key.name, 'c');
    assert.equal(key.ctrl, true);
    assert.equal(key.ch, '');
  });

  it('parses Ctrl+T', () => {
    const key = parseKey(Buffer.from([0x14]));
    assert.equal(key.name, 't');
    assert.equal(key.ctrl, true);
  });

  it('parses Ctrl+Y', () => {
    const key = parseKey(Buffer.from([0x19]));
    assert.equal(key.name, 'y');
    assert.equal(key.ctrl, true);
  });

  it('parses Ctrl+N', () => {
    const key = parseKey(Buffer.from([0x0e]));
    assert.equal(key.name, 'n');
    assert.equal(key.ctrl, true);
  });

  it('parses Ctrl+P', () => {
    const key = parseKey(Buffer.from([0x10]));
    assert.equal(key.name, 'p');
    assert.equal(key.ctrl, true);
  });

  it('parses Ctrl+L', () => {
    const key = parseKey(Buffer.from([0x0c]));
    assert.equal(key.name, 'l');
    assert.equal(key.ctrl, true);
  });

  it('parses Ctrl+R', () => {
    const key = parseKey(Buffer.from([0x12]));
    assert.equal(key.name, 'r');
    assert.equal(key.ctrl, true);
  });

  it('parses Enter (0x0d)', () => {
    const key = parseKey(Buffer.from([0x0d]));
    assert.equal(key.name, 'return');
    assert.equal(key.ctrl, false); // Enter is its own key, not Ctrl+M
  });

  it('parses Tab', () => {
    const key = parseKey(Buffer.from([0x09]));
    assert.equal(key.name, 'tab');
    assert.equal(key.ctrl, false); // Tab is its own key, not Ctrl+I
  });

  it('parses Escape', () => {
    const key = parseKey(Buffer.from([0x1b]));
    assert.equal(key.name, 'escape');
  });

  it('parses Backspace (0x7f)', () => {
    const key = parseKey(Buffer.from([0x7f]));
    assert.equal(key.name, 'backspace');
  });

  it('parses arrow up', () => {
    const key = parseKey(Buffer.from('\x1b[A'));
    assert.equal(key.name, 'up');
    assert.equal(key.ctrl, false);
    assert.equal(key.shift, false);
  });

  it('parses arrow down', () => {
    const key = parseKey(Buffer.from('\x1b[B'));
    assert.equal(key.name, 'down');
  });

  it('parses arrow right', () => {
    const key = parseKey(Buffer.from('\x1b[C'));
    assert.equal(key.name, 'right');
  });

  it('parses arrow left', () => {
    const key = parseKey(Buffer.from('\x1b[D'));
    assert.equal(key.name, 'left');
  });

  it('parses Home', () => {
    const key = parseKey(Buffer.from('\x1b[H'));
    assert.equal(key.name, 'home');
  });

  it('parses End', () => {
    const key = parseKey(Buffer.from('\x1b[F'));
    assert.equal(key.name, 'end');
  });

  it('parses Delete', () => {
    const key = parseKey(Buffer.from('\x1b[3~'));
    assert.equal(key.name, 'delete');
  });

  it('parses PageUp', () => {
    const key = parseKey(Buffer.from('\x1b[5~'));
    assert.equal(key.name, 'pageup');
  });

  it('parses PageDown', () => {
    const key = parseKey(Buffer.from('\x1b[6~'));
    assert.equal(key.name, 'pagedown');
  });

  it('parses Shift+Arrow', () => {
    const key = parseKey(Buffer.from('\x1b[1;2A'));
    assert.equal(key.name, 'up');
    assert.equal(key.shift, true);
  });

  it('parses Ctrl+Arrow', () => {
    const key = parseKey(Buffer.from('\x1b[1;5C'));
    assert.equal(key.name, 'right');
    assert.equal(key.ctrl, true);
  });

  it('parses Shift+Enter (kitty protocol)', () => {
    const key = parseKey(Buffer.from('\x1b[13;2u'));
    assert.equal(key.name, 'return');
    assert.equal(key.shift, true);
  });

  it('parses Alt+a', () => {
    const key = parseKey(Buffer.from('\x1ba'));
    assert.equal(key.name, 'a');
    assert.equal(key.meta, true);
    assert.equal(key.ch, 'a');
  });

  it('parses Alt+Enter', () => {
    const key = parseKey(Buffer.from('\x1b\r'));
    assert.equal(key.name, 'return');
    assert.equal(key.meta, true);
  });

  it('parses SS3 arrow sequences', () => {
    const key = parseKey(Buffer.from('\x1bOA'));
    assert.equal(key.name, 'up');
  });

  it('parses Shift+Tab (backtab)', () => {
    const key = parseKey(Buffer.from('\x1b[Z'));
    assert.equal(key.name, 'tab');
    assert.equal(key.shift, true);
  });
});

// ─── createKeybindMap ───────────────────────────────────────────

describe('createKeybindMap', () => {
  it('maps Enter to send', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x0d])); // Enter = Ctrl+M
    assert.equal(map.lookup(key), 'send');
  });

  it('maps Ctrl+C to cancel_or_exit', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x03]));
    assert.equal(map.lookup(key), 'cancel_or_exit');
  });

  it('maps Ctrl+T to toggle_tools', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x14]));
    assert.equal(map.lookup(key), 'toggle_tools');
  });

  it('maps Ctrl+Y to approve', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x19]));
    assert.equal(map.lookup(key), 'approve');
  });

  it('maps Ctrl+N to deny', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x0e]));
    assert.equal(map.lookup(key), 'deny');
  });

  it('maps Ctrl+P to provider_switcher', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x10]));
    assert.equal(map.lookup(key), 'provider_switcher');
  });

  it('maps Ctrl+L to clear_viewport', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x0c]));
    assert.equal(map.lookup(key), 'clear_viewport');
  });

  it('maps Escape to close_modal', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x1b]));
    assert.equal(map.lookup(key), 'close_modal');
  });

  it('maps Alt+Enter to newline', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from('\x1b\r'));
    assert.equal(map.lookup(key), 'newline');
  });

  it('returns null for unmapped keys', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from('x'));
    assert.equal(map.lookup(key), null);
  });

  it('custom bindings override defaults', () => {
    const map = createKeybindMap();
    map.bind('C-t', 'custom_action');
    const key = parseKey(Buffer.from([0x14]));
    assert.equal(map.lookup(key), 'custom_action');
  });
});

// ─── createComposer ─────────────────────────────────────────────

describe('createComposer', () => {
  it('starts empty', () => {
    const c = createComposer();
    assert.equal(c.getText(), '');
    assert.equal(c.isEmpty(), true);
    assert.deepEqual(c.getCursor(), { line: 0, col: 0 });
  });

  it('inserts characters', () => {
    const c = createComposer();
    c.insertChar('h');
    c.insertChar('i');
    assert.equal(c.getText(), 'hi');
    assert.deepEqual(c.getCursor(), { line: 0, col: 2 });
    assert.equal(c.isEmpty(), false);
  });

  it('handles backspace', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertChar('b');
    c.backspace();
    assert.equal(c.getText(), 'a');
    assert.deepEqual(c.getCursor(), { line: 0, col: 1 });
  });

  it('backspace at start of line merges with previous', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertNewline();
    c.insertChar('b');
    c.moveHome();
    c.backspace();
    assert.equal(c.getText(), 'ab');
    assert.deepEqual(c.getCursor(), { line: 0, col: 1 });
  });

  it('inserts newline', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertNewline();
    c.insertChar('b');
    assert.equal(c.getText(), 'a\nb');
    assert.deepEqual(c.getLines(), ['a', 'b']);
    assert.deepEqual(c.getCursor(), { line: 1, col: 1 });
  });

  it('cursor movement — left/right', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertChar('b');
    c.moveLeft();
    assert.deepEqual(c.getCursor(), { line: 0, col: 1 });
    c.moveRight();
    assert.deepEqual(c.getCursor(), { line: 0, col: 2 });
  });

  it('cursor movement — left at start wraps to previous line', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertNewline();
    c.moveLeft();
    assert.deepEqual(c.getCursor(), { line: 0, col: 1 });
  });

  it('cursor movement — right at end wraps to next line', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertNewline();
    c.insertChar('b');
    // Move to end of first line
    c.moveUp();
    c.moveEnd();
    c.moveRight();
    assert.deepEqual(c.getCursor(), { line: 1, col: 0 });
  });

  it('cursor movement — up/down', () => {
    const c = createComposer();
    c.insertChar('abc');
    c.insertNewline();
    c.insertChar('d');
    c.moveUp();
    assert.equal(c.getCursor().line, 0);
    c.moveDown();
    assert.equal(c.getCursor().line, 1);
  });

  it('cursor movement — home/end', () => {
    const c = createComposer();
    c.insertChar('hello');
    c.moveHome();
    assert.equal(c.getCursor().col, 0);
    c.moveEnd();
    assert.equal(c.getCursor().col, 5);
  });

  it('delete forward', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertChar('b');
    c.moveHome();
    c.deleteForward();
    assert.equal(c.getText(), 'b');
  });

  it('delete forward merges lines', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertNewline();
    c.insertChar('b');
    c.moveUp();
    c.moveEnd();
    c.deleteForward();
    assert.equal(c.getText(), 'ab');
  });

  it('clear resets state', () => {
    const c = createComposer();
    c.insertChar('hello');
    c.insertNewline();
    c.insertChar('world');
    c.clear();
    assert.equal(c.getText(), '');
    assert.equal(c.isEmpty(), true);
    assert.deepEqual(c.getCursor(), { line: 0, col: 0 });
  });

  it('insert at cursor position mid-line', () => {
    const c = createComposer();
    c.insertChar('a');
    c.insertChar('c');
    c.moveLeft();
    c.insertChar('b');
    assert.equal(c.getText(), 'abc');
    assert.deepEqual(c.getCursor(), { line: 0, col: 2 });
  });

  it('setText replaces content and places cursor at end', () => {
    const c = createComposer();
    c.insertChar('old');
    c.setText('/model gemini');
    assert.equal(c.getText(), '/model gemini');
    assert.deepEqual(c.getCursor(), { line: 0, col: 13 });
  });

  it('setText handles multi-line text', () => {
    const c = createComposer();
    c.setText('line1\nline2');
    assert.deepEqual(c.getLines(), ['line1', 'line2']);
    assert.deepEqual(c.getCursor(), { line: 1, col: 5 });
  });

  it('setText with empty string resets to empty', () => {
    const c = createComposer();
    c.insertChar('hello');
    c.setText('');
    assert.equal(c.getText(), '');
    assert.deepEqual(c.getCursor(), { line: 0, col: 0 });
  });
});
