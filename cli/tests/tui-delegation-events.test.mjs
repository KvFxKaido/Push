import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_EVENT_TYPES,
  delegationEventToTranscript,
  isDelegationEvent,
} from '../tui-delegation-events.ts';

// ─── isDelegationEvent ───────────────────────────────────────────

describe('isDelegationEvent', () => {
  it('recognizes all nine delegation event types', () => {
    const expected = [
      'subagent.started',
      'subagent.completed',
      'subagent.failed',
      'task_graph.task_ready',
      'task_graph.task_started',
      'task_graph.task_completed',
      'task_graph.task_failed',
      'task_graph.task_cancelled',
      'task_graph.graph_completed',
    ];
    for (const type of expected) {
      assert.equal(isDelegationEvent({ type }), true, `missing: ${type}`);
      assert.equal(DELEGATION_EVENT_TYPES.has(type), true, `set missing: ${type}`);
    }
  });

  it('rejects non-delegation event types', () => {
    assert.equal(isDelegationEvent({ type: 'tool.execution_start' }), false);
    assert.equal(isDelegationEvent({ type: 'assistant_token' }), false);
    assert.equal(isDelegationEvent({ type: 'run_complete' }), false);
    assert.equal(isDelegationEvent({ type: 'status' }), false);
  });

  it('has exactly nine entries so every handled case is enumerated', () => {
    // Sanity check: if someone adds a case to the switch without updating the
    // set (or vice versa), this test catches the drift.
    assert.equal(DELEGATION_EVENT_TYPES.size, 9);
  });
});

// ─── delegationEventToTranscript: subagent.* ─────────────────────

describe('delegationEventToTranscript — subagent events', () => {
  it('maps subagent.started with detail to a status entry', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.started',
      payload: { executionId: 'ex-1', agent: 'explorer', detail: 'auth-flow' },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: '--- subagent started: explorer --- auth-flow',
      boundary: 'start',
    });
  });

  it('maps subagent.started without detail', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.started',
      payload: { executionId: 'ex-1', agent: 'coder' },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: '--- subagent started: coder ---',
      boundary: 'start',
    });
  });

  it('maps subagent.completed to a status entry with the summary', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.completed',
      payload: {
        executionId: 'ex-1',
        agent: 'explorer',
        summary: 'found 3 files matching auth logic',
      },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: '--- subagent completed: explorer --- found 3 files matching auth logic',
      boundary: 'end',
    });
  });

  it('falls back to "(no summary)" when subagent.completed omits summary', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.completed',
      payload: { executionId: 'ex-1', agent: 'explorer' },
    });
    assert.equal(entry?.text, '--- subagent completed: explorer --- (no summary)');
    assert.equal(entry?.boundary, 'end');
  });

  it('maps subagent.failed to an error entry', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.failed',
      payload: { executionId: 'ex-1', agent: 'coder', error: 'patch conflict' },
    });
    assert.deepEqual(entry, {
      role: 'error',
      text: '--- subagent failed: coder --- patch conflict',
      boundary: 'end',
    });
  });

  it('falls back to "(unknown error)" when subagent.failed omits error', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.failed',
      payload: { executionId: 'ex-1', agent: 'coder' },
    });
    assert.equal(entry?.text, '--- subagent failed: coder --- (unknown error)');
    assert.equal(entry?.boundary, 'end');
  });
});

// ─── delegationEventToTranscript: task_graph.* ───────────────────

describe('delegationEventToTranscript — task_graph events', () => {
  it('maps task_graph.task_ready with detail', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_ready',
      payload: {
        executionId: 'ex-1',
        taskId: 'investigate-auth',
        agent: 'explorer',
        detail: 'auth module',
      },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: 'task ready: investigate-auth (explorer) — auth module',
    });
  });

  it('maps task_graph.task_ready without detail', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_ready',
      payload: { executionId: 'ex-1', taskId: 't-1', agent: 'coder' },
    });
    assert.equal(entry?.text, 'task ready: t-1 (coder)');
  });

  it('maps task_graph.task_started', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_started',
      payload: { executionId: 'ex-1', taskId: 't-1', agent: 'coder' },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: 'task started: t-1 (coder)',
    });
  });

  it('maps task_graph.task_completed with elapsedMs', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_completed',
      payload: {
        executionId: 'ex-1',
        taskId: 't-1',
        agent: 'coder',
        summary: 'patch applied',
        elapsedMs: 1234,
      },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: 'task completed: t-1 (coder, 1234ms) — patch applied',
    });
  });

  it('omits elapsed suffix when task_completed has no elapsedMs', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_completed',
      payload: {
        executionId: 'ex-1',
        taskId: 't-1',
        agent: 'coder',
        summary: 'done',
      },
    });
    assert.equal(entry?.text, 'task completed: t-1 (coder) — done');
  });

  it('maps task_graph.task_failed to an error entry', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_failed',
      payload: {
        executionId: 'ex-1',
        taskId: 't-1',
        agent: 'coder',
        error: 'compilation error',
        elapsedMs: 500,
      },
    });
    assert.deepEqual(entry, {
      role: 'error',
      text: 'task failed: t-1 (coder, 500ms) — compilation error',
    });
  });

  it('maps task_graph.task_cancelled with reason and elapsedMs', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_cancelled',
      payload: {
        executionId: 'ex-1',
        taskId: 't-1',
        agent: 'explorer',
        reason: 'budget exceeded',
        elapsedMs: 1200,
      },
    });
    assert.deepEqual(entry, {
      role: 'warning',
      text: 'task cancelled: t-1 (explorer, 1200ms) — budget exceeded',
    });
  });

  it('maps task_graph.task_cancelled without elapsedMs', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_cancelled',
      payload: {
        executionId: 'ex-1',
        taskId: 't-1',
        agent: 'coder',
        reason: 'user aborted',
      },
    });
    assert.equal(entry?.text, 'task cancelled: t-1 (coder) — user aborted');
  });

  it('maps task_graph.task_cancelled without reason (fallback to bare label)', () => {
    // `reason` is required in the shared contract, but the observer should
    // still render a sensible line if a producer omits it during a protocol
    // hiccup rather than crashing or printing "undefined".
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_cancelled',
      payload: { executionId: 'ex-1', taskId: 't-1', agent: 'explorer' },
    });
    assert.equal(entry?.text, 'task cancelled: t-1 (explorer)');
  });
});

