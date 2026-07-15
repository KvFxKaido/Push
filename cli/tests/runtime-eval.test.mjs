import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluateRuntimeEvents, RUNTIME_EVAL_POLICY_VERSION } from '../../lib/runtime-eval.ts';

function event(type, payload, index, overrides = {}) {
  return {
    v: 'push.runtime.v1',
    kind: 'event',
    sessionId: 'sess_eval',
    runId: 'run_eval',
    seq: index + 1,
    ts: 1_000 + index * 10,
    type,
    payload,
    ...overrides,
  };
}

function gate(result, id) {
  const found = result.gates.find((candidate) => candidate.id === id);
  assert.ok(found, `missing gate ${id}`);
  return found;
}

describe('runtime receipt evaluation', () => {
  it('reduces a successful receipt into gates, metrics, and passing scores', () => {
    const events = [
      event('assistant.turn_start', { round: 1 }, 0),
      event('tool.execution_start', { toolName: 'read_file', args: { path: 'a.ts' } }, 1),
      event(
        'tool.execution_complete',
        {
          round: 1,
          executionId: 'tool_1',
          toolName: 'read_file',
          toolSource: 'cli',
          durationMs: 12,
          isError: false,
          preview: 'contents',
        },
        2,
      ),
      event(
        'context.compaction',
        {
          round: 1,
          phase: 'hard_trim',
          beforeTokens: 10_000,
          afterTokens: 8_000,
          messagesDropped: 2,
        },
        3,
      ),
      event(
        'acceptance_complete',
        {
          passed: true,
          checks: [{ command: 'pnpm test', ok: true, exitCode: 0, durationMs: 20 }],
        },
        4,
      ),
      event('assistant.turn_end', { round: 1, outcome: 'completed' }, 5),
      event('run_complete', { runId: 'run_eval', outcome: 'success', summary: 'done' }, 6),
    ];

    const result = evaluateRuntimeEvents(events, {
      version: RUNTIME_EVAL_POLICY_VERSION,
      gates: {
        acceptancePassed: true,
        requiredTools: ['read_file'],
        forbiddenTools: ['exec'],
      },
      scores: {
        maxRounds: 1,
        maxDurationMs: 100,
        maxToolCalls: 1,
        maxCompactions: 1,
      },
    });

    assert.equal(result.verdict, 'pass');
    assert.ok(result.gates.every((candidate) => candidate.status === 'pass'));
    assert.ok(result.scores.every((candidate) => candidate.status === 'pass'));
    assert.equal(result.metrics.rounds, 1);
    assert.equal(result.metrics.durationMs, 60);
    assert.equal(result.metrics.toolCalls, 1);
    assert.equal(result.metrics.compactions, 1);
    assert.equal(result.metrics.acceptancePassed, true);
    assert.deepEqual(result.metrics.tools, { read_file: 1 });
  });

  it('reports score_miss without converting a held deterministic floor into failure', () => {
    const result = evaluateRuntimeEvents(
      [
        event('assistant.turn_start', { round: 1 }, 0),
        event('run_complete', { outcome: 'success' }, 1),
      ],
      {
        version: RUNTIME_EVAL_POLICY_VERSION,
        scores: { maxRounds: 0 },
      },
    );

    assert.equal(result.verdict, 'score_miss');
    assert.ok(result.gates.every((candidate) => candidate.status === 'pass'));
    assert.deepEqual(result.scores, [{ id: 'maxRounds', status: 'miss', actual: 1, threshold: 0 }]);
  });

  it('uses task-graph aggregate rounds for delegated receipts', () => {
    const result = evaluateRuntimeEvents([
      event(
        'task_graph.graph_completed',
        {
          executionId: 'graph_1',
          summary: 'done',
          success: true,
          aborted: false,
          nodeCount: 3,
          totalRounds: 9,
          wallTimeMs: 5_000,
        },
        0,
      ),
      event('run_complete', { outcome: 'success' }, 1),
    ]);

    assert.equal(result.verdict, 'pass');
    assert.equal(result.metrics.rounds, 9);
  });

  it('fails deterministic error, malformed-call, branch, and terminal gates', () => {
    const result = evaluateRuntimeEvents([
      event('tool.execution_complete', { toolName: 'exec', isError: true, preview: 'exit 1' }, 0),
      event('tool.call_malformed', { round: 1, reason: 'bad json', preview: '{' }, 1),
      event('error', { message: 'provider failed' }, 2),
      event(
        'branch_desync',
        { expected: 'main', actual: 'feature', command: 'git switch feature' },
        3,
      ),
      event('run_complete', { outcome: 'failed', summary: 'failed' }, 4),
    ]);

    assert.equal(result.verdict, 'fail');
    for (const id of [
      'terminal.success',
      'tools.no_malformed_calls',
      'tools.no_errors',
      'runtime.no_errors',
      'branch.in_sync',
    ]) {
      assert.equal(gate(result, id).status, 'fail');
    }
    assert.equal(result.metrics.toolErrors, 1);
    assert.equal(result.metrics.malformedToolCalls, 1);
    assert.equal(result.metrics.errorEvents, 1);
    assert.equal(result.metrics.branchDesyncs, 1);
  });

  it('distinguishes resolved approvals from affirmative approvals', () => {
    const events = [
      event(
        'approval_required',
        {
          approvalId: 'approval_1',
          kind: 'exec',
          title: 'Run command',
          summary: 'pnpm test',
          options: ['approve', 'deny'],
        },
        0,
      ),
      event('approval_received', { approvalId: 'approval_1', decision: 'deny', by: 'user' }, 1),
      event('run_complete', { outcome: 'success' }, 2),
    ];

    const resolved = evaluateRuntimeEvents(events);
    assert.equal(resolved.verdict, 'pass');
    assert.equal(gate(resolved, 'approvals.resolved').status, 'pass');
    assert.equal(resolved.metrics.approvalDenials, 1);

    const affirmative = evaluateRuntimeEvents(events, {
      version: RUNTIME_EVAL_POLICY_VERSION,
      gates: { approvalsApproved: true },
    });
    assert.equal(affirmative.verdict, 'fail');
    assert.equal(gate(affirmative, 'approvals.approved').status, 'fail');
  });

  it('accepts repeated job suspend/resume cycles and settled subagents', () => {
    const result = evaluateRuntimeEvents([
      event('subagent.started', { executionId: 'sub_1', agent: 'explorer' }, 0),
      event(
        'subagent.completed',
        { executionId: 'sub_1', agent: 'explorer', summary: 'found it' },
        1,
      ),
      event('job.started', { executionId: 'job_1', role: 'coder' }, 2),
      event(
        'job.suspended',
        {
          executionId: 'job_1',
          role: 'coder',
          question: 'Choose a target',
          context: 'Two targets are possible',
          resumeSchema: '{}',
        },
        3,
      ),
      event('job.resumed', { executionId: 'job_1', role: 'coder' }, 4),
      event(
        'job.suspended',
        {
          executionId: 'job_1',
          role: 'coder',
          question: 'Confirm',
          context: 'Ready to continue',
          resumeSchema: '{}',
        },
        5,
      ),
      event('job.resumed', { executionId: 'job_1', role: 'coder' }, 6),
      event('job.completed', { executionId: 'job_1', role: 'coder', summary: 'done' }, 7),
      event('run_complete', { outcome: 'success' }, 8),
    ]);

    assert.equal(result.verdict, 'pass');
    assert.equal(gate(result, 'subagents.settled').status, 'pass');
    assert.equal(gate(result, 'jobs.settled').status, 'pass');
    assert.equal(result.metrics.danglingSubagents, 0);
    assert.equal(result.metrics.danglingJobs, 0);
  });

  it('fails unresolved and invalid lifecycle state', () => {
    const result = evaluateRuntimeEvents([
      event(
        'approval_required',
        {
          approvalId: 'approval_1',
          kind: 'exec',
          title: 'Run command',
          summary: 'pnpm test',
          options: ['approve', 'deny'],
        },
        0,
      ),
      event('subagent.started', { executionId: 'sub_1', agent: 'coder' }, 1),
      event('job.started', { executionId: 'job_1', role: 'coder' }, 2),
      event(
        'job.suspended',
        {
          executionId: 'job_1',
          role: 'coder',
          question: 'Need input',
          context: 'Blocked',
          resumeSchema: '{}',
        },
        3,
      ),
      event('run_complete', { outcome: 'success' }, 4),
    ]);

    assert.equal(result.verdict, 'fail');
    assert.equal(gate(result, 'approvals.resolved').status, 'fail');
    assert.equal(gate(result, 'subagents.settled').status, 'fail');
    assert.equal(gate(result, 'jobs.settled').status, 'fail');
    assert.equal(result.metrics.unresolvedApprovals, 1);
    assert.equal(result.metrics.danglingSubagents, 1);
    assert.equal(result.metrics.suspendedJobs, 1);
    assert.equal(result.metrics.danglingJobs, 1);
  });

  it('selects one run from a session journal and rejects a combined receipt', () => {
    const events = [
      event('run_complete', { outcome: 'failed' }, 0, { runId: 'run_old' }),
      event('assistant.turn_start', { round: 1 }, 1, { runId: 'run_target' }),
      event('run_complete', { outcome: 'success' }, 2, { runId: 'run_target' }),
    ];

    const combined = evaluateRuntimeEvents(events);
    assert.equal(combined.verdict, 'fail');
    assert.equal(gate(combined, 'receipt.valid').status, 'fail');

    const selected = evaluateRuntimeEvents(events, undefined, { runId: 'run_target' });
    assert.equal(selected.verdict, 'pass');
    assert.equal(selected.runId, 'run_target');
    assert.equal(selected.metrics.eventCount, 2);
    assert.equal(selected.metrics.rounds, 1);
  });

  it('fails receipt validation when acceptance evidence has the wrong shape', () => {
    const result = evaluateRuntimeEvents(
      [
        event('acceptance_complete', { passed: 'yes', checks: [] }, 0),
        event('run_complete', { outcome: 'success' }, 1),
      ],
      {
        version: RUNTIME_EVAL_POLICY_VERSION,
        gates: { acceptancePassed: true },
      },
    );

    assert.equal(result.verdict, 'fail');
    assert.equal(gate(result, 'receipt.valid').status, 'fail');
    assert.equal(gate(result, 'acceptance.passed').status, 'fail');
  });

  it('does not trust an acceptance summary that contradicts its check evidence', () => {
    const result = evaluateRuntimeEvents(
      [
        event(
          'acceptance_complete',
          {
            passed: true,
            checks: [{ command: 'pnpm test', ok: false, exitCode: 1, durationMs: 20 }],
          },
          0,
        ),
        event('run_complete', { outcome: 'success' }, 1),
      ],
      {
        version: RUNTIME_EVAL_POLICY_VERSION,
        gates: { acceptancePassed: true },
      },
    );

    assert.equal(result.verdict, 'fail');
    assert.equal(result.metrics.acceptancePassed, false);
    assert.equal(gate(result, 'acceptance.passed').status, 'fail');
  });
});
