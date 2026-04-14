import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEventEnvelope,
  validateRunEventPayload,
  validateEvent,
  assertValidEvent,
  isStrictModeEnabled,
  SCHEMA_VALIDATED_EVENT_TYPES,
} from '../protocol-schema.ts';
import { PROTOCOL_VERSION } from '../session-store.ts';

// Helper to build a known-good envelope that we can then mutate in
// each failure-case test. Keeps test cases compact by starting from a
// single source of truth for what a valid envelope looks like.
function makeValidEnvelope(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: 'sess_abc_def123',
    runId: 'run_parent',
    seq: 5,
    ts: 1_712_345_678_901,
    type: 'subagent.started',
    payload: {
      executionId: 'sub_1',
      agent: 'explorer',
      detail: 'find the thing',
    },
    ...overrides,
  };
}

describe('isStrictModeEnabled', () => {
  it('returns false when PUSH_PROTOCOL_STRICT is unset', () => {
    const prev = process.env.PUSH_PROTOCOL_STRICT;
    delete process.env.PUSH_PROTOCOL_STRICT;
    try {
      assert.equal(isStrictModeEnabled(), false);
    } finally {
      if (prev !== undefined) process.env.PUSH_PROTOCOL_STRICT = prev;
    }
  });

  it('returns true for "1"', () => {
    const prev = process.env.PUSH_PROTOCOL_STRICT;
    process.env.PUSH_PROTOCOL_STRICT = '1';
    try {
      assert.equal(isStrictModeEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
      else process.env.PUSH_PROTOCOL_STRICT = prev;
    }
  });

  it('returns true for "true"', () => {
    const prev = process.env.PUSH_PROTOCOL_STRICT;
    process.env.PUSH_PROTOCOL_STRICT = 'true';
    try {
      assert.equal(isStrictModeEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
      else process.env.PUSH_PROTOCOL_STRICT = prev;
    }
  });

  it('returns false for arbitrary truthy strings', () => {
    const prev = process.env.PUSH_PROTOCOL_STRICT;
    process.env.PUSH_PROTOCOL_STRICT = 'yes';
    try {
      assert.equal(isStrictModeEnabled(), false);
    } finally {
      if (prev === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
      else process.env.PUSH_PROTOCOL_STRICT = prev;
    }
  });

  it('reads the env var at call time, not import time', () => {
    const prev = process.env.PUSH_PROTOCOL_STRICT;
    delete process.env.PUSH_PROTOCOL_STRICT;
    try {
      assert.equal(isStrictModeEnabled(), false);
      process.env.PUSH_PROTOCOL_STRICT = '1';
      assert.equal(isStrictModeEnabled(), true);
      delete process.env.PUSH_PROTOCOL_STRICT;
      assert.equal(isStrictModeEnabled(), false);
    } finally {
      if (prev !== undefined) process.env.PUSH_PROTOCOL_STRICT = prev;
    }
  });
});

describe('validateEventEnvelope', () => {
  it('accepts a canonical envelope', () => {
    const issues = validateEventEnvelope(makeValidEnvelope());
    assert.deepEqual(issues, []);
  });

  it('accepts an envelope with runId omitted', () => {
    const envelope = makeValidEnvelope();
    delete envelope.runId;
    assert.deepEqual(validateEventEnvelope(envelope), []);
  });

  it('rejects a non-object event', () => {
    const issues = validateEventEnvelope('not an envelope');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, '');
    assert.match(issues[0].message, /plain object/);
  });

  it('rejects null', () => {
    const issues = validateEventEnvelope(null);
    assert.equal(issues.length, 1);
  });

  it('rejects an array', () => {
    const issues = validateEventEnvelope([]);
    assert.equal(issues.length, 1);
  });

  it('rejects the wrong protocol version', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ v: 'push.runtime.v0' }));
    assert.ok(issues.some((i) => i.path === 'v'));
  });

  it('rejects kind that is not "event"', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ kind: 'response' }));
    assert.ok(issues.some((i) => i.path === 'kind'));
  });

  it('rejects an empty sessionId', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ sessionId: '' }));
    assert.ok(issues.some((i) => i.path === 'sessionId'));
  });

  it('rejects a missing sessionId', () => {
    const envelope = makeValidEnvelope();
    delete envelope.sessionId;
    const issues = validateEventEnvelope(envelope);
    assert.ok(issues.some((i) => i.path === 'sessionId'));
  });

  // The whole point of this check — matches the PR #276 review regression.
  it('rejects runId: null (must be omitted, not serialised as null)', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ runId: null }));
    assert.ok(
      issues.some((i) => i.path === 'runId'),
      `expected a runId issue, got ${JSON.stringify(issues)}`,
    );
  });

  it('rejects runId of wrong type', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ runId: 42 }));
    assert.ok(issues.some((i) => i.path === 'runId'));
  });

  it('rejects a negative seq', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ seq: -1 }));
    assert.ok(issues.some((i) => i.path === 'seq'));
  });

  it('rejects a non-integer seq', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ seq: 1.5 }));
    assert.ok(issues.some((i) => i.path === 'seq'));
  });

  it('rejects a missing seq', () => {
    const envelope = makeValidEnvelope();
    delete envelope.seq;
    const issues = validateEventEnvelope(envelope);
    assert.ok(issues.some((i) => i.path === 'seq'));
  });

  it('rejects ts <= 0', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ ts: 0 }));
    assert.ok(issues.some((i) => i.path === 'ts'));
  });

  it('rejects a non-finite ts', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ ts: Number.POSITIVE_INFINITY }));
    assert.ok(issues.some((i) => i.path === 'ts'));
  });

  it('rejects an empty type', () => {
    const issues = validateEventEnvelope(makeValidEnvelope({ type: '' }));
    assert.ok(issues.some((i) => i.path === 'type'));
  });

  it('rejects a missing payload field entirely', () => {
    const envelope = makeValidEnvelope();
    delete envelope.payload;
    const issues = validateEventEnvelope(envelope);
    assert.ok(issues.some((i) => i.path === 'payload'));
  });
});

