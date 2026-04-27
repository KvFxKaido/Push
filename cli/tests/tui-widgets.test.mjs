import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cursorMarker,
  cursorStyle,
  getCenteredModalRect,
  getWindowedListRange,
} from '../tui-widgets.ts';

// Identity-styling theme stub: returns text wrapped with the token name so
// assertions can distinguish accent vs base styling without parsing ANSI.
function makeTheme(promptGlyph = '>') {
  return {
    style: (token, text) => `<${token}>${text}</>`,
    glyphs: { prompt: promptGlyph },
  };
}

describe('getCenteredModalRect', () => {
  it('centers a modal within the terminal', () => {
    const rect = getCenteredModalRect(24, 80, 40, 10);
    assert.equal(rect.top, 7);
    assert.equal(rect.left, 20);
    assert.equal(rect.width, 40);
    assert.equal(rect.height, 10);
  });

  it('respects minimum offsets', () => {
    const rect = getCenteredModalRect(8, 20, 18, 6, { minTop: 2, minLeft: 3 });
    assert.ok(rect.top >= 2);
    assert.ok(rect.left >= 3);
  });
});

describe('getWindowedListRange', () => {
  it('returns full range when count fits window', () => {
    assert.deepEqual(getWindowedListRange(4, 1, 10), { start: 0, end: 4 });
  });

  it('centers around cursor when list exceeds window', () => {
    assert.deepEqual(getWindowedListRange(20, 10, 5), { start: 8, end: 13 });
  });

  it('clamps near start and end', () => {
    assert.deepEqual(getWindowedListRange(20, 0, 5), { start: 0, end: 5 });
    assert.deepEqual(getWindowedListRange(20, 19, 5), { start: 15, end: 20 });
  });
});

describe('cursorMarker', () => {
  it('returns the accented prompt glyph for the cursor row', () => {
    const theme = makeTheme('>');
    assert.equal(cursorMarker(theme, true), '<accent.primary>></>');
  });

  it('returns a single space for non-cursor rows so columns align', () => {
    const theme = makeTheme('>');
    assert.equal(cursorMarker(theme, false), ' ');
  });

  it('uses the theme glyph (degrades to ASCII when unicode is off)', () => {
    assert.equal(cursorMarker(makeTheme('>'), true), '<accent.primary>></>');
    assert.equal(cursorMarker(makeTheme('›'), true), '<accent.primary>›</>');
  });
});

describe('cursorStyle', () => {
  it('applies the accent token to the cursor row', () => {
    assert.equal(cursorStyle(makeTheme(), true, 'item'), '<accent.primary>item</>');
  });

  it('applies the default fg.secondary token to inactive rows', () => {
    assert.equal(cursorStyle(makeTheme(), false, 'item'), '<fg.secondary>item</>');
  });

  it('honors a caller-supplied base token for inactive rows', () => {
    assert.equal(cursorStyle(makeTheme(), false, 'item', 'fg.primary'), '<fg.primary>item</>');
  });

  it('ignores the base token when the row is active', () => {
    assert.equal(cursorStyle(makeTheme(), true, 'item', 'fg.primary'), '<accent.primary>item</>');
  });
});
