import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { broadcastEvent } from '../pushd.ts';
import {
  PROTOCOL_VERSION,
  SCHEMA_VALIDATED_EVENT_TYPES,
  assertValidEvent,
  isStrictModeEnabled,
  validateRunEventPayload,
} from '../../lib/protocol-schema.ts';
import { isV2DelegationEvent, synthesizeV1DelegationEvent } from '../v1-downgrade.ts';
import { PUSH_STREAM_WIRE_CONTRACT, toPushStreamWire } from '../../lib/provider-wire.ts';

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
      'approval_received',
      'approval_required',
      'assistant.prompt_snapshot',
      'assistant.turn_end',
      'assistant.turn_start',
      'assistant_citations',
      'assistant_thinking_token',
      'assistant_token',
      'branch_desync',
      'context.compaction',
      'context_compacted',
      'delegation_interrupted',
      'error',
      'harness.adaptation',
      'job.completed',
      'job.failed',
      'job.started',
      'recovery_skipped',
      'run_complete',
      'run_recovered',
      'session_reverted',
      'session_started',
      'session_state_changed',
      'session_unreverted',
      'status',
      'subagent.completed',
      'subagent.failed',
      'subagent.started',
      'task_graph.graph_completed',
      'task_graph.task_cancelled',
      'task_graph.task_completed',
      'task_graph.task_failed',
      'task_graph.task_ready',
      'task_graph.task_started',
      'tool.call_malformed',
      'tool.execution_complete',
      'tool.execution_start',
      'tool_call',
      'tool_result',
      'turn.route',
      'user.follow_up_queued',
      'user.follow_up_steered',
      'user_message',
      'warning',
      'workspace.state_delta',
      'workspace.state_snapshot',
    ]);
  });

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
    assert.ok(issues.some((issue) => issue.path === 'payload.route'));
  });

  it('treats assistant_done and other untyped events as envelope-only today', () => {
    // `assistant_done` carries no required payload fields the TUI
    // reads; we leave it envelope-only on purpose. Anything else that
    // doesn't have a registered validator also short-circuits to []
    // — `validateRunEventPayload` returns no issues for unknown types.
    assert.deepEqual(validateRunEventPayload('assistant_done', { messageId: 'asst_123' }), []);
    assert.deepEqual(validateRunEventPayload('assistant_thinking_done', {}), []);
    assert.deepEqual(validateRunEventPayload('something.not.registered', { foo: 'bar' }), []);
  });

  it('pins ExecResult.branch on shared and web exec result envelopes', () => {
    const sharedProvider = readFileSync(
      new URL('../../lib/sandbox-provider.ts', import.meta.url),
      'utf8',
    );
    const webClient = readFileSync(
      new URL('../../app/src/lib/sandbox-client.ts', import.meta.url),
      'utf8',
    );
    assert.match(sharedProvider, /interface ExecResult[\s\S]*branch\?: string;/);
    assert.match(webClient, /interface ExecResult[\s\S]*branch\?: string;/);
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

describe('protocol drift characterization — context.compaction', () => {
  installStrictModeHooks();

  it('accepts a well-formed context.compaction envelope in strict mode', () => {
    assertStrictBroadcastPass(
      makeEnvelope('context.compaction', {
        round: 3,
        phase: 'summarization',
        beforeTokens: 90_000,
        afterTokens: 60_000,
        messagesDropped: 0,
        provider: 'openrouter',
        cause: 'tool_output',
      }),
    );
  });

  it('accepts context.compaction with optional fields omitted', () => {
    assertStrictBroadcastPass(
      makeEnvelope('context.compaction', {
        round: 5,
        phase: 'hard_trim',
        beforeTokens: 100_000,
        afterTokens: 88_000,
        messagesDropped: 4,
      }),
    );
  });

  it('rejects context.compaction with an unknown phase in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('context.compaction', {
        round: 3,
        phase: 'mystery_phase',
        beforeTokens: 100,
        afterTokens: 50,
        messagesDropped: 0,
      }),
    );
  });

  it('rejects context.compaction with negative token counts', () => {
    assertStrictBroadcastFail(
      makeEnvelope('context.compaction', {
        round: 3,
        phase: 'summarization',
        beforeTokens: -1,
        afterTokens: 50,
        messagesDropped: 0,
      }),
    );
  });
});

