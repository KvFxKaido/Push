/**
 * Memory-write orchestration for daemon task-graph executions.
 *
 * After `executeTaskGraph` returns, each completed node contributes
 * a typed `MemoryRecord` via `writeTaskGraphNodeMemory` so later
 * runs can retrieve prior findings + outcomes. The writes go to
 * whatever `ContextMemoryStore` is active (`getDefaultMemoryStore()`
 * by default — the daemon wires a file-backed store at startup; see
 * `cli/pushd.ts:main()`).
 *
 * Error isolation: a single failed write must not abort subsequent
 * writes or cancel the graph_completed RPC emit. Each write is
 * try/catch-wrapped and failures are logged but do not throw.
 */

import { writeTaskGraphNodeMemory } from '../lib/context-memory.ts';
import type { ContextMemoryStore } from '../lib/context-memory-store.ts';
import type { MemoryScope, TaskGraphResult } from '../lib/runtime-contract.ts';

type GraphMemoryScope = Omit<MemoryScope, 'role' | 'taskId'>;

export interface WriteTaskGraphResultMemoryOptions {
  store?: ContextMemoryStore;
  // Test hook — lets tests observe per-node write failures without
  // going through stderr. Defaults to a stderr writer.
  onWriteError?: (nodeId: string, error: unknown) => void;
}

function defaultOnWriteError(nodeId: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  // stderr is the daemon's structured-log channel for
  // non-protocol-breaking warnings (same pattern as the
  // ROLE_CAPABILITY_DENIED log added in Gap 2).
  process.stderr.write(
    `${JSON.stringify({
      level: 'warn',
      event: 'task_graph_memory_write_failed',
      nodeId,
      error: msg,
    })}\n`,
  );
}

/**
 * Persist a typed memory record for each completed node in a task
 * graph result. Scope flows from the caller — typically
 * `{ repoFullName, branch, chatId: sessionId, taskGraphId: executionId }` —
 * and `writeTaskGraphNodeMemory` derives `role` + `taskId` from the
 * node itself.
 */
export async function writeTaskGraphResultMemory(
  result: TaskGraphResult,
  scope: GraphMemoryScope,
  options: WriteTaskGraphResultMemoryOptions = {},
): Promise<void> {
  const onWriteError = options.onWriteError ?? defaultOnWriteError;

  for (const [id, nodeState] of result.nodeStates) {
    if (nodeState.status !== 'completed') continue;
    try {
      await writeTaskGraphNodeMemory({
        scope: { ...scope, role: nodeState.node.agent },
        nodeState,
        store: options.store,
      });
    } catch (err) {
      onWriteError(id, err);
    }
  }
}
