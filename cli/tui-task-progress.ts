/** Pure rendering for shared task-ledger and drift events. */

import { normalizeTaskLedgerSteps, taskLedgerCounts } from '../lib/task-ledger.ts';

export const TASK_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.ledger_snapshot',
  'task.drift_changed',
]);

export interface TaskProgressTranscriptEntry {
  role: 'status' | 'warning';
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function taskProgressEventToTranscript(event: {
  type: string;
  payload?: unknown;
}): TaskProgressTranscriptEntry | null {
  const payload = asRecord(event.payload);
  if (event.type === 'task.ledger_snapshot') {
    const steps = normalizeTaskLedgerSteps(payload.steps);
    const counts = taskLedgerCounts(steps);
    const rows = steps.map((step) => {
      const marker = step.status === 'completed' ? 'x' : step.status === 'in_progress' ? '~' : ' ';
      const label = step.status === 'in_progress' ? step.activeForm : step.content;
      return `  [${marker}] ${label}`;
    });
    return {
      role: 'status',
      text: [
        `Task progress · ${counts.completed}/${steps.length} done`,
        ...(rows.length > 0 ? rows : ['  (ledger cleared)']),
      ].join('\n'),
    };
  }

  if (event.type === 'task.drift_changed') {
    const health = payload.health === 'possibly_stalled' ? 'possibly_stalled' : 'working';
    const active = Array.isArray(payload.active)
      ? payload.active
          .map((signal) => asRecord(signal).detail)
          .filter((detail): detail is string => typeof detail === 'string' && detail.length > 0)
      : [];
    const cleared = Array.isArray(payload.cleared)
      ? payload.cleared.filter((kind): kind is string => typeof kind === 'string')
      : [];
    return health === 'possibly_stalled'
      ? {
          role: 'warning',
          text: `Task possibly stalled${active.length > 0 ? ` · ${active.join('; ')}` : ''}`,
        }
      : {
          role: 'status',
          text: `Task progress resumed${cleared.length > 0 ? ` · cleared ${cleared.join(', ')}` : ''}`,
        };
  }

  return null;
}