describe('protocol drift characterization — harness.adaptation', () => {
  installStrictModeHooks();

  it('accepts a well-formed harness.adaptation envelope in strict mode', () => {
    assertStrictBroadcastPass(
      makeEnvelope('harness.adaptation', {
        round: 3,
        fromMaxRounds: 30,
        toMaxRounds: 20,
        reasons: ['Reduce max rounds to 20: 3 malformed tool calls'],
      }),
    );
  });

  it('rejects harness.adaptation with empty reasons', () => {
    assertStrictBroadcastFail(
      makeEnvelope('harness.adaptation', {
        round: 3,
        fromMaxRounds: 30,
        toMaxRounds: 20,
        reasons: [],
      }),
    );
  });

  it('rejects harness.adaptation with a non-integer cap', () => {
    assertStrictBroadcastFail(
      makeEnvelope('harness.adaptation', {
        round: 3,
        fromMaxRounds: 30,
        toMaxRounds: 20.5,
        reasons: ['bad cap'],
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

  it('rejects approval_required missing the approvalId field', () => {
    assertStrictBroadcastFail(
      makeEnvelope('approval_required', {
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf dist',
        options: ['approve', 'deny'],
      }),
    );
  });

  it('rejects approval_required with an empty options array', () => {
    assertStrictBroadcastFail(
      makeEnvelope('approval_required', {
        approvalId: 'approval_123',
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf dist',
        options: [],
      }),
    );
  });

  it('rejects approval_required with a non-string element in options', () => {
    // app's `useApprovalQueue` iterates `options` and uses each entry
    // as a button label. A non-string element silently falls back to
    // the default approve/deny pair and hides the daemon's intent
    // (copilot review on PR #666).
    assertStrictBroadcastFail(
      makeEnvelope('approval_required', {
        approvalId: 'approval_123',
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf dist',
        options: ['approve', 42, 'deny'],
      }),
    );
  });

  it('rejects approval_required with an empty string in options', () => {
    assertStrictBroadcastFail(
      makeEnvelope('approval_required', {
        approvalId: 'approval_123',
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf dist',
        options: ['approve', '', 'deny'],
      }),
    );
  });

  it('rejects approval_received with an unknown decision value', () => {
    assertStrictBroadcastFail(
      makeEnvelope('approval_received', {
        approvalId: 'approval_123',
        decision: 'maybe',
        by: 'client',
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

describe('protocol drift characterization — assistant streaming', () => {
  installStrictModeHooks();

  it('accepts assistant_token with non-empty text', () => {
    assertStrictBroadcastPass(makeEnvelope('assistant_token', { text: 'hello world' }));
  });

  it('accepts assistant_token with empty text (zero-length delta)', () => {
    // Provider streams legitimately emit zero-length chunks across the
    // content/reasoning boundary. Rejecting them in strict mode hangs
    // the daemon broadcast loop on real runs (caught at PR #4 dev time).
    assertStrictBroadcastPass(makeEnvelope('assistant_token', { text: '' }));
  });

  it('rejects assistant_token with a non-string text field', () => {
    assertStrictBroadcastFail(makeEnvelope('assistant_token', { text: 42 }));
  });

  it('accepts assistant_thinking_token symmetrically', () => {
    assertStrictBroadcastPass(makeEnvelope('assistant_thinking_token', { text: 'thinking…' }));
  });

  it('accepts a well-formed assistant_citations envelope', () => {
    assertStrictBroadcastPass(
      makeEnvelope('assistant_citations', {
        citations: [
          { url: 'https://a.test', title: 'A', content: 'excerpt', startIndex: 0, endIndex: 5 },
        ],
      }),
    );
  });

  it('rejects assistant_citations whose citations is not an array', () => {
    assertStrictBroadcastFail(makeEnvelope('assistant_citations', { citations: 'nope' }));
  });

  it('rejects an assistant_citations entry missing a url', () => {
    assertStrictBroadcastFail(
      makeEnvelope('assistant_citations', {
        citations: [{ title: 'no url', content: '', startIndex: 0, endIndex: 0 }],
      }),
    );
  });

  it('rejects an assistant_citations entry with a non-string title', () => {
    assertStrictBroadcastFail(
      makeEnvelope('assistant_citations', {
        citations: [{ url: 'https://a.test', title: 42, content: '', startIndex: 0, endIndex: 0 }],
      }),
    );
  });
});

describe('protocol drift characterization — tool events', () => {
  installStrictModeHooks();

  it('accepts a well-formed tool_call envelope', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool_call', { toolName: 'read_file', args: { path: 'README.md' } }),
    );
  });

  it('accepts tool.execution_start with the same shape', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool.execution_start', {
        toolName: 'read_file',
        args: { path: 'README.md' },
        executionId: 'exec_1',
        round: 1,
      }),
    );
  });

  it('rejects tool_call with non-object args', () => {
    assertStrictBroadcastFail(
      makeEnvelope('tool_call', { toolName: 'read_file', args: 'not an object' }),
    );
  });

  it('rejects tool_call with empty toolName', () => {
    assertStrictBroadcastFail(makeEnvelope('tool_call', { toolName: '', args: {} }));
  });

  it('accepts a well-formed tool_result envelope', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool_result', {
        toolName: 'read_file',
        isError: false,
        text: 'file contents',
        durationMs: 42,
      }),
    );
  });

  it('accepts tool.execution_complete with preview instead of text', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool.execution_complete', {
        toolName: 'exec',
        isError: false,
        preview: 'stdout snippet',
        durationMs: 100,
      }),
    );
  });

  it('accepts tool.execution_complete with an optional branch stamp', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool.execution_complete', {
        toolName: 'sandbox_exec',
        isError: false,
        preview: 'stdout snippet',
        durationMs: 100,
        branch: 'feature/desynced',
      }),
    );
  });

  it('accepts tool.execution_complete with a structured edit diff', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool.execution_complete', {
        toolName: 'edit_file',
        isError: false,
        preview: 'Applied 1 hashline edits to src/foo.ts',
        durationMs: 25,
        diff: {
          path: 'src/foo.ts',
          adds: 1,
          dels: 1,
          lines: [
            { kind: 'ctx', oldLine: 1, newLine: 1, text: 'alpha' },
            { kind: 'del', oldLine: 2, text: 'old' },
            { kind: 'add', newLine: 2, text: 'new', textTruncated: true },
          ],
          truncated: true,
        },
      }),
    );
  });

  it('rejects tool.execution_complete with a malformed diff', () => {
    // Bad line kind
    assertStrictBroadcastFail(
      makeEnvelope('tool.execution_complete', {
        toolName: 'edit_file',
        isError: false,
        preview: 'x',
        diff: {
          path: 'src/foo.ts',
          adds: 1,
          dels: 0,
          lines: [{ kind: 'changed', text: 'x' }],
        },
      }),
    );
    // Missing counters / non-array lines
    assertStrictBroadcastFail(
      makeEnvelope('tool.execution_complete', {
        toolName: 'edit_file',
        isError: false,
        preview: 'x',
        diff: { path: 'src/foo.ts', lines: 'not-an-array' },
      }),
    );
  });

  it('rejects tool.execution_complete with a non-string branch stamp', () => {
    assertStrictBroadcastFail(
      makeEnvelope('tool.execution_complete', {
        toolName: 'sandbox_exec',
        isError: false,
        preview: 'stdout snippet',
        branch: 123,
      }),
    );
  });

  it('rejects tool_result with a non-boolean isError', () => {
    assertStrictBroadcastFail(
      makeEnvelope('tool_result', { toolName: 'read_file', isError: 'no' }),
    );
  });

  it('accepts tool.call_malformed with a non-empty reason', () => {
    assertStrictBroadcastPass(
      makeEnvelope('tool.call_malformed', { reason: 'missing closing fence' }),
    );
  });

  it('accepts tool.call_malformed with the optional toolName hint', () => {
    // toolName is populated from the kernel's recovered rawToolName (PR #733);
    // pin that the hint-bearing event still passes strict broadcast validation.
    assertStrictBroadcastPass(
      makeEnvelope('tool.call_malformed', { reason: 'missing_args_object', toolName: 'pr' }),
    );
  });

  it('rejects tool.call_malformed without a reason', () => {
    assertStrictBroadcastFail(makeEnvelope('tool.call_malformed', {}));
  });
});

