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
  RUN_HOST_ADOPTED_WALL_CLOCK_MS,
  RUN_HOST_ADOPTED_WATCHDOG_MS,
  RUN_HOST_ATTACH_POLL_INTERVAL_MS,
  RUN_HOST_ATTACH_SNAPSHOT_FIELDS,
  RUN_HOST_ATTACH_SNAPSHOT_OPTIONAL_FIELDS,
  RUN_HOST_CHECKPOINT_MAX_BYTES,
  RUN_HOST_HEARTBEAT_INTERVAL_MS,
  RUN_HOST_MAX_ADOPTION_RELAUNCHES,
  RUN_HOST_PROTOCOL_VERSION,
  RUN_HOST_RECORD_ADOPTION_FIELDS,
  RUN_HOST_RECORD_FIELDS,
  RUN_HOST_SILENCE_THRESHOLD_MS,
  RUN_HOST_WATCH_SERVER_FRAME_TYPES,
  RUN_LIFECYCLE_ALARM_ACTIVE_STATES,
  RUN_LIFECYCLE_STATES,
  buildAttachSnapshot,
  checkpointExceedsHostCap,
  decideAdoptedAlarm,
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
  // The alarm now serves three roles (Phase 2 loop): silence detector on
  // `watched`, scheduled adoption retry on `adoptable`, loop watchdog /
  // orphan relaunch on `adopted`. Terminal states stay alarm-free.
  assert.deepEqual([...RUN_LIFECYCLE_ALARM_ACTIVE_STATES], ['watched', 'adoptable', 'adopted']);
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
  // Adoption-loop additions are all OPTIONAL on the record (pre-loop records
  // lack them) and pinned separately so the base vocabulary stays stable.
  // `resolvedApproval` is the Phase 3 attach-control addition.
  assert.deepEqual([...RUN_HOST_RECORD_ADOPTION_FIELDS].sort(), [
    'adoptedAt',
    'adoptionId',
    'adoptionRelaunches',
    'lastError',
    'origin',
    'pausedForApproval',
    'resolvedApproval',
  ]);
});

test('pin: attach snapshot field vocabulary (Phase 3)', () => {
  assert.deepEqual([...RUN_HOST_ATTACH_SNAPSHOT_FIELDS].sort(), [
    'checkpointSavedAt',
    'lastHeartbeatAt',
    'midFlight',
    'mode',
    'round',
    'runId',
    'state',
    'v',
  ]);
  assert.deepEqual([...RUN_HOST_ATTACH_SNAPSHOT_OPTIONAL_FIELDS].sort(), [
    'adoptedAt',
    'checkpoint',
    'lastError',
    'pausedForApproval',
  ]);
});

test('pin: watch server frame vocabulary (Phase 3 refinement)', () => {
  // The `/run/watch` WS push frames the DO sends and the client parses. A
  // drift here is a cross-surface drift (host DO ↔ reopening client read the
  // same module), so the set is pinned alongside the attach snapshot it
  // carries — extending it means updating this pin in the same PR.
  assert.deepEqual([...RUN_HOST_WATCH_SERVER_FRAME_TYPES].sort(), ['error', 'snapshot']);
});

