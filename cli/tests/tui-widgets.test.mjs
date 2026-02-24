import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getCenteredModalRect, getWindowedListRange } from '../tui-widgets.mjs';

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

