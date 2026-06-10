/**
 * RunHost adoption vocabulary drift pin + decision-kernel unit tests —
 * Durable Runs (Adopt-on-Silence) Phase 2 substrate.
 *
 * Same discipline as run-checkpoint-drift.test.mjs: the lifecycle states,
 * record field vocabulary, protocol version, and the load-bearing constants
 * are pinned here so the run-ledger contract can't grow, shrink, or shift
 * silently. The host DO (`app/src/worker/run-host-do.ts`) and the reopening
 * client both read this module, so a drift here is a cross-surface drift —
 * extending the vocabulary means updating this pin in the same PR.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  RUN_HOST_CHECKPOINT_MAX_BYTES,
  RUN_HOST_HEARTBEAT_INTERVAL_MS,
  RUN_HOST_PROTOCOL_VERSION,
  RUN_HOST_RECORD_FIELDS,
  RUN_HOST_SILENCE_THRESHOLD_MS,
  RUN_LIFECYCLE_ALARM_ACTIVE_STATES,
  RUN_LIFECYCLE_STATES,
  checkpointExceedsHostCap,
  decideAdoption,
  isCompleteScope,
  runHostInstanceId,
} from '../../lib/run-host-adoption.ts';

const SCOPE = { repoFullName: 'KvFxKaido/Push', branch: 'main', chatId: 'chat-1' };

function makeRecord(overrides = {}) {
  return {
    v: RUN_HOST_PROTOCOL_VERSION,
    runId: 'run-1',
    scope: SCOPE,
    mode: 'supervised',
    state: 'watched',
    registeredAt: 1781000000000,
    lastHeartbeatAt: 1781000000000,
    hasCheckpoint: true,
    midFlight: true,
    round: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE PIN — version, lifecycle, record fields, constants
// ---------------------------------------------------------------------------

test('pin: protocol version', () => {
  assert.equal(RUN_HOST_PROTOCOL_VERSION, 1);
});

test('pin: exact lifecycle state set + alarm-active subset', () => {
  assert.deepEqual(
    [...RUN_LIFECYCLE_STATES],
    ['watched', 'adoptable', 'adopted', 'released', 'ended'],
  );
  // Only `watched` runs are the silence alarm's to act on.
  assert.deepEqual([...RUN_LIFECYCLE_ALARM_ACTIVE_STATES], ['watched']);
});

test('pin: exact record field vocabulary', () => {
  assert.deepEqual([...RUN_HOST_RECORD_FIELDS].sort(), [
    'hasCheckpoint',
    'lastHeartbeatAt',
    'midFlight',
    'mode',
    'registeredAt',
    'round',
    'runId',
    'scope',
    'state',
    'v',
  ]);
});

test('pin: load-bearing constants', () => {
  // The DO-storage value cap — a checkpoint above this needs tiering.
  assert.equal(RUN_HOST_CHECKPOINT_MAX_BYTES, 128 * 1024);
  // The documented invariant: ≥3× the cadence, so two dropped beats in a
  // row still don't trip adoption. Pin the stated guarantee, not a weaker one.
  assert.ok(RUN_HOST_SILENCE_THRESHOLD_MS >= RUN_HOST_HEARTBEAT_INTERVAL_MS * 3);
  assert.equal(RUN_HOST_HEARTBEAT_INTERVAL_MS, 15_000);
  assert.equal(RUN_HOST_SILENCE_THRESHOLD_MS, 45_000);
});

// ---------------------------------------------------------------------------
// Scope → instance
// ---------------------------------------------------------------------------

test('runHostInstanceId is deterministic and scope-versioned', () => {
  assert.equal(runHostInstanceId(SCOPE), runHostInstanceId({ ...SCOPE }));
  assert.match(runHostInstanceId(SCOPE), /^runhost:v1:/);
});

test('runHostInstanceId cannot collide distinct scopes through the delimiter', () => {
  // A branch containing the delimiter must not alias onto another scope.
  const a = runHostInstanceId({ repoFullName: 'o/r', branch: 'a:b', chatId: 'c' });
  const b = runHostInstanceId({ repoFullName: 'o/r', branch: 'a', chatId: 'b:c' });
  assert.notEqual(a, b);
  // Different chat → different instance.
  assert.notEqual(runHostInstanceId(SCOPE), runHostInstanceId({ ...SCOPE, chatId: 'chat-2' }));
});

test('isCompleteScope requires all three non-empty parts', () => {
  assert.ok(isCompleteScope(SCOPE));
  assert.ok(!isCompleteScope({ repoFullName: 'o/r', branch: 'main' }));
  assert.ok(!isCompleteScope({ ...SCOPE, chatId: '' }));
  assert.ok(!isCompleteScope(null));
  assert.ok(!isCompleteScope('o/r:main:chat'));
});

// ---------------------------------------------------------------------------
// Byte cap
// ---------------------------------------------------------------------------

test('checkpointExceedsHostCap is a strict over-cap test', () => {
  assert.ok(!checkpointExceedsHostCap(RUN_HOST_CHECKPOINT_MAX_BYTES));
  assert.ok(checkpointExceedsHostCap(RUN_HOST_CHECKPOINT_MAX_BYTES + 1));
  assert.ok(!checkpointExceedsHostCap(1024));
});

// ---------------------------------------------------------------------------
// decideAdoption — every branch
// ---------------------------------------------------------------------------

test('adopts a watched, mid-flight run with a checkpoint once heartbeats lapse', () => {
  const record = makeRecord();
  const now = record.lastHeartbeatAt + RUN_HOST_SILENCE_THRESHOLD_MS;
  const decision = decideAdoption(record, now);
  assert.equal(decision.action, 'adopt');
  assert.equal(decision.reason, 'heartbeat_lapsed');
});

test('re-arms while still within the silence window', () => {
  const record = makeRecord();
  const now = record.lastHeartbeatAt + RUN_HOST_SILENCE_THRESHOLD_MS - 1;
  const decision = decideAdoption(record, now);
  assert.equal(decision.action, 'rearm');
  assert.equal(decision.reArmAt, record.lastHeartbeatAt + RUN_HOST_SILENCE_THRESHOLD_MS);
  assert.equal(decision.reason, 'still_watched');
});

test('idle when not in an alarm-active state', () => {
  for (const state of ['adoptable', 'adopted', 'released', 'ended']) {
    const decision = decideAdoption(makeRecord({ state }), Date.now() + 10 * 60_000);
    assert.equal(decision.action, 'idle');
    assert.equal(decision.reason, `state_${state}`);
  }
});

test('idle when no checkpoint has been captured yet', () => {
  const record = makeRecord({ hasCheckpoint: false });
  const decision = decideAdoption(record, record.lastHeartbeatAt + RUN_HOST_SILENCE_THRESHOLD_MS);
  assert.equal(decision.action, 'idle');
  assert.equal(decision.reason, 'no_checkpoint');
});

test('idle when the run is no longer mid-flight (completed / aborted)', () => {
  const record = makeRecord({ midFlight: false });
  const decision = decideAdoption(record, record.lastHeartbeatAt + RUN_HOST_SILENCE_THRESHOLD_MS);
  assert.equal(decision.action, 'idle');
  assert.equal(decision.reason, 'not_mid_flight');
});

test('decision order: state is checked before checkpoint/mid-flight', () => {
  // A released run with no checkpoint reports the state reason, not no_checkpoint.
  const decision = decideAdoption(
    makeRecord({ state: 'released', hasCheckpoint: false, midFlight: false }),
    Date.now(),
  );
  assert.equal(decision.reason, 'state_released');
});