describe('protocol drift characterization — branch desync', () => {
  installStrictModeHooks();

  it('accepts a branch_desync event with expected, actual, and command', () => {
    assertStrictBroadcastPass(
      makeEnvelope('branch_desync', {
        expected: 'main',
        actual: 'feature/desynced',
        command: 'git rebase origin/main',
      }),
    );
  });

  it('rejects branch_desync without an actual branch', () => {
    assertStrictBroadcastFail(
      makeEnvelope('branch_desync', {
        expected: 'main',
        command: 'git rebase origin/main',
      }),
    );
  });
});

describe('protocol drift characterization — lifecycle (error/warning/status)', () => {
  installStrictModeHooks();

  it('accepts an error envelope with code + message + retryable', () => {
    assertStrictBroadcastPass(
      makeEnvelope('error', {
        code: 'PROVIDER_TIMEOUT',
        message: 'Upstream timed out after 30s',
        retryable: true,
      }),
    );
  });

  it('accepts an error envelope with only message', () => {
    assertStrictBroadcastPass(makeEnvelope('error', { message: 'something broke' }));
  });

  it('rejects an error envelope with an empty code', () => {
    assertStrictBroadcastFail(makeEnvelope('error', { code: '', message: 'bad' }));
  });

  it('rejects an error envelope with a non-boolean retryable', () => {
    assertStrictBroadcastFail(makeEnvelope('error', { message: 'bad', retryable: 'yes' }));
  });

  it('accepts a warning envelope with message only', () => {
    assertStrictBroadcastPass(makeEnvelope('warning', { message: 'minor issue' }));
  });

  it('accepts a warning envelope with code only', () => {
    assertStrictBroadcastPass(makeEnvelope('warning', { code: 'PARTIAL_RESULT' }));
  });

  it('rejects a warning envelope with neither message nor code', () => {
    assertStrictBroadcastFail(makeEnvelope('warning', { unrelated: 'field' }));
  });

  it('rejects a warning envelope where message is a truthy non-string', () => {
    // Regression: the TUI renders `payload.message || payload.code`,
    // so a non-string message wins the OR-fallback and ends up as a
    // non-string transcript entry. The first cut of this validator
    // only checked "at least one is non-empty string"; copilot +
    // codex on PR #666 flagged that present-but-malformed fields
    // had to be type-checked individually.
    assertStrictBroadcastFail(makeEnvelope('warning', { message: 123, code: 'PARTIAL_RESULT' }));
  });

  it('rejects a warning envelope where code is a truthy non-string', () => {
    assertStrictBroadcastFail(makeEnvelope('warning', { message: 'ok', code: { typo: true } }));
  });

  it('accepts a status envelope with phase + detail', () => {
    assertStrictBroadcastPass(
      makeEnvelope('status', { phase: 'context_trimming', detail: '100 → 50 tokens' }),
    );
  });

  it('rejects a status envelope with neither phase nor detail', () => {
    assertStrictBroadcastFail(makeEnvelope('status', { source: 'orchestrator' }));
  });

  it('rejects a status envelope where detail is a truthy non-string', () => {
    // Same OR-fallback rendering rule as warning — `payload.detail ||
    // payload.phase`. Strict mode catches the drift instead of letting
    // the malformed value render.
    assertStrictBroadcastFail(makeEnvelope('status', { detail: { wrong: true }, phase: 'ok' }));
  });
});

