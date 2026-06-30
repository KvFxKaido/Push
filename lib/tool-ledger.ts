/**
 * Shared tool ledger.
 *
 * The grouping kernel decides which calls fit this turn. The ledger records that
 * decision in a queryable shape so budgets, loop guards, Auditor context, and
 * future steer handlers do not each re-derive turn state from local arrays.
 */

import type { GroupedCalls } from './tool-call-grouping.js';
import { createBlockIntervention, type RuntimeIntervention } from './runtime-intervention.js';

export type ToolLedgerPhase =
  | 'read'
  | 'parallel_delegation'
  | 'file_mutation'
  | 'trailing_side_effect'
  | 'file_mutation_batch_overflow'
  | 'tool_order_violation';

export type ToolLedgerDisposition = 'accepted' | 'rejected';

export type ToolLedgerRejectionReason = 'file_mutation_batch_overflow' | 'tool_order_violation';

export type ToolLedgerSideEffectClass =
  | 'read'
  | 'file_mutation'
  | 'side_effect'
  | 'delegation'
  | 'unknown';

export interface ToolLedgerCallDescriptor {
  readonly toolName: string;
  readonly source?: string;
  readonly argsKey?: string;
  readonly target?: string;
  readonly sideEffect?: ToolLedgerSideEffectClass;
}

export interface ToolLedgerExecution {
  readonly status: 'started' | 'completed' | 'failed';
  readonly durationMs?: number;
  readonly isError?: boolean;
  readonly structuredErrorType?: string;
  readonly retryable?: boolean;
}

export interface ToolLedgerEntry<TCall = unknown> extends ToolLedgerCallDescriptor {
  readonly sequence: number;
  readonly call: TCall;
  readonly phase: ToolLedgerPhase;
  readonly disposition: ToolLedgerDisposition;
  readonly rejectionReason?: ToolLedgerRejectionReason;
  readonly execution?: ToolLedgerExecution;
}

export interface ToolLedgerCounts {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly byPhase: Record<ToolLedgerPhase, number>;
}

export interface ToolLedgerSnapshot<TCall = unknown> {
  readonly entries: readonly ToolLedgerEntry<TCall>[];
  readonly accepted: readonly ToolLedgerEntry<TCall>[];
  readonly rejected: readonly ToolLedgerEntry<TCall>[];
  readonly counts: ToolLedgerCounts;
}

export interface BuildToolLedgerOptions<TCall> {
  readonly describeCall: (call: TCall) => ToolLedgerCallDescriptor;
}

export type ToolLedgerGroupedCalls<TCall> = Pick<
  GroupedCalls<TCall>,
  | 'readOnly'
  | 'parallelDelegations'
  | 'fileMutations'
  | 'mutating'
  | 'batchOverflow'
  | 'extraMutations'
>;

const TOOL_LEDGER_PHASES: readonly ToolLedgerPhase[] = [
  'read',
  'parallel_delegation',
  'file_mutation',
  'trailing_side_effect',
  'file_mutation_batch_overflow',
  'tool_order_violation',
];

function createEmptyPhaseCounts(): Record<ToolLedgerPhase, number> {
  return {
    read: 0,
    parallel_delegation: 0,
    file_mutation: 0,
    trailing_side_effect: 0,
    file_mutation_batch_overflow: 0,
    tool_order_violation: 0,
  };
}

export function buildToolLedgerFromGroupedCalls<TCall>(
  grouped: ToolLedgerGroupedCalls<TCall>,
  options: BuildToolLedgerOptions<TCall>,
): ToolLedgerSnapshot<TCall> {
  const entries: ToolLedgerEntry<TCall>[] = [];

  const addEntry = (
    call: TCall,
    phase: ToolLedgerPhase,
    disposition: ToolLedgerDisposition,
    rejectionReason?: ToolLedgerRejectionReason,
  ) => {
    entries.push({
      sequence: entries.length,
      call,
      phase,
      disposition,
      ...(rejectionReason ? { rejectionReason } : {}),
      ...options.describeCall(call),
    });
  };

  for (const call of grouped.readOnly) addEntry(call, 'read', 'accepted');
  for (const call of grouped.parallelDelegations) {
    addEntry(call, 'parallel_delegation', 'accepted');
  }
  for (const call of grouped.fileMutations) addEntry(call, 'file_mutation', 'accepted');
  if (grouped.mutating) addEntry(grouped.mutating, 'trailing_side_effect', 'accepted');
  for (const call of grouped.batchOverflow) {
    addEntry(call, 'file_mutation_batch_overflow', 'rejected', 'file_mutation_batch_overflow');
  }
  for (const call of grouped.extraMutations) {
    addEntry(call, 'tool_order_violation', 'rejected', 'tool_order_violation');
  }

  const accepted = entries.filter((entry) => entry.disposition === 'accepted');
  const rejected = entries.filter((entry) => entry.disposition === 'rejected');
  const byPhase = createEmptyPhaseCounts();
  for (const phase of TOOL_LEDGER_PHASES) {
    byPhase[phase] = entries.filter((entry) => entry.phase === phase).length;
  }

  return {
    entries,
    accepted,
    rejected,
    counts: {
      total: entries.length,
      accepted: accepted.length,
      rejected: rejected.length,
      byPhase,
    },
  };
}

export interface ToolBudgetBlockContext<TCall = unknown> {
  readonly ledger: ToolLedgerSnapshot<TCall>;
  readonly rejectedTools: readonly string[];
  readonly rejectionReasons: readonly ToolLedgerRejectionReason[];
}

export interface ToolBudgetBlockOptions {
  readonly source?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly guidance?: string;
}

export function createToolBudgetBlockIntervention<TCall>(
  ledger: ToolLedgerSnapshot<TCall>,
  options: ToolBudgetBlockOptions = {},
): RuntimeIntervention<ToolBudgetBlockContext<TCall>> | null {
  if (ledger.rejected.length === 0) return null;

  const rejectionReasons = [
    ...new Set(ledger.rejected.map((entry) => entry.rejectionReason)),
  ].filter((reason): reason is ToolLedgerRejectionReason => reason != null);
  const rejectedTools = ledger.rejected.map((entry) => entry.toolName);

  return createBlockIntervention({
    point: 'before_tool',
    source: options.source ?? 'tool_budget',
    reason: options.reason ?? 'tool_budget_violation',
    message:
      options.message ??
      `Rejected ${ledger.rejected.length} tool call(s) before execution: ${rejectedTools.join(', ')}.`,
    guidance: options.guidance,
    context: {
      ledger,
      rejectedTools,
      rejectionReasons,
    },
  });
}
