import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_EVENT_TYPES,
  delegationEventToTranscript,
  isDelegationEvent,
} from '../tui-delegation-events.ts';

// ─── isDelegationEvent ───────────────────────────────────────────

describe('isDelegationEvent', () => {
  it('recognizes all eight delegation event types', () => {
    const expected = [
      'subagent.started',
      'subagent.completed',
      'subagent.failed',
      'task_graph.task_ready',
      'task_graph.task_started',
      'task_graph.task_completed',
      'task_graph.task_failed',
      'task_graph.task_cancelled',
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

  it('has exactly eight entries so every handled case is enumerated', () => {
    // Sanity check: if someone adds a case to the switch without updating the
    // set (or vice versa), this test catches the drift.
    assert.equal(DELEGATION_EVENT_TYPES.size, 8);
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
      text: 'subagent started: explorer — auth-flow',
    });
  });

  it('maps subagent.started without detail', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.started',
      payload: { executionId: 'ex-1', agent: 'coder' },
    });
    assert.deepEqual(entry, {
      role: 'status',
      text: 'subagent started: coder',
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
      text: 'subagent completed: explorer — found 3 files matching auth logic',
    });
  });

  it('falls back to "(no summary)" when subagent.completed omits summary', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.completed',
      payload: { executionId: 'ex-1', agent: 'explorer' },
    });
    assert.equal(entry?.text, 'subagent completed: explorer — (no summary)');
  });

  it('maps subagent.failed to an error entry', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.failed',
      payload: { executionId: 'ex-1', agent: 'coder', error: 'patch conflict' },
    });
    assert.deepEqual(entry, {
      role: 'error',
      text: 'subagent failed: coder — patch conflict',
    });
  });

  it('falls back to "(unknown error)" when subagent.failed omits error', () => {
    const entry = delegationEventToTranscript({
      type: 'subagent.failed',
      payload: { executionId: 'ex-1', agent: 'coder' },
    });
    assert.equal(entry?.text, 'subagent failed: coder — (unknown error)');
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

  it('maps task_graph.task_cancelled to a warning entry', () => {
    const entry = delegationEventToTranscript({
      type: 'task_graph.task_cancelled',
      payload: { executionId: 'ex-1', taskId: 't-1', agent: 'explorer' },
    });
    assert.deepEqual(entry, {
      role: 'warning',
      text: 'task cancelled: t-1 (explorer)',
    });
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
    assert.equal(entry?.text, 'subagent started: subagent');
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
