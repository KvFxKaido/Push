import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startElapsedMs } from '../../lib/monotonic-elapsed.ts';

describe('startElapsedMs', () => {
  it('returns a non-negative whole number of milliseconds', () => {
    const elapsed = startElapsedMs();
    const ms = elapsed();
    assert.ok(Number.isInteger(ms), `expected integer, got ${ms}`);
    assert.ok(ms >= 0, `expected non-negative, got ${ms}`);
  });

  it('stays non-negative when the wall clock (Date.now) steps backward', () => {
    // The exec-card / run-event bug: measuring `Date.now() - start` went
    // negative when the WALL clock stepped backward mid-operation (WSL2
    // host-clock skew, NTP correction, VM resume). startElapsedMs uses the
    // MONOTONIC clock, so faking Date.now backward cannot make it negative.
    const realDateNow = Date.now;
    const elapsed = startElapsedMs();
    Date.now = () => realDateNow() - 132_000; // ~132s back — the observed jump
    try {
      const ms = elapsed();
      assert.ok(ms >= 0, `monotonic elapsed must stay non-negative, got ${ms}`);
      // Precondition: the naive Date.now-based measurement WOULD go negative,
      // which is exactly the "-132323" the exec card was showing.
      const naive = Date.now() - realDateNow();
      assert.ok(naive < 0, 'expected the faked wall clock to be backward');
    } finally {
      Date.now = realDateNow;
    }
  });
});
