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
export type DelegationTranscriptBoundary = 'start' | 'end';

export interface DelegationTranscriptEntry {
  role: DelegationTranscriptRole;
  text: string;
  boundary?: DelegationTranscriptBoundary;
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
    // Future producers may include graph edges. Current daemon/web events do
    // not, so the renderer only shows dependencies when they are explicit.
    dependsOn?: string[];
    dependencies?: string[];
  };
}

export type DelegationTranscriptRenderer = (
  event: DelegationEventEnvelope,
) => DelegationTranscriptEntry | null;

type TaskGraphNodeStatus = 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';

interface TaskGraphTranscriptNode {
  taskId: string;
  agent: string;
  status: TaskGraphNodeStatus;
  detail?: string;
  summary?: string;
  error?: string;
  reason?: string;
  elapsedMs?: number;
  dependencies?: string[];
}

interface TaskGraphTerminalState {
  success?: boolean;
  aborted?: boolean;
  summary: string;
  nodeCount: number;
  totalRounds: number;
  wallTimeMs: number;
}

interface TaskGraphTranscriptState {
  executionId: string;
  nodes: Map<string, TaskGraphTranscriptNode>;
  focusTaskId?: string;
  terminal?: TaskGraphTerminalState;
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
        ? `--- subagent started: ${agent} --- ${p.detail}`
        : `--- subagent started: ${agent} ---`;
      return { role: 'status', text, boundary: 'start' };
    }

    case 'subagent.completed': {
      const agent = String(p.agent ?? 'subagent');
      const summary = p.summary ?? '(no summary)';
      return {
        role: 'status',
        text: `--- subagent completed: ${agent} --- ${summary}`,
        boundary: 'end',
      };
    }

    case 'subagent.failed': {
      const agent = String(p.agent ?? 'subagent');
      const error = p.error ?? '(unknown error)';
      return {
        role: 'error',
        text: `--- subagent failed: ${agent} --- ${error}`,
        boundary: 'end',
      };
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

/**
 * Create a transcript-compatible graph renderer for `task_graph.*` events.
 *
 * The stateless mapper above intentionally stays as the small, exact
 * event-to-line fallback. This renderer adds the Step 5 behavior: a compact
 * node-focus view that remembers prior graph events and re-renders the current
 * state as plain transcript text. It does not invent DAG edges; current events
 * do not carry dependencies, so edges appear only if a future producer includes
 * `dependsOn` / `dependencies` in the payload.
 */
export function createDelegationTranscriptRenderer(): DelegationTranscriptRenderer {
  const graphs = new Map<string, TaskGraphTranscriptState>();
  const maxTrackedGraphs = 25;

  function getGraph(executionId: string): TaskGraphTranscriptState {
    let graph = graphs.get(executionId);
    if (!graph) {
      graph = { executionId, nodes: new Map() };
      graphs.set(executionId, graph);
      if (graphs.size > maxTrackedGraphs) {
        const oldest = graphs.keys().next().value;
        if (oldest) graphs.delete(oldest);
      }
    }
    return graph;
  }

  return (event) => {
    if (!isDelegationEvent(event)) return null;
    if (!event.type.startsWith('task_graph.')) {
      return delegationEventToTranscript(event);
    }
    return taskGraphEventToTranscript(event, getGraph);
  };
}

function taskGraphEventToTranscript(
  event: DelegationEventEnvelope,
  getGraph: (executionId: string) => TaskGraphTranscriptState,
): DelegationTranscriptEntry | null {
  const p = event.payload ?? {};
  const executionId = p.executionId ?? '?';
  const graph = getGraph(executionId);

  switch (event.type) {
    case 'task_graph.task_ready': {
      const node = upsertNode(graph, p, 'ready');
      node.detail = p.detail ?? node.detail;
      graph.focusTaskId = node.taskId;
      return renderTaskGraph(graph, 'status');
    }

    case 'task_graph.task_started': {
      const node = upsertNode(graph, p, 'running');
      node.detail = p.detail ?? node.detail;
      graph.focusTaskId = node.taskId;
      return renderTaskGraph(graph, 'status');
    }

    case 'task_graph.task_completed': {
      const node = upsertNode(graph, p, 'completed');
      node.summary = p.summary ?? p.detail ?? '(no summary)';
      node.elapsedMs = p.elapsedMs;
      graph.focusTaskId = node.taskId;
      return renderTaskGraph(graph, 'status');
    }

    case 'task_graph.task_failed': {
      const node = upsertNode(graph, p, 'failed');
      node.error = p.error ?? p.detail ?? '(unknown error)';
      node.elapsedMs = p.elapsedMs;
      graph.focusTaskId = node.taskId;
      return renderTaskGraph(graph, 'error');
    }

    case 'task_graph.task_cancelled': {
      const node = upsertNode(graph, p, 'cancelled');
      node.reason = p.reason ?? p.detail ?? 'Task cancelled';
      node.elapsedMs = p.elapsedMs;
      graph.focusTaskId = node.taskId;
      return renderTaskGraph(graph, 'warning');
    }

    case 'task_graph.graph_completed': {
      graph.terminal = {
        success: p.success,
        aborted: p.aborted,
        summary: p.summary ?? '(no summary)',
        nodeCount: p.nodeCount ?? graph.nodes.size,
        totalRounds: p.totalRounds ?? 0,
        wallTimeMs: p.wallTimeMs ?? 0,
      };
      if (p.aborted) return renderTaskGraph(graph, 'warning');
      if (p.success === false) return renderTaskGraph(graph, 'error');
      return renderTaskGraph(graph, 'status');
    }

    default:
      return null;
  }
}

function upsertNode(
  graph: TaskGraphTranscriptState,
  payload: NonNullable<DelegationEventEnvelope['payload']>,
  status: TaskGraphNodeStatus,
): TaskGraphTranscriptNode {
  const taskId = payload.taskId ?? '?';
  let node = graph.nodes.get(taskId);
  if (!node) {
    node = {
      taskId,
      agent: String(payload.agent ?? 'agent'),
      status,
    };
    graph.nodes.set(taskId, node);
  }
  node.agent = String(payload.agent ?? node.agent ?? 'agent');
  node.status = status;
  const dependencies = getPayloadDependencies(payload);
  if (dependencies.length > 0) {
    node.dependencies = dependencies;
  }
  return node;
}

function getPayloadDependencies(
  payload: NonNullable<DelegationEventEnvelope['payload']>,
): string[] {
  const raw = Array.isArray(payload.dependsOn)
    ? payload.dependsOn
    : Array.isArray(payload.dependencies)
      ? payload.dependencies
      : [];
  return raw.filter((dep): dep is string => typeof dep === 'string' && dep.length > 0);
}

function renderTaskGraph(
  graph: TaskGraphTranscriptState,
  role: DelegationTranscriptRole,
): DelegationTranscriptEntry {
  const lines: string[] = [];
  lines.push(renderTaskGraphHeader(graph));

  const focusNode = graph.focusTaskId ? graph.nodes.get(graph.focusTaskId) : null;
  if (focusNode) {
    lines.push(`focus: ${renderFocusNode(focusNode)}`);
  }

  if (graph.terminal) {
    const outcome = graph.terminal.aborted
      ? 'aborted'
      : graph.terminal.success === false
        ? 'failed'
        : 'completed';
    lines.push(`result: ${outcome} — ${graph.terminal.summary}`);
  }

  for (const node of graph.nodes.values()) {
    lines.push(renderTaskNode(node));
  }

  return { role, text: lines.join('\n') };
}

function renderTaskGraphHeader(graph: TaskGraphTranscriptState): string {
  if (graph.terminal) {
    const outcome = graph.terminal.aborted
      ? 'aborted'
      : graph.terminal.success === false
        ? 'failed'
        : 'completed';
    return `task graph: ${graph.executionId} — ${outcome} — ${formatTerminalStats(graph.terminal)}`;
  }

  const counts = countNodes(graph.nodes);
  return (
    `task graph: ${graph.executionId} — ` +
    `ready ${counts.ready} / running ${counts.running} / ` +
    `done ${counts.completed} / failed ${counts.failed} / cancelled ${counts.cancelled}`
  );
}

function countNodes(nodes: Map<string, TaskGraphTranscriptNode>) {
  const counts: Record<TaskGraphNodeStatus, number> = {
    ready: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const node of nodes.values()) {
    counts[node.status] += 1;
  }
  return counts;
}

function renderFocusNode(node: TaskGraphTranscriptNode): string {
  const note = node.summary ?? node.error ?? node.reason ?? node.detail;
  const suffix = note ? ` — ${note}` : '';
  return `${node.taskId} (${formatNodeAgent(node)}) ${formatNodeStatus(node.status)}${suffix}`;
}

function renderTaskNode(node: TaskGraphTranscriptNode): string {
  const dependencies = node.dependencies?.length ? ` <- ${node.dependencies.join(', ')}` : '';
  const note = node.summary ?? node.error ?? node.reason ?? node.detail;
  const suffix = note ? ` — ${note}` : '';
  return `[${formatNodeStatus(node.status)}] ${node.taskId} (${formatNodeAgent(
    node,
  )})${dependencies}${suffix}`;
}

function formatNodeAgent(node: TaskGraphTranscriptNode): string {
  if (typeof node.elapsedMs === 'number') {
    return `${node.agent}, ${node.elapsedMs}ms`;
  }
  return node.agent;
}

function formatNodeStatus(status: TaskGraphNodeStatus): string {
  return status === 'completed' ? 'done' : status;
}

function formatTerminalStats(terminal: TaskGraphTerminalState): string {
  return `${terminal.nodeCount} nodes / ${terminal.totalRounds} rounds / ${terminal.wallTimeMs}ms`;
}
