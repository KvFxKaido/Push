import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isV2DelegationEvent,
  synthesizeV1DelegationEvent,
  V1_SYNTHESIZABLE_EVENT_TYPES,
} from '../v1-downgrade.ts';
import { validateEventEnvelope } from '../protocol-schema.ts';
import { PROTOCOL_VERSION } from '../session-store.ts';

// ─── Helpers ──────────────────────────────────────────────────────

function makeEnvelope(type, payload, overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: 'sess_downgrade_test',
    runId: 'run_child_abc',
    seq: 7,
    ts: Date.now(),
    type,
    payload,
    ...overrides,
  };
}

function assertValidEnvelope(event) {
  const issues = validateEventEnvelope(event);
  assert.deepEqual(
    issues,
    [],
    `expected envelope to pass validation, got: ${JSON.stringify(issues)}`,
  );
}

// ─── isV2DelegationEvent ─────────────────────────────────────────

describe('isV2DelegationEvent', () => {
  it('returns true for every synthesizable delegation type', () => {
    for (const t of V1_SYNTHESIZABLE_EVENT_TYPES) {
      assert.equal(isV2DelegationEvent(t), true, `expected ${t} to be a v2 delegation event`);
    }
  });

  it('returns false for common v1 events', () => {
    const v1Types = [
      'assistant_token',
      'tool_call',
      'tool_result',
      'status',
      'run_complete',
      'error',
      'session_started',
      'approval_required',
      'approval_received',
      'user_message',
    ];
    for (const t of v1Types) {
      assert.equal(isV2DelegationEvent(t), false, `expected ${t} NOT to be a v2 delegation event`);
    }
  });

  it('returns false for an unknown event type', () => {
    assert.equal(isV2DelegationEvent('some.made.up.event'), false);
  });
});

// ─── synthesizeV1DelegationEvent — per-type coverage ──────────────

describe('synthesizeV1DelegationEvent — subagent events', () => {
  it('subagent.started → [Role] started: <detail>', () => {
    const envelope = makeEnvelope('subagent.started', {
      executionId: 'sub_1',
      subagentId: 'sub_1',
      parentRunId: 'run_parent_xyz',
      childRunId: 'run_child_abc',
      agent: 'explorer',
      role: 'explorer',
      detail: 'inspect repo layout',
    });
    const out = synthesizeV1DelegationEvent(envelope);
    assert.equal(out.length, 1);
    const [ev] = out;
    assert.equal(ev.type, 'assistant_token');
    assert.equal(ev.runId, 'run_parent_xyz');
    assert.equal(ev.payload.text, '[Explorer] started: inspect repo layout\n');
    assertValidEnvelope(ev);
  });

  it('subagent.completed → [Role] completed: <summary>', () => {
    const envelope = makeEnvelope('subagent.completed', {
      executionId: 'sub_1',
      subagentId: 'sub_1',
      parentRunId: 'run_parent_xyz',
      agent: 'coder',
      role: 'coder',
      summary: 'Added retry logic',
    });
    const out = synthesizeV1DelegationEvent(envelope);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'assistant_token');
    assert.equal(out[0].runId, 'run_parent_xyz');
    assert.equal(out[0].payload.text, '[Coder] completed: Added retry logic\n');
    assertValidEnvelope(out[0]);
  });

  it('subagent.failed → [Role] failed: <error>', () => {
    const envelope = makeEnvelope('subagent.failed', {
      executionId: 'sub_1',
      subagentId: 'sub_1',
      parentRunId: 'run_parent_xyz',
      agent: 'explorer',
      role: 'explorer',
      error: 'provider timeout',
    });
    const out = synthesizeV1DelegationEvent(envelope);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.text, '[Explorer] failed: provider timeout\n');
    assertValidEnvelope(out[0]);
  });

  it('falls back to envelope.runId when payload.parentRunId is missing', () => {
    const envelope = makeEnvelope(
      'subagent.started',
      {
        executionId: 'sub_1',
        agent: 'reviewer',
        detail: 'single-turn review',
      },
      { runId: 'run_parent_fallback' },
    );
    const out = synthesizeV1DelegationEvent(envelope);
    assert.equal(out.length, 1);
    assert.equal(out[0].runId, 'run_parent_fallback');
  });

  it('returns [] when both parentRunId and envelope.runId are missing', () => {
    const envelope = makeEnvelope(
      'subagent.started',
      { executionId: 'sub_1', agent: 'explorer', detail: 'no parent anywhere' },
      { runId: undefined },
    );
    delete envelope.runId;
    const out = synthesizeV1DelegationEvent(envelope);
    assert.deepEqual(out, []);
  });
});

