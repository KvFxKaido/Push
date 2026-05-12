import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { broadcastEvent } from '../pushd.ts';
import {
  PROTOCOL_VERSION,
  SCHEMA_VALIDATED_EVENT_TYPES,
  assertValidEvent,
  isStrictModeEnabled,
  validateRunEventPayload,
} from '../../lib/protocol-schema.ts';
import { isV2DelegationEvent, synthesizeV1DelegationEvent } from '../v1-downgrade.ts';

const FIXED_TS = 1_712_345_678_901;

function installStrictModeHooks() {
  let previousStrictMode;

  before(() => {
    previousStrictMode = process.env.PUSH_PROTOCOL_STRICT;
    process.env.PUSH_PROTOCOL_STRICT = '1';
  });

  after(() => {
    if (previousStrictMode === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
    else process.env.PUSH_PROTOCOL_STRICT = previousStrictMode;
  });
}

function installNonStrictModeHooks() {
  let previousStrictMode;

  before(() => {
    previousStrictMode = process.env.PUSH_PROTOCOL_STRICT;
    delete process.env.PUSH_PROTOCOL_STRICT;
  });

  after(() => {
    if (previousStrictMode === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
    else process.env.PUSH_PROTOCOL_STRICT = previousStrictMode;
  });
}

function makeEnvelope(type, payload, overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: 'sess_protocol_drift',
    runId: 'run_parent',
    seq: 7,
    ts: FIXED_TS,
    type,
    payload,
    ...overrides,
  };
}

function assertStrictBroadcastPass(event) {
  assert.equal(isStrictModeEnabled(), true);
  assert.doesNotThrow(() => {
    broadcastEvent(event.sessionId, event);
  });
}

function assertStrictBroadcastFail(event, type = event.type) {
  assert.equal(isStrictModeEnabled(), true);
  assert.throws(
    () => {
      broadcastEvent(event.sessionId, event);
    },
    new RegExp(`Protocol schema violation on event "${type.replaceAll('.', '\\.')}"`),
  );
}

describe('protocol drift characterization — schema surface', () => {
  it('pins the current set of schema-validated event types', () => {
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

  it('treats assistant and approval payloads as envelope-only today', () => {
    assert.deepEqual(validateRunEventPayload('assistant_done', { messageId: 'asst_123' }), []);
    assert.deepEqual(validateRunEventPayload('assistant_token', { text: 'hello' }), []);
    assert.deepEqual(
      validateRunEventPayload('approval_required', {
        approvalId: 'approval_123',
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf dist',
        options: ['approve', 'deny'],
      }),
      [],
    );
    assert.deepEqual(
      validateRunEventPayload('approval_received', {
        approvalId: 'approval_123',
        decision: 'approve',
        by: 'client',
      }),
      [],
    );
  });
});

describe('protocol drift characterization — assistant lifecycle family', () => {
  installStrictModeHooks();

  it('accepts a well-formed assistant_done envelope in strict mode', () => {
    assertStrictBroadcastPass(makeEnvelope('assistant_done', { messageId: 'asst_123' }));
  });

  it('rejects assistant_done missing the payload field in strict mode', () => {
    const event = makeEnvelope('assistant_done', { messageId: 'asst_123' });
    delete event.payload;
    assertStrictBroadcastFail(event);
  });
});

describe('protocol drift characterization — approval family', () => {
  installStrictModeHooks();

  it('accepts a well-formed approval_required envelope in strict mode', () => {
    assertStrictBroadcastPass(
      makeEnvelope('approval_required', {
        approvalId: 'approval_123',
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf dist',
        options: ['approve', 'deny'],
      }),
    );
  });

  it('rejects approval_received with an invalid seq in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope(
        'approval_received',
        { approvalId: 'approval_123', decision: 'approve', by: 'client' },
        { seq: -1 },
      ),
    );
  });
});

