import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PROTOCOL_VERSION,
  SCHEMA_VALIDATED_EVENT_TYPES,
  SUBAGENT_AGENTS,
  TASK_GRAPH_AGENTS,
  assertValidEvent,
  isStrictModeEnabled,
  validateEvent,
  validateEventEnvelope,
  validateRunEventPayload,
} from '../../lib/protocol-schema.ts';

// Cache the runtime-contract source file once per suite. The three
// drift guard-rail tests (event types, RunEventSubagent roles,
// TaskGraphNode agent) all read from the same file.
async function loadRuntimeContractSource() {
  const contractPath = path.join(import.meta.dirname, '..', '..', 'lib', 'runtime-contract.ts');
  return fs.readFile(contractPath, 'utf8');
}

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

  it('covers every delegation variant declared in RunEventInput', async () => {
    // This is the real drift guard: parse `lib/runtime-contract.ts` to
    // find the `RunEventInput` discriminated union, extract every
    // `type: '...'` literal inside its body, and filter to the
    // delegation-event subset (`subagent.*` and `task_graph.*`). The
    // result is the authoritative list of types any CLI/Web client
    // should expect on the wire. `SCHEMA_VALIDATED_EVENT_TYPES` must
    // equal that list — otherwise a new delegation variant has landed
    // in the shared runtime contract without a matching schema, and a
    // strict-mode broadcast of it would slip through this PR's
    // validator entirely.
    //
    // Reading source text is brittler than importing a runtime const,
    // but the RunEvent union is TypeScript-only (erased at runtime) and
    // the union-member syntax is produced deterministically by biome
    // format, so a regex over the file text is a reasonable trade-off.
    // If runtime-contract.ts ever grows its own runtime-const mirror of
    // the delegation types, this test should switch to importing that
    // mirror instead.
    const source = await loadRuntimeContractSource();

    // Find the body of `export type RunEventInput = ...;`. The block
    // ends at the semicolon that closes the entire union declaration,
    // which is the first `;` encountered at brace depth 0 — naive
    // `indexOf(';')` would land on an interior semicolon like
    // `round: number;` inside the first union member.
    const unionStart = source.indexOf('export type RunEventInput');
    assert.ok(unionStart >= 0, 'RunEventInput type not found in runtime-contract.ts');
    let unionEnd = -1;
    let depth = 0;
    for (let i = unionStart; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === ';' && depth === 0) {
        unionEnd = i;
        break;
      }
    }
    assert.ok(unionEnd > unionStart, 'RunEventInput type block not terminated');
    const unionBody = source.slice(unionStart, unionEnd);

    // Extract every `type: '...'` literal in the union body.
    const typeLiteralRe = /type:\s*'([^']+)'/g;
    const allTypes = new Set();
    for (const match of unionBody.matchAll(typeLiteralRe)) {
      allTypes.add(match[1]);
    }
    assert.ok(
      allTypes.size > 0,
      `expected RunEventInput to declare at least one type literal, got ${JSON.stringify([...allTypes])}`,
    );

    // Filter to the delegation-event subset we want to schema-validate.
    // The other RunEvent types (assistant.*, tool.*, user.*) are left
    // to envelope-only validation per this PR's scope.
    const delegationTypes = [...allTypes]
      .filter((t) => t.startsWith('subagent.') || t.startsWith('task_graph.'))
      .sort();

    assert.deepEqual(
      [...SCHEMA_VALIDATED_EVENT_TYPES].sort(),
      delegationTypes,
      `SCHEMA_VALIDATED_EVENT_TYPES drifted from RunEventInput's delegation variants.\n` +
        `If you just added a new \`subagent.*\` or \`task_graph.*\` variant to ` +
        `lib/runtime-contract.ts, you also need to register a payload validator ` +
        `in cli/protocol-schema.ts (see the PAYLOAD_VALIDATORS map).`,
    );
  });

  it('SUBAGENT_AGENTS matches the RunEventSubagent type literals', async () => {
    // Drift guard for the agent list used by `subagent.*` payload
    // validators. If someone adds a new role to the
    // `RunEventSubagent` string-literal union in
    // `lib/runtime-contract.ts`, the payload validators here will
    // start rejecting legitimate events carrying that new role. This
    // test catches that drift by re-extracting the union from source.
    const source = await loadRuntimeContractSource();

    const typeStart = source.indexOf('export type RunEventSubagent');
    assert.ok(typeStart >= 0, 'RunEventSubagent not found in runtime-contract.ts');
    const typeEnd = source.indexOf(';', typeStart);
    assert.ok(typeEnd > typeStart, 'RunEventSubagent declaration not terminated');
    const typeBody = source.slice(typeStart, typeEnd);

    const literals = [...typeBody.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    assert.ok(
      literals.length > 0,
      `expected RunEventSubagent to declare at least one literal, got ${JSON.stringify(literals)}`,
    );

    assert.deepEqual(
      [...SUBAGENT_AGENTS].sort(),
      literals,
      `SUBAGENT_AGENTS drifted from RunEventSubagent in lib/runtime-contract.ts. ` +
        `If you just added a new agent role to the union, also add it to ` +
        `SUBAGENT_AGENTS in cli/protocol-schema.ts — otherwise subagent.* ` +
        `events carrying the new role will be rejected by strict-mode validation.`,
    );
  });

  it('TASK_GRAPH_AGENTS matches TaskGraphNode.agent literals', async () => {
    // Drift guard for the narrower set of agents allowed on task_graph
    // nodes. `TaskGraphNode.agent` is declared inline as a string-literal
    // union on the interface field, so the regex is targeted at that
    // specific field declaration rather than a full type export.
    const source = await loadRuntimeContractSource();

    // Locate `export interface TaskGraphNode { ... }` and carve out the
    // `agent: '...' | '...';` line inside it. A simple regex on the
    // field is enough because biome format writes each field on its
    // own line.
    const ifaceStart = source.indexOf('export interface TaskGraphNode');
    assert.ok(ifaceStart >= 0, 'TaskGraphNode interface not found');
    const ifaceEnd = source.indexOf('}', ifaceStart);
    assert.ok(ifaceEnd > ifaceStart, 'TaskGraphNode interface not terminated');
    const ifaceBody = source.slice(ifaceStart, ifaceEnd);

    const agentField = ifaceBody.match(/agent:\s*([^;]+);/);
    assert.ok(agentField, 'TaskGraphNode.agent field not found — has the interface shape changed?');

    const literals = [...agentField[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    assert.ok(
      literals.length > 0,
      `expected TaskGraphNode.agent to declare at least one literal, got ${JSON.stringify(literals)}`,
    );

    assert.deepEqual(
      [...TASK_GRAPH_AGENTS].sort(),
      literals,
      `TASK_GRAPH_AGENTS drifted from TaskGraphNode.agent in lib/runtime-contract.ts. ` +
        `If you just broadened the agent type (e.g. added 'auditor'), also add it to ` +
        `TASK_GRAPH_AGENTS in cli/protocol-schema.ts — otherwise task_graph.* events ` +
        `carrying the new agent will be rejected by strict-mode validation.`,
    );
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
