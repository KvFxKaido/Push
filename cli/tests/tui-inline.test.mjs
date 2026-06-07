import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderInline } from '../tui-inline.ts';
import { createTheme } from '../tui-theme.ts';

const color = createTheme({ tier: '256', unicode: true, name: 'default' });
const none = createTheme({ tier: 'none', unicode: true, name: 'default' });

const ESC = /\x1b\[([0-9;]*)m/g;
const CLOSERS = new Set(['0', '22', '27', '39', '49']);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// The invariant wordWrap depends on: no styling stays open across a space. Each
// space-separated token must have balanced opens/closes, so a wrap between
// tokens can never strand an open colour/attribute.
function assertNoColorAcrossSpace(rendered) {
  for (const token of rendered.split(' ')) {
    let opens = 0;
    let closes = 0;
    for (const m of token.matchAll(ESC)) {
      const first = m[1].split(';')[0];
      if (CLOSERS.has(m[1]) || CLOSERS.has(first)) closes++;
      else opens++;
    }
    assert.equal(opens, closes, `unbalanced ANSI in token ${JSON.stringify(token)}`);
  }
}

describe('renderInline — tier none is a no-op', () => {
  it('leaves markers intact and emits no footnotes', () => {
    const r = renderInline(none, 'a **b** `c` [d](https://x.com)');
    assert.equal(r.text, 'a **b** `c` [d](https://x.com)');
    assert.deepEqual(r.footnotes, []);
  });
});

describe('renderInline — bold', () => {
  it('strips ** markers and bolds the interior, keeping the base foreground', () => {
    const r = renderInline(color, 'see **this** now');
    assert.ok(!r.text.includes('**'), 'markers stripped');
    assert.ok(r.text.includes('\x1b[1m'), 'bold opener present');
    assert.ok(r.text.includes('this'), 'text preserved');
    // Bold must also carry the base fg colour (38;5;… at the 256 tier), not drop
    // to the terminal default — otherwise bold reads dimmer than its prose.
    assert.ok(/\x1b\[38;5;\d+m/.test(r.text), 'bold span carries the base foreground');
    assertNoColorAcrossSpace(r.text);
  });

  it('supports __ as a bold marker', () => {
    const r = renderInline(color, '__loud__');
    assert.ok(!r.text.includes('__'));
    assert.ok(r.text.includes('\x1b[1m'));
  });

  it('leaves an unbalanced marker literal', () => {
    const r = renderInline(color, 'a **b');
    assert.ok(r.text.includes('**'), 'unbalanced ** stays literal');
  });

  it('keeps a multi-word bold span safe across the space', () => {
    const r = renderInline(color, 'a **two words** b');
    assertNoColorAcrossSpace(r.text);
  });
});

describe('renderInline — inline code', () => {
  it('strips backticks and styles the interior', () => {
    const r = renderInline(color, 'run `npm test` now');
    assert.ok(!r.text.includes('`'), 'backticks stripped');
    assert.ok(r.text.includes('npm'));
    assertNoColorAcrossSpace(r.text);
  });

  it('does not parse emphasis inside code', () => {
    const r = renderInline(color, '`a **b** c`');
    // The ** is inside code → preserved literally, not turned into a bold span.
    assert.ok(r.text.includes('**'), 'code interior is not re-parsed');
  });

  it('leaves an unterminated backtick literal', () => {
    const r = renderInline(color, 'a `b c');
    assert.ok(r.text.includes('`'));
  });
});

describe('renderInline — links (per-line footnotes)', () => {
  it('renders text with a superscript marker and a footnote line', () => {
    const r = renderInline(color, 'see the [docs](https://docs.example.com)');
    assert.ok(!r.text.includes('](') && !r.text.includes('https://'), 'url off the main line');
    assert.ok(r.text.includes('docs'), 'anchor text preserved');
    assert.ok(r.text.includes('¹'), 'superscript marker attached');
    assert.equal(r.footnotes.length, 1);
    assert.ok(r.footnotes[0].includes('https://docs.example.com'));
    assert.ok(r.footnotes[0].includes('¹'));
    assertNoColorAcrossSpace(r.text);
  });

  it('numbers multiple links per line in order', () => {
    const r = renderInline(color, '[a](https://a.test) and [b](https://b.test)');
    assert.ok(r.text.includes('¹') && r.text.includes('²'));
    assert.equal(r.footnotes.length, 2);
    assert.ok(r.footnotes[0].includes('a.test'));
    assert.ok(r.footnotes[1].includes('b.test'));
  });

  it('falls back to [n] markers when unicode is off', () => {
    const ascii = createTheme({ tier: '256', unicode: false, name: 'default' });
    const r = renderInline(ascii, '[x](https://x.test)');
    assert.ok(r.text.includes('[1]'));
    assert.ok(r.footnotes[0].includes('[1]'));
  });

  it('leaves a non-link bracket literal', () => {
    const r = renderInline(color, 'an array [0] index');
    assert.ok(r.text.includes('[0]'));
    assert.equal(r.footnotes.length, 0);
  });
});

describe('renderInline — escapes & mixed', () => {
  it('honours backslash escapes', () => {
    const r = renderInline(color, 'literal \\*not bold\\* and \\`tick\\`');
    const plain = stripAnsi(r.text);
    assert.ok(plain.includes('*not bold*'), 'escaped asterisks are literal');
    assert.ok(plain.includes('`tick`'), 'escaped backticks are literal');
    assert.ok(!plain.includes('\\'), 'backslashes consumed');
    assert.ok(!r.text.includes('\x1b[1m'), 'nothing was bolded');
  });

  it('handles bold + code + link on one line, all wrap-safe', () => {
    const r = renderInline(color, 'use **bold**, `code`, and [a link](https://x.test) here');
    assertNoColorAcrossSpace(r.text);
    r.footnotes.forEach(assertNoColorAcrossSpace);
    assert.equal(r.footnotes.length, 1);
  });
});
