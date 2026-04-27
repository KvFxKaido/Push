import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripAnsi,
  visibleWidth,
  truncate,
  wordWrap,
  padTo,
  drawBox,
  drawDivider,
  computeLayout,
  createScreenBuffer,
  createRenderScheduler,
  charWidth,
  osc52Copy,
  ESC,
  solveFlex,
} from '../tui-renderer.ts';
import { createTheme, GLYPHS_UNICODE, GLYPHS_ASCII } from '../tui-theme.ts';

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

  it('footer has 2 rows', () => {
    const layout = computeLayout(24, 80);
    assert.equal(layout.footer.height, 2);
  });

  it('composer has min 3 rows', () => {
    const layout = computeLayout(24, 80);
    assert.ok(layout.composer.height >= 3);
  });

  it('tool pane opens with correct width ratio', () => {
    const layout = computeLayout(40, 100, { toolPaneOpen: true });
    assert.ok(layout.toolPane);
    const ratio = layout.toolPane.width / layout.innerWidth;
    assert.ok(ratio >= 0.3 && ratio <= 0.42, `Tool pane ratio: ${ratio}`);
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

  it('keeps footer + composer anchored within the viewport on tiny terminals', () => {
    // Regression: with a top-down flex stack, fixed children whose total
    // exceeded available height would push the footer past row N. The
    // footer is anchored to the terminal bottom; composer abuts it.
    const rows = 10;
    const layout = computeLayout(rows, 40);
    assert.ok(
      layout.footer.top + layout.footer.height - 1 <= rows,
      `footer (top ${layout.footer.top}, height ${layout.footer.height}) overflows ${rows}-row terminal`,
    );
    assert.equal(layout.composer.top + layout.composer.height, layout.footer.top);
  });

  it('respects outer margins', () => {
    const layout = computeLayout(24, 80);
    assert.ok(layout.innerLeft >= 3); // 2 col margin + 1 for 1-indexing
    assert.ok(layout.innerWidth <= 76); // 80 - 4
  });
});

// ─── solveFlex ──────────────────────────────────────────────────

