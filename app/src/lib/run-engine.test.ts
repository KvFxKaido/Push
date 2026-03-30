/**
 * run-engine.test.ts
 *
 * Replay tests for the RunEngine reducer (Track A, Phase 0).
 *
 * No mocks needed — the reducer is pure. Tests supply sequences of events and
 * assert the resulting state. Each scenario corresponds to a real code path in
 * the sendMessage loop; the comments call out which lines in useChat.ts /
 * useChatCheckpoint.ts the scenario covers.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { QueuedFollowUp } from '@/types';
import {
  collectRunEngineParityIssues,
  IDLE_RUN_STATE,
  isRunActive,
  replayEvents,
  runEngineReducer,
  type RunEngineEvent,
  type RunEngineState,
} from './run-engine';

// ---------------------------------------------------------------------------
// Monotonic test clock
//
// The reducer requires timestamps on every event. Using a simple counter
// gives deterministic, human-readable values (1, 2, 3…) without needing
// fake timers. Reset in beforeEach so each test starts at 1.
// ---------------------------------------------------------------------------

let clock = 0;
function t(): number {
  return ++clock;
}

beforeEach(() => {
  clock = 0;
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeRunStarted(
  overrides: Partial<Extract<RunEngineEvent, { type: 'RUN_STARTED' }>> = {},
): RunEngineEvent {
  return {
    type: 'RUN_STARTED',
    timestamp: t(),
    runId: 'run-1',
    chatId: 'chat-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    baseMessageCount: 2,
    ...overrides,
  };
}

function makeFollowUp(text = 'follow up'): QueuedFollowUp {
  return { text, queuedAt: t() };
}

/** Apply a sequence of events to IDLE_RUN_STATE and return the final state. */
function run(events: RunEngineEvent[]): RunEngineState {
  return replayEvents(IDLE_RUN_STATE, events);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run-engine', () => {

  // ─── IDLE_RUN_STATE shape ────────────────────────────────────────────────

  it('IDLE_RUN_STATE has expected zero values', () => {
    expect(IDLE_RUN_STATE.phase).toBe('idle');
    expect(IDLE_RUN_STATE.runId).toBe('');
    expect(IDLE_RUN_STATE.chatId).toBe('');
    expect(IDLE_RUN_STATE.queuedFollowUps).toEqual([]);
    expect(IDLE_RUN_STATE.hasPendingSteer).toBe(false);
    expect(IDLE_RUN_STATE.tabLockId).toBeNull();
    expect(IDLE_RUN_STATE.failureReason).toBeNull();
    expect(IDLE_RUN_STATE.loopCompletedNormally).toBe(false);
    expect(IDLE_RUN_STATE.startedAt).toBe(0);
    expect(IDLE_RUN_STATE.lastUpdatedAt).toBe(0);
  });

  // ─── Normal happy path ───────────────────────────────────────────────────
  //
  // Covers: sendMessage startup (line ~882), round loop (line ~949),
  // loopCompletedNormally flag (line ~1125), finally block cleanup (line ~1134).

  it('normal happy path: two-round run completes cleanly', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-abc' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'Hello', thinking: '' },
      { type: 'TOOLS_STARTED',       timestamp: t() },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 1 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'World', thinking: '' },
      { type: 'LOOP_COMPLETED',      timestamp: t() },
    ]);

    expect(state.phase).toBe('completed');
    expect(state.loopCompletedNormally).toBe(true);
    expect(state.round).toBe(1);
    expect(state.tabLockId).toBeNull();
    expect(state.failureReason).toBeNull();
    expect(state.chatId).toBe('chat-1');
    expect(state.provider).toBe('anthropic');
  });

  it('RUN_STARTED resets identity and clears accumulated content', () => {
    const state = runEngineReducer(IDLE_RUN_STATE, makeRunStarted());

    expect(state.phase).toBe('starting');
    expect(state.runId).toBe('run-1');
    expect(state.chatId).toBe('chat-1');
    expect(state.accumulatedText).toBe('');
    expect(state.accumulatedThinking).toBe('');
    expect(state.loopCompletedNormally).toBe(false);
    expect(state.failureReason).toBeNull();
    expect(state.tabLockId).toBeNull();
    expect(state.startedAt).toBeGreaterThan(0);
  });

  it('RUN_STARTED preserves same-chat queued follow-ups across runs', () => {
    const previous: RunEngineState = {
      ...IDLE_RUN_STATE,
      runId: 'run-old',
      chatId: 'chat-1',
      phase: 'completed',
      queuedFollowUps: [makeFollowUp('keep me')],
    };

    const state = runEngineReducer(previous, makeRunStarted());

    expect(state.chatId).toBe('chat-1');
    expect(state.queuedFollowUps).toHaveLength(1);
    expect(state.queuedFollowUps[0].text).toBe('keep me');
  });

  it('ROUND_STARTED resets accumulated content and advances round', () => {
    const s0 = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'partial', thinking: 'hmm' },
      { type: 'TOOLS_STARTED',       timestamp: t() },
    ]);
    const s1 = runEngineReducer(s0, { type: 'ROUND_STARTED', timestamp: t(), round: 1 });

    expect(s1.round).toBe(1);
    expect(s1.phase).toBe('streaming_llm');
    expect(s1.accumulatedText).toBe('');
    expect(s1.accumulatedThinking).toBe('');
  });

  // ─── Tab lock denial ─────────────────────────────────────────────────────
  //
  // Covers: tab lock guard in sendMessage (~line 886).

  it('TAB_LOCK_DENIED sets phase to failed with tab_lock_denied reason', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_DENIED', timestamp: t() },
    ]);

    expect(state.phase).toBe('failed');
    expect(state.failureReason).toBe('tab_lock_denied');
    expect(state.tabLockId).toBeNull();
    expect(state.loopCompletedNormally).toBe(false);
  });

  it('TAB_LOCK_ACQUIRED sets tabLockId without changing phase', () => {
    const s0 = runEngineReducer(IDLE_RUN_STATE, makeRunStarted());
    const s1 = runEngineReducer(s0, { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-xyz' });

    expect(s1.tabLockId).toBe('lock-xyz');
    expect(s1.phase).toBe('starting');
  });

  // ─── Abort ───────────────────────────────────────────────────────────────
  //
  // Covers: abortRef.current check in the loop (~line 987), finally block.

  it('LOOP_ABORTED sets phase to aborted and clears tabLockId', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'partial...', thinking: '' },
      { type: 'LOOP_ABORTED',        timestamp: t() },
    ]);

    expect(state.phase).toBe('aborted');
    expect(state.loopCompletedNormally).toBe(false);
    expect(state.tabLockId).toBeNull();
  });

  it('LOOP_FAILED stores reason and clears tabLockId', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',     timestamp: t(), round: 0 },
      { type: 'LOOP_FAILED',       timestamp: t(), reason: 'network_error' },
    ]);

    expect(state.phase).toBe('failed');
    expect(state.failureReason).toBe('network_error');
    expect(state.tabLockId).toBeNull();
    expect(state.loopCompletedNormally).toBe(false);
  });

  // ─── STREAMING_COMPLETED does not advance phase ──────────────────────────
  //
  // Key invariant: phase moves to 'executing_tools' only on TOOLS_STARTED,
  // not on STREAMING_COMPLETED. Mirrors checkpointRefs.phase assignment in
  // useChat.ts (~line 1071: phase set to 'executing_tools' after flushCheckpoint).

  it('STREAMING_COMPLETED updates content but keeps streaming_llm phase', () => {
    const s0 = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',     timestamp: t(), round: 0 },
    ]);
    const s1 = runEngineReducer(s0, {
      type: 'STREAMING_COMPLETED',
      timestamp: t(),
      accumulated: 'some text',
      thinking: 'some thinking',
    });

    expect(s1.phase).toBe('streaming_llm');
    expect(s1.accumulatedText).toBe('some text');
    expect(s1.accumulatedThinking).toBe('some thinking');
  });

  it('TOOLS_STARTED advances phase to executing_tools', () => {
    const s0 = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'text', thinking: '' },
    ]);
    const s1 = runEngineReducer(s0, { type: 'TOOLS_STARTED', timestamp: t() });

    expect(s1.phase).toBe('executing_tools');
  });

  // ─── Follow-up queue ─────────────────────────────────────────────────────
  //
  // Covers: enqueueQueuedFollowUp (~line 763), dequeueQueuedFollowUp in finally
  // (~line 1159), clearQueuedFollowUps (~line 1157).

  it('queue: enqueue two items, dequeue one removes the first (FIFO)', () => {
    const first = makeFollowUp('first');
    const second = makeFollowUp('second');

    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'FOLLOW_UP_ENQUEUED',  timestamp: t(), followUp: first },
      { type: 'FOLLOW_UP_ENQUEUED',  timestamp: t(), followUp: second },
      { type: 'FOLLOW_UP_DEQUEUED',  timestamp: t() },
    ]);

    expect(state.queuedFollowUps).toHaveLength(1);
    expect(state.queuedFollowUps[0].text).toBe('second');
  });

  it('queue: FOLLOW_UP_QUEUE_CLEARED empties the queue', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',      timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',          timestamp: t(), round: 0 },
      { type: 'FOLLOW_UP_ENQUEUED',     timestamp: t(), followUp: makeFollowUp('a') },
      { type: 'FOLLOW_UP_ENQUEUED',     timestamp: t(), followUp: makeFollowUp('b') },
      { type: 'FOLLOW_UP_QUEUE_CLEARED', timestamp: t() },
    ]);

    expect(state.queuedFollowUps).toHaveLength(0);
  });

  it('queue: FOLLOW_UP_DEQUEUED on empty queue leaves empty queue', () => {
    const state = run([
      makeRunStarted(),
      { type: 'FOLLOW_UP_DEQUEUED', timestamp: t() },
    ]);

    expect(state.queuedFollowUps).toHaveLength(0);
  });

  // ─── Steer ───────────────────────────────────────────────────────────────
  //
  // Covers: setPendingSteer (~line 749), consumePendingSteer (~line 1013 and ~1088),
  // the mid-stream steer path in the loop body.

  it('steer: STEER_SET marks hasPendingSteer and stores preview', () => {
    const state = run([
      makeRunStarted(),
      { type: 'STEER_SET', timestamp: t(), preview: 'focus on auth only' },
    ]);

    expect(state.hasPendingSteer).toBe(true);
    expect(state.pendingSteerPreview).toBe('focus on auth only');
  });

  it('steer: last STEER_SET wins (last-write-wins semantics)', () => {
    const state = run([
      makeRunStarted(),
      { type: 'STEER_SET', timestamp: t(), preview: 'first' },
      { type: 'STEER_SET', timestamp: t(), preview: 'second' },
    ]);

    expect(state.pendingSteerPreview).toBe('second');
    expect(state.hasPendingSteer).toBe(true);
  });

  it('steer: STEER_CONSUMED clears hasPendingSteer and preview', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'hi', thinking: '' },
      { type: 'STEER_SET',           timestamp: t(), preview: 'do something else' },
      { type: 'STEER_CONSUMED',      timestamp: t() },
    ]);

    expect(state.hasPendingSteer).toBe(false);
    expect(state.pendingSteerPreview).toBe('');
  });

  it('steer: STEER_CONSUMED does not change phase', () => {
    const s0 = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'hi', thinking: '' },
      { type: 'STEER_SET',           timestamp: t(), preview: 'redirect' },
    ]);
    const s1 = runEngineReducer(s0, { type: 'STEER_CONSUMED', timestamp: t() });

    expect(s1.phase).toBe('streaming_llm');
  });

  it('steer: TURN_STEERED re-enters streaming_llm phase', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'partial', thinking: '' },
      { type: 'STEER_SET',           timestamp: t(), preview: 'steer' },
      { type: 'STEER_CONSUMED',      timestamp: t() },
      { type: 'TURN_STEERED',        timestamp: t() },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 1 },
    ]);

    expect(state.phase).toBe('streaming_llm');
    expect(state.round).toBe(1);
    expect(state.hasPendingSteer).toBe(false);
  });

  it('steer: STEER_CLEARED explicitly removes a pending steer', () => {
    const state = run([
      makeRunStarted(),
      { type: 'STEER_SET',     timestamp: t(), preview: 'abort this' },
      { type: 'STEER_CLEARED', timestamp: t() },
    ]);

    expect(state.hasPendingSteer).toBe(false);
    expect(state.pendingSteerPreview).toBe('');
  });

  it('steer: steer present when loop ends is preserved (reducer does not auto-clear)', () => {
    // The harness adapter is responsible for emitting STEER_CLEARED before
    // the finally block. The reducer records truth, not policy.
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'STEER_SET',         timestamp: t(), preview: 'still pending' },
      { type: 'LOOP_COMPLETED',    timestamp: t() },
    ]);

    expect(state.phase).toBe('completed');
    expect(state.hasPendingSteer).toBe(true);
  });

  // ─── Explorer delegation ──────────────────────────────────────────────────
  //
  // Covers: executeDelegateCall delegate_explorer path in useAgentDelegation.ts.

  it('explorer delegation: full phase sequence', () => {
    const states: string[] = [];
    let state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',     timestamp: t(), round: 0 },
    ]);
    states.push(state.phase);

    state = runEngineReducer(state, { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: '', thinking: '' });
    state = runEngineReducer(state, { type: 'TOOLS_STARTED', timestamp: t() });
    states.push(state.phase);

    state = runEngineReducer(state, { type: 'DELEGATION_STARTED', timestamp: t(), agent: 'explorer' });
    states.push(state.phase);

    state = runEngineReducer(state, { type: 'DELEGATION_COMPLETED', timestamp: t(), agent: 'explorer' });
    states.push(state.phase);

    state = runEngineReducer(state, { type: 'TURN_CONTINUED', timestamp: t() });
    states.push(state.phase);

    expect(states).toEqual([
      'streaming_llm',
      'executing_tools',
      'delegating_explorer',
      'executing_tools',
      'streaming_llm',
    ]);
  });

  // ─── Coder delegation (planner / auditor → delegating_coder) ─────────────
  //
  // Covers: planner pre-pass and auditor evaluation both run inside the
  // delegate_coder flow — all three map to 'delegating_coder'.

  it.each([
    ['coder'],
    ['planner'],
    ['auditor'],
  ] as const)('DELEGATION_STARTED(%s) maps to delegating_coder', (agent) => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',     timestamp: t(), round: 0 },
      { type: 'TOOLS_STARTED',     timestamp: t() },
      { type: 'DELEGATION_STARTED', timestamp: t(), agent },
    ]);

    expect(state.phase).toBe('delegating_coder');
  });

  it('DELEGATION_COMPLETED after coder returns to executing_tools', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'TOOLS_STARTED',       timestamp: t() },
      { type: 'DELEGATION_STARTED',  timestamp: t(), agent: 'coder' },
      { type: 'DELEGATION_COMPLETED', timestamp: t(), agent: 'coder' },
    ]);

    expect(state.phase).toBe('executing_tools');
  });

  it.each([
    ['planner'],
    ['auditor'],
  ] as const)('DELEGATION_COMPLETED(%s) keeps delegating_coder phase', (agent) => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'TOOLS_STARTED',       timestamp: t() },
      { type: 'DELEGATION_STARTED',  timestamp: t(), agent },
      { type: 'DELEGATION_COMPLETED', timestamp: t(), agent },
    ]);

    expect(state.phase).toBe('delegating_coder');
  });

  // ─── ACCUMULATED_UPDATED ─────────────────────────────────────────────────

  it('ACCUMULATED_UPDATED sets text and thinking without changing phase', () => {
    const s0 = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',     timestamp: t(), round: 0 },
    ]);
    const s1 = runEngineReducer(s0, {
      type: 'ACCUMULATED_UPDATED',
      timestamp: t(),
      text: 'in progress...',
      thinking: '<thinking>draft</thinking>',
    });

    expect(s1.accumulatedText).toBe('in progress...');
    expect(s1.accumulatedThinking).toBe('<thinking>draft</thinking>');
    expect(s1.phase).toBe('streaming_llm');
  });

  // ─── isRunActive ─────────────────────────────────────────────────────────

  it('isRunActive returns false for idle/completed/aborted/failed, true for all active phases', () => {
    const inactive: Array<RunEngineState['phase']> = ['idle', 'completed', 'aborted', 'failed'];
    const active: Array<RunEngineState['phase']> = [
      'starting',
      'streaming_llm',
      'executing_tools',
      'delegating_coder',
      'delegating_explorer',
    ];

    for (const phase of inactive) {
      expect(isRunActive({ ...IDLE_RUN_STATE, phase }), `phase=${phase}`).toBe(false);
    }
    for (const phase of active) {
      expect(isRunActive({ ...IDLE_RUN_STATE, phase }), `phase=${phase}`).toBe(true);
    }
  });

  // ─── parity diagnostics ───────────────────────────────────────────────────

  it('collectRunEngineParityIssues returns no issues for a matching active state', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED', timestamp: t(), round: 0 },
      { type: 'ACCUMULATED_UPDATED', timestamp: t(), text: 'hello', thinking: 'plan' },
      { type: 'FOLLOW_UP_ENQUEUED', timestamp: t(), followUp: makeFollowUp('next') },
      { type: 'STEER_SET', timestamp: t(), preview: 'redirect' },
    ]);

    expect(collectRunEngineParityIssues(state, {
      loopActive: true,
      checkpointPhase: 'streaming_llm',
      round: 0,
      accumulatedText: 'hello',
      accumulatedThinking: 'plan',
      queuedFollowUpCount: 1,
      hasPendingSteer: true,
      tabLockId: 'lock-1',
    })).toEqual([]);
  });

  it('collectRunEngineParityIssues reports mismatches for active-state drift', () => {
    const state = run([
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED', timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED', timestamp: t(), round: 2 },
    ]);

    const issues = collectRunEngineParityIssues(state, {
      loopActive: false,
      checkpointPhase: 'executing_tools',
      round: 1,
      accumulatedText: '',
      accumulatedThinking: '',
      queuedFollowUpCount: 3,
      hasPendingSteer: true,
      tabLockId: null,
    });

    expect(issues).toContain('engine phase=streaming_llm but loopActive=false');
    expect(issues).toContain('phase mismatch: engine=streaming_llm observed=executing_tools');
    expect(issues).toContain('round mismatch: engine=2 observed=1');
    expect(issues).toContain('queue length mismatch: engine=0 observed=3');
    expect(issues).toContain('pending steer mismatch: engine=false observed=true');
    expect(issues).toContain('tab lock mismatch: engine=lock-1 observed=null');
  });

  // ─── replayEvents ────────────────────────────────────────────────────────

  it('replayEvents produces the same result as manually folding events', () => {
    const events: RunEngineEvent[] = [
      makeRunStarted(),
      { type: 'TAB_LOCK_ACQUIRED',   timestamp: t(), tabLockId: 'lock-1' },
      { type: 'ROUND_STARTED',       timestamp: t(), round: 0 },
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'hi', thinking: '' },
      { type: 'TOOLS_STARTED',       timestamp: t() },
      { type: 'LOOP_COMPLETED',      timestamp: t() },
    ];

    const fromReplay = replayEvents(IDLE_RUN_STATE, events);
    const fromFold = events.reduce(runEngineReducer, IDLE_RUN_STATE);

    expect(fromReplay).toEqual(fromFold);
  });

  it('replayEvents with empty events returns the initial state unchanged', () => {
    const result = replayEvents(IDLE_RUN_STATE, []);
    expect(result).toEqual(IDLE_RUN_STATE);
  });

  it('replayEvents accepts a non-idle initial state (partial history replay)', () => {
    // Represents replaying from a mid-run snapshot
    const midRunState: RunEngineState = {
      ...IDLE_RUN_STATE,
      runId: 'run-x',
      chatId: 'chat-x',
      phase: 'streaming_llm',
      round: 2,
      tabLockId: 'lock-x',
    };

    const result = replayEvents(midRunState, [
      { type: 'STREAMING_COMPLETED', timestamp: t(), accumulated: 'final answer', thinking: '' },
      { type: 'LOOP_COMPLETED',      timestamp: t() },
    ]);

    expect(result.phase).toBe('completed');
    expect(result.round).toBe(2);
    expect(result.runId).toBe('run-x');
    expect(result.tabLockId).toBeNull();
  });

  // ─── All terminal events clear tabLockId ─────────────────────────────────

  it.each([
    [{ type: 'LOOP_COMPLETED' as const, timestamp: 1 }, 'completed'],
    [{ type: 'LOOP_ABORTED' as const,   timestamp: 1 }, 'aborted'],
    [{ type: 'LOOP_FAILED' as const,    timestamp: 1, reason: 'err' }, 'failed'],
  ] as const)('$0.type clears tabLockId', (event, expectedPhase) => {
    const withLock: RunEngineState = {
      ...IDLE_RUN_STATE,
      phase: 'streaming_llm',
      tabLockId: 'lock-1',
    };
    const result = runEngineReducer(withLock, event);

    expect(result.tabLockId).toBeNull();
    expect(result.phase).toBe(expectedPhase);
  });

});
