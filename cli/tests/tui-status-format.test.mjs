/**
 * tui-status-format.test.mjs — formatElapsed + formatTokenCount.
 *
 * Both are pure formatting helpers used by the running indicator and
 * the status bar. Tested here separately from
 * renderStatusBar so the format conventions are pinned without
 * needing a screen buffer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatElapsed, formatTokenCount } from '../tui-status.ts';

describe('formatElapsed', () => {
  it('renders sub-second as 0s', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(500), '0s');
  });

  it('renders sub-minute as Ys', () => {
    assert.equal(formatElapsed(1_000), '1s');
    assert.equal(formatElapsed(45_000), '45s');
    assert.equal(formatElapsed(59_999), '59s');
  });

  it('renders minute boundary as Xm 0s', () => {
    assert.equal(formatElapsed(60_000), '1m 0s');
    assert.equal(formatElapsed(120_000), '2m 0s');
  });

  it('renders Xm Ys for multi-minute durations', () => {
    assert.equal(formatElapsed(65_000), '1m 5s');
    assert.equal(formatElapsed(245_000), '4m 5s');
    assert.equal(formatElapsed(3_725_000), '62m 5s');
  });

  it('clamps negative and non-finite to 0', () => {
    assert.equal(formatElapsed(-100), '0s');
    assert.equal(formatElapsed(NaN), '0s');
    assert.equal(formatElapsed(Infinity), '0s');
  });
});

describe('formatTokenCount', () => {
  it('renders < 1k as raw integer', () => {
    assert.equal(formatTokenCount(0), '0');
    assert.equal(formatTokenCount(1), '1');
    assert.equal(formatTokenCount(999), '999');
  });

  it('renders < 10k with one decimal', () => {
    assert.equal(formatTokenCount(1_000), '1.0k');
    assert.equal(formatTokenCount(4_100), '4.1k');
    assert.equal(formatTokenCount(9_900), '9.9k');
  });

  it('renders >= 10k as rounded thousands', () => {
    assert.equal(formatTokenCount(10_000), '10k');
    assert.equal(formatTokenCount(17_900), '18k');
    assert.equal(formatTokenCount(100_000), '100k');
  });
});
