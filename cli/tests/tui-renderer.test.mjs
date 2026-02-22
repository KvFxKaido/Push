import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripAnsi, visibleWidth, truncate, wordWrap, padTo,
  drawBox, drawDivider, computeLayout,
  createScreenBuffer, createRenderScheduler,
} from '../tui-renderer.mjs';
import { createTheme, GLYPHS_UNICODE, GLYPHS_ASCII } from '../tui-theme.mjs';

// ─── stripAnsi ──────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[39m'), 'red');
  });

  it('removes 24-bit color codes', () => {
    assert.equal(stripAnsi('\x1b[38;2;255;0;0mred\x1b[0m'), 'red');
  });

  it('passes through plain text unchanged', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  it('strips multiple codes', () => {
    assert.equal(stripAnsi('\x1b[1m\x1b[31mbold red\x1b[39m\x1b[22m'), 'bold red');
  });
});

// ─── visibleWidth ───────────────────────────────────────────────

describe('visibleWidth', () => {
  it('counts plain text correctly', () => {
    assert.equal(visibleWidth('hello'), 5);
  });

  it('ignores ANSI codes in width', () => {
    assert.equal(visibleWidth('\x1b[31mred\x1b[39m'), 3);
  });

  it('handles empty string', () => {
    assert.equal(visibleWidth(''), 0);
  });
});

// ─── truncate ───────────────────────────────────────────────────

describe('truncate', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncate('hi', 10), 'hi');
  });

  it('truncates long text with ellipsis', () => {
    const result = truncate('hello world!', 8);
    const stripped = stripAnsi(result);
    assert.ok(stripped.length <= 8, `"${stripped}" should be <= 8 chars`);
    assert.ok(stripped.includes('…'));
  });

  it('handles zero width', () => {
    assert.equal(truncate('test', 0), '');
  });

  it('handles text with ANSI codes', () => {
    const result = truncate('\x1b[31mhello world long text\x1b[39m', 10);
    const stripped = stripAnsi(result);
    assert.ok(stripped.length <= 10);
  });
});

// ─── wordWrap ───────────────────────────────────────────────────

describe('wordWrap', () => {
  it('returns short line as-is', () => {
    const result = wordWrap('hello', 80);
    assert.deepEqual(result, ['hello']);
  });

  it('wraps at word boundaries', () => {
    const result = wordWrap('hello world foo bar', 11);
    assert.ok(result.length >= 2);
    for (const line of result) {
      assert.ok(visibleWidth(line) <= 11, `Line "${line}" exceeds max width`);
    }
  });

  it('preserves existing newlines', () => {
    const result = wordWrap('line1\nline2', 80);
    assert.deepEqual(result, ['line1', 'line2']);
  });

  it('handles empty string', () => {
    assert.deepEqual(wordWrap('', 80), ['']);
  });

  it('hard-breaks very long words', () => {
    const longWord = 'a'.repeat(20);
    const result = wordWrap(longWord, 10);
    assert.ok(result.length >= 2);
    for (const line of result) {
      assert.ok(line.length <= 10);
    }
  });

  it('handles maxWidth=0', () => {
    assert.deepEqual(wordWrap('test', 0), ['']);
  });
});

// ─── padTo ──────────────────────────────────────────────────────

describe('padTo', () => {
  it('pads short text to exact width', () => {
    assert.equal(visibleWidth(padTo('hi', 10)), 10);
  });

  it('truncates long text to width', () => {
    const result = padTo('hello world!', 8);
    assert.ok(visibleWidth(result) <= 8);
  });

  it('right-aligns text', () => {
    const result = padTo('hi', 10, 'right');
    assert.ok(result.startsWith('        '));
  });

  it('center-aligns text', () => {
    const result = padTo('hi', 10, 'center');
    const stripped = stripAnsi(result);
    assert.equal(stripped.length, 10);
    assert.ok(stripped.startsWith('    '));
  });
});

// ─── drawBox ────────────────────────────────────────────────────

