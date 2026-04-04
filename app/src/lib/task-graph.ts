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
 *   - Completed task summaries propagate into dependent tasks' knownContext.
 *   - Failed tasks cascade failure to all transitive dependents.
 */

import type {
  TaskGraphNode,
  TaskGraphNodeState,
  TaskGraphResult,
  TaskGraphProgressEvent,
  DelegationOutcome,
} from '@/types';

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
  const GRAY = 1;
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
  const GRAY = 1;
  color.set(nodeId, GRAY);
  path.push(nodeId);

  for (const dep of adj.get(nodeId) ?? []) {
    if (color.get(dep) === GRAY) {
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
 * in the `completed` state.
 */
export function getReadyTasks(states: Map<string, TaskGraphNodeState>): string[] {
  const ready: string[] = [];
  for (const [id, state] of states) {
    if (state.status !== 'pending') continue;
    const deps = state.node.dependsOn ?? [];
    const allDepsComplete = deps.every((dep) => states.get(dep)?.status === 'completed');
    if (allDepsComplete) {
      ready.push(id);
    }
  }
  return ready;
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
 * completed dependency tasks.
 */
export function buildEnrichedContext(
  node: TaskGraphNode,
  states: Map<string, TaskGraphNodeState>,
): string[] {
  const base = [...(node.knownContext ?? [])];
  for (const depId of node.dependsOn ?? []) {
    const depState = states.get(depId);
    if (depState?.status === 'completed' && depState.result) {
      base.push(`[From ${depId}] ${depState.result}`);
    }
  }
  return base;
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

/**
 * Execute a validated task graph.
 *
 * Dispatch strategy:
 * - Explorer tasks with satisfied deps → run in parallel (up to maxParallelExplorers).
 * - Coder tasks with satisfied deps → run one at a time (sequential).
 * - Explorer and Coder tasks can overlap (reads don't conflict with writes).
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

  // Initialize state map
  const states = new Map<string, TaskGraphNodeState>();
  for (const node of nodes) {
    states.set(node.id, { node, status: 'pending' });
  }

  // Main dispatch loop
  while (true) {
    if (signal?.aborted) {
      // Mark all non-terminal tasks as cancelled
      for (const [, state] of states) {
        if (state.status === 'pending' || state.status === 'ready' || state.status === 'running') {
          state.status = 'cancelled';
          state.error = 'Graph execution aborted.';
        }
      }
      break;
    }

    const readyIds = getReadyTasks(states);
    if (readyIds.length === 0) {
      // No more tasks to dispatch — check if we're truly done
      const hasRunning = [...states.values()].some((s) => s.status === 'running');
      if (!hasRunning) break;
      // If tasks are still running, wait for them (handled by the promises below)
      // This branch shouldn't normally be reached because we await below.
      break;
    }

    // Separate ready tasks by agent type
    const readyExplorers = readyIds.filter((id) => states.get(id)!.node.agent === 'explorer');
    const readyCoders = readyIds.filter((id) => states.get(id)!.node.agent === 'coder');

    // Build dispatch batch: up to maxParallelExplorers explorers + at most 1 coder
    const batch: string[] = [];
    const explorerBatch = readyExplorers.slice(0, maxParallelExplorers);
    batch.push(...explorerBatch);

    // Only dispatch one coder at a time
    if (readyCoders.length > 0) {
      batch.push(readyCoders[0]);
    }

    if (batch.length === 0) break;

    // Mark batch as running
    for (const id of batch) {
      const state = states.get(id)!;
      state.status = 'running';
      onProgress?.({ type: 'task_started', taskId: id, detail: state.node.task });
    }

    // Execute batch in parallel
    const promises = batch.map(async (id) => {
      const state = states.get(id)!;
      const enrichedContext = buildEnrichedContext(state.node, states);
      const taskStartMs = Date.now();

      try {
        const result = await executor(state.node, enrichedContext, signal);
        state.status = 'completed';
        state.result = result.summary;
        state.delegationOutcome = result.delegationOutcome;
        state.elapsedMs = Date.now() - taskStartMs;
        totalRounds += result.rounds;
        onProgress?.({ type: 'task_completed', taskId: id, detail: result.summary });
      } catch (err) {
        state.status = 'failed';
        state.error = err instanceof Error ? err.message : String(err);
        state.elapsedMs = Date.now() - taskStartMs;
        onProgress?.({ type: 'task_failed', taskId: id, detail: state.error });

        // Cascade failure to dependents
        const cancelled = cascadeFailure(id, states);
        for (const cancelledId of cancelled) {
          onProgress?.({ type: 'task_cancelled', taskId: cancelledId, detail: `Dependency "${id}" failed.` });
        }
      }
    });

    await Promise.all(promises);
  }

  // Build summary
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
    }
  }

  onProgress?.({ type: 'graph_complete', detail: allSuccess ? 'All tasks completed.' : 'Some tasks failed.' });

  return {
    success: allSuccess,
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
  const statusLine = result.success ? 'All tasks completed successfully.' : 'Some tasks failed or were cancelled.';
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