test('pin: load-bearing constants', () => {
  // The DO-storage value cap — a checkpoint above this needs tiering.
  assert.equal(RUN_HOST_CHECKPOINT_MAX_BYTES, 128 * 1024);
  // The documented invariant: ≥3× the cadence, so two dropped beats in a
  // row still don't trip adoption. Pin the stated guarantee, not a weaker one.
  assert.ok(RUN_HOST_SILENCE_THRESHOLD_MS >= RUN_HOST_HEARTBEAT_INTERVAL_MS * 3);
  assert.equal(RUN_HOST_HEARTBEAT_INTERVAL_MS, 15_000);
  assert.equal(RUN_HOST_SILENCE_THRESHOLD_MS, 45_000);
  // Adopted-loop constants: watchdog cadence, bounded relaunches, wall-clock
  // backstop (CoderJob parity).
  assert.equal(RUN_HOST_ADOPTED_WATCHDOG_MS, 60_000);
  assert.equal(RUN_HOST_MAX_ADOPTION_RELAUNCHES, 2);
  assert.equal(RUN_HOST_ADOPTED_WALL_CLOCK_MS, 60 * 60 * 1000);
  // Phase 3 attach cursor-follow cadence — read-only polls, so it may sit
  // under the heartbeat cadence without affecting adoption decisions.
  assert.equal(RUN_HOST_ATTACH_POLL_INTERVAL_MS, 10_000);
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

// ---------------------------------------------------------------------------
// decideAdoptedAlarm — every branch
// ---------------------------------------------------------------------------

function makeAdoptedRecord(overrides = {}) {
  return makeRecord({
    state: 'adopted',
    adoptedAt: 1781000000000,
    adoptionId: 'adoption-1',
    adoptionRelaunches: 0,
    ...overrides,
  });
}

test('adopted watchdog: idle when the record is not adopted', () => {
  const decision = decideAdoptedAlarm(makeRecord(), { now: Date.now(), loopAlive: false });
  assert.equal(decision.action, 'idle');
  assert.equal(decision.reason, 'state_watched');
});

test('adopted watchdog: idle when paused at a supervised approval gate', () => {
  const record = makeAdoptedRecord({
    pausedForApproval: { approvalId: 'adopt-sandbox_push-r5', kind: 'remote_side_effect' },
  });
  const decision = decideAdoptedAlarm(record, {
    now: record.adoptedAt + 5_000,
    loopAlive: false,
  });
  assert.equal(decision.action, 'idle');
  assert.equal(decision.reason, 'paused_for_approval');
});

test('adopted watchdog: expires a run past the wall-clock budget', () => {
  const record = makeAdoptedRecord();
  const decision = decideAdoptedAlarm(record, {
    now: record.adoptedAt + RUN_HOST_ADOPTED_WALL_CLOCK_MS,
    loopAlive: true,
  });
  assert.equal(decision.action, 'expire');
  assert.equal(decision.reason, 'wall_clock_exhausted');
});

test('adopted watchdog: re-arms while the loop is alive', () => {
  const record = makeAdoptedRecord();
  const now = record.adoptedAt + 60_000;
  const decision = decideAdoptedAlarm(record, { now, loopAlive: true });
  assert.equal(decision.action, 'rearm');
  assert.equal(decision.reArmAt, now + RUN_HOST_ADOPTED_WATCHDOG_MS);
  assert.equal(decision.reason, 'loop_alive');
});

test('adopted watchdog: relaunches an orphaned loop (DO eviction)', () => {
  const record = makeAdoptedRecord();
  const decision = decideAdoptedAlarm(record, {
    now: record.adoptedAt + 60_000,
    loopAlive: false,
  });
  assert.equal(decision.action, 'relaunch');
  assert.equal(decision.reason, 'loop_orphaned');
});

test('adopted watchdog: expires when the relaunch cap is exhausted', () => {
  const record = makeAdoptedRecord({ adoptionRelaunches: RUN_HOST_MAX_ADOPTION_RELAUNCHES });
  const decision = decideAdoptedAlarm(record, {
    now: record.adoptedAt + 60_000,
    loopAlive: false,
  });
  assert.equal(decision.action, 'expire');
  assert.equal(decision.reason, 'relaunch_cap_exhausted');
});

// ---------------------------------------------------------------------------
// buildAttachSnapshot (Phase 3) — cursor semantics
// ---------------------------------------------------------------------------

function makeStoredCheckpoint(savedAt) {
  return {
    v: 1,
    chatId: SCOPE.chatId,
    repoFullName: SCOPE.repoFullName,
    branch: SCOPE.branch,
    runId: 'run-1',
    round: 5,
    phase: 'executing_tools',
    savedAt,
    reason: 'turn',
    messages: [{ role: 'user', content: 'goal' }],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'goal',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
  };
}

test('attach snapshot: first attach (no cursor) includes the checkpoint', () => {
  const record = makeRecord({ state: 'adopted', round: 5 });
  const cp = makeStoredCheckpoint(1781000050000);
  const snapshot = buildAttachSnapshot(record, cp, null);
  assert.equal(snapshot.v, RUN_HOST_PROTOCOL_VERSION);
  assert.equal(snapshot.runId, 'run-1');
  assert.equal(snapshot.state, 'adopted');
  assert.equal(snapshot.checkpointSavedAt, cp.savedAt);
  assert.deepEqual(snapshot.checkpoint, cp);
});

test('attach snapshot: a stale cursor gets the fresher checkpoint; a current cursor does not', () => {
  const record = makeRecord();
  const cp = makeStoredCheckpoint(1781000050000);
  const stale = buildAttachSnapshot(record, cp, cp.savedAt - 1);
  assert.deepEqual(stale.checkpoint, cp);
  const current = buildAttachSnapshot(record, cp, cp.savedAt);
  assert.equal(current.checkpoint, undefined);
  assert.equal(current.checkpointSavedAt, cp.savedAt);
});

test('attach snapshot: no stored checkpoint → null cursor, no checkpoint field', () => {
  const snapshot = buildAttachSnapshot(makeRecord({ hasCheckpoint: false }), null, null);
  assert.equal(snapshot.checkpointSavedAt, null);
  assert.equal(snapshot.checkpoint, undefined);
});

test('attach snapshot: carries the pause and error surfaces when present', () => {
  const record = makeRecord({
    state: 'adopted',
    adoptedAt: 1781000010000,
    pausedForApproval: {
      approvalId: 'adopt-sandbox_exec-r5',
      kind: 'destructive_sandbox',
      tool: 'sandbox_exec',
    },
    lastError: 'provider stalled',
  });
  const snapshot = buildAttachSnapshot(record, makeStoredCheckpoint(1781000050000), null);
  assert.equal(snapshot.adoptedAt, 1781000010000);
  assert.equal(snapshot.pausedForApproval.approvalId, 'adopt-sandbox_exec-r5');
  assert.equal(snapshot.pausedForApproval.tool, 'sandbox_exec');
  assert.equal(snapshot.lastError, 'provider stalled');
});