describe('protocol drift characterization — run_complete outcomes', () => {
  installStrictModeHooks();

  it('accepts each documented outcome value', () => {
    for (const outcome of ['success', 'completed', 'failed', 'aborted', 'max_rounds']) {
      assertStrictBroadcastPass(makeEnvelope('run_complete', { outcome, summary: 'ok' }));
    }
  });

  it('rejects an unknown outcome value', () => {
    assertStrictBroadcastFail(makeEnvelope('run_complete', { outcome: 'mystery' }));
  });

  it('accepts run_complete with summary omitted', () => {
    assertStrictBroadcastPass(makeEnvelope('run_complete', { outcome: 'success' }));
  });
});

describe('protocol drift characterization — session_started / user_message', () => {
  installStrictModeHooks();

  it('accepts a well-formed session_started envelope', () => {
    assertStrictBroadcastPass(
      makeEnvelope('session_started', {
        sessionId: 'sess_abc',
        state: 'idle',
        mode: 'tui',
        provider: 'ollama',
        sandboxProvider: 'local',
      }),
    );
  });

  it('rejects session_started with an unknown state value', () => {
    assertStrictBroadcastFail(
      makeEnvelope('session_started', { sessionId: 'sess_abc', state: 'paused' }),
    );
  });

  it('accepts a well-formed user_message envelope', () => {
    assertStrictBroadcastPass(makeEnvelope('user_message', { chars: 27, preview: 'hello…' }));
  });

  it('rejects user_message with a negative char count', () => {
    assertStrictBroadcastFail(makeEnvelope('user_message', { chars: -1, preview: 'x' }));
  });

  it('rejects user_message with a non-string preview', () => {
    assertStrictBroadcastFail(makeEnvelope('user_message', { chars: 5, preview: null }));
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

  it('accepts a well-formed workspace.state_snapshot', () => {
    assert.deepEqual(
      validateRunEventPayload('workspace.state_snapshot', {
        workspaceId: 'kvfxkaido/push',
        rev: 0,
        state: {
          activeBranch: 'main',
          headSha: 'abc123',
          ahead: 0,
          behind: 0,
          dirtyFiles: [{ path: 'lib/foo.ts', status: 'modified' }],
          protectMain: true,
          sandboxReady: true,
        },
      }),
      [],
    );
  });

  it('accepts a well-formed workspace.state_delta over the closed op-set', () => {
    assert.deepEqual(
      validateRunEventPayload('workspace.state_delta', {
        workspaceId: 'kvfxkaido/push',
        rev: 3,
        baseRev: 2,
        ops: [
          { op: 'set_branch', activeBranch: 'feat/x', headSha: 'def456' },
          { op: 'dirty_add', file: { path: 'app/bar.ts', status: 'added' } },
          { op: 'dirty_remove', path: 'lib/foo.ts' },
          { op: 'dirty_clear' },
          { op: 'set_protect_main', protectMain: false },
        ],
      }),
      [],
    );
  });

  it('rejects a workspace.state_delta op outside the closed set', () => {
    const issues = validateRunEventPayload('workspace.state_delta', {
      workspaceId: 'kvfxkaido/push',
      rev: 1,
      baseRev: 0,
      ops: [{ op: 'set_remote', url: 'https://evil.example/x.git' }],
    });
    assert.ok(issues.length >= 1);
    assert.ok(issues.some((i) => i.path === 'payload.ops[0].op'));
  });

  it('rejects a dirty_add whose file is missing a valid status in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('workspace.state_delta', {
        workspaceId: 'kvfxkaido/push',
        rev: 1,
        baseRev: 0,
        ops: [{ op: 'dirty_add', file: { path: 'app/bar.ts' } }],
      }),
    );
  });

  it('rejects a workspace.state_delta missing baseRev in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('workspace.state_delta', {
        workspaceId: 'kvfxkaido/push',
        rev: 1,
        ops: [{ op: 'dirty_clear' }],
      }),
    );
  });

  it('rejects a workspace.state_snapshot with a non-boolean guard in strict mode', () => {
    assertStrictBroadcastFail(
      makeEnvelope('workspace.state_snapshot', {
        workspaceId: 'kvfxkaido/push',
        rev: 0,
        state: {
          activeBranch: 'main',
          headSha: 'abc123',
          dirtyFiles: [],
          protectMain: 'yes',
          sandboxReady: true,
        },
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
  RELAY_SENDER_FIELD,
  isRelayEnvelope,
  validateRelayEnvelope,
} from '../../lib/protocol-schema.ts';

describe('relay sender-id field', () => {
  // RELAY_SENDER_FIELD is the single source of truth for the per-phone
  // identity the relay DO stamps onto forwarded frames (writer) and pushd
  // reads to scope run ownership (reader). Pin the literal so the DO and the
  // daemon can't drift to different field names — a rename here forces both
  // sides (and this assertion) to move together. AGENTS.md guardrail #3.
  it('pins the stamped sender-id field name', () => {
    assert.equal(RELAY_SENDER_FIELD, '_relaySender');
  });
});

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

describe('push.stream.v1 wire contract', () => {
  // The neutral client↔Worker request wire (web chat → dual-accept handlers).
  // `lib/provider-wire.ts` is the single definition both sides import;
  // `validateAndNormalizeWireRequest` (app-side) branches on the discriminator
  // and the dual-accept handlers treat any OTHER contract value as a 400, not
  // legacy — so a silent rename here would hard-fail every flipped client.
  // Pin the literal and the emitted field vocabulary per AGENTS.md guardrail #3
  // (the round-trip serializer↔validator test lives app-side in
  // `chat-request-guardrails.test.ts`; this is the cross-surface pin).
  it('pins the contract discriminator', () => {
    assert.equal(PUSH_STREAM_WIRE_CONTRACT, 'push.stream.v1');
  });

  it('pins the full field vocabulary toPushStreamWire can emit', () => {
    const wire = toPushStreamWire(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: 'ok',
          reasoning_blocks: [{ type: 'thinking', text: 't', signature: 'sig' }],
          reasoningContent: 'plain DeepSeek reasoning',
        },
      ],
      {
        provider: 'anthropic',
        model: 'claude-test',
        maxTokens: 1024,
        temperature: 0,
        topP: 1,
        cacheBreakpointIndices: [1],
        anthropicWebSearch: true,
        googleSearchGrounding: true,
        replayAssistantTurns: [[{ type: 'text', text: 'paused' }]],
      },
    );

    // Every top-level field the serializer can put on the wire, maximally
    // populated. A new field must be added here AND to the app-side validator
    // in the same PR; a removed/renamed field fails this pin first.
    assert.deepEqual(Object.keys(wire).sort(), [
      'anthropicWebSearch',
      'cacheBreakpointIndices',
      'contract',
      'googleSearchGrounding',
      'maxTokens',
      'messages',
      'model',
      'provider',
      'replayAssistantTurns',
      'temperature',
      'topP',
    ]);
    assert.equal(wire.contract, PUSH_STREAM_WIRE_CONTRACT);

    // Message-level vocabulary: bare turns carry role+content only; assistant
    // turns with signed reasoning gain camelCase `reasoningBlocks` (renamed
    // from the materializer's snake_case `reasoning_blocks`) and DeepSeek plain
    // reasoning rides as upstream-native `reasoning_content`.
    assert.deepEqual(Object.keys(wire.messages[0]).sort(), ['content', 'role']);
    assert.deepEqual(Object.keys(wire.messages[1]).sort(), ['content', 'role']);
    assert.deepEqual(Object.keys(wire.messages[2]).sort(), [
      'content',
      'reasoningBlocks',
      'reasoning_content',
      'role',
    ]);
  });

  it('omits unset optional scalars so minimal bodies stay minimal', () => {
    const wire = toPushStreamWire([{ role: 'user', content: 'hi' }], {
      model: 'claude-test',
    });
    assert.deepEqual(Object.keys(wire).sort(), ['contract', 'messages', 'model']);
  });
});