describe('solveFlex', () => {
  const region = { top: 1, left: 1, width: 100, height: 50 };

  it('registers the root region under its id', () => {
    const out = solveFlex({ id: 'root', size: { kind: 'flex', weight: 1 } }, region);
    assert.deepEqual(out.get('root'), region);
  });

  it('lays out fixed children sequentially along col axis', () => {
    const out = solveFlex(
      {
        dir: 'col',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'a', size: { kind: 'fixed', size: 4 } },
          { id: 'b', size: { kind: 'fixed', size: 6 } },
        ],
      },
      region,
    );
    assert.deepEqual(out.get('a'), { top: 1, left: 1, width: 100, height: 4 });
    assert.deepEqual(out.get('b'), { top: 5, left: 1, width: 100, height: 6 });
  });

  it('flex children share remaining space proportional to weight', () => {
    const out = solveFlex(
      {
        dir: 'row',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'left', size: { kind: 'flex', weight: 1 } },
          { id: 'right', size: { kind: 'flex', weight: 3 } },
        ],
      },
      { top: 1, left: 1, width: 80, height: 10 },
    );
    assert.equal(out.get('left').width, 20);
    assert.equal(out.get('right').width, 60);
  });

  it('last flex child absorbs the rounding remainder', () => {
    // 75 / (1+1+1) = 25 each — but check uneven: 7 / 3 → 2,2,3
    const out = solveFlex(
      {
        dir: 'row',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'a', size: { kind: 'flex', weight: 1 } },
          { id: 'b', size: { kind: 'flex', weight: 1 } },
          { id: 'c', size: { kind: 'flex', weight: 1 } },
        ],
      },
      { top: 1, left: 1, width: 7, height: 1 },
    );
    assert.equal(out.get('a').width, 2);
    assert.equal(out.get('b').width, 2);
    assert.equal(out.get('c').width, 3); // remainder
    // No cells lost
    assert.equal(out.get('a').width + out.get('b').width + out.get('c').width, 7);
  });

  it('percent children consume a floor(parentDim * percent) slice before flex', () => {
    const out = solveFlex(
      {
        dir: 'row',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'fill', size: { kind: 'flex', weight: 1 } },
          { size: { kind: 'fixed', size: 1 } }, // divider
          { id: 'side', size: { kind: 'percent', percent: 0.37 } },
        ],
      },
      { top: 1, left: 1, width: 96, height: 10 },
    );
    assert.equal(out.get('side').width, 35); // floor(96 * 0.37)
    assert.equal(out.get('fill').width, 60); // 96 - 1 (divider) - 35
  });

  it('children without an id consume axis space but produce no result entry', () => {
    const out = solveFlex(
      {
        dir: 'col',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'top', size: { kind: 'fixed', size: 4 } },
          { size: { kind: 'fixed', size: 1 } }, // gap, no id
          { id: 'bottom', size: { kind: 'fixed', size: 5 } },
        ],
      },
      region,
    );
    assert.equal(out.get('bottom').top, 6); // 1 + 4 + 1
    assert.equal(out.size, 2);
  });

  it('recurses into nested splits', () => {
    const out = solveFlex(
      {
        dir: 'col',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'header', size: { kind: 'fixed', size: 2 } },
          {
            dir: 'row',
            size: { kind: 'flex', weight: 1 },
            children: [
              { id: 'tree', size: { kind: 'fixed', size: 20 } },
              { id: 'main', size: { kind: 'flex', weight: 1 } },
            ],
          },
        ],
      },
      { top: 1, left: 1, width: 100, height: 50 },
    );
    assert.deepEqual(out.get('header'), { top: 1, left: 1, width: 100, height: 2 });
    assert.deepEqual(out.get('tree'), { top: 3, left: 1, width: 20, height: 48 });
    assert.deepEqual(out.get('main'), { top: 3, left: 21, width: 80, height: 48 });
  });

  it('clamps flex children to zero when fixed sizes consume the axis', () => {
    const out = solveFlex(
      {
        dir: 'col',
        size: { kind: 'flex', weight: 1 },
        children: [
          { id: 'a', size: { kind: 'fixed', size: 10 } },
          { id: 'b', size: { kind: 'flex', weight: 1 } },
        ],
      },
      { top: 1, left: 1, width: 10, height: 5 },
    );
    assert.equal(out.get('a').height, 10); // overshoots; caller decides what to do
    assert.equal(out.get('b').height, 0); // no space left
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

// Capture stdout writes so we can assert on emitted bytes per flush.
function withCapturedStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  };
  try {
    return fn(() => {
      const out = captured;
      captured = '';
      return out;
    });
  } finally {
    process.stdout.write = original;
  }
}

describe('createScreenBuffer (line-level diff)', () => {
  it('emits line writes on the first flush', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      const out = take();
      assert.match(out, /hello/);
      assert.match(out, /\x1b\[1;1H/);
    });
  });

  it('skips unchanged line writes on subsequent flushes', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      assert.equal(take(), '');
    });
  });

  it('emits only the changed line when one row of two changes', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello');
      buf.writeLine(2, 1, 'world');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'hello');
      buf.writeLine(2, 1, 'updated');
      buf.flush();
      const out = take();
      assert.match(out, /updated/);
      assert.doesNotMatch(out, /hello/);
    });
  });

  it('does not auto-clear rows that are absent from the next frame', () => {
    // tui.ts has a partial-redraw path that re-emits only dirty panes;
    // an unwritten row is meant to retain its previous contents. Auto-
    // blanking would corrupt the panes that intentionally skipped this
    // frame. Callers that need a row gone must rewrite it (or trigger a
    // full redraw, which emits clearScreen → forceFullFrame).
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello');
      buf.writeLine(2, 1, 'world');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      assert.equal(take(), '');
    });
  });

  it('preserves untouched prior lines across partial re-renders', () => {
    // Stronger regression check: when one line updates and the other is
    // omitted, the output should be EXACTLY the changed-line emit — no
    // trailing blanks for the untouched row.
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'first');
      buf.writeLine(2, 1, 'second');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'first updated');
      buf.flush();
      assert.equal(take(), '\x1b[1;1Hfirst updated');
    });
  });

  it('pads with spaces when a line shrinks at the same position', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello world');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'hi');
      buf.flush();
      const out = take();
      // Emitted text should include the new content followed by enough
      // trailing spaces to overwrite the old tail (11 - 2 = 9 spaces).
      assert.match(out, /hi {9}/);
    });
  });

  it('forces a full re-emit when clearScreen appears in the frame', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      take();
      buf.write(ESC.clearScreen);
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      const out = take();
      assert.match(out, /\x1b\[2J/);
      assert.match(out, /hello/);
    });
  });

  it('clear() drops pending ops without invalidating the previous frame', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'CHANGED');
      buf.clear();
      buf.writeLine(1, 1, 'hello');
      buf.flush();
      assert.equal(take(), '');
    });
  });

  it('passes through raw write() escapes verbatim', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.write('\x1b[?25h');
      buf.flush();
      assert.equal(take(), '\x1b[?25h');
    });
  });

  it('treats different cols on the same row as separate diff entries', () => {
    withCapturedStdout((take) => {
      const buf = createScreenBuffer();
      buf.writeLine(1, 1, 'AAA');
      buf.writeLine(1, 10, 'BBB');
      buf.flush();
      take();
      buf.writeLine(1, 1, 'AAA');
      buf.writeLine(1, 10, 'BBB');
      buf.flush();
      assert.equal(take(), '');
    });
  });
});

