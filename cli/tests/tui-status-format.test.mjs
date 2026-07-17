/**
 * tui-status-format.test.mjs — formatElapsed + formatTokenCount.
 *
 * Pure formatting helpers for the Silvery header and footer. The
 * `renderStatusBar` block that used to live here went with the function: it
 * painted into the ANSI `ScreenBuffer` that no longer exists, and its green
 * tests were the reason nobody noticed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatElapsed, formatTokenCount, formatWorkspaceStateView } from '../tui-status.ts';

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
    assert.equal(formatTokenCount(1_000_000), '1m');
    assert.equal(formatTokenCount(1_050_000), '1.1m');
    assert.equal(formatTokenCount(2_000_000), '2m');
  });
});

describe('formatWorkspaceStateView', () => {
  it('renders branch, dirty count, tracking, and runtime guards', () => {
    assert.equal(
      formatWorkspaceStateView(
        {
          workspaceId: 'sess_ws',
          rev: 3,
          state: {
            activeBranch: 'feature/workspace',
            headSha: 'abc1234',
            ahead: 2,
            behind: 1,
            dirtyFiles: [
              { path: 'a.ts', status: 'modified' },
              { path: 'b.ts', status: 'untracked' },
            ],
            protectMain: true,
            sandboxReady: true,
          },
        },
        80,
      ),
      'feature/workspace +2 ↑2 ↓1 protect-main sandbox-ready',
    );
  });

  it('renders clean state and disabled guards explicitly', () => {
    assert.equal(
      formatWorkspaceStateView(
        {
          workspaceId: 'sess_ws',
          rev: 0,
          state: {
            activeBranch: 'main',
            headSha: 'abc1234',
            dirtyFiles: [],
            protectMain: false,
            sandboxReady: false,
          },
        },
        80,
      ),
      'main clean no-protect-main sandbox-wait',
    );
  });
});
