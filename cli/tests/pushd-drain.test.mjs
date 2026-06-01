import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleDrain,
  noteRunSettled,
  isDaemonIdle,
  __setActiveSessionForTesting,
  __evictActiveSessionForTesting,
  __setDrainExitForTesting,
} from '../pushd.ts';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The drain self-exit fires on a 50ms timer; give it margin before asserting.
const EXIT_SETTLE_MS = 130;

describe('pushd drain', () => {
  let exitCalls;
  const SID = 'drain-test-session';

  beforeEach(() => {
    exitCalls = 0;
    // Inject a spy exit (also resets `draining` + `drainExitScheduled`) so the
    // handler never SIGTERMs the test runner.
    __setDrainExitForTesting(() => {
      exitCalls += 1;
    });
    __evictActiveSessionForTesting(SID);
  });

  afterEach(() => {
    __evictActiveSessionForTesting(SID);
    __setDrainExitForTesting(); // restore SIGTERM default
  });

  it('reports idle and schedules self-exit when no run is in flight', async () => {
    assert.equal(isDaemonIdle(), true);
    const res = await handleDrain({ requestId: 'r1', payload: {} });
    assert.equal(res.ok, true);
    assert.equal(res.payload.draining, true);
    assert.equal(res.payload.idle, true);
    assert.deepEqual(res.payload.pendingRuns, []);
    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 1, 'idle drain should self-exit');
  });

  it('defers self-exit while a run is active, then exits once it settles', async () => {
    __setActiveSessionForTesting(SID, {
      state: { sessionId: SID },
      attachToken: 't',
      activeRunId: 'run-1',
    });
    assert.equal(isDaemonIdle(), false);

    const res = await handleDrain({ requestId: 'r2', payload: { reason: 'stale' } });
    assert.equal(res.ok, true);
    assert.equal(res.payload.draining, true);
    assert.equal(res.payload.idle, false);
    assert.equal(res.payload.pendingRuns.length, 1);
    assert.equal(res.payload.pendingRuns[0].runId, 'run-1');

    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 0, 'must NOT exit while a run is in flight');

    // Simulate the run completing: clear the marker and notify.
    const entry = { state: { sessionId: SID }, attachToken: 't', activeRunId: null };
    __setActiveSessionForTesting(SID, entry);
    noteRunSettled();
    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 1, 'should self-exit once the daemon goes idle');
  });

  it('self-exits on background work (delegation) settling, with no noteRunSettled call', async () => {
    // Regression for the three-reviewer CRITICAL: a drain blocked solely on a
    // delegation/task graph (no activeRunId). The delegation-cleanup paths do
    // NOT call noteRunSettled(), so the drain idle watcher is what guarantees
    // the eventual self-exit. This test deliberately never calls noteRunSettled.
    __setActiveSessionForTesting(SID, {
      state: { sessionId: SID },
      attachToken: 't',
      activeRunId: null,
      activeDelegations: new Map([['sub-1', { kind: 'explorer' }]]),
      activeGraphs: new Map(),
    });
    assert.equal(isDaemonIdle(), false);

    const res = await handleDrain({ requestId: 'r-bg', payload: {} });
    assert.equal(res.payload.idle, false);
    // The response reports the background work, not "0 runs".
    assert.equal(res.payload.pendingRuns.length, 0);
    assert.equal(res.payload.pendingDelegations, 1);
    assert.equal(res.payload.pendingWork, 1);

    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 0, 'must not exit while the delegation is active');

    // Delegation completes (cleanup deletes from the map) — no notifier call.
    __setActiveSessionForTesting(SID, {
      state: { sessionId: SID },
      attachToken: 't',
      activeRunId: null,
      activeDelegations: new Map(),
      activeGraphs: new Map(),
    });
    // Wait past at least one watcher poll tick (250ms) + the 50ms exit timer.
    await delay(450);
    assert.equal(exitCalls, 1, 'watcher should self-exit once background work clears');
  });

  it('rejects a relay-originated drain but allows a loopback drain', async () => {
    // Denied path: a relay sender (paired phone) must not be able to drain.
    const denied = await handleDrain({ requestId: 'r-relay', payload: {} }, () => {}, {
      relaySenderId: 'phone-abc',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'FORBIDDEN');
    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 0, 'a rejected drain must not schedule an exit');

    // Allowed path: loopback (no relaySenderId) proceeds.
    const allowed = await handleDrain({ requestId: 'r-loopback', payload: {} }, () => {}, null);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.payload.draining, true);
    // The allowed (idle) drain schedules a 50ms self-exit. Drain that timer
    // here, while this test's spy is still installed, so it can't leak into a
    // later test (or fire SIGTERM after afterEach restores the default).
    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 1);
  });

  it('noteRunSettled is a no-op when not draining', async () => {
    // No drain requested in this test (beforeEach reset draining=false).
    noteRunSettled();
    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 0);
  });

  it('idle-exit is scheduled at most once', async () => {
    await handleDrain({ requestId: 'r3', payload: {} });
    // A second drain while already draining must not schedule a second exit.
    await handleDrain({ requestId: 'r4', payload: {} });
    await delay(EXIT_SETTLE_MS);
    assert.equal(exitCalls, 1, 'duplicate drains must not double-exit');
  });
});