describe('drawBox', () => {
  it('draws a box with correct dimensions', () => {
    const theme = createTheme({ tier: 'none', unicode: true });
    const lines = drawBox(['hello', 'world'], 20, GLYPHS_UNICODE, theme);
    assert.equal(lines.length, 4); // top + 2 content + bottom
  });

  it('works with ASCII glyphs', () => {
    const theme = createTheme({ tier: 'none', unicode: false });
    const lines = drawBox(['test'], 20, GLYPHS_ASCII, theme);
    assert.equal(lines.length, 3); // top + 1 content + bottom
    assert.ok(lines[0].includes('+'));
    assert.ok(lines[0].includes('-'));
  });
});

// ─── drawDivider ────────────────────────────────────────────────

describe('drawDivider', () => {
  it('draws a divider of specified width', () => {
    const theme = createTheme({ tier: 'none', unicode: true });
    const divider = drawDivider(20, GLYPHS_UNICODE, theme);
    assert.equal(divider.length, 20);
    assert.ok(divider.includes('─'));
  });
});

// ─── computeLayout ──────────────────────────────────────────────

describe('computeLayout', () => {
  it('computes layout for 80x24 terminal', () => {
    const layout = computeLayout(24, 80);
    assert.ok(layout.header);
    assert.ok(layout.transcript);
    assert.ok(layout.composer);
    assert.ok(layout.footer);
    assert.equal(layout.toolPane, null); // tool pane closed by default
  });

  it('transcript has positive height', () => {
    const layout = computeLayout(24, 80);
    assert.ok(layout.transcript.height > 0, `transcript height: ${layout.transcript.height}`);
  });

  it('header has 4 rows', () => {
    const layout = computeLayout(24, 80);
    assert.equal(layout.header.height, 4);
  });

  it('footer has 1 row', () => {
    const layout = computeLayout(24, 80);
    assert.equal(layout.footer.height, 1);
  });

  it('composer has min 3 rows', () => {
    const layout = computeLayout(24, 80);
    assert.ok(layout.composer.height >= 3);
  });

  it('tool pane opens with correct width ratio', () => {
    const layout = computeLayout(40, 100, { toolPaneOpen: true });
    assert.ok(layout.toolPane);
    const ratio = layout.toolPane.width / layout.innerWidth;
    assert.ok(ratio >= 0.30 && ratio <= 0.42, `Tool pane ratio: ${ratio}`);
  });

  it('transcript width shrinks when tool pane opens', () => {
    const closed = computeLayout(40, 100, { toolPaneOpen: false });
    const open = computeLayout(40, 100, { toolPaneOpen: true });
    assert.ok(open.transcript.width < closed.transcript.width);
  });

  it('handles very small terminal gracefully', () => {
    const layout = computeLayout(10, 40);
    assert.ok(layout.transcript.height >= 1);
    assert.ok(layout.header.width > 0);
  });

  it('respects outer margins', () => {
    const layout = computeLayout(24, 80);
    assert.ok(layout.innerLeft >= 3); // 2 col margin + 1 for 1-indexing
    assert.ok(layout.innerWidth <= 76); // 80 - 4
  });
});

// ─── createScreenBuffer ─────────────────────────────────────────

describe('createScreenBuffer', () => {
  it('creates buffer with expected methods', () => {
    const buf = createScreenBuffer();
    assert.equal(typeof buf.moveTo, 'function');
    assert.equal(typeof buf.write, 'function');
    assert.equal(typeof buf.writeLine, 'function');
    assert.equal(typeof buf.flush, 'function');
    assert.equal(typeof buf.clear, 'function');
  });
});

// ─── createRenderScheduler ──────────────────────────────────────

describe('createRenderScheduler', () => {
  it('calls renderFn', (t, done) => {
    let called = false;
    const scheduler = createRenderScheduler(() => { called = true; });
    scheduler.schedule();
    // Immediate call since first render has no recent render
    setTimeout(() => {
      assert.ok(called);
      scheduler.destroy();
      done();
    }, 10);
  });

  it('flush calls renderFn immediately', () => {
    let called = false;
    const scheduler = createRenderScheduler(() => { called = true; });
    scheduler.flush();
    assert.ok(called);
    scheduler.destroy();
  });
});
