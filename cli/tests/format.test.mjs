import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFormatter, formatRelativeTime, hasColor, Spinner } from '../format.ts';

// ─── createFormatter ────────────────────────────────────────────

describe('createFormatter', () => {
  const on = createFormatter(true);
  const off = createFormatter(false);

  it('bold wraps with ANSI when enabled', () => {
    assert.equal(on.bold('hi'), '\x1b[1mhi\x1b[22m');
  });

  it('bold returns plain text when disabled', () => {
    assert.equal(off.bold('hi'), 'hi');
  });

  it('dim wraps with ANSI when enabled', () => {
    assert.equal(on.dim('x'), '\x1b[2mx\x1b[22m');
  });

  it('dim returns plain text when disabled', () => {
    assert.equal(off.dim('x'), 'x');
  });

  it('red wraps with ANSI when enabled', () => {
    assert.equal(on.red('err'), '\x1b[31merr\x1b[39m');
  });

  it('red returns plain text when disabled', () => {
    assert.equal(off.red('err'), 'err');
  });

  it('green wraps with ANSI when enabled', () => {
    assert.equal(on.green('ok'), '\x1b[32mok\x1b[39m');
  });

  it('green returns plain text when disabled', () => {
    assert.equal(off.green('ok'), 'ok');
  });

  it('yellow wraps with ANSI when enabled', () => {
    assert.equal(on.yellow('warn'), '\x1b[33mwarn\x1b[39m');
  });

  it('yellow returns plain text when disabled', () => {
    assert.equal(off.yellow('warn'), 'warn');
  });

  it('cyan wraps with ANSI when enabled', () => {
    assert.equal(on.cyan('info'), '\x1b[36minfo\x1b[39m');
  });

  it('cyan returns plain text when disabled', () => {
    assert.equal(off.cyan('info'), 'info');
  });

  it('success is green', () => {
    assert.equal(on.success('pass'), on.green('pass'));
  });

  it('warn is yellow', () => {
    assert.equal(on.warn('caution'), on.yellow('caution'));
  });

  it('error is bold+red (compound)', () => {
    const expected = '\x1b[1m\x1b[31mbad\x1b[39m\x1b[22m';
    assert.equal(on.error('bad'), expected);
  });

  it('error returns plain text when disabled', () => {
    assert.equal(off.error('bad'), 'bad');
  });

  it('handles non-string input (number)', () => {
    assert.equal(off.bold(42), '42');
    assert.match(on.bold(42), /42/);
  });

  it('handles non-string input (undefined)', () => {
    assert.equal(off.dim(undefined), 'undefined');
    assert.match(on.dim(undefined), /undefined/);
  });
});

// ─── formatRelativeTime ─────────────────────────────────────────

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000; // frozen reference so bands are deterministic

  it('returns "just now" for deltas under a minute', () => {
    assert.equal(formatRelativeTime(NOW - 500, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 59_999, NOW), 'just now');
  });

  it('returns Nm ago for minutes under an hour', () => {
    assert.equal(formatRelativeTime(NOW - 60_000, NOW), '1m ago');
    assert.equal(formatRelativeTime(NOW - 59 * 60_000, NOW), '59m ago');
  });

  it('returns Nh ago for hours under a day', () => {
    assert.equal(formatRelativeTime(NOW - 60 * 60_000, NOW), '1h ago');
    assert.equal(formatRelativeTime(NOW - 23 * 3_600_000, NOW), '23h ago');
  });

  it('returns "yesterday" for exactly one day ago', () => {
    assert.equal(formatRelativeTime(NOW - 24 * 3_600_000, NOW), 'yesterday');
    assert.equal(formatRelativeTime(NOW - 47 * 3_600_000, NOW), 'yesterday');
  });

  it('returns Nd ago for days under a week', () => {
    assert.equal(formatRelativeTime(NOW - 2 * 86_400_000, NOW), '2d ago');
    assert.equal(formatRelativeTime(NOW - 6 * 86_400_000, NOW), '6d ago');
  });

  it('returns Nw ago for weeks under a month', () => {
    assert.equal(formatRelativeTime(NOW - 7 * 86_400_000, NOW), '1w ago');
    assert.equal(formatRelativeTime(NOW - 21 * 86_400_000, NOW), '3w ago');
  });

  it('returns Nmo ago for months under a year', () => {
    assert.equal(formatRelativeTime(NOW - 40 * 86_400_000, NOW), '1mo ago');
    assert.equal(formatRelativeTime(NOW - 200 * 86_400_000, NOW), '6mo ago');
  });

  it('returns Ny ago for years', () => {
    assert.equal(formatRelativeTime(NOW - 400 * 86_400_000, NOW), '1y ago');
    assert.equal(formatRelativeTime(NOW - 3 * 365 * 86_400_000, NOW), '3y ago');
  });

  it('returns "future" for timestamps ahead of now (clock skew)', () => {
    assert.equal(formatRelativeTime(NOW + 5_000, NOW), 'future');
  });

  it('defaults `now` to Date.now() when omitted', () => {
    // Don't freeze time; just assert the return shape is a legal band.
    const out = formatRelativeTime(Date.now() - 10_000);
    assert.match(out, /^(just now|\d+m ago)$/);
  });
});

// ─── hasColor ───────────────────────────────────────────────────

describe('hasColor', () => {
  it('is a boolean', () => {
    assert.equal(typeof hasColor, 'boolean');
  });
});

// ─── Spinner ────────────────────────────────────────────────────

describe('Spinner', () => {
  it('starts inactive', () => {
    const s = new Spinner(false);
    assert.equal(s.active, false);
  });

  it('start is a no-op when color disabled', () => {
    const s = new Spinner(false);
    s.start('test');
    assert.equal(s.active, false);
    s.stop(); // safe to call even if not active
  });

  it('has correct frame count', () => {
    assert.equal(Spinner.FRAMES.length, 10);
  });

  it('has 80ms interval', () => {
    assert.equal(Spinner.INTERVAL, 80);
  });
});