describe('synthesizeV1DelegationEvent — task_graph events', () => {
  const makeGraphEnv = (type, payloadOverride = {}) =>
    makeEnvelope(
      type,
      {
        executionId: 'graph_1',
        taskId: 'a',
        agent: 'coder',
        ...payloadOverride,
      },
      { runId: 'run_parent_graph' },
    );

  it('task_graph.task_ready → [TaskGraph] task ready: <id> (<agent>)', () => {
    const out = synthesizeV1DelegationEvent(makeGraphEnv('task_graph.task_ready'));
    assert.equal(out.length, 1);
    assert.equal(out[0].runId, 'run_parent_graph');
    assert.equal(out[0].payload.text, '[TaskGraph] task ready: a (coder)\n');
    assertValidEnvelope(out[0]);
  });

  it('task_graph.task_started → [TaskGraph] task started: <id> (<agent>) — <detail>', () => {
    const out = synthesizeV1DelegationEvent(
      makeGraphEnv('task_graph.task_started', { detail: 'starting run' }),
    );
    assert.equal(out[0].payload.text, '[TaskGraph] task started: a (coder) — starting run\n');
    assertValidEnvelope(out[0]);
  });

  it('task_graph.task_completed → [TaskGraph] task completed: <id> (<agent>) — <summary>', () => {
    const out = synthesizeV1DelegationEvent(
      makeGraphEnv('task_graph.task_completed', { summary: 'wrote file' }),
    );
    assert.equal(out[0].payload.text, '[TaskGraph] task completed: a (coder) — wrote file\n');
    assertValidEnvelope(out[0]);
  });

  it('task_graph.task_completed falls back when summary is empty', () => {
    const out = synthesizeV1DelegationEvent(
      makeGraphEnv('task_graph.task_completed', { summary: '' }),
    );
    assert.equal(out[0].payload.text, '[TaskGraph] task completed: a (coder) — done\n');
  });

  it('task_graph.task_failed → [TaskGraph] task failed: <id> (<agent>) — <error>', () => {
    const out = synthesizeV1DelegationEvent(
      makeGraphEnv('task_graph.task_failed', { error: 'boom' }),
    );
    assert.equal(out[0].payload.text, '[TaskGraph] task failed: a (coder) — boom\n');
    assertValidEnvelope(out[0]);
  });

  it('task_graph.task_cancelled → [TaskGraph] task cancelled: <id> (<agent>) — <reason>', () => {
    const out = synthesizeV1DelegationEvent(
      makeGraphEnv('task_graph.task_cancelled', { reason: 'user cancel' }),
    );
    assert.equal(out[0].payload.text, '[TaskGraph] task cancelled: a (coder) — user cancel\n');
    assertValidEnvelope(out[0]);
  });

  it('task_graph.graph_completed → [TaskGraph] graph completed: <n> nodes, success=<bool>', () => {
    const envelope = makeEnvelope(
      'task_graph.graph_completed',
      {
        executionId: 'graph_1',
        summary: 'all good',
        success: true,
        aborted: false,
        nodeCount: 3,
        totalRounds: 5,
        wallTimeMs: 1234,
      },
      { runId: 'run_parent_graph' },
    );
    const out = synthesizeV1DelegationEvent(envelope);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.text, '[TaskGraph] graph completed: 3 nodes, success=true\n');
    assertValidEnvelope(out[0]);
  });
});

describe('synthesizeV1DelegationEvent — non-delegation + edge cases', () => {
  it('returns [] for a non-delegation event type', () => {
    const envelope = makeEnvelope('assistant_token', { text: 'hi' });
    assert.deepEqual(synthesizeV1DelegationEvent(envelope), []);
  });

  it('returns [] for an unknown event type', () => {
    const envelope = makeEnvelope('some.made.up.event', { whatever: 1 });
    assert.deepEqual(synthesizeV1DelegationEvent(envelope), []);
  });

  it('returns [] when payload is not a plain object', () => {
    const envelope = makeEnvelope('subagent.started', 'not an object');
    assert.deepEqual(synthesizeV1DelegationEvent(envelope), []);
  });

  it('returns [] when payload is null', () => {
    const envelope = makeEnvelope('subagent.started', null);
    assert.deepEqual(synthesizeV1DelegationEvent(envelope), []);
  });

  it('uses payload.agent when payload.role is missing', () => {
    const envelope = makeEnvelope('subagent.started', {
      executionId: 'sub_1',
      parentRunId: 'run_parent',
      agent: 'reviewer',
      detail: 'review diff',
    });
    const out = synthesizeV1DelegationEvent(envelope);
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.text, '[Reviewer] started: review diff\n');
  });

  it('every synthesized envelope passes validateEventEnvelope', () => {
    const cases = [
      {
        type: 'subagent.started',
        payload: { executionId: 'sub_1', parentRunId: 'run_p', agent: 'explorer', detail: 'x' },
      },
      {
        type: 'subagent.completed',
        payload: { executionId: 'sub_1', parentRunId: 'run_p', agent: 'coder', summary: 's' },
      },
      {
        type: 'subagent.failed',
        payload: { executionId: 'sub_1', parentRunId: 'run_p', agent: 'coder', error: 'e' },
      },
      {
        type: 'task_graph.task_ready',
        payload: { executionId: 'g', taskId: 't', agent: 'coder' },
      },
      {
        type: 'task_graph.task_started',
        payload: { executionId: 'g', taskId: 't', agent: 'coder', detail: 'd' },
      },
      {
        type: 'task_graph.task_completed',
        payload: { executionId: 'g', taskId: 't', agent: 'coder', summary: 's' },
      },
      {
        type: 'task_graph.task_failed',
        payload: { executionId: 'g', taskId: 't', agent: 'coder', error: 'e' },
      },
      {
        type: 'task_graph.task_cancelled',
        payload: { executionId: 'g', taskId: 't', agent: 'coder', reason: 'r' },
      },
      {
        type: 'task_graph.graph_completed',
        payload: {
          executionId: 'g',
          summary: 's',
          success: true,
          aborted: false,
          nodeCount: 1,
          totalRounds: 1,
          wallTimeMs: 1,
        },
      },
    ];
    for (const { type, payload } of cases) {
      const env = makeEnvelope(type, payload);
      const out = synthesizeV1DelegationEvent(env);
      assert.equal(out.length, 1, `expected 1 synthesized event for ${type}`);
      assertValidEnvelope(out[0]);
      assert.equal(out[0].type, 'assistant_token');
      assert.ok(out[0].payload.text.length > 0, `empty text for ${type}`);
    }
  });
});
