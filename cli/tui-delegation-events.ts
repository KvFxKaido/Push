// Pure transforms from shared runtime `subagent.*` and `task_graph.*` events
// into transcript entries for the CLI TUI. Kept separate from `tui.ts` so the
// mapping is trivially unit-testable without spinning up the renderer or any
// of its closures.
//
// The CLI engine does not currently *produce* these events — it emits the
// shared tool/assistant lifecycle events but not delegation ones. This module
// is an observer slice: when events arrive from another source (daemon
// stream, future CLI delegation runtime), they land in the same transcript
// format as any other status message.
//
// The event envelope shape matches what `cli/engine.ts:dispatchEvent` emits:
// `{ type, payload, runId?, sessionId? }`. We only read `type` and `payload`
// here; the other fields are ignored.

import type { RunEventSubagent } from '../lib/runtime-contract.ts';

export type DelegationTranscriptRole = 'status' | 'warning' | 'error';

export interface DelegationTranscriptEntry {
  role: DelegationTranscriptRole;
  text: string;
}

export interface DelegationEventEnvelope {
  type: string;
  payload?: {
    executionId?: string;
    agent?: RunEventSubagent | string;
    detail?: string;
    summary?: string;
    error?: string;
    reason?: string;
    taskId?: string;
    elapsedMs?: number;
    // task_graph.graph_completed fields
    success?: boolean;
    aborted?: boolean;
    nodeCount?: number;
    totalRounds?: number;
    wallTimeMs?: number;
  };
}

/**
 * The set of event types this module handles. Callers can use this to route
 * events to `delegationEventToTranscript` or fall through to other handlers.
 *
 * Adding a new delegation event type to `lib/runtime-contract.ts` means
 * updating this set AND the switch in `delegationEventToTranscript` — the
 * test suite pins the count so drift between the two is caught at test time.
 */
export const DELEGATION_EVENT_TYPES = new Set<string>([
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'task_graph.task_ready',
  'task_graph.task_started',
  'task_graph.task_completed',
  'task_graph.task_failed',
  'task_graph.task_cancelled',
  'task_graph.graph_completed',
]);

export function isDelegationEvent(event: { type: string }): boolean {
  return DELEGATION_EVENT_TYPES.has(event.type);
}

/**
 * Convert a shared-runtime delegation event into a transcript entry. Returns
 * `null` for any event type outside `DELEGATION_EVENT_TYPES` so the caller can
 * fall through to its other handlers.
 *
 * Rendering choices:
 *   - `status` role for "normal" lifecycle transitions (started, ready,
 *     completed). These share the INFO badge with other ambient status.
 *   - `error` role for failures (subagent.failed, task_graph.task_failed) so
 *     they surface with the same severity as other run errors.
 *   - `warning` role for cancellations — not a failure, but worth surfacing
 *     distinctly from a quiet success.
 */
export function delegationEventToTranscript(
  event: DelegationEventEnvelope,
): DelegationTranscriptEntry | null {
  const p = event.payload ?? {};

  switch (event.type) {
    case 'subagent.started': {
      const agent = String(p.agent ?? 'subagent');
      const text = p.detail
        ? `subagent started: ${agent} — ${p.detail}`
        : `subagent started: ${agent}`;
      return { role: 'status', text };
    }

    case 'subagent.completed': {
      const agent = String(p.agent ?? 'subagent');
      const summary = p.summary ?? '(no summary)';
      return { role: 'status', text: `subagent completed: ${agent} — ${summary}` };
    }

    case 'subagent.failed': {
      const agent = String(p.agent ?? 'subagent');
      const error = p.error ?? '(unknown error)';
      return { role: 'error', text: `subagent failed: ${agent} — ${error}` };
    }

    case 'task_graph.task_ready': {
      const taskId = p.taskId ?? '?';
      const agent = String(p.agent ?? 'agent');
      const text = p.detail
        ? `task ready: ${taskId} (${agent}) — ${p.detail}`
        : `task ready: ${taskId} (${agent})`;
      return { role: 'status', text };
    }

    case 'task_graph.task_started': {
      const taskId = p.taskId ?? '?';
      const agent = String(p.agent ?? 'agent');
      const text = p.detail
        ? `task started: ${taskId} (${agent}) — ${p.detail}`
        : `task started: ${taskId} (${agent})`;
      return { role: 'status', text };
    }

    case 'task_graph.task_completed': {
      const taskId = p.taskId ?? '?';
      const agent = String(p.agent ?? 'agent');
      const summary = p.summary ?? '(no summary)';
      const elapsed = typeof p.elapsedMs === 'number' ? `, ${p.elapsedMs}ms` : '';
      return {
        role: 'status',
        text: `task completed: ${taskId} (${agent}${elapsed}) — ${summary}`,
      };
    }

    case 'task_graph.task_failed': {
      const taskId = p.taskId ?? '?';
      const agent = String(p.agent ?? 'agent');
      const error = p.error ?? '(unknown error)';
      const elapsed = typeof p.elapsedMs === 'number' ? `, ${p.elapsedMs}ms` : '';
      return {
        role: 'error',
        text: `task failed: ${taskId} (${agent}${elapsed}) — ${error}`,
      };
    }

    case 'task_graph.task_cancelled': {
      const taskId = p.taskId ?? '?';
      const agent = String(p.agent ?? 'agent');
      const elapsed = typeof p.elapsedMs === 'number' ? `, ${p.elapsedMs}ms` : '';
      const reason = p.reason ? ` — ${p.reason}` : '';
      return {
        role: 'warning',
        text: `task cancelled: ${taskId} (${agent}${elapsed})${reason}`,
      };
    }

    case 'task_graph.graph_completed': {
      const nodeCount = p.nodeCount ?? 0;
      const totalRounds = p.totalRounds ?? 0;
      const wallTimeMs = p.wallTimeMs ?? 0;
      const summary = p.summary ?? '(no summary)';
      const stats = `${nodeCount} nodes / ${totalRounds} rounds / ${wallTimeMs}ms`;
      // Severity branches on success/aborted: aborted → warn, failed → error,
      // success → info. Keeps the rendering honest about what happened.
      if (p.aborted) {
        return { role: 'warning', text: `task graph aborted: ${stats} — ${summary}` };
      }
      if (p.success === false) {
        return { role: 'error', text: `task graph failed: ${stats} — ${summary}` };
      }
      return { role: 'status', text: `task graph completed: ${stats} — ${summary}` };
    }

    default:
      return null;
  }
}
