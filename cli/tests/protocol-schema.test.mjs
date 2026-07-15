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

  it('accepts subagent.completed with orchestratorBytes', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'coder',
      summary: 'done',
      orchestratorBytes: 280,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects subagent.completed with non-numeric orchestratorBytes', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'coder',
      summary: 'done',
      orchestratorBytes: '280',
    });
    assert.ok(issues.some((i) => i.path === 'payload.orchestratorBytes'));
  });

  it('rejects subagent.completed with negative orchestratorBytes', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'coder',
      summary: 'done',
      orchestratorBytes: -1,
    });
    assert.ok(issues.some((i) => i.path === 'payload.orchestratorBytes'));
  });

  it('rejects subagent.completed with non-integer orchestratorBytes', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'coder',
      summary: 'done',
      orchestratorBytes: 1.5,
    });
    assert.ok(issues.some((i) => i.path === 'payload.orchestratorBytes'));
  });

  it('accepts subagent.completed with zero orchestratorBytes', () => {
    const issues = validateRunEventPayload('subagent.completed', {
      executionId: 'sub_1',
      agent: 'coder',
      summary: 'done',
      orchestratorBytes: 0,
    });
    assert.deepEqual(issues, []);
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
    // Use a deliberately fake event name — every concrete daemon-
    // emitted type the TUI cares about now has a validator (PR #4),
    // so the only way to exercise the "no schema" branch is with a
    // type the registry doesn't recognise.
    const issues = validateRunEventPayload('totally.unregistered.type', { foo: 'bar' });
    assert.deepEqual(issues, []);
  });

  it('covers every variant declared in RunEventInput', async () => {
    // This is the real drift guard: parse `lib/runtime-contract.ts` to
    // find the `RunEventInput` discriminated union, extract every
    // `type: '...'` literal inside its body, and assert two
    // invariants:
    //
    //   1. EVERY RunEventInput variant has a registered payload
    //      validator in `SCHEMA_VALIDATED_EVENT_TYPES`. The contract is
    //      intended to be complete — every typed run event is
    //      schema-validated — so a new variant without a validator
    //      slips through strict/observe validation silently. (Events
    //      with no required payload, e.g. `assistant_done`, live OUTSIDE
    //      RunEventInput and are envelope-only by design.)
    //   2. Every type in `SCHEMA_VALIDATED_EVENT_TYPES` corresponds
    //      to a real RunEventInput variant, OR is on the daemon-only
    //      allowlist below. Otherwise an orphan validator is registered
    //      for a removed/renamed event type.
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

    // Invariant 1: every RunEventInput variant has a validator.
    const runEventTypes = [...allTypes].sort();
    const validatedSet = new Set(SCHEMA_VALIDATED_EVENT_TYPES);
    const missingValidators = runEventTypes.filter((t) => !validatedSet.has(t));
    assert.deepEqual(
      missingValidators,
      [],
      `RunEventInput variants without a payload validator.\n` +
        `Every variant in the RunEventInput union (lib/runtime-contract.ts) must ` +
        `have a payload validator registered in lib/protocol-schema.ts (the ` +
        `PAYLOAD_VALIDATORS map). If you added a new variant, register one. If it ` +
        `is genuinely envelope-only (no required payload), it should not live in ` +
        `RunEventInput — emit it as a daemon-only event instead (see assistant_done).`,
    );

    // Invariant 2: no orphan validators — every validated type must
    // correspond to a real RunEventInput variant, OR be on the
    // daemon-only allowlist below.
    //
    // The allowlist is for events the daemon emits in response to
    // out-of-band session mutations (not part of a run's event stream).
    // These intentionally do not live in `RunEventInput` because lib
    // agents never produce them — adding them to that union would
    // misrepresent the shared contract. They still need schema
    // validation, hence the allowlist instead of just skipping them.
    const DAEMON_ONLY_VALIDATED_TYPES = new Set([
      // Emitted by `update_session` and `configure_role_routing` in
      // `cli/pushd.ts` so attached clients can mirror the daemon's
      // session-scoped truth (provider, model, roleRouting).
      'session_state_changed',
      // Lifecycle + streaming events the daemon emits to fan-out
      // clients. These shapes live in `cli/pushd.ts` (the
      // broadcaster) and are read by `cli/tui.ts` /
      // `app/src/hooks/chat-*`; the lib agent kernels don't emit
      // them, so they don't belong in `RunEventInput`. Pinning their
      // schemas here closes the silent-drift hole the audit flagged
      // (PR #4): a rename or wrong-type regression now lands as a
      // strict-mode broadcast failure instead of slipping through
      // to a runtime UI bug.
      'approval_received',
      'approval_required',
      // Emitted by the headless CLI adapter after its post-run acceptance
      // commands settle; it is part of the saved run receipt but not an
      // event produced by the shared agent kernel.
      'acceptance_complete',
      'assistant_citations',
      'assistant_thinking_token',
      'assistant_token',
      'error',
      'run_complete',
      'session_started',
      'status',
      'tool.call_malformed',
      'tool.execution_complete',
      'tool.execution_start',
      'tool_call',
      'tool_result',
      'user_message',
      'warning',
      // Session-mutation broadcasts + recovery/interruption events emitted
      // by `cli/pushd.ts` (the latter persisted via `appendSessionEvent` and
      // replayed through the validated fan-out on reconnect). Daemon-owned,
      // so deliberately absent from `RunEventInput`.
      'context_compacted',
      'session_reverted',
      'session_unreverted',
      'run_recovered',
      'recovery_skipped',
      'delegation_interrupted',
    ]);
    const orphanValidators = [...SCHEMA_VALIDATED_EVENT_TYPES]
      .filter((t) => !allTypes.has(t) && !DAEMON_ONLY_VALIDATED_TYPES.has(t))
      .sort();
    assert.deepEqual(
      orphanValidators,
      [],
      `Payload validators registered for types that do not exist in RunEventInput\n` +
        `and are not on the DAEMON_ONLY_VALIDATED_TYPES allowlist.\n` +
        `If you renamed or removed a RunEventInput variant, also drop its entry ` +
        `from PAYLOAD_VALIDATORS in lib/protocol-schema.ts.\n` +
        `If you added a new daemon-emitted event, extend ` +
        `DAEMON_ONLY_VALIDATED_TYPES in this test.`,
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

describe('validateRunEventPayload — session-mutation broadcasts', () => {
  it('accepts a valid context_compacted payload', () => {
    const issues = validateRunEventPayload('context_compacted', {
      preserveTurns: 4,
      totalTurns: 20,
      compactedMessages: 12,
      removedCount: 8,
      beforeTokens: 50_000,
      afterTokens: 12_000,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects context_compacted with a non-integer count', () => {
    const issues = validateRunEventPayload('context_compacted', {
      preserveTurns: 4,
      totalTurns: 20,
      compactedMessages: 12,
      removedCount: 8,
      beforeTokens: 50_000,
      afterTokens: 'lots',
    });
    assert.ok(issues.some((i) => i.path === 'payload.afterTokens'));
  });

  it('accepts a valid session_reverted payload', () => {
    const issues = validateRunEventPayload('session_reverted', {
      turns: 2,
      removedCount: 6,
      totalTurns: 10,
      remainingTurns: 8,
      remainingMessages: 24,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects session_reverted missing remainingMessages', () => {
    const issues = validateRunEventPayload('session_reverted', {
      turns: 2,
      removedCount: 6,
      totalTurns: 10,
      remainingTurns: 8,
    });
    assert.ok(issues.some((i) => i.path === 'payload.remainingMessages'));
  });

  it('accepts a valid session_unreverted payload', () => {
    const issues = validateRunEventPayload('session_unreverted', {
      restoredCount: 6,
      totalMessages: 30,
    });
    assert.deepEqual(issues, []);
  });
});

describe('validateRunEventPayload — recovery/interruption events', () => {
  it('accepts a valid run_recovered payload', () => {
    const issues = validateRunEventPayload('run_recovered', {
      originalRunId: 'run_a',
      recoveryRunId: 'run_b',
      policy: 'on-failure',
      markerAge: 42_000,
    });
    assert.deepEqual(issues, []);
  });

  it('accepts run_recovered with a negative markerAge (clock skew)', () => {
    const issues = validateRunEventPayload('run_recovered', {
      originalRunId: 'run_a',
      recoveryRunId: 'run_b',
      policy: 'always',
      markerAge: -5,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects run_recovered missing recoveryRunId', () => {
    const issues = validateRunEventPayload('run_recovered', {
      originalRunId: 'run_a',
      policy: 'always',
      markerAge: 0,
    });
    assert.ok(issues.some((i) => i.path === 'payload.recoveryRunId'));
  });

  it('accepts a valid recovery_skipped payload', () => {
    const issues = validateRunEventPayload('recovery_skipped', {
      originalRunId: 'run_a',
      reason: 'policy=never',
      policy: 'never',
      markerAge: 1_000,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects recovery_skipped with a non-string reason', () => {
    const issues = validateRunEventPayload('recovery_skipped', {
      originalRunId: 'run_a',
      reason: 42,
      policy: 'never',
      markerAge: 1_000,
    });
    assert.ok(issues.some((i) => i.path === 'payload.reason'));
  });

  it('accepts delegation_interrupted with empty arrays', () => {
    const issues = validateRunEventPayload('delegation_interrupted', {
      originalRunId: 'run_a',
      recoveryRunId: 'run_b',
      subagents: [],
      graphs: [],
    });
    assert.deepEqual(issues, []);
  });

  it('accepts delegation_interrupted with populated object arrays', () => {
    // collectOrphanedDelegations yields { subagentId, agent } and
    // { executionId } objects — NOT strings.
    const issues = validateRunEventPayload('delegation_interrupted', {
      originalRunId: 'run_a',
      recoveryRunId: 'run_b',
      subagents: [{ subagentId: 'sub_1', agent: 'coder' }],
      graphs: [{ executionId: 'graph_1' }],
    });
    assert.deepEqual(issues, []);
  });

  it('rejects delegation_interrupted with a subagents element missing agent', () => {
    const issues = validateRunEventPayload('delegation_interrupted', {
      originalRunId: 'run_a',
      recoveryRunId: 'run_b',
      subagents: [{ subagentId: 'sub_1' }],
      graphs: [],
    });
    assert.ok(issues.some((i) => i.path === 'payload.subagents[0].agent'));
  });

  it('rejects delegation_interrupted when subagents holds a non-object (old string shape)', () => {
    const issues = validateRunEventPayload('delegation_interrupted', {
      originalRunId: 'run_a',
      recoveryRunId: 'run_b',
      subagents: ['sub_1'],
      graphs: [],
    });
    assert.ok(issues.some((i) => i.path === 'payload.subagents[0]'));
  });
});

describe('validateRunEventPayload — RunEventInput passthrough events', () => {
  it('accepts turn.route and rejects an unknown route', () => {
    assert.deepEqual(
      validateRunEventPayload('turn.route', {
        route: 'inline-delegation',
        reason: 'conversational_inline',
        intent: 'conversational',
        repoBranchReady: true,
      }),
      [],
    );
    const issues = validateRunEventPayload('turn.route', {
      route: 'side-quest',
      reason: 'conversational_inline',
      intent: 'conversational',
      repoBranchReady: true,
    });
    assert.ok(issues.some((i) => i.path === 'payload.route'));
  });

  it('still accepts the legacy conversational_downgrade reason (back-compat)', () => {
    // Pre-Phase-3 clients persisted turn.route events with this reason; the
    // validator must keep accepting them so stored/replayed envelopes don't
    // fail strict validation after upgrade.
    assert.deepEqual(
      validateRunEventPayload('turn.route', {
        route: 'orchestrator',
        reason: 'conversational_downgrade',
        suppressedRoute: 'inline-delegation',
        intent: 'conversational',
        repoBranchReady: true,
      }),
      [],
    );
  });

  it('accepts assistant.turn_start', () => {
    assert.deepEqual(validateRunEventPayload('assistant.turn_start', { round: 0 }), []);
  });

  it('rejects assistant.turn_start with a non-integer round', () => {
    const issues = validateRunEventPayload('assistant.turn_start', { round: 1.5 });
    assert.ok(issues.some((i) => i.path === 'payload.round'));
  });

  it('accepts render-only assistant tool prose with its round', () => {
    assert.deepEqual(
      validateRunEventPayload('assistant.tool_prose', {
        round: 2,
        text: 'I’ll run the focused tests.',
      }),
      [],
    );
    assert.ok(validateRunEventPayload('assistant.tool_prose', { round: 2, text: '' }).length > 0);
  });

  it('accepts assistant.turn_end with a valid outcome', () => {
    const issues = validateRunEventPayload('assistant.turn_end', {
      round: 3,
      outcome: 'completed',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects assistant.turn_end with an unknown outcome', () => {
    const issues = validateRunEventPayload('assistant.turn_end', { round: 3, outcome: 'finished' });
    assert.ok(issues.some((i) => i.path === 'payload.outcome'));
  });

  it('accepts turn.quiesced only for a terminal run outcome', () => {
    assert.deepEqual(
      validateRunEventPayload('turn.quiesced', { runId: 'run-1', outcome: 'completed' }),
      [],
    );
    const issues = validateRunEventPayload('turn.quiesced', {
      runId: '',
      outcome: 'continued',
    });
    assert.ok(issues.some((issue) => issue.path === 'payload.runId'));
    assert.ok(issues.some((issue) => issue.path === 'payload.outcome'));
  });

  it('accepts tool.execution_complete target and rejects a non-string target', () => {
    const payload = {
      round: 1,
      executionId: 'exec_1',
      toolName: 'exec',
      toolSource: 'sandbox',
      durationMs: 12,
      isError: false,
      preview: 'ok',
      target: 'npm test',
    };
    assert.deepEqual(validateRunEventPayload('tool.execution_complete', payload), []);

    const issues = validateRunEventPayload('tool.execution_complete', {
      ...payload,
      target: 42,
    });
    assert.ok(issues.some((i) => i.path === 'payload.target'));
  });

  it('validates the optional tool-card envelope without rejecting future types', () => {
    const payload = {
      toolName: 'ci_status',
      isError: false,
      preview: 'ok',
      card: { type: 'future-ci-card', data: { checks: 3 } },
    };
    assert.deepEqual(validateRunEventPayload('tool.execution_complete', payload), []);

    const issues = validateRunEventPayload('tool.execution_complete', {
      ...payload,
      card: { type: 'ci-status', data: [] },
    });
    assert.ok(issues.some((issue) => issue.path === 'payload.card'));
  });

  it('accepts job.started (detail optional)', () => {
    assert.deepEqual(
      validateRunEventPayload('job.started', { executionId: 'job_1', role: 'coder' }),
      [],
    );
  });

  it('rejects job.started with an unknown role', () => {
    const issues = validateRunEventPayload('job.started', {
      executionId: 'job_1',
      role: 'planner',
    });
    assert.ok(issues.some((i) => i.path === 'payload.role'));
  });

  it('accepts job.completed and rejects a missing summary', () => {
    assert.deepEqual(
      validateRunEventPayload('job.completed', {
        executionId: 'job_1',
        role: 'explorer',
        summary: 'done',
      }),
      [],
    );
    const issues = validateRunEventPayload('job.completed', {
      executionId: 'job_1',
      role: 'explorer',
    });
    assert.ok(issues.some((i) => i.path === 'payload.summary'));
  });

  it('accepts job.failed and rejects a missing error', () => {
    assert.deepEqual(
      validateRunEventPayload('job.failed', {
        executionId: 'job_1',
        role: 'coder',
        error: 'boom',
      }),
      [],
    );
    const issues = validateRunEventPayload('job.failed', { executionId: 'job_1', role: 'coder' });
    assert.ok(issues.some((i) => i.path === 'payload.error'));
  });

  it('accepts branch_desync and rejects a missing actual branch', () => {
    assert.deepEqual(
      validateRunEventPayload('branch_desync', {
        expected: 'main',
        actual: 'feature/desynced',
        command: 'git rebase origin/main',
      }),
      [],
    );
    const issues = validateRunEventPayload('branch_desync', {
      expected: 'main',
      command: 'git rebase origin/main',
    });
    assert.ok(issues.some((i) => i.path === 'payload.actual'));
  });

  it('accepts user.follow_up_queued', () => {
    const issues = validateRunEventPayload('user.follow_up_queued', {
      round: 2,
      position: 1,
      preview: 'fix the bug',
    });
    assert.deepEqual(issues, []);
  });

  it('rejects user.follow_up_queued with a non-integer position', () => {
    const issues = validateRunEventPayload('user.follow_up_queued', {
      round: 2,
      position: -1,
      preview: 'x',
    });
    assert.ok(issues.some((i) => i.path === 'payload.position'));
  });

  it('accepts user.follow_up_steered', () => {
    const issues = validateRunEventPayload('user.follow_up_steered', {
      round: 2,
      preview: 'actually do this instead',
      replacedPending: true,
    });
    assert.deepEqual(issues, []);
  });

  it('rejects user.follow_up_steered with a non-boolean replacedPending', () => {
    const issues = validateRunEventPayload('user.follow_up_steered', {
      round: 2,
      preview: 'x',
      replacedPending: 'yes',
    });
    assert.ok(issues.some((i) => i.path === 'payload.replacedPending'));
  });
});
