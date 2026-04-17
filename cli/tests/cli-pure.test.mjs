import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, truncateText, parseBoolFlag } from '../cli.ts';

// ─── clamp ──────────────────────────────────────────────────────

describe('clamp', () => {
  it('returns value when within range', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it('returns min when value is below range', () => {
    assert.equal(clamp(-3, 0, 10), 0);
  });

  it('returns max when value is above range', () => {
    assert.equal(clamp(15, 0, 10), 10);
  });

  it('returns bound when value equals min', () => {
    assert.equal(clamp(0, 0, 10), 0);
  });

  it('returns bound when value equals max', () => {
    assert.equal(clamp(10, 0, 10), 10);
  });

  it('works with negative ranges', () => {
    assert.equal(clamp(-5, -10, -1), -5);
    assert.equal(clamp(-20, -10, -1), -10);
    assert.equal(clamp(0, -10, -1), -1);
  });
});

// ─── truncateText ───────────────────────────────────────────────

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncateText('hello', 100), 'hello');
  });

  it('returns text unchanged at exact maxLength', () => {
    assert.equal(truncateText('abcde', 5), 'abcde');
  });

  it('truncates with ellipsis when over limit', () => {
    const result = truncateText('hello world, this is a long string', 10);
    assert.equal(result, 'hello worl...');
    assert.equal(result.length, 13); // 10 chars + '...'
  });

  it('returns empty string for falsy input', () => {
    assert.equal(truncateText('', 100), '');
    assert.equal(truncateText(null, 100), '');
    assert.equal(truncateText(undefined, 100), '');
  });

  it('uses default maxLength of 100', () => {
    const short = 'a'.repeat(100);
    assert.equal(truncateText(short), short);

    const long = 'a'.repeat(101);
    assert.equal(truncateText(long), 'a'.repeat(100) + '...');
  });
});

// ─── parseBoolFlag ──────────────────────────────────────────────

describe('parseBoolFlag', () => {
  it('returns false for undefined', () => {
    assert.equal(parseBoolFlag(undefined, 'force'), false);
  });

  it('returns true for boolean true', () => {
    assert.equal(parseBoolFlag(true, 'force'), true);
  });

  it('returns false for boolean false', () => {
    assert.equal(parseBoolFlag(false, 'force'), false);
  });

  it('returns true for string "true"', () => {
    assert.equal(parseBoolFlag('true', 'force'), true);
    assert.equal(parseBoolFlag('TRUE', 'force'), true);
    assert.equal(parseBoolFlag('True', 'force'), true);
  });

  it('returns false for string "false"', () => {
    assert.equal(parseBoolFlag('false', 'force'), false);
    assert.equal(parseBoolFlag('FALSE', 'force'), false);
    assert.equal(parseBoolFlag('False', 'force'), false);
  });

  it('returns true for "1"', () => {
    assert.equal(parseBoolFlag('1', 'dry-run'), true);
  });

  it('returns false for "0"', () => {
    assert.equal(parseBoolFlag('0', 'dry-run'), false);
  });

  it('returns true for empty string (flag present with no value)', () => {
    assert.equal(parseBoolFlag('', 'verbose'), true);
  });

  it('throws for invalid string values with flag name in message', () => {
    assert.throws(
      () => parseBoolFlag('maybe', 'force'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('force'), 'error should mention flag name');
        assert.ok(err.message.includes('maybe'), 'error should mention the bad value');
        return true;
      },
    );

    assert.throws(
      () => parseBoolFlag('yes', 'dry-run'),
      (err) => {
        assert.ok(err.message.includes('dry-run'));
        return true;
      },
    );
  });
});
