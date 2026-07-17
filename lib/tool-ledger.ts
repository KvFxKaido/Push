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
  readonly executionId?: string;
  readonly status: 'started' | 'completed' | 'failed';
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
  readonly structuredErrorType?: string;
  readonly retryable?: boolean;
  readonly postconditions?: readonly string[];
}

export interface ToolLedgerEntry<TCall = unknown> extends ToolLedgerCallDescriptor {
  readonly sequence: number;
  readonly round?: number;
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
  'readOnly' | 'parallelDelegations' | 'fileMutations' | 'mutating' | 'extraMutations'
> & { readonly batchOverflow?: readonly TCall[] };

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

function sideEffectForPhase(phase: ToolLedgerPhase): ToolLedgerSideEffectClass {
  if (phase === 'read') return 'read';
  if (phase === 'parallel_delegation') return 'delegation';
  if (phase === 'file_mutation' || phase === 'file_mutation_batch_overflow') {
    return 'file_mutation';
  }
  if (phase === 'trailing_side_effect') return 'side_effect';
  return 'unknown';
}

export function buildToolLedgerFromGroupedCalls<TCall>(
  grouped: ToolLedgerGroupedCalls<TCall>,
  options: BuildToolLedgerOptions<TCall>,
  round?: number,
): ToolLedgerSnapshot<TCall> {
  const entries: ToolLedgerEntry<TCall>[] = [];

  const addEntry = (
    call: TCall,
    phase: ToolLedgerPhase,
    disposition: ToolLedgerDisposition,
    rejectionReason?: ToolLedgerRejectionReason,
  ) => {
    const descriptor = options.describeCall(call);
    entries.push({
      sequence: entries.length,
      ...(round === undefined ? {} : { round }),
      call,
      phase,
      disposition,
      ...(rejectionReason ? { rejectionReason } : {}),
      ...descriptor,
      sideEffect: descriptor.sideEffect ?? sideEffectForPhase(phase),
    });
  };

  for (const call of grouped.readOnly) addEntry(call, 'read', 'accepted');
  for (const call of grouped.parallelDelegations) {
    addEntry(call, 'parallel_delegation', 'accepted');
  }
  for (const call of grouped.fileMutations) addEntry(call, 'file_mutation', 'accepted');
  if (grouped.mutating) addEntry(grouped.mutating, 'trailing_side_effect', 'accepted');
  for (const call of grouped.batchOverflow ?? []) {
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

export interface ToolLedgerExecutionStart {
  readonly executionId?: string;
  readonly startedAt?: number;
}

export interface ToolLedgerExecutionEnd {
  readonly completedAt?: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
  readonly structuredErrorType?: string;
  readonly retryable?: boolean;
  readonly postconditions?: readonly string[];
}

export interface ToolExecutionLedger<TCall> {
  /** Append one grouped model turn and return just that turn's ledger view. */
  recordGroupedCalls(
    grouped: ToolLedgerGroupedCalls<TCall>,
    round?: number,
  ): ToolLedgerSnapshot<TCall>;
  /** Mark the latest accepted, unfinished entry for this call as executing. */
  start(call: TCall, execution?: ToolLedgerExecutionStart): void;
  /** Mark an execution as successfully completed. */
  complete(call: TCall, execution?: ToolLedgerExecutionEnd): void;
  /** Mark an execution as denied, errored, or thrown. */
  fail(call: TCall, execution?: ToolLedgerExecutionEnd): void;
  snapshot(): ToolLedgerSnapshot<TCall>;
}

function snapshotEntries<TCall>(
  entries: readonly ToolLedgerEntry<TCall>[],
): ToolLedgerSnapshot<TCall> {
  const copied = entries.map((entry) => ({
    ...entry,
    ...(entry.execution
      ? {
          execution: {
            ...entry.execution,
            ...(entry.execution.postconditions
              ? { postconditions: [...entry.execution.postconditions] }
              : {}),
          },
        }
      : {}),
  }));
  const accepted = copied.filter((entry) => entry.disposition === 'accepted');
  const rejected = copied.filter((entry) => entry.disposition === 'rejected');
  const byPhase = createEmptyPhaseCounts();
  for (const entry of copied) byPhase[entry.phase] += 1;
  return {
    entries: copied,
    accepted,
    rejected,
    counts: { total: copied.length, accepted: accepted.length, rejected: rejected.length, byPhase },
  };
}

/**
 * Mutable run-scoped execution ledger. Its snapshots are detached values, so
 * callers can safely retain a turn view while later executions keep updating.
 *
 * `initialEntries` seeds a resumed run with the ledger persisted at its last
 * checkpoint, so the final snapshot spans the whole logical run rather than
 * only the rounds after a sandbox restore. Restored entries are settled
 * history: their `call` references never match live call objects by identity,
 * so lifecycle updates cannot touch them.
 */
export function createToolExecutionLedger<TCall>(
  options: BuildToolLedgerOptions<TCall> & {
    initialEntries?: readonly ToolLedgerEntry<TCall>[];
  },
): ToolExecutionLedger<TCall> {
  const entries: Array<ToolLedgerEntry<TCall>> = (options.initialEntries ?? []).map(
    (entry, index) => ({ ...entry, sequence: index }),
  );

  const findPending = (call: TCall): number => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.call === call && entry.disposition === 'accepted') {
        if (!entry.execution || entry.execution.status === 'started') return index;
      }
    }
    return -1;
  };

  const replaceExecution = (call: TCall, execution: ToolLedgerExecution): void => {
    const index = findPending(call);
    if (index < 0) return;
    entries[index] = { ...entries[index], execution };
  };

