/**
 * task-graph.ts
 *
 * Dependency-aware task graph executor for multi-agent orchestration.
 *
 * The Orchestrator emits a `plan_tasks` tool call with a DAG of tasks
 * assigned to Explorer or Coder agents. This module validates the graph,
 * resolves dependencies topologically, and dispatches tasks in parallel
 * where safe:
 *
 *   - Explorer tasks are fully parallelizable (read-only).
 *   - Coder tasks run sequentially (mutations may conflict in sandbox).
 *   - Explorer tasks can run concurrently with a Coder task.
 *   - Completed tasks write graph-scoped memory entries that are summarized
 *     into later tasks' knownContext.
 *   - Failed tasks cascade failure to all transitive dependents.
 */

import type {
  TaskGraphNode,
  TaskGraphMemoryEntry,
  TaskGraphNodeState,
  TaskGraphResult,
  TaskGraphProgressEvent,
  DelegationOutcome,
} from '@/types';

const MAX_MEMORY_SUMMARY_CHARS = 220;
const MAX_MEMORY_CHECKS = 5;
const MAX_MEMORY_EVIDENCE_LABELS = 5;
const MAX_SUPPLEMENTAL_MEMORY_ENTRIES = 2;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TaskGraphValidationError {
  type: 'duplicate_id' | 'missing_dependency' | 'cycle' | 'empty_graph' | 'invalid_agent';
  message: string;
}

/**
 * Validate a task graph for structural correctness.
 * Returns an empty array if valid, or a list of errors.
 */
export function validateTaskGraph(nodes: TaskGraphNode[]): TaskGraphValidationError[] {
  const errors: TaskGraphValidationError[] = [];

  if (nodes.length === 0) {
    errors.push({ type: 'empty_graph', message: 'Task graph must contain at least one task.' });
    return errors;
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      errors.push({ type: 'duplicate_id', message: `Duplicate task id: "${node.id}".` });
    }
    ids.add(node.id);
  }

  // Check for valid agents
  for (const node of nodes) {
    if (node.agent !== 'explorer' && node.agent !== 'coder') {
      errors.push({ type: 'invalid_agent', message: `Task "${node.id}" has invalid agent "${node.agent}". Must be "explorer" or "coder".` });
    }
  }

  // Check for missing dependencies
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!ids.has(dep)) {
        errors.push({ type: 'missing_dependency', message: `Task "${node.id}" depends on unknown task "${dep}".` });
      }
    }
  }

  // Cycle detection via DFS
  if (errors.length === 0) {
    const cycleError = detectCycle(nodes);
    if (cycleError) {
      errors.push(cycleError);
    }
  }

  return errors;
}

function detectCycle(nodes: TaskGraphNode[]): TaskGraphValidationError | null {
  const WHITE = 0;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const adjMap = new Map<string, string[]>();
  for (const n of nodes) {
    adjMap.set(n.id, n.dependsOn ?? []);
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const cycle = dfs(n.id, color, adjMap, []);
      if (cycle) {
        return { type: 'cycle', message: `Cycle detected: ${cycle.join(' → ')}.` };
      }
    }
  }
  return null;
}

function dfs(
  nodeId: string,
  color: Map<string, number>,
  adj: Map<string, string[]>,
  path: string[],
): string[] | null {
  color.set(nodeId, 1 /* GRAY */);
  path.push(nodeId);

  for (const dep of adj.get(nodeId) ?? []) {
    if (color.get(dep) === 1 /* GRAY */) {
      // Found a back-edge — extract the cycle
      const cycleStart = path.indexOf(dep);
      return [...path.slice(cycleStart), dep];
    }
    if (color.get(dep) === 0 /* WHITE */) {
      const result = dfs(dep, color, adj, path);
      if (result) return result;
    }
  }

  path.pop();
  color.set(nodeId, 2 /* BLACK */);
  return null;
}

// ---------------------------------------------------------------------------
// Topological helpers
// ---------------------------------------------------------------------------

/**
 * Return the set of task IDs that are ready to run: all dependencies are
 * in the `completed` state. Transitions matching tasks from `pending` to `ready`.
 */
export function getReadyTasks(states: Map<string, TaskGraphNodeState>): string[] {
  const ready: string[] = [];
  for (const [id, state] of states) {
    if (state.status !== 'pending') continue;
    const deps = state.node.dependsOn ?? [];
    const allDepsComplete = deps.every((dep) => states.get(dep)?.status === 'completed');
    if (allDepsComplete) {
      state.status = 'ready';
      ready.push(id);
    }
  }
  return ready;
}

