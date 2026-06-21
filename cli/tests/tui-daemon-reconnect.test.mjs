import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BACKOFF_MS,
  RECONNECT_BACKOFF_MS,
  cancelReconnect,
  createReconnectState,
  nudgeReconnect,
  pickBackoffMs,
  planNextRetry,
  recordAttemptResult,
  secondsUntilNextRetry,
} from '../tui-daemon-reconnect.ts';

describe('pickBackoffMs', () => {
  it('returns the first delay for attempt 0', () => {
    assert.equal(pickBackoffMs(0), RECONNECT_BACKOFF_MS[0]);
    assert.equal(pickBackoffMs(0), 1_000);
  });

  it('walks the schedule for attempts within bounds', () => {
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i += 1) {
      assert.equal(pickBackoffMs(i), RECONNECT_BACKOFF_MS[i]);
    }
  });

  it('clamps to MAX_BACKOFF_MS once the schedule is exhausted', () => {
    assert.equal(pickBackoffMs(RECONNECT_BACKOFF_MS.length), MAX_BACKOFF_MS);
    assert.equal(pickBackoffMs(50), MAX_BACKOFF_MS);
    assert.equal(pickBackoffMs(50), 30_000);
  });

  it('treats negative attempt counts as the first delay (defensive)', () => {
    assert.equal(pickBackoffMs(-1), RECONNECT_BACKOFF_MS[0]);
  });
});

describe('createReconnectState', () => {
  it('starts idle with zero attempts', () => {
    const s = createReconnectState();
    assert.equal(s.phase, 'idle');
    assert.equal(s.attempts, 0);
    assert.equal(s.nextRetryAtMs, null);
  });
});

describe('planNextRetry', () => {
  it('returns a reconnecting state with the first delay on the first call', () => {
    const now = 10_000;
    const { next, delayMs } = planNextRetry(createReconnectState(), now);
    assert.equal(delayMs, 1_000);
    assert.equal(next.phase, 'reconnecting');
    assert.equal(next.attempts, 0);
    assert.equal(next.nextRetryAtMs, now + 1_000);
  });

  it('uses the backoff schedule when attempts have accumulated', () => {
    const now = 50_000;
    const state = { phase: 'reconnecting', attempts: 3, nextRetryAtMs: null };
    const { next, delayMs } = planNextRetry(state, now);
    assert.equal(delayMs, RECONNECT_BACKOFF_MS[3]);
    assert.equal(next.nextRetryAtMs, now + RECONNECT_BACKOFF_MS[3]);
    // Attempt count does NOT bump on plan — it bumps on recordAttemptResult.
    assert.equal(next.attempts, 3);
  });

  it('clamps to the max delay once the schedule is exhausted', () => {
    const state = { phase: 'reconnecting', attempts: 99, nextRetryAtMs: null };
    const { delayMs } = planNextRetry(state, 0);
    assert.equal(delayMs, MAX_BACKOFF_MS);
  });
});

describe('recordAttemptResult', () => {
  it('resets to idle with zero attempts on success', () => {
    const state = { phase: 'reconnecting', attempts: 5, nextRetryAtMs: 12345 };
    const next = recordAttemptResult(state, 'success');
    assert.equal(next.phase, 'idle');
    assert.equal(next.attempts, 0);
    assert.equal(next.nextRetryAtMs, null);
  });

  it('bumps the attempt count on failure and keeps the phase', () => {
    const state = { phase: 'reconnecting', attempts: 2, nextRetryAtMs: 0 };
    const next = recordAttemptResult(state, 'fail');
    assert.equal(next.phase, 'reconnecting');
    assert.equal(next.attempts, 3);
    // nextRetryAtMs is cleared because the caller must re-plan to arm the timer.
    assert.equal(next.nextRetryAtMs, null);
  });
});

describe('cancelReconnect', () => {
  it('returns to idle but preserves attempt count', () => {
    const state = { phase: 'reconnecting', attempts: 4, nextRetryAtMs: 999 };
    const next = cancelReconnect(state);
    assert.equal(next.phase, 'idle');
    assert.equal(next.attempts, 4);
    assert.equal(next.nextRetryAtMs, null);
  });
});

describe('nudgeReconnect', () => {
  it('returns to idle AND zeroes the attempt count (unlike cancelReconnect)', () => {
    const state = { phase: 'reconnecting', attempts: 5, nextRetryAtMs: 999 };
    const next = nudgeReconnect(state);
    assert.equal(next.phase, 'idle');
    assert.equal(next.attempts, 0);
    assert.equal(next.nextRetryAtMs, null);
  });

  it('makes the next planNextRetry start from the top of the ladder', () => {
    // Climb the ladder a few rungs, then nudge: the next plan should be
    // back at the 1s tier, not the deep-backoff tier it had reached.
    let state = createReconnectState();
    for (let i = 0; i < 4; i += 1) state = recordAttemptResult(state, 'fail');
    assert.equal(state.attempts, 4);
    const deep = planNextRetry(state, 0).delayMs;
    assert.equal(deep, RECONNECT_BACKOFF_MS[4]);

    state = nudgeReconnect(state);
    const afterNudge = planNextRetry(state, 0).delayMs;
    assert.equal(afterNudge, RECONNECT_BACKOFF_MS[0]);
    assert.equal(afterNudge, 1_000);
  });
});

describe('secondsUntilNextRetry', () => {
  it('returns 0 for an idle state', () => {
    assert.equal(secondsUntilNextRetry(createReconnectState(), 0), 0);
  });

  it('rounds up so the chip never reads 0 while still waiting', () => {
    const state = { phase: 'reconnecting', attempts: 0, nextRetryAtMs: 3_500 };
    // Asking at now=0 means 3.5s remain → display rounds up to 4.
    assert.equal(secondsUntilNextRetry(state, 0), 4);
  });

  it('returns 0 if the retry is overdue (timer fired but not resolved yet)', () => {
    const state = { phase: 'reconnecting', attempts: 0, nextRetryAtMs: 100 };
    assert.equal(secondsUntilNextRetry(state, 200), 0);
  });
});

describe('integration — full backoff progression', () => {
  it('walks the backoff schedule across failed attempts and resets on success', () => {
    let state = createReconnectState();
    let now = 0;
    const seenDelays = [];

    // Six failed attempts should walk the full schedule once.
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i += 1) {
      const { next, delayMs } = planNextRetry(state, now);
      state = next;
      seenDelays.push(delayMs);
      now += delayMs;
      state = recordAttemptResult(state, 'fail');
    }
    assert.deepEqual(seenDelays, [...RECONNECT_BACKOFF_MS]);

    // A seventh attempt clamps at the max.
    const { delayMs: capped } = planNextRetry(state, now);
    assert.equal(capped, MAX_BACKOFF_MS);

    // Success resets the machine cleanly.
    state = recordAttemptResult(state, 'success');
    assert.equal(state.phase, 'idle');
    assert.equal(state.attempts, 0);
  });
});
