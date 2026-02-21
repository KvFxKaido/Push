import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFormatter, hasColor, Spinner } from '../format.mjs';

// ─── createFormatter ────────────────────────────────────────────

describe('createFormatter', () => {
  const on  = createFormatter(true);
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
