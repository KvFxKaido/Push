import { describe, expect, it } from 'vitest';

import {
  buildToolLedgerFromGroupedCalls,
  createToolExecutionLedger,
  createToolBudgetBlockIntervention,
  formatToolLedgerContext,
  mergeToolLedgerSnapshots,
  type ToolLedgerCallDescriptor,
} from './tool-ledger.js';

interface StubCall {
  id: string;
  tool: string;
  source: string;
}

const call = (id: string, tool: string, source = 'sandbox'): StubCall => ({ id, tool, source });

const describeCall = (entry: StubCall): ToolLedgerCallDescriptor => ({
  toolName: entry.tool,
  source: entry.source,
  argsKey: `${entry.tool}:${entry.id}`,
});

describe('tool ledger', () => {
  it('records accepted grouped calls by execution phase', () => {
    const ledger = buildToolLedgerFromGroupedCalls(
      {
        readOnly: [call('1', 'sandbox_read_file')],
        parallelDelegations: [call('2', 'delegate_explorer', 'delegate')],
        fileMutations: [call('3', 'sandbox_write_file')],
        mutating: call('4', 'sandbox_exec'),
        batchOverflow: [],
        extraMutations: [],
      },
      { describeCall },
    );

    expect(ledger.counts).toMatchObject({ total: 4, accepted: 4, rejected: 0 });
    expect(ledger.entries.map((entry) => [entry.sequence, entry.phase, entry.toolName])).toEqual([
      [0, 'read', 'sandbox_read_file'],
      [1, 'parallel_delegation', 'delegate_explorer'],
      [2, 'file_mutation', 'sandbox_write_file'],
      [3, 'trailing_side_effect', 'sandbox_exec'],
    ]);
  });

  it('records batch overflow and ordering violations as rejected entries', () => {
    const ledger = buildToolLedgerFromGroupedCalls(
      {
        readOnly: [],
        parallelDelegations: [],
        fileMutations: [call('1', 'sandbox_write_file')],
        mutating: call('2', 'sandbox_exec'),
        batchOverflow: [call('3', 'sandbox_write_file')],
        extraMutations: [call('4', 'sandbox_read_file')],
      },
      { describeCall },
    );

    expect(ledger.counts).toMatchObject({ total: 4, accepted: 2, rejected: 2 });
    expect(
      ledger.rejected.map((entry) => [entry.phase, entry.rejectionReason, entry.toolName]),
    ).toEqual([
      ['file_mutation_batch_overflow', 'file_mutation_batch_overflow', 'sandbox_write_file'],
      ['tool_order_violation', 'tool_order_violation', 'sandbox_read_file'],
    ]);
    expect(ledger.counts.byPhase.file_mutation_batch_overflow).toBe(1);
    expect(ledger.counts.byPhase.tool_order_violation).toBe(1);
  });

  it('builds a block intervention only when the ledger has rejected calls', () => {
    const clean = buildToolLedgerFromGroupedCalls(
      {
        readOnly: [call('1', 'sandbox_read_file')],
        parallelDelegations: [],
        fileMutations: [],
        mutating: null,
        batchOverflow: [],
        extraMutations: [],
      },
      { describeCall },
    );
    expect(createToolBudgetBlockIntervention(clean)).toBeNull();

    const rejected = buildToolLedgerFromGroupedCalls(
      {
        readOnly: [],
        parallelDelegations: [],
        fileMutations: [],
        mutating: call('1', 'sandbox_exec'),
        batchOverflow: [],
        extraMutations: [call('2', 'sandbox_exec')],
      },
      { describeCall },
    );

    const intervention = createToolBudgetBlockIntervention(rejected, {
      reason: 'multiple_mutating_calls',
    });
    expect(intervention).toMatchObject({
      mode: 'block',
      point: 'before_tool',
      source: 'tool_budget',
      reason: 'multiple_mutating_calls',
    });
    expect(intervention?.context?.rejectedTools).toEqual(['sandbox_exec']);
    expect(intervention?.context?.rejectionReasons).toEqual(['tool_order_violation']);
  });

  it('tracks execution lifecycle without mutating retained turn snapshots', () => {
    const read = call('1', 'sandbox_read_file');
    const write = call('2', 'sandbox_write_file');
    const ledger = createToolExecutionLedger({ describeCall });
    const turn = ledger.recordGroupedCalls(
      {
        readOnly: [read],
        parallelDelegations: [],
        fileMutations: [write],
        mutating: null,
        extraMutations: [],
      },
      3,
    );

    ledger.start(read, { executionId: 'exec-read', startedAt: 100 });
    ledger.complete(read, { completedAt: 104, durationMs: 4 });
    ledger.start(write, { executionId: 'exec-write', startedAt: 105 });
    ledger.fail(write, {
      completedAt: 112,
      durationMs: 7,
      structuredErrorType: 'WRITE_FAILED',
      retryable: true,
      postconditions: ['workspace unchanged'],
    });

    expect(turn.entries.every((entry) => entry.execution === undefined)).toBe(true);
    expect(ledger.snapshot().entries).toMatchObject([
      {
        sequence: 0,
        round: 3,
        execution: { executionId: 'exec-read', status: 'completed', durationMs: 4 },
      },
      {
        sequence: 1,
        round: 3,
        execution: {
          executionId: 'exec-write',
          status: 'failed',
          structuredErrorType: 'WRITE_FAILED',
          retryable: true,
          postconditions: ['workspace unchanged'],
        },
      },
    ]);
  });

  it('merges snapshots and formats compact Auditor context', () => {
    const first = createToolExecutionLedger({ describeCall });
    const read = call('1', 'sandbox_read_file');
    first.recordGroupedCalls({
      readOnly: [read],
      parallelDelegations: [],
      fileMutations: [],
      mutating: null,
      extraMutations: [],
    });
    first.start(read, { executionId: 'read' });
    first.complete(read, { durationMs: 2, postconditions: ['read src/a.ts'] });

    const second = createToolExecutionLedger({ describeCall });
    second.recordGroupedCalls({
      readOnly: [],
      parallelDelegations: [],
      fileMutations: [],
      mutating: call('2', 'sandbox_exec'),
      extraMutations: [call('3', 'sandbox_exec')],
    });

    const merged = mergeToolLedgerSnapshots([first.snapshot(), second.snapshot()]);
    expect(merged.entries.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(formatToolLedgerContext(merged)).toContain('3 total; 2 accepted; 1 rejected');
    expect(formatToolLedgerContext(merged)).toContain('post=read src/a.ts');
    expect(formatToolLedgerContext(merged)).toContain('rejected:tool_order_violation');
  });
});
