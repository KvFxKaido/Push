/**
 * Mechanical task-drift signals for long lead runs.
 *
 * The monitor reads only the runtime tool ledger. It does not ask the model
 * whether it is making progress. Signals are advisory: they drive a visible
 * `working` / `possibly_stalled` transition and a bounded re-orientation
 * nudge, never an automatic kill.
 */

import type { ToolLedgerSideEffectClass } from './tool-ledger.ts';
import type { TaskLedgerStep } from './task-ledger.ts';

export const DEFAULT_IDENTICAL_CALL_ROUNDS = 3;
export const DEFAULT_NO_NOVEL_READ_ROUNDS = 4;
export const DEFAULT_NO_MUTATION_ROUNDS = 6;
export const MAX_TASK_DRIFT_NUDGES = 2;

export type TaskProgressHealth = 'working' | 'possibly_stalled';
export type TaskDriftSignalKind = 'repeated_tool_call' | 'no_novel_reads' | 'no_mutation';

export interface TaskDriftSignal {
  kind: TaskDriftSignalKind;
  count: number;
  detail: string;
}

export interface TaskDriftToolActivity {
  toolName: string;
  argsKey?: string;
  target?: string;
  sideEffect?: ToolLedgerSideEffectClass;
}

export interface TaskDriftTransition {
  health: TaskProgressHealth;
  fired: TaskDriftSignal[];
  cleared: TaskDriftSignalKind[];
  active: TaskDriftSignal[];
}

export interface TaskDriftMonitorOptions {
  identicalCallRounds?: number;
  noNovelReadRounds?: number;
  noMutationRounds?: number;
  expectedToMutate?: boolean;
}

export interface TaskDriftMonitor {
  /** Observe one completed model round. Empty activity is ignored. */
  observeRound(activity: readonly TaskDriftToolActivity[]): TaskDriftTransition | null;
  snapshot(): { health: TaskProgressHealth; active: TaskDriftSignal[] };
  clear(): void;
}

function signatureOf(activity: readonly TaskDriftToolActivity[]): string | null {
  if (activity.length !== 1) return null;
  const call = activity[0];
  return `${call.toolName}\n${call.argsKey ?? call.target ?? ''}`;
}

function cloneSignals(signals: readonly TaskDriftSignal[]): TaskDriftSignal[] {
  return signals.map((signal) => ({ ...signal }));
}

export function createTaskDriftMonitor(options: TaskDriftMonitorOptions = {}): TaskDriftMonitor {
  const identicalCallRounds = Math.max(
    2,
    options.identicalCallRounds ?? DEFAULT_IDENTICAL_CALL_ROUNDS,
  );
  const noNovelReadRounds = Math.max(2, options.noNovelReadRounds ?? DEFAULT_NO_NOVEL_READ_ROUNDS);
  const noMutationRounds = Math.max(2, options.noMutationRounds ?? DEFAULT_NO_MUTATION_ROUNDS);
  const expectedToMutate = options.expectedToMutate ?? false;

  const seenReadTargets = new Set<string>();
  let lastSignature: string | null = null;
  let identicalRounds = 0;
  let noNovelReadStreak = 0;
  let noMutationStreak = 0;
  let active = new Map<TaskDriftSignalKind, TaskDriftSignal>();

  const reset = () => {
    seenReadTargets.clear();
    lastSignature = null;
    identicalRounds = 0;
    noNovelReadStreak = 0;
    noMutationStreak = 0;
    active = new Map();
  };

  return {
    observeRound(activity) {
      if (activity.length === 0) return null;

      const signature = signatureOf(activity);
      if (signature && signature === lastSignature) identicalRounds += 1;
      else identicalRounds = signature ? 1 : 0;
      lastSignature = signature;

      const readTargets = activity
        .filter((entry) => entry.sideEffect === 'read' && entry.target?.trim())
        .map((entry) => entry.target!.trim());
      const hasMutation = activity.some((entry) => entry.sideEffect === 'file_mutation');
      const novelTargets = readTargets.filter((target) => !seenReadTargets.has(target));
      for (const target of readTargets) seenReadTargets.add(target);
      if (novelTargets.length > 0 || hasMutation) noNovelReadStreak = 0;
      else if (readTargets.length > 0) noNovelReadStreak += 1;

      if (expectedToMutate) {
        noMutationStreak = hasMutation ? 0 : noMutationStreak + 1;
      } else {
        noMutationStreak = 0;
      }

      const next = new Map<TaskDriftSignalKind, TaskDriftSignal>();
      if (signature && identicalRounds >= identicalCallRounds) {
        next.set('repeated_tool_call', {
          kind: 'repeated_tool_call',
          count: identicalRounds,
          detail: `${activity[0].toolName} repeated with identical arguments for ${identicalRounds} rounds`,
        });
      }
      if (noNovelReadStreak >= noNovelReadRounds) {
        next.set('no_novel_reads', {
          kind: 'no_novel_reads',
          count: noNovelReadStreak,
          detail: `read activity found no new target for ${noNovelReadStreak} rounds`,
        });
      }
      if (noMutationStreak >= noMutationRounds) {
        next.set('no_mutation', {
          kind: 'no_mutation',
          count: noMutationStreak,
          detail: `no workspace mutation observed for ${noMutationStreak} active rounds`,
        });
      }

      const fired = [...next.entries()]
        .filter(([kind]) => !active.has(kind))
        .map(([, signal]) => signal);
      const cleared = [...active.keys()].filter((kind) => !next.has(kind));
      active = next;
      if (fired.length === 0 && cleared.length === 0) return null;

      return {
        health: active.size > 0 ? 'possibly_stalled' : 'working',
        fired: cloneSignals(fired),
        cleared,
        active: cloneSignals([...active.values()]),
      };
    },
    snapshot() {
      return {
        health: active.size > 0 ? 'possibly_stalled' : 'working',
        active: cloneSignals([...active.values()]),
      };
    },
    clear: reset,
  };
}

function renderTaskLedger(steps: readonly TaskLedgerStep[]): string {
  if (steps.length === 0) return '(no task ledger has been recorded yet)';
  return steps
    .map((step) => {
      const marker = step.status === 'completed' ? 'x' : step.status === 'in_progress' ? '~' : ' ';
      const label = step.status === 'in_progress' ? step.activeForm : step.content;
      return `- [${marker}] ${label}`;
    })
    .join('\n');
}

/** Model-facing steering block. The runtime supplies evidence and position. */
export function formatTaskDriftNudge(
  signals: readonly TaskDriftSignal[],
  steps: readonly TaskLedgerStep[],
): string {
  const evidence = signals.length
    ? signals.map((signal) => `- ${signal.detail}`).join('\n')
    : '- progress signal changed';
  return [
    '[RUNTIME_INTERVENTION mode="steer" source="task_drift" reason="possibly_stalled"]',
    'The tool stream shows possible task drift.',
    'Evidence:',
    evidence,
    '',
    'Current task ledger:',
    renderTaskLedger(steps),
    '',
    'Re-orient now: continue with a materially new action on the current step, update the ledger if the plan changed, or report the concrete blocker.',
    '[/RUNTIME_INTERVENTION]',
  ].join('\n');
}