describe('protocol drift characterization — subagent family', () => {
  installStrictModeHooks();

  it('accepts a well-formed subagent.started envelope with additive fields in strict mode', () => {
    assertStrictBroadcastPass(
      makeEnvelope('subagent.started', {
        executionId: 'sub_1',
        subagentId: 'sub_1',
        parentRunId: 'run_parent',
        childRunId: 'run_child',
        agent: 'explorer',
        role: 'explorer',
        detail: 'scan repo layout',
        futureOptionalField: 'allowed',
      }),
    );
  });

  it('rejects subagent.completed missing summary in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('subagent.completed', {
        executionId: 'sub_1',
        agent: 'explorer',
      }),
    );
  });
});

describe('protocol drift characterization — task_graph family', () => {
  installStrictModeHooks();

  it('accepts a well-formed task_graph.graph_completed envelope in strict mode', () => {
    assertStrictBroadcastPass(
      makeEnvelope('task_graph.graph_completed', {
        executionId: 'graph_1',
        summary: '2 tasks completed',
        success: true,
        aborted: false,
        nodeCount: 2,
        totalRounds: 3,
        wallTimeMs: 456,
      }),
    );
  });

  it('rejects task_graph.task_ready missing taskId in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('task_graph.task_ready', {
        executionId: 'graph_1',
        agent: 'explorer',
        detail: 'ready',
      }),
    );
  });
});

describe('protocol drift characterization — strict downgrade toggle', () => {
  installNonStrictModeHooks();

  it('passes malformed delegation payloads through when strict mode is disabled', () => {
    assert.equal(isStrictModeEnabled(), false);
    assert.doesNotThrow(() => {
      broadcastEvent(
        'sess_protocol_drift',
        makeEnvelope('subagent.completed', {
          executionId: 'sub_1',
          agent: 'explorer',
        }),
      );
    });
  });

  it('passes malformed envelope-only events through when strict mode is disabled', () => {
    const event = makeEnvelope('assistant_done', { messageId: 'asst_123' });
    delete event.payload;
    assert.equal(isStrictModeEnabled(), false);
    assert.doesNotThrow(() => {
      broadcastEvent(event.sessionId, event);
    });
  });
});

describe('protocol drift characterization — additive evolution', () => {
  installStrictModeHooks();

  it('silently tolerates unknown optional payload fields on schema-validated events', () => {
    assert.doesNotThrow(() => {
      assertValidEvent(
        makeEnvelope('task_graph.task_started', {
          executionId: 'graph_1',
          taskId: 'task_a',
          agent: 'coder',
          detail: 'running',
          futureField: { shape: 'new' },
        }),
      );
    });
  });
});

