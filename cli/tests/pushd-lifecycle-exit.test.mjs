import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDaemonIdle,
  maybeScheduleLifecycleExit,
  cancelLifecycleExit,
  __setActiveSessionForTesting,
  __evictActiveSessionForTesting,
  __setLifecycleExitForTesting,
  __setLiveConnectionsForTesting,
  __setActiveRelayForTesting,
} from '../pushd.ts';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The grace window is shrunk to 20ms for the tests; give it margin.
const GRACE_MS = 20;
const SETTLE_MS = 70;

describe('pushd lifecycle exit', () => {
  let exitCalls;
  const SID = 'lifecycle-test-session';

  beforeEach(() => {
    exitCalls = 0;
    // Spy exit (also resets liveConnections + arm/fired flags + grace window).
    __setLifecycleExitForTesting(
      () => {
        exitCalls += 1;
      },
      { graceMs: GRACE_MS },
    );
    __setActiveRelayForTesting(null);
    __evictActiveSessionForTesting(SID);
  });

  afterEach(() => {
    __evictActiveSessionForTesting(SID);
    __setActiveRelayForTesting(null);
    __setLifecycleExitForTesting(); // restore SIGTERM default + clear timers
  });

  it('self-exits after the grace window when the last client leaves and the daemon is idle', async () => {
    __setLiveConnectionsForTesting(0);
    assert.equal(isDaemonIdle(), true);
    maybeScheduleLifecycleExit();
    await delay(SETTLE_MS);
    assert.equal(exitCalls, 1, 'idle + no clients + no relay should self-exit');
  });

  it('does NOT exit while a client is still connected', async () => {
    __setLiveConnectionsForTesting(1);
    maybeScheduleLifecycleExit();
    await delay(SETTLE_MS);
    assert.equal(exitCalls, 0);
  });

  it('does NOT exit while a relay (paired phone) is attached', async () => {
    __setLiveConnectionsForTesting(0);
    __setActiveRelayForTesting({ send() {} });
    maybeScheduleLifecycleExit();
    await delay(SETTLE_MS);
    assert.equal(exitCalls, 0, 'a live relay keeps the daemon alive');
  });

  it('cancels the grace window if a client reconnects before it fires', async () => {
    __setLiveConnectionsForTesting(0);
    maybeScheduleLifecycleExit(); // arm
    // Reconnect within the grace window (mirrors handleConnection).
    __setLiveConnectionsForTesting(1);
    cancelLifecycleExit('client_connected');
    await delay(SETTLE_MS);
    assert.equal(exitCalls, 0, 'a reconnect must abort the pending exit');
  });

  it('waits for an in-flight durable run to settle, then exits', async () => {
    __setLiveConnectionsForTesting(0);
    __setActiveSessionForTesting(SID, {
      state: { sessionId: SID },
      attachToken: 't',
      activeRunId: 'run-1',
    });
    assert.equal(isDaemonIdle(), false);

    maybeScheduleLifecycleExit(); // arms, but re-arms on fire because not idle
    await delay(SETTLE_MS);
    assert.equal(exitCalls, 0, 'must not exit while the durable run is in flight');

    // Run completes — the next grace tick sees idle and exits.
    __setActiveSessionForTesting(SID, {
      state: { sessionId: SID },
      attachToken: 't',
      activeRunId: null,
    });
    await delay(SETTLE_MS);
    assert.equal(exitCalls, 1, 'exits once the durable run settles');
  });
});