  return {
    recordGroupedCalls(grouped, round) {
      const turn = buildToolLedgerFromGroupedCalls(grouped, options, round);
      const offset = entries.length;
      entries.push(
        ...turn.entries.map((entry) => ({ ...entry, sequence: entry.sequence + offset })),
      );
      return snapshotEntries(entries.slice(offset));
    },
    start(call, execution = {}) {
      replaceExecution(call, {
        status: 'started',
        ...(execution.executionId ? { executionId: execution.executionId } : {}),
        startedAt: execution.startedAt ?? Date.now(),
      });
    },
    complete(call, execution = {}) {
      const index = findPending(call);
      if (index < 0) return;
      const previous = entries[index].execution;
      replaceExecution(call, {
        status: 'completed',
        ...(previous?.executionId ? { executionId: previous.executionId } : {}),
        ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        completedAt: execution.completedAt ?? Date.now(),
        ...execution,
        isError: false,
      });
    },
    fail(call, execution = {}) {
      const index = findPending(call);
      if (index < 0) return;
      const previous = entries[index].execution;
      replaceExecution(call, {
        status: 'failed',
        ...(previous?.executionId ? { executionId: previous.executionId } : {}),
        ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        completedAt: execution.completedAt ?? Date.now(),
        ...execution,
        isError: true,
      });
    },
    snapshot() {
      return snapshotEntries(entries);
    },
  };
}

export function mergeToolLedgerSnapshots<TCall>(
  snapshots: readonly ToolLedgerSnapshot<TCall>[],
): ToolLedgerSnapshot<TCall> {
  let sequence = 0;
  const entries = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({ ...entry, sequence: sequence++ })),
  );
  return snapshotEntries(entries);
}

/**
 * Detail-line budget for {@link formatToolLedgerContext}. A lead run can reach
 * 150 rounds and accumulate hundreds of entries; dumping every one into the
 * Auditor prompt bloats exactly the evaluation the ledger is meant to sharpen.
 * Anomalies (rejected, failed, still-started) are always shown even past the
 * budget — an elided failure would be a false "clean run" — with the remaining
 * budget split between the run's head and tail.
 */
export const MAX_TOOL_LEDGER_CONTEXT_DETAIL_LINES = 40;

/** Compact, transcript-free execution context for Auditor prompts and logs. */
export function formatToolLedgerContext(
  snapshot: ToolLedgerSnapshot<unknown> | null | undefined,
  options?: { maxDetailLines?: number },
): string {
  if (!snapshot || snapshot.entries.length === 0) return 'No tool calls were recorded.';
  const completed = snapshot.accepted.filter((entry) => entry.execution?.status === 'completed');
  const failed = snapshot.accepted.filter((entry) => entry.execution?.status === 'failed');
  const started = snapshot.accepted.filter((entry) => entry.execution?.status === 'started');
  const lines = [
    `Calls: ${snapshot.counts.total} total; ${snapshot.counts.accepted} accepted; ${snapshot.counts.rejected} rejected; ${completed.length} completed; ${failed.length} failed; ${started.length} still started.`,
  ];

  const maxDetailLines = options?.maxDetailLines ?? MAX_TOOL_LEDGER_CONTEXT_DETAIL_LINES;
  const entries = snapshot.entries;
  const shown = new Set<number>();
  if (entries.length <= maxDetailLines) {
    for (let i = 0; i < entries.length; i += 1) shown.add(i);
  } else {
    // Everything except a clean completion is an anomaly: rejections, failures,
    // still-running calls, and accepted calls that never executed (a batch the
    // loop policy skipped). Only clean completions are ever elided, which also
    // keeps the elision marker's label exact.
    const isAnomaly = (entry: ToolLedgerEntry<unknown>): boolean =>
      entry.disposition === 'rejected' || entry.execution?.status !== 'completed';
    for (let i = 0; i < entries.length; i += 1) {
      if (isAnomaly(entries[i])) shown.add(i);
    }
    const fillBudget = Math.max(0, maxDetailLines - shown.size);
    const headBudget = Math.ceil(fillBudget / 2);
    let taken = 0;
    for (let i = 0; i < entries.length && taken < headBudget; i += 1) {
      if (!shown.has(i)) {
        shown.add(i);
        taken += 1;
      }
    }
    taken = 0;
    for (let i = entries.length - 1; i >= 0 && taken < fillBudget - headBudget; i -= 1) {
      if (!shown.has(i)) {
        shown.add(i);
        taken += 1;
      }
    }
  }

  let elided = 0;
  const flushElision = (): void => {
    if (elided > 0) lines.push(`- (… ${elided} completed call(s) elided …)`);
    elided = 0;
  };
  for (let i = 0; i < entries.length; i += 1) {
    if (!shown.has(i)) {
      elided += 1;
      continue;
    }
    flushElision();
    const entry = entries[i];
    const outcome =
      entry.disposition === 'rejected'
        ? `rejected:${entry.rejectionReason ?? 'unknown'}`
        : (entry.execution?.status ?? 'not_started');
    const detail = entry.execution?.structuredErrorType
      ? ` error=${entry.execution.structuredErrorType}`
      : '';
    const duration =
      entry.execution?.durationMs === undefined ? '' : ` durationMs=${entry.execution.durationMs}`;
    const postconditions = entry.execution?.postconditions?.length
      ? ` post=${entry.execution.postconditions.join(', ')}`
      : '';
    lines.push(
      `- #${entry.sequence}${entry.round === undefined ? '' : ` round=${entry.round}`} ${entry.toolName} ${outcome}${duration}${detail}${postconditions}`,
    );
  }
  flushElision();
  return lines.join('\n');
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
