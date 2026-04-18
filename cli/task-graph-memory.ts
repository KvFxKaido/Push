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

import {
  buildRetrievedMemoryKnownContext,
  writeTaskGraphNodeMemory,
} from '../lib/context-memory.ts';
import type { ContextMemoryStore } from '../lib/context-memory-store.ts';
import {
  MAX_ROLE_RETRIEVED_MEMORY_RECORDS,
  ROLE_MEMORY_SECTION_BUDGETS,
} from '../lib/role-memory-budgets.ts';
import type { MemoryScope, TaskGraphNode, TaskGraphResult } from '../lib/runtime-contract.ts';

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
 * Retrieve a typed-memory block scoped to a specific task-graph node.
 * Returns a formatted context-memory block (from
 * `buildRetrievedMemoryKnownContext`) or null when no relevant
 * records exist.
 *
 * Pulls the shared `ROLE_MEMORY_SECTION_BUDGETS` so CLI retrievals
 * use the same per-section caps the web surface applies to
 * Reviewer / Auditor retrievals. Same budget for every role today;
 * tune per-role later if measurement shows it matters.
 *
 * Derives `fileHints` from the node's declared files so scored
 * retrieval favors records with file overlap. `includeStale` is
 * left at the `buildRetrievedMemoryKnownContext` default (true),
 * since the stale section has its own modest budget and the Coder
 * kernel can still benefit from prior stale findings.
 */
export async function buildTypedMemoryBlockForNode(input: {
  node: TaskGraphNode;
  scope: GraphMemoryScope;
  store?: ContextMemoryStore;
}): Promise<string | null> {
  const { node, scope, store } = input;
  if (!scope.repoFullName) return null;

  const fileHints = node.files && node.files.length > 0 ? node.files.slice(0, 8) : undefined;

  try {
    const { line } = await buildRetrievedMemoryKnownContext(
      {
        repoFullName: scope.repoFullName,
        branch: scope.branch,
        chatId: scope.chatId,
        taskGraphId: scope.taskGraphId,
        taskId: node.id,
        role: node.agent,
        taskText: node.task,
        fileHints,
        maxRecords: MAX_ROLE_RETRIEVED_MEMORY_RECORDS,
      },
      {
        sectionBudgets: ROLE_MEMORY_SECTION_BUDGETS,
        store,
      },
    );
    return line;
  } catch (err) {
    // Retrieval failure must not block the delegation. Log and
    // return null so the node runs with no memory block — same
    // graceful-degradation pattern writeTaskGraphResultMemory uses
    // on the write path.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'task_graph_memory_retrieve_failed',
        nodeId: node.id,
        error: msg,
      })}\n`,
    );
    return null;
  }
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