// ─── createRenderScheduler ──────────────────────────────────────

describe('createRenderScheduler', () => {
  it('calls renderFn', (t, done) => {
    let called = false;
    const scheduler = createRenderScheduler(() => {
      called = true;
    });
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
    const scheduler = createRenderScheduler(() => {
      called = true;
    });
    scheduler.flush();
    assert.ok(called);
    scheduler.destroy();
  });
});

// ─── charWidth ─────────────────────────────────────────────────

describe('charWidth', () => {
  it('returns 1 for ASCII characters', () => {
    assert.equal(charWidth('A'.codePointAt(0)), 1);
    assert.equal(charWidth('z'.codePointAt(0)), 1);
    assert.equal(charWidth(' '.codePointAt(0)), 1);
  });

  it('returns 2 for CJK ideographs', () => {
    assert.equal(charWidth('中'.codePointAt(0)), 2); // U+4E2D
    assert.equal(charWidth('漢'.codePointAt(0)), 2); // U+6F22
  });

  it('returns 2 for Hiragana/Katakana', () => {
    assert.equal(charWidth('あ'.codePointAt(0)), 2); // U+3042
    assert.equal(charWidth('カ'.codePointAt(0)), 2); // U+30AB
  });

  it('returns 2 for Hangul syllables', () => {
    assert.equal(charWidth('한'.codePointAt(0)), 2); // U+D55C
  });

  it('returns 2 for fullwidth ASCII variants', () => {
    assert.equal(charWidth('Ａ'.codePointAt(0)), 2); // U+FF21
  });

  it('returns 0 for combining marks', () => {
    assert.equal(charWidth(0x0301), 0); // Combining acute accent
    assert.equal(charWidth(0x0300), 0); // Combining grave accent
  });

  it('returns 2 for emoji', () => {
    assert.equal(charWidth('🎉'.codePointAt(0)), 2); // U+1F389
  });
});

// ─── visibleWidth with CJK ─────────────────────────────────────

describe('visibleWidth (CJK)', () => {
  it('counts CJK characters as width 2', () => {
    assert.equal(visibleWidth('中文'), 4);
  });

  it('counts mixed ASCII + CJK', () => {
    assert.equal(visibleWidth('hi中文'), 6); // 2 + 4
  });

  it('ignores ANSI codes around CJK', () => {
    assert.equal(visibleWidth('\x1b[31m中\x1b[0m'), 2);
  });
});

// ─── osc52Copy ─────────────────────────────────────────────────

describe('osc52Copy', () => {
  it('wraps ASCII text in OSC 52 envelope with BEL terminator', () => {
    const out = osc52Copy('hello');
    assert.equal(out, '\x1b]52;c;aGVsbG8=\x07');
  });

  it('encodes UTF-8 correctly (no latin-1 mangling)', () => {
    const out = osc52Copy('中文');
    // "中文" → UTF-8 bytes E4 B8 AD E6 96 87 → base64 5Lit5paH
    assert.equal(out, '\x1b]52;c;5Lit5paH\x07');
  });

  it('handles empty input as an empty base64 payload', () => {
    assert.equal(osc52Copy(''), '\x1b]52;c;\x07');
  });
});
