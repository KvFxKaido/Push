import { describe, expect, it } from 'vitest';

import {
  buildToolLedgerFromGroupedCalls,
  createToolBudgetBlockIntervention,
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
});