/**
 * Emit task_ready events for newly ready tasks. Call after getReadyTasks().
 */
function emitReadyEvents(
  readyIds: string[],
  states: Map<string, TaskGraphNodeState>,
  onProgress?: (event: TaskGraphProgressEvent) => void,
): void {
  for (const id of readyIds) {
    const state = states.get(id);
    if (state) {
      onProgress?.({ type: 'task_ready', taskId: id, detail: state.node.task });
    }
  }
}

/**
 * Mark a task and all its transitive dependents as cancelled.
 */
export function cascadeFailure(
  failedId: string,
  states: Map<string, TaskGraphNodeState>,
): string[] {
  const cancelled: string[] = [];
  const queue = [failedId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    // Find all tasks that depend on the current failed/cancelled task
    for (const [id, state] of states) {
      if (state.status !== 'pending' && state.status !== 'ready') continue;
      const deps = state.node.dependsOn ?? [];
      if (deps.includes(current)) {
        state.status = 'cancelled';
        state.error = `Cancelled: dependency "${current}" failed.`;
        cancelled.push(id);
        queue.push(id);
      }
    }
  }

  return cancelled;
}

// ---------------------------------------------------------------------------
// Context propagation
// ---------------------------------------------------------------------------

/**
 * Build enriched knownContext for a task by appending summaries from
 * completed dependency tasks plus a compact shared-memory summary from
 * other completed graph work.
 */
export function buildEnrichedContext(
  node: TaskGraphNode,
  states: Map<string, TaskGraphNodeState>,
): string[] {
  const base = [...(node.knownContext ?? [])];
  const memorySummary = formatSharedMemorySummary(node, states);
  if (memorySummary) {
    base.push(memorySummary);
  }
  return base;
}