describe('protocol drift characterization — v1 downgrade fidelity', () => {
  const downgradeCases = [
    {
      name: 'subagent.started downgrades to a parent-run assistant_token line',
      source: makeEnvelope(
        'subagent.started',
        {
          executionId: 'sub_1',
          subagentId: 'sub_1',
          parentRunId: 'run_parent',
          childRunId: 'run_child',
          agent: 'explorer',
          role: 'explorer',
          detail: 'inspect repo layout',
        },
        { runId: 'run_child' },
      ),
      expected: [
        makeEnvelope(
          'assistant_token',
          { text: '[Explorer] started: inspect repo layout\n' },
          { runId: 'run_parent' },
        ),
      ],
    },
    {
      name: 'subagent.completed downgrades to a parent-run assistant_token line',
      source: makeEnvelope(
        'subagent.completed',
        {
          executionId: 'sub_1',
          subagentId: 'sub_1',
          parentRunId: 'run_parent',
          childRunId: 'run_child',
          agent: 'coder',
          role: 'coder',
          summary: 'Added retry logic',
        },
        { runId: 'run_child' },
      ),
      expected: [
        makeEnvelope(
          'assistant_token',
          { text: '[Coder] completed: Added retry logic\n' },
          { runId: 'run_parent' },
        ),
      ],
    },
    {
      name: 'subagent.failed downgrades to a parent-run assistant_token line',
      source: makeEnvelope(
        'subagent.failed',
        {
          executionId: 'sub_1',
          subagentId: 'sub_1',
          parentRunId: 'run_parent',
          childRunId: 'run_child',
          agent: 'reviewer',
          role: 'reviewer',
          error: 'provider timeout',
        },
        { runId: 'run_child' },
      ),
      expected: [
        makeEnvelope(
          'assistant_token',
          { text: '[Reviewer] failed: provider timeout\n' },
          { runId: 'run_parent' },
        ),
      ],
    },
    {
      name: 'task_graph.task_ready downgrades to a parent-run assistant_token line',
      source: makeEnvelope('task_graph.task_ready', {
        executionId: 'graph_1',
        taskId: 'task_a',
        agent: 'coder',
        detail: 'ready',
      }),
      expected: [
        makeEnvelope('assistant_token', { text: '[TaskGraph] task ready: task_a (coder)\n' }),
      ],
    },
    {
      name: 'task_graph.task_started downgrades to a parent-run assistant_token line',
      source: makeEnvelope('task_graph.task_started', {
        executionId: 'graph_1',
        taskId: 'task_a',
        agent: 'explorer',
        detail: 'running scan',
      }),
      expected: [
        makeEnvelope('assistant_token', {
          text: '[TaskGraph] task started: task_a (explorer) — running scan\n',
        }),
      ],
    },
    {
      name: 'task_graph.task_completed downgrades to a parent-run assistant_token line',
      source: makeEnvelope('task_graph.task_completed', {
        executionId: 'graph_1',
        taskId: 'task_a',
        agent: 'coder',
        summary: 'wrote file',
        elapsedMs: 321,
      }),
      expected: [
        makeEnvelope('assistant_token', {
          text: '[TaskGraph] task completed: task_a (coder) — wrote file\n',
        }),
      ],
    },
    {
      name: 'task_graph.task_failed downgrades to a parent-run assistant_token line',
      source: makeEnvelope('task_graph.task_failed', {
        executionId: 'graph_1',
        taskId: 'task_a',
        agent: 'coder',
        error: 'boom',
        elapsedMs: 321,
      }),
      expected: [
        makeEnvelope('assistant_token', {
          text: '[TaskGraph] task failed: task_a (coder) — boom\n',
        }),
      ],
    },
    {
      name: 'task_graph.task_cancelled downgrades to a parent-run assistant_token line',
      source: makeEnvelope('task_graph.task_cancelled', {
        executionId: 'graph_1',
        taskId: 'task_a',
        agent: 'explorer',
        reason: 'user cancel',
        elapsedMs: 321,
      }),
      expected: [
        makeEnvelope('assistant_token', {
          text: '[TaskGraph] task cancelled: task_a (explorer) — user cancel\n',
        }),
      ],
    },
    {
      name: 'task_graph.graph_completed downgrades to a lossy assistant_token summary',
      source: makeEnvelope('task_graph.graph_completed', {
        executionId: 'graph_1',
        summary: 'all done',
        success: false,
        aborted: true,
        nodeCount: 3,
        totalRounds: 9,
        wallTimeMs: 654,
      }),
      expected: [
        makeEnvelope('assistant_token', {
          text: '[TaskGraph] graph completed: 3 nodes, success=false\n',
        }),
      ],
    },
  ];

  for (const { name, source, expected } of downgradeCases) {
    it(name, () => {
      assert.equal(isV2DelegationEvent(source.type), true);
      assert.deepEqual(synthesizeV1DelegationEvent(source), expected);
    });
  }

  it('recognizes non-downgradeable events via isV2DelegationEvent', () => {
    assert.equal(isV2DelegationEvent('assistant_token'), false);
    assert.equal(isV2DelegationEvent('assistant_done'), false);
    assert.equal(isV2DelegationEvent('approval_required'), false);
    assert.equal(isV2DelegationEvent('approval_received'), false);
  });
});