describe('validateRunEventPayload — subagent events', () => {
  it('accepts a valid subagent.started payload', () => {
    const issues = validateRunEventPayload('subagent.started', {
      executionId: 'sub_1',
      agent: 'explorer',
      detail: 'scanning',
    });
    assert.deepEqual(issues, []);
  });

  it('accepts subagent.started without optional detail', () => {
    const issues = validateRunEventPayload('subagent.started', {
      executionId: 'sub_1',
      agent: 'coder',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects subagent.started missing executionId', () => {
    const issues = validateRunEventPayload('subagent.started', {
      agent: 'explorer',
    });
    assert.ok(issues.some((i) => i.path === 'payload.executionId'));
  });

  it('rejects subagent.started with unknown agent', () => {
    const issues = validateRunEventPayload('subagent.started', {
      executionId: 'sub_1',
      agent: 'not_a_role',
    });
    assert.ok(issues.some((i) => i.path === 'payload.agent'));
  });

  it('accepts a valid subagent.completed payload', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'explorer',
      summary: 'found 3 files',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects subagent.completed missing summary', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'explorer',
    });
    assert.ok(issues.some((i) => i.path === 'payload.summary'));
  });

  it('accepts a valid subagent.failed payload', () => {
    const issues = validateRunEventPayload('subagent.failed', {
      executionId: 'sub_1',
      agent: 'coder',
      error: 'compile error',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects subagent.failed missing error', () => {
    const issues = validateRunEventPayload('subagent.failed', {
      executionId: 'sub_1',
      agent: 'coder',
    });
    assert.ok(issues.some((i) => i.path === 'payload.error'));
  });
});

describe('validateRunEventPayload — task_graph events', () => {
  it('accepts task_graph.task_ready with all fields', () => {
    const issues = validateRunEventPayload('task_graph.task_ready', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'explorer',
      detail: 'ready',
    });
    assert.deepEqual(issues, []);
  });

  it('accepts task_graph.task_started without optional detail', () => {
    const issues = validateRunEventPayload('task_graph.task_started', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'coder',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects task_graph.task_ready with agent outside {explorer, coder}', () => {
    const issues = validateRunEventPayload('task_graph.task_ready', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'auditor',
    });
    assert.ok(issues.some((i) => i.path === 'payload.agent'));
  });

  it('accepts task_graph.task_completed with empty summary string', () => {
    // Empty string is allowed — the executor defaults to '' when the
    // downstream kernel does not produce a summary. Only the wrong
    // *type* is a schema violation.
    const issues = validateRunEventPayload('task_graph.task_completed', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'explorer',
      summary: '',
      elapsedMs: 1234,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects task_graph.task_completed with non-string summary', () => {
    const issues = validateRunEventPayload('task_graph.task_completed', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'explorer',
      summary: null,
    });
    assert.ok(issues.some((i) => i.path === 'payload.summary'));
  });

  it('rejects task_graph.task_completed with non-number elapsedMs', () => {
    const issues = validateRunEventPayload('task_graph.task_completed', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'explorer',
      summary: 'done',
      elapsedMs: 'fast',
    });
    assert.ok(issues.some((i) => i.path === 'payload.elapsedMs'));
  });

  it('accepts a valid task_graph.task_failed payload', () => {
    const issues = validateRunEventPayload('task_graph.task_failed', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'coder',
      error: 'build failed',
      elapsedMs: 500,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects task_graph.task_failed missing error', () => {
    const issues = validateRunEventPayload('task_graph.task_failed', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'coder',
    });
    assert.ok(issues.some((i) => i.path === 'payload.error'));
  });

  it('accepts a valid task_graph.task_cancelled payload', () => {
    const issues = validateRunEventPayload('task_graph.task_cancelled', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'explorer',
      reason: 'parent aborted',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects task_graph.task_cancelled missing reason', () => {
    const issues = validateRunEventPayload('task_graph.task_cancelled', {
      executionId: 'graph_1',
      taskId: 'a',
      agent: 'explorer',
    });
    assert.ok(issues.some((i) => i.path === 'payload.reason'));
  });

  it('accepts a valid task_graph.graph_completed payload', () => {
    const issues = validateRunEventPayload('task_graph.graph_completed', {
      executionId: 'graph_1',
      summary: 'three nodes ran',
      success: true,
      aborted: false,
      nodeCount: 3,
      totalRounds: 7,
      wallTimeMs: 1234,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects task_graph.graph_completed with boolean success as string', () => {
    const issues = validateRunEventPayload('task_graph.graph_completed', {
      executionId: 'graph_1',
      summary: 'failed',
      success: 'false',
      aborted: false,
      nodeCount: 3,
      totalRounds: 7,
      wallTimeMs: 1234,
    });
    assert.ok(issues.some((i) => i.path === 'payload.success'));
  });

  it('rejects task_graph.graph_completed with non-integer nodeCount', () => {
    const issues = validateRunEventPayload('task_graph.graph_completed', {
      executionId: 'graph_1',
      summary: 'done',
      success: true,
      aborted: false,
      nodeCount: 2.5,
      totalRounds: 7,
      wallTimeMs: 1234,
    });
    assert.ok(issues.some((i) => i.path === 'payload.nodeCount'));
  });

  it('returns empty for unknown event types (no schema defined)', () => {
    const issues = validateRunEventPayload('session_started', { sessionId: 'x' });
    assert.deepEqual(issues, []);
  });

  it('exports the full set of schema-covered event types', () => {
    // Guard rail: if a new delegation event type lands in the shared
    // runtime contract and we forget to add a validator, the test
    // suite should tell us. This is the list of types we currently
    // cover. Update BOTH this set and the schema map in lockstep.
    assert.deepEqual([...SCHEMA_VALIDATED_EVENT_TYPES].sort(), [
      'subagent.completed',
      'subagent.failed',
      'subagent.started',
      'task_graph.graph_completed',
      'task_graph.task_cancelled',
      'task_graph.task_completed',
      'task_graph.task_failed',
      'task_graph.task_ready',
      'task_graph.task_started',
    ]);
  });
});

describe('validateEvent (envelope + payload composed)', () => {
  it('reports envelope issues before touching the payload', () => {
    const issues = validateEvent({
      ...makeValidEnvelope({ v: 'push.runtime.v0' }),
      payload: { executionId: 'sub_1', agent: 'explorer' },
    });
    // Envelope should fail first; payload validator should not have run.
    assert.ok(issues.some((i) => i.path === 'v'));
    assert.ok(!issues.some((i) => i.path.startsWith('payload.')));
  });

  it('reports payload issues when envelope is valid', () => {
    const envelope = makeValidEnvelope({
      type: 'task_graph.graph_completed',
      payload: {
        executionId: 'graph_1',
        summary: 'ok',
        success: 'true', // wrong type
        aborted: false,
        nodeCount: 1,
        totalRounds: 1,
        wallTimeMs: 1,
      },
    });
    const issues = validateEvent(envelope);
    assert.ok(issues.some((i) => i.path === 'payload.success'));
  });

  it('returns empty for a valid event all the way through', () => {
    const issues = validateEvent(makeValidEnvelope());
    assert.deepEqual(issues, []);
  });
});

describe('assertValidEvent', () => {
  it('does not throw for a valid event', () => {
    assert.doesNotThrow(() => assertValidEvent(makeValidEnvelope()));
  });

  it('throws a descriptive error for an invalid event', () => {
    assert.throws(
      () => assertValidEvent(makeValidEnvelope({ runId: null })),
      (err) => {
        assert.match(err.message, /Protocol schema violation/);
        assert.match(err.message, /subagent\.started/);
        assert.match(err.message, /runId/);
        return true;
      },
    );
  });

  it('includes the full envelope in the thrown error for easier debugging', () => {
    try {
      assertValidEvent(makeValidEnvelope({ seq: -5 }));
      assert.fail('expected throw');
    } catch (err) {
      assert.match(err.message, /Full envelope:/);
      assert.match(err.message, /"seq":-5/);
    }
  });
});