function truncateMemoryText(text: string, maxLength = MAX_MEMORY_SUMMARY_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildTaskGraphMemoryEntry(state: TaskGraphNodeState): TaskGraphMemoryEntry | null {
  if (state.status !== 'completed') return null;
  const summary = state.delegationOutcome?.summary || state.result;
  if (!summary?.trim()) return null;

  return {
    namespace: state.node.id,
    agent: state.node.agent,
    status: state.delegationOutcome?.status ?? 'complete',
    summary: truncateMemoryText(summary),
    checks: state.delegationOutcome?.checks?.slice(0, MAX_MEMORY_CHECKS).map((check) => ({
      id: check.id,
      passed: check.passed,
    })),
    evidenceLabels: state.delegationOutcome?.evidence
      ?.slice(0, MAX_MEMORY_EVIDENCE_LABELS)
      .map((evidence) => evidence.label),
    nextRequiredAction: state.delegationOutcome?.nextRequiredAction ?? null,
  };
}

function formatMemoryEntry(entry: TaskGraphMemoryEntry): string {
  const lines = [
    `- [${entry.namespace} | ${entry.agent} | ${entry.status}] ${entry.summary}`,
  ];
  if (entry.checks && entry.checks.length > 0) {
    lines.push(`  Checks: ${entry.checks.map((check) => `${check.passed ? 'PASS' : 'FAIL'} ${check.id}`).join(', ')}`);
  }
  if (entry.evidenceLabels && entry.evidenceLabels.length > 0) {
    lines.push(`  Evidence: ${entry.evidenceLabels.join(', ')}`);
  }
  if (entry.nextRequiredAction) {
    lines.push(`  Next: ${entry.nextRequiredAction}`);
  }
  return lines.join('\n');
}

function formatSharedMemorySummary(
  node: TaskGraphNode,
  states: Map<string, TaskGraphNodeState>,
): string | null {
  const dependencyEntries: TaskGraphMemoryEntry[] = [];
  for (const depId of node.dependsOn ?? []) {
    const entry = states.get(depId)?.memoryEntry;
    if (entry) dependencyEntries.push(entry);
  }

  const supplementalEntries: TaskGraphMemoryEntry[] = [];
  if (dependencyEntries.length > 0) {
    for (const [id, state] of states) {
      if (id === node.id || (node.dependsOn ?? []).includes(id)) continue;
      if (state.status !== 'completed' || !state.memoryEntry) continue;
      supplementalEntries.push(state.memoryEntry);
      if (supplementalEntries.length >= MAX_SUPPLEMENTAL_MEMORY_ENTRIES) break;
    }
  }

  if (dependencyEntries.length === 0 && supplementalEntries.length === 0) {
    return null;
  }

  const sections: string[] = ['[TASK_GRAPH_MEMORY]'];
  if (dependencyEntries.length > 0) {
    sections.push('Dependency memory:');
    sections.push(...dependencyEntries.map(formatMemoryEntry));
  }
  if (supplementalEntries.length > 0) {
    sections.push('Shared graph memory:');
    sections.push(...supplementalEntries.map(formatMemoryEntry));
  }
  sections.push('[/TASK_GRAPH_MEMORY]');
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Callback that actually runs a single agent task. */
export type TaskExecutor = (
  node: TaskGraphNode,
  enrichedContext: string[],
  signal?: AbortSignal,
) => Promise<{
  summary: string;
  delegationOutcome?: DelegationOutcome;
  rounds: number;
}>;

export interface TaskGraphExecutorOptions {
  /** Max parallel Explorer tasks. Default: 3. */
  maxParallelExplorers?: number;
  /** Abort signal for the entire graph. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: TaskGraphProgressEvent) => void;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError')
    || (typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError')
  );
}

/**
 * Execute a validated task graph.
 *
 * Dispatch strategy:
 * - Explorer tasks with satisfied deps → run in parallel (up to maxParallelExplorers).
 * - Coder tasks with satisfied deps → run one at a time (sequential).
 * - Explorer and Coder tasks can overlap (reads don't conflict with writes).
 * - Uses Promise.race to react to task completion immediately, dispatching
 *   newly-ready tasks without waiting for the entire batch.
 *
 * The loop continues until all tasks are terminal (completed, failed, or cancelled).
 */
export async function executeTaskGraph(
  nodes: TaskGraphNode[],
  executor: TaskExecutor,
  options: TaskGraphExecutorOptions = {},
): Promise<TaskGraphResult> {
  const { maxParallelExplorers = 3, signal, onProgress } = options;
  const startMs = Date.now();
  let totalRounds = 0;
  let aborted = Boolean(signal?.aborted);

  // Initialize state map
  const states = new Map<string, TaskGraphNodeState>();
  for (const node of nodes) {
    states.set(node.id, { node, status: 'pending' });
  }

  // Track in-flight promises by task id
  const inFlight = new Map<string, Promise<string>>();

  /** Dispatch a single task — returns a promise that resolves with the task id. */
  function dispatchTask(id: string): void {
    const state = states.get(id)!;
    state.status = 'running';
    onProgress?.({ type: 'task_started', taskId: id, detail: state.node.task });

    const enrichedContext = buildEnrichedContext(state.node, states);
    const taskStartMs = Date.now();

    const promise = (async () => {
      try {
        const result = await executor(state.node, enrichedContext, signal);
        if (state.status === 'cancelled' || signal?.aborted) {
          state.elapsedMs ??= Date.now() - taskStartMs;
          return id;
        }
        state.status = 'completed';
        state.result = result.summary;
        state.delegationOutcome = result.delegationOutcome;
        state.memoryEntry = buildTaskGraphMemoryEntry(state) ?? undefined;
        state.elapsedMs = Date.now() - taskStartMs;
        totalRounds += result.rounds;
        onProgress?.({ type: 'task_completed', taskId: id, detail: result.summary, elapsedMs: state.elapsedMs });
      } catch (err) {
        if (state.status === 'cancelled') {
          state.elapsedMs ??= Date.now() - taskStartMs;
          return id;
        }
        if (signal?.aborted || isAbortError(err)) {
          aborted = true;
          state.status = 'cancelled';
          state.error = 'Cancelled by user.';
          state.elapsedMs = Date.now() - taskStartMs;
          onProgress?.({ type: 'task_cancelled', taskId: id, detail: state.error, elapsedMs: state.elapsedMs });
          return id;
        }
        state.status = 'failed';
        state.error = err instanceof Error ? err.message : String(err);
        state.elapsedMs = Date.now() - taskStartMs;
        onProgress?.({ type: 'task_failed', taskId: id, detail: state.error, elapsedMs: state.elapsedMs });

        // Cascade failure to dependents
        const cancelled = cascadeFailure(id, states);
        for (const cancelledId of cancelled) {
          onProgress?.({ type: 'task_cancelled', taskId: cancelledId, detail: `Dependency "${id}" failed.` });
        }
      }
      return id;
    })();

    inFlight.set(id, promise);
  }

  /** Count in-flight tasks by agent type. */
  function countRunning(agent: 'explorer' | 'coder'): number {
    let count = 0;
    for (const [id] of inFlight) {
      if (states.get(id)?.node.agent === agent) count++;
    }
    return count;
  }

  // Main dispatch loop — dispatch what we can, then wait for any completion
  while (true) {
    if (signal?.aborted) {
      aborted = true;
      for (const [, state] of states) {
        if (state.status === 'pending' || state.status === 'ready' || state.status === 'running') {
          state.status = 'cancelled';
          state.error = 'Cancelled by user.';
        }
      }
      break;
    }

    // Find newly ready tasks and also collect previously-ready tasks that
    // couldn't be dispatched due to capacity constraints.
    const newlyReady = getReadyTasks(states);
    emitReadyEvents(newlyReady, states, onProgress);

    // Collect all dispatchable tasks (newly ready + previously ready but undispatched)
    const dispatchable: string[] = [];
    for (const [id, state] of states) {
      if (state.status === 'ready') dispatchable.push(id);
    }

    for (const id of dispatchable) {
      const node = states.get(id)!.node;
      if (node.agent === 'explorer' && countRunning('explorer') < maxParallelExplorers) {
        dispatchTask(id);
      } else if (node.agent === 'coder' && countRunning('coder') < 1) {
        dispatchTask(id);
      }
      // else: stays in 'ready' state, will be dispatched when capacity frees up
    }

    // If nothing in-flight, check if there's any remaining work.
    // Don't break yet — a failure cascade may have left independent branches
    // in 'pending' that getReadyTasks() can still promote on the next iteration.
    if (inFlight.size === 0) {
      const hasPending = [...states.values()].some((s) => s.status === 'pending');
      if (!hasPending) break;
      // There are pending tasks but none were dispatched or ready — they must
      // be blocked on failed/cancelled deps. Nothing more we can do.
      const hasReady = [...states.values()].some((s) => s.status === 'ready');
      if (!hasReady) break;
      // There are ready tasks we couldn't dispatch (shouldn't happen with
      // current capacity rules, but guard against it).
      continue;
    }

    // Wait for any single task to complete, then re-check for new ready tasks
    const completedId = await Promise.race(inFlight.values());
    inFlight.delete(completedId);
  }

  // Build summary — any task not in 'completed' means the graph didn't fully succeed
  const summaryParts: string[] = [];
  let allSuccess = true;
  for (const [id, state] of states) {
    if (state.status === 'completed') {
      summaryParts.push(`[${id}] ${state.result}`);
    } else if (state.status === 'failed') {
      summaryParts.push(`[${id}] FAILED: ${state.error}`);
      allSuccess = false;
    } else if (state.status === 'cancelled') {
      summaryParts.push(`[${id}] CANCELLED: ${state.error}`);
      allSuccess = false;
    } else {
      // Tasks still in pending/ready were blocked by upstream failures
      summaryParts.push(`[${id}] SKIPPED: blocked by failed dependency`);
      allSuccess = false;
    }
  }

  onProgress?.({
    type: 'graph_complete',
    detail: aborted
      ? 'Task graph cancelled by user.'
      : allSuccess
        ? 'All tasks completed.'
        : 'Some tasks failed.',
  });

  return {
    success: allSuccess,
    aborted,
    memoryEntries: new Map(
      [...states.entries()]
        .flatMap(([id, state]) => (state.memoryEntry ? [[id, state.memoryEntry] as const] : [])),
    ),
    nodeStates: states,
    summary: summaryParts.join('\n'),
    wallTimeMs: Date.now() - startMs,
    totalRounds,
  };
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

/**
 * Format a TaskGraphResult into a tool result string for the Orchestrator.
 */
export function formatTaskGraphResult(result: TaskGraphResult): string {
  const lines: string[] = ['[Tool Result — plan_tasks]'];
  const statusLine = result.aborted
    ? 'Task graph execution cancelled by user.'
    : result.success
      ? 'All tasks completed successfully.'
      : 'Some tasks failed or were cancelled.';
  lines.push(statusLine);
  lines.push('');

  for (const [id, state] of result.nodeStates) {
    const elapsed = state.elapsedMs ? ` (${Math.round(state.elapsedMs / 1000)}s)` : '';
    const icon = state.status === 'completed' ? 'OK' : state.status === 'failed' ? 'FAILED' : 'CANCELLED';
    const detail = state.status === 'completed'
      ? state.result ?? ''
      : state.error ?? '';
    lines.push(`${id} [${state.node.agent}, ${icon}${elapsed}]: ${detail}`);
  }

  lines.push('');
  lines.push(`Total: ${result.nodeStates.size} tasks, ${result.totalRounds} rounds, ${Math.round(result.wallTimeMs / 1000)}s wall time.`);
  return lines.join('\n');
}
