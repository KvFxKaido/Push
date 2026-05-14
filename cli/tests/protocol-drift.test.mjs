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
      'assistant.prompt_snapshot',
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

  it('accepts a well-formed assistant.prompt_snapshot envelope in strict mode', () => {
    assertStrictBroadcastPass(
      makeEnvelope('assistant.prompt_snapshot', {
        round: 3,
        role: 'orchestrator',
        totalChars: 20888,
        sections: {
          identity: { hash: 1234567, size: 191, volatile: false },
          memory: { hash: 7654321, size: 540, volatile: true },
        },
      }),
    );
  });

  it('rejects assistant.prompt_snapshot with an unknown role in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('assistant.prompt_snapshot', {
        round: 3,
        role: 'mystery-role',
        totalChars: 20888,
        sections: {},
      }),
    );
  });

  it('rejects assistant.prompt_snapshot with a non-boolean section.volatile in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('assistant.prompt_snapshot', {
        round: 3,
        role: 'orchestrator',
        totalChars: 20888,
        sections: { identity: { hash: 1234567, size: 191, volatile: 'yes' } },
      }),
    );
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

// ---------------------------------------------------------------------------
// Relay-control envelopes (Phase 2.d.1)
//
// Drift detector for the relay vocabulary added in
// `lib/protocol-schema.ts`. The relay DO (`app/src/worker/relay-do.ts`)
// is the only consumer today, so the pin shape is:
//
//   - `RELAY_ENVELOPE_KINDS` lists every relay-control kind.
//   - Each kind has a representative valid envelope that
//     `validateRelayEnvelope` accepts.
//   - Each kind has a representative malformed envelope that
//     `validateRelayEnvelope` rejects.
//   - `isRelayEnvelope` discriminates control envelopes from
//     forwardable runtime events.
//
// If a 5th relay kind lands without a validator update, the matching
// case here will be missing and CI fails. AGENTS.md guardrail #3 in
// PR form.
// ---------------------------------------------------------------------------

import {
  RELAY_ENVELOPE_KINDS,
  isRelayEnvelope,
  validateRelayEnvelope,
} from '../../lib/protocol-schema.ts';

describe('relay envelope schema', () => {
  it('RELAY_ENVELOPE_KINDS is the complete set the validator accepts', () => {
    const accepted = new Set();
    for (const kind of RELAY_ENVELOPE_KINDS) {
      const env = {
        v: 'push.runtime.v1',
        kind,
        ts: 1,
        // Per-kind minimum-valid fields. The allow/revoke envelopes
        // carry `tokenHashes`, NOT bearer plaintext — pushd persists
        // attach tokens by hash only and the wire matches that shape
        // so the daemon can reseed the allowlist on restart.
        ...(kind === 'relay_phone_allow' || kind === 'relay_phone_revoke'
          ? { tokenHashes: ['c2hhMjU2X29mX2JlYXJlcg'] }
          : {}),
        ...(kind === 'relay_replay_unavailable' ? { reason: 'BUFFER_GAP' } : {}),
      };
      const issues = validateRelayEnvelope(env);
      assert.equal(
        issues.length,
        0,
        `kind=${kind} should validate, got: ${JSON.stringify(issues)}`,
      );
      accepted.add(kind);
    }
    assert.deepEqual(Array.from(accepted).sort(), Array.from(RELAY_ENVELOPE_KINDS).sort());
  });

  it('isRelayEnvelope discriminates control envelopes from runtime events', () => {
    assert.equal(isRelayEnvelope({ v: 'push.runtime.v1', kind: 'relay_attach', ts: 1 }), true);
    // `kind: 'event'` is the runtime broadcast vocabulary; not a
    // relay-control envelope.
    assert.equal(
      isRelayEnvelope({
        v: 'push.runtime.v1',
        kind: 'event',
        sessionId: 's',
        seq: 0,
        ts: 1,
        type: 'foo',
        payload: {},
      }),
      false,
    );
    // Non-objects / missing kind:
    assert.equal(isRelayEnvelope(null), false);
    assert.equal(isRelayEnvelope('string'), false);
    assert.equal(isRelayEnvelope({ v: 'push.runtime.v1' }), false);
  });

  it('rejects relay_phone_allow without tokenHashes', () => {
    const issues = validateRelayEnvelope({
      v: 'push.runtime.v1',
      kind: 'relay_phone_allow',
      ts: 1,
    });
    assert.equal(issues.length > 0, true);
    assert.equal(
      issues.some((i) => i.path === 'tokenHashes'),
      true,
    );
  });

  it('rejects relay_phone_revoke whose tokenHashes array contains a non-string entry', () => {
    const issues = validateRelayEnvelope({
      v: 'push.runtime.v1',
      kind: 'relay_phone_revoke',
      tokenHashes: ['c2hhMjU2X29mX2JlYXJlcg', 42],
      ts: 1,
    });
    assert.equal(issues.length > 0, true);
    assert.equal(
      issues.some((i) => i.path === 'tokenHashes[1]'),
      true,
    );
  });

  it('rejects relay_attach whose lastSeq is negative or non-integer', () => {
    assert.equal(
      validateRelayEnvelope({
        v: 'push.runtime.v1',
        kind: 'relay_attach',
        lastSeq: -1,
        ts: 1,
      }).length > 0,
      true,
    );
    assert.equal(
      validateRelayEnvelope({
        v: 'push.runtime.v1',
        kind: 'relay_attach',
        lastSeq: 1.5,
        ts: 1,
      }).length > 0,
      true,
    );
    // Omitted lastSeq is valid (first-attach scenario).
    assert.equal(
      validateRelayEnvelope({ v: 'push.runtime.v1', kind: 'relay_attach', ts: 1 }).length,
      0,
    );
  });

  it('rejects relay_replay_unavailable without reason', () => {
    const issues = validateRelayEnvelope({
      v: 'push.runtime.v1',
      kind: 'relay_replay_unavailable',
      ts: 1,
    });
    assert.equal(issues.length > 0, true);
    assert.equal(
      issues.some((i) => i.path === 'reason'),
      true,
    );
  });

  it('rejects an unknown kind', () => {
    const issues = validateRelayEnvelope({
      v: 'push.runtime.v1',
      kind: 'relay_made_up',
      ts: 1,
    });
    assert.equal(
      issues.some((i) => i.path === 'kind'),
      true,
    );
  });

  it('rejects wrong protocol version', () => {
    const issues = validateRelayEnvelope({
      v: 'push.runtime.v2',
      kind: 'relay_attach',
      ts: 1,
    });
    assert.equal(
      issues.some((i) => i.path === 'v'),
      true,
    );
  });
});
