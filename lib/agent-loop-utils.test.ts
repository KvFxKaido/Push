import { describe, expect, it } from 'vitest';
import { createMutationFailureTracker, getToolInvocationKey } from './agent-loop-utils.js';

describe('createMutationFailureTracker — failure counting', () => {
  it('records persistent failures across calls', () => {
    const t = createMutationFailureTracker();
    t.recordFailure('k');
    t.recordFailure('k');
    t.recordFailure('k');
    expect(t.isRepeatedFailure('k', 3)).toBe(true);
    expect(t.isRepeatedFailure('k', 4)).toBe(false);
  });

  it('keeps failure counts independent across keys', () => {
    const t = createMutationFailureTracker();
    t.recordFailure('a');
    t.recordFailure('a');
    t.recordFailure('b');
    expect(t.isRepeatedFailure('a', 2)).toBe(true);
    expect(t.isRepeatedFailure('b', 2)).toBe(false);
  });

  it('clear() resets failure and consecutive-call state', () => {
    const t = createMutationFailureTracker();
    t.recordFailure('k');
    t.recordCall('k');
    t.recordCall('k');
    t.clear();
    expect(t.isRepeatedFailure('k', 1)).toBe(false);
    expect(t.isRepeatedCall('k', 1)).toBe(false);
  });
});

describe('createMutationFailureTracker — consecutive-call detection', () => {
  it('returns true once the same key has been recorded `limit` times in a row', () => {
    const t = createMutationFailureTracker();
    t.recordCall('ls:/workspace');
    expect(t.isRepeatedCall('ls:/workspace', 3)).toBe(false);
    t.recordCall('ls:/workspace');
    expect(t.isRepeatedCall('ls:/workspace', 3)).toBe(false);
    t.recordCall('ls:/workspace');
    // 3rd consecutive — limit met.
    expect(t.isRepeatedCall('ls:/workspace', 3)).toBe(true);
  });

  it('returns false against a different key even at the same depth', () => {
    const t = createMutationFailureTracker();
    t.recordCall('ls:/workspace');
    t.recordCall('ls:/workspace');
    t.recordCall('ls:/workspace');
    // Same key trips; sibling key does not.
    expect(t.isRepeatedCall('ls:/workspace', 3)).toBe(true);
    expect(t.isRepeatedCall('read:/foo', 3)).toBe(false);
  });

  it('resets the consecutive counter when a different key lands between repetitions', () => {
    // Reproduces the legitimate pattern: read X → edit X → read X again.
    // The edit breaks the same-key streak, so the third "read X" starts
    // fresh and the breaker does not trip.
    const t = createMutationFailureTracker();
    t.recordCall('read:/foo');
    t.recordCall('read:/foo');
    t.recordCall('edit:/foo');
    t.recordCall('read:/foo');
    expect(t.isRepeatedCall('read:/foo', 3)).toBe(false);
    expect(t.isRepeatedCall('read:/foo', 2)).toBe(false);
    expect(t.isRepeatedCall('read:/foo', 1)).toBe(true);
  });

  it('reproduces the `ls /workspace` ×5 loop from the 2026-05-20 failure log', () => {
    // The original session had the Orchestrator call ls /workspace
    // identically across 5 consecutive rounds. With limit=3 the
    // pre-execution check trips starting on round 4 — three calls
    // have already been recorded, so the 4th round's check sees
    // count >= limit and aborts before executing. Rounds 4 and 5
    // each see the breaker tripped; rounds 1-3 do not.
    const t = createMutationFailureTracker();
    const key = getToolInvocationKey('sandbox_list_dir', { path: '/workspace' });
    // The breaker check fires BEFORE the recording step on each round.
    // Simulate the round structure: check → execute → record.
    let tripCount = 0;
    for (let round = 1; round <= 5; round++) {
      if (t.isRepeatedCall(key, 3)) tripCount++;
      t.recordCall(key);
    }
    // Rounds 4 and 5 see the breaker tripped (after rounds 1-3 recorded).
    expect(tripCount).toBe(2);
  });

  it('does not count failures as automatic consecutive calls — `recordCall` is the only path', () => {
    // The two tracking surfaces are independent: `recordFailure` does
    // NOT bump the consecutive-call counter. Callers must wire both.
    const t = createMutationFailureTracker();
    t.recordFailure('k');
    t.recordFailure('k');
    t.recordFailure('k');
    expect(t.isRepeatedCall('k', 1)).toBe(false);
  });

  it('chat-send only checks the first batch call — a preceding different-key call in the same batch resets the streak by execution time', () => {
    // Regression for the Copilot P1 on PR #602: an earlier draft of
    // the breaker pre-scanned every incoming call, which false-
    // positived on `[read_file, ls]` arriving after an `ls` streak —
    // `read_file` would land first at execution time, reset the
    // counter, and `ls` should NOT trip. The chat-send check now
    // applies only to index 0 of the batch. This test pins the
    // tracker behavior the chat-send guard depends on: the prior
    // streak is correctly detected against the first call, and
    // any subsequent same-key calls in the same batch are
    // intentionally not re-checked here.
    const t = createMutationFailureTracker();
    // Prior rounds: three `ls`.
    t.recordCall('ls:/workspace');
    t.recordCall('ls:/workspace');
    t.recordCall('ls:/workspace');
    // Next batch arrives: [read_file, ls]. chat-send only checks
    // index 0 (read_file) against isRepeatedCall.
    expect(t.isRepeatedCall('read:/foo', 3)).toBe(false);
    // ls at index 1 would otherwise still trip from the prior streak,
    // but chat-send skips the check for non-first calls so this is
    // not asked. Documented here so a future refactor that walks the
    // whole batch knows the contract:
    expect(t.isRepeatedCall('ls:/workspace', 3)).toBe(true);
  });
});
