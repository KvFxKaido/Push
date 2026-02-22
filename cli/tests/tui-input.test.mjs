import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, createKeybindMap, createComposer, createInputHistory } from '../tui-input.mjs';

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

  it('maps Ctrl+G to toggle_reasoning', () => {
    const map = createKeybindMap();
    const key = parseKey(Buffer.from([0x07]));
    assert.equal(map.lookup(key), 'toggle_reasoning');
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

  // ─── Word navigation ──────────────────────────────────────────

  it('moveWordRight skips to next word boundary', () => {
    const c = createComposer();
    c.setText('hello world foo');
    c.moveHome();
    c.moveWordRight();
    assert.equal(c.getCursor().col, 6); // after "hello "
  });

  it('moveWordLeft skips to previous word boundary', () => {
    const c = createComposer();
    c.setText('hello world');
    // cursor at end (col 11)
    c.moveWordLeft();
    assert.equal(c.getCursor().col, 6); // before "world"
  });

  it('moveWordLeft from middle of word goes to word start', () => {
    const c = createComposer();
    c.setText('hello world');
    c.moveHome();
    c.moveWordRight(); // at col 6
    c.moveLeft();      // col 5 (the space)
    c.moveWordLeft();
    assert.equal(c.getCursor().col, 0);
  });

  it('moveWordRight wraps to next line at end', () => {
    const c = createComposer();
    c.setText('abc\ndef');
    c.moveHome(); // line 0, col 0
    c.moveEnd();  // line 0, col 3 (we're on line 1 after setText, so reset)
    // Need to set up properly
    const c2 = createComposer();
    c2.insertChar('abc');
    c2.insertNewline();
    c2.insertChar('def');
    // cursor at line 1, col 3
    c2.moveUp(); c2.moveEnd(); // line 0, col 3
    c2.moveWordRight(); // should wrap to line 1, col 0
    assert.equal(c2.getCursor().line, 1);
    assert.equal(c2.getCursor().col, 0);
  });

  it('moveWordLeft wraps to previous line at start', () => {
    const c = createComposer();
    c.insertChar('abc');
    c.insertNewline();
    c.insertChar('def');
    c.moveHome(); // line 1, col 0
    c.moveWordLeft(); // should wrap to line 0, end
    assert.equal(c.getCursor().line, 0);
    assert.equal(c.getCursor().col, 3);
  });

  it('moveWordRight handles punctuation', () => {
    const c = createComposer();
    c.setText('foo.bar baz');
    c.moveHome();
    c.moveWordRight();
    assert.equal(c.getCursor().col, 4); // skips "foo" (word) then "." (non-word), lands at "bar"
  });

  // ─── Kill operations ──────────────────────────────────────────

  it('killLineBackward deletes to line start', () => {
    const c = createComposer();
    c.setText('hello world');
    // cursor at col 5
    c.moveHome();
    for (let i = 0; i < 5; i++) c.moveRight();
    const killed = c.killLineBackward();
    assert.equal(killed, 'hello');
    assert.equal(c.getText(), ' world');
    assert.equal(c.getCursor().col, 0);
  });

  it('killLineForward deletes to line end', () => {
    const c = createComposer();
    c.setText('hello world');
    c.moveHome();
    for (let i = 0; i < 5; i++) c.moveRight();
    const killed = c.killLineForward();
    assert.equal(killed, ' world');
    assert.equal(c.getText(), 'hello');
    assert.equal(c.getCursor().col, 5);
  });

  it('killWordBackward deletes to previous word', () => {
    const c = createComposer();
    c.setText('hello world');
    const killed = c.killWordBackward();
    assert.equal(killed, 'world');
    assert.equal(c.getText(), 'hello ');
  });

  it('killWordBackward from middle of word', () => {
    const c = createComposer();
    c.setText('hello world');
    c.moveLeft(); c.moveLeft(); // col 9, in "world"
    const killed = c.killWordBackward();
    assert.equal(killed, 'wor');
    assert.equal(c.getText(), 'hello ld');
  });

  it('killLineBackward returns empty when at start', () => {
    const c = createComposer();
    c.setText('hello');
    c.moveHome();
    const killed = c.killLineBackward();
    assert.equal(killed, '');
    assert.equal(c.getText(), 'hello');
  });

  it('killLineForward returns empty when at end', () => {
    const c = createComposer();
    c.setText('hello');
    const killed = c.killLineForward();
    assert.equal(killed, '');
    assert.equal(c.getText(), 'hello');
  });

  it('killWordBackward at start does nothing', () => {
    const c = createComposer();
    c.setText('hello');
    c.moveHome();
    const killed = c.killWordBackward();
    assert.equal(killed, '');
    assert.equal(c.getText(), 'hello');
  });

  // ─── insertText ────────────────────────────────────────────────

  it('insertText handles single-line paste', () => {
    const c = createComposer();
    c.insertText('hello world');
    assert.equal(c.getText(), 'hello world');
    assert.deepEqual(c.getCursor(), { line: 0, col: 11 });
  });

  it('insertText handles multi-line paste', () => {
    const c = createComposer();
    c.insertText('line1\nline2\nline3');
    assert.deepEqual(c.getLines(), ['line1', 'line2', 'line3']);
    assert.equal(c.getCursor().line, 2);
    assert.equal(c.getCursor().col, 5);
  });

  it('insertText normalizes CRLF to single newlines', () => {
    const c = createComposer();
    c.insertText('line1\r\nline2\r\nline3');
    assert.deepEqual(c.getLines(), ['line1', 'line2', 'line3']);
    assert.equal(c.getCursor().line, 2);
  });

  it('insertText normalizes standalone CR to newline', () => {
    const c = createComposer();
    c.insertText('line1\rline2');
    assert.deepEqual(c.getLines(), ['line1', 'line2']);
  });
});

// ─── createInputHistory ────────────────────────────────────────

describe('createInputHistory', () => {
  it('starts not navigating', () => {
    const h = createInputHistory();
    assert.equal(h.isNavigating(), false);
  });

  it('up returns null when empty', () => {
    const h = createInputHistory();
    assert.equal(h.up(''), null);
  });

  it('down returns null when not navigating', () => {
    const h = createInputHistory();
    assert.equal(h.down(''), null);
  });

  it('push + up recalls last entry', () => {
    const h = createInputHistory();
    h.push('hello');
    h.push('world');
    const recalled = h.up('current');
    assert.equal(recalled, 'world');
    assert.equal(h.isNavigating(), true);
  });

  it('up twice goes to older entry', () => {
    const h = createInputHistory();
    h.push('first');
    h.push('second');
    h.up('current');
    const recalled = h.up('');
    assert.equal(recalled, 'first');
  });

  it('up at oldest returns null', () => {
    const h = createInputHistory();
    h.push('only');
    h.up('current');
    assert.equal(h.up(''), null);
  });

  it('down past newest restores stashed text', () => {
    const h = createInputHistory();
    h.push('old');
    h.up('my typing');
    const restored = h.down('');
    assert.equal(restored, 'my typing');
    assert.equal(h.isNavigating(), false);
  });

  it('deduplicates consecutive entries', () => {
    const h = createInputHistory();
    h.push('same');
    h.push('same');
    h.up('');
    assert.equal(h.up(''), null); // only one entry
  });

  it('reset clears navigation state', () => {
    const h = createInputHistory();
    h.push('test');
    h.up('');
    assert.equal(h.isNavigating(), true);
    h.reset();
    assert.equal(h.isNavigating(), false);
  });
});
