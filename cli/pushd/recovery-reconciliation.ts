/**
 * recovery-reconciliation.ts — pure orphaned-delegation detection and the
 * `[DELEGATION_INTERRUPTED]` reconciliation note for crash recovery.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). Pure
 * functions over a session event log; the recovery orchestration that calls
 * them stays in `cli/pushd.ts` until the recovery extraction phase.
 */

export interface OrphanedSubagent {
  subagentId: string;
  agent: string;
}

export interface OrphanedGraph {
  executionId: string;
}

export interface OrphanedDelegations {
  subagents: OrphanedSubagent[];
  graphs: OrphanedGraph[];
}

/**
 * Structural subset of a persisted session event that orphan detection reads.
 * Events arrive from the session-store JSON log, so fields are validated at
 * use rather than trusted.
 */
export interface SessionEventLike {
  type?: unknown;
  runId?: unknown;
  payload?: unknown;
}

/**
 * Scan a session event log and return delegations/task-graphs that were
 * tied to the given parent run but never reached a terminal event. Used by
 * crash recovery to build the `[DELEGATION_INTERRUPTED]` reconciliation note.
 *
 * A subagent delegation is "orphaned" if there is a `subagent.started` event
 * whose `payload.parentRunId === parentRunId` AND no matching
 * `subagent.completed` / `subagent.failed` for the same `subagentId`.
 *
 * A task graph is "orphaned" if there is any `task_graph.*` event whose
 * envelope `runId === parentRunId` AND no matching `task_graph.graph_completed`
 * for the same `executionId`.
 *
 * We deliberately restrict to events bound to the interrupted parent run —
 * older fire-and-forget failures from prior runs are not this recovery's
 * problem.
 */
export function collectOrphanedDelegations(
  events: ReadonlyArray<SessionEventLike | null | undefined>,
  parentRunId: string,
): OrphanedDelegations {
  const startedSubagents = new Map<string, { agent: string }>(); // subagentId -> { agent }
  const terminatedSubagents = new Set<string>(); // subagentId
  const seenGraphs = new Map<string, true>(); // executionId -> true
  const completedGraphs = new Set<string>(); // executionId

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const payload = (event.payload || {}) as Record<string, unknown>;

    if (event.type === 'subagent.started') {
      if (payload.parentRunId !== parentRunId) continue;
      const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
      if (!subagentId) continue;
      startedSubagents.set(subagentId, {
        agent: typeof payload.agent === 'string' ? payload.agent : 'subagent',
      });
      continue;
    }
    if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
      if (subagentId) terminatedSubagents.add(subagentId);
      continue;
    }
    if (event.type.startsWith('task_graph.')) {
      if (event.runId !== parentRunId) continue;
      const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
      if (!executionId) continue;
      if (event.type === 'task_graph.graph_completed') {
        completedGraphs.add(executionId);
      } else {
        seenGraphs.set(executionId, true);
      }
      continue;
    }
  }

  const orphanedSubagents: OrphanedSubagent[] = [];
  for (const [subagentId, meta] of startedSubagents) {
    if (!terminatedSubagents.has(subagentId)) {
      orphanedSubagents.push({ subagentId, agent: meta.agent });
    }
  }

  const orphanedGraphs: OrphanedGraph[] = [];
  for (const [executionId] of seenGraphs) {
    if (!completedGraphs.has(executionId)) {
      orphanedGraphs.push({ executionId });
    }
  }

  return { subagents: orphanedSubagents, graphs: orphanedGraphs };
}

/**
 * Build the `[DELEGATION_INTERRUPTED]` reconciliation note injected into the
 * message history on recovery. Returns null if nothing was orphaned.
 */
export function formatDelegationInterruptedNote(orphans: OrphanedDelegations): string | null {
  const { subagents, graphs } = orphans;
  if (subagents.length === 0 && graphs.length === 0) return null;
  const lines = ['[DELEGATION_INTERRUPTED]'];
  lines.push(
    'One or more sub-agents launched during the interrupted run never reported a terminal result.',
  );
  if (subagents.length > 0) {
    lines.push('Unfinished delegations:');
    for (const { subagentId, agent } of subagents) {
      lines.push(`  - ${agent} (${subagentId})`);
    }
  }
  if (graphs.length > 0) {
    lines.push('Unfinished task graphs:');
    for (const { executionId } of graphs) {
      lines.push(`  - ${executionId}`);
    }
  }
  lines.push(
    'Assume their work is lost. If you still need their results, re-delegate explicitly — do not wait for ghost completions.',
  );
  lines.push('[/DELEGATION_INTERRUPTED]');
  return lines.join('\n');
}