// ─── delegationEventToTranscript: task_graph.graph_completed ─────

describe('delegationEventToTranscript — task_graph.graph_completed', () => {
  it('maps a successful graph completion to a status entry', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.graph_completed',
      payload: {
        executionId: 'ex-1',
        summary: 'all tasks succeeded',
        success: true,
        aborted: false,
        nodeCount: 5,
        totalRounds: 3,
        wallTimeMs: 4200,
      },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: 'task graph completed: 5 nodes / 3 rounds / 4200ms — all tasks succeeded',
    });
  });

  it('maps an aborted graph completion to a warning entry', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.graph_completed',
      payload: {
        executionId: 'ex-1',
        summary: 'run aborted by user',
        success: false,
        aborted: true,
        nodeCount: 2,
        totalRounds: 1,
        wallTimeMs: 800,
      },
    });
    assert.deepEqual(entry, {
      role: 'warning',
      text: 'task graph aborted: 2 nodes / 1 rounds / 800ms — run aborted by user',
    });
  });

  it('maps a failed (non-aborted) graph completion to an error entry', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.graph_completed',
      payload: {
        executionId: 'ex-1',
        summary: 'coder task failed',
        success: false,
        aborted: false,
        nodeCount: 3,
        totalRounds: 2,
        wallTimeMs: 1500,
      },
    });
    assert.deepEqual(entry, {
      role: 'error',
      text: 'task graph failed: 3 nodes / 2 rounds / 1500ms — coder task failed',
    });
  });

  it('falls back to zeros and "(no summary)" on missing fields', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.graph_completed',
      payload: { executionId: 'ex-1', success: true, aborted: false },
    });
    assert.equal(entry?.text, 'task graph completed: 0 nodes / 0 rounds / 0ms — (no summary)');
  });

  it('prioritizes aborted over failed when both flags are set', () => {
    // aborted is a more specific signal than "not successful" — a user
    // cancellation shouldn't get rendered as a failure even if the run also
    // reports success: false.
    const entry = delegationEventToTranscript({
      type: 'task_graph.graph_completed',
      payload: {
        executionId: 'ex-1',
        summary: 'stopped mid-run',
        success: false,
        aborted: true,
        nodeCount: 1,
        totalRounds: 0,
        wallTimeMs: 100,
      },
    });
    assert.equal(entry?.role, 'warning');
  });
});

// ─── delegationEventToTranscript: defensive behavior ─────────────

describe('delegationEventToTranscript — defensive behavior', () => {
  it('returns null for non-delegation event types', () => {
    assert.equal(delegationEventToTranscript({ type: 'tool.execution_start' }), null);
    assert.equal(delegationEventToTranscript({ type: 'assistant_token' }), null);
    assert.equal(delegationEventToTranscript({ type: 'unknown' }), null);
  });

  it('tolerates missing payload without throwing', () => {
    // Daemon streams might forward envelope skeletons during protocol hiccups;
    // the observer should stay silent-resilient rather than crash the TUI.
    assert.doesNotThrow(() => {
      delegationEventToTranscript({ type: 'subagent.started' });
    });
    const entry = delegationEventToTranscript({ type: 'subagent.started' });
    assert.equal(entry?.text, '--- subagent started: subagent ---');
    assert.equal(entry?.boundary, 'start');
  });

  it('tolerates missing agent field', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_started',
      payload: { taskId: 't-1' },
    });
    assert.equal(entry?.text, 'task started: t-1 (agent)');
  });

  it('tolerates missing taskId field', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_started',
      payload: { agent: 'coder' },
    });
    assert.equal(entry?.text, 'task started: ? (coder)');
  });
});
