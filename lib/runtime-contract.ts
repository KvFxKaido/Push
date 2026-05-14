/**
 * Shared runtime-contract types for agent delegation, task graphs, and
 * typed artifact memory.
 *
 * These are the semantic types that define how Push behaves as an agent
 * runtime, independent of whether the caller is the web app or the CLI.
 */

import type { ReviewResult } from './provider-contract.js';

// ---------------------------------------------------------------------------
// Agent roles
// ---------------------------------------------------------------------------

export type AgentRole = 'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor';

// ---------------------------------------------------------------------------
// Acceptance criteria and delegated-run outcomes
// ---------------------------------------------------------------------------

/** A single machine-checkable criterion a Coder task must pass. */
export interface AcceptanceCriterion {
  id: string;
  check: string;
  exitCode?: number;
  description?: string;
}

/** Status of a delegated run. */
export type DelegationStatus = 'complete' | 'incomplete' | 'inconclusive';

/** A single piece of evidence produced during a delegated run. */
export interface DelegationEvidence {
  kind: 'diff' | 'test' | 'observation';
  label: string;
  detail?: string;
}

/** A verification or acceptance-check result captured during delegation. */
export interface DelegationCheck {
  id: string;
  passed: boolean;
  exitCode?: number;
  output?: string;
}

/** A gate verdict captured during delegation, such as an auditor result. */
export interface DelegationGateVerdict {
  gate: string;
  outcome: 'passed' | 'failed' | 'inconclusive';
  summary: string;
}

/** Structured outcome contract returned by delegated Explorer/Coder runs. */
export interface DelegationOutcome {
  agent: 'coder' | 'explorer';
  status: DelegationStatus;
  summary: string;
  evidence: DelegationEvidence[];
  checks: DelegationCheck[];
  gateVerdicts: DelegationGateVerdict[];
  missingRequirements: string[];
  nextRequiredAction: string | null;
  rounds: number;
  checkpoints: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Task graph — dependency-aware orchestration
// ---------------------------------------------------------------------------

/** A single node in an Orchestrator-emitted task graph. */
export interface TaskGraphNode {
  id: string;
  agent: 'explorer' | 'coder';
  task: string;
  files?: string[];
  dependsOn?: string[];
  deliverable?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  knownContext?: string[];
  constraints?: string[];
}

/** Graph-scoped memory written by a completed task and injected into later tasks. */
export interface TaskGraphMemoryEntry {
  namespace: string;
  agent: 'explorer' | 'coder';
  status: DelegationStatus;
  summary: string;
  checks?: Array<{ id: string; passed: boolean }>;
  evidenceLabels?: string[];
  nextRequiredAction?: string | null;
}

/** Runtime status for a task-graph node. */
export type TaskGraphNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Runtime state for a task-graph node during execution. */
export interface TaskGraphNodeState {
  node: TaskGraphNode;
  status: TaskGraphNodeStatus;
  result?: string;
  error?: string;
  delegationOutcome?: DelegationOutcome;
  memoryEntry?: TaskGraphMemoryEntry;
  elapsedMs?: number;
}

/** The Orchestrator's task-graph tool arguments. */
export interface TaskGraphArgs {
  tasks: TaskGraphNode[];
}

/** Progress event emitted during task-graph execution. */
export interface TaskGraphProgressEvent {
  type:
    | 'task_ready'
    | 'task_started'
    | 'task_completed'
    | 'task_failed'
    | 'task_cancelled'
    | 'graph_complete';
  taskId?: string;
  detail?: string;
  elapsedMs?: number;
}

/** Final result of a task-graph execution. */
export interface TaskGraphResult {
  success: boolean;
  aborted: boolean;
  memoryEntries: Map<string, TaskGraphMemoryEntry>;
  nodeStates: Map<string, TaskGraphNodeState>;
  summary: string;
  wallTimeMs: number;
  totalRounds: number;
}

// ---------------------------------------------------------------------------
// Context memory — typed, scoped artifact memory
// ---------------------------------------------------------------------------

export type MemoryRecordKind =
  | 'fact'
  | 'finding'
  | 'decision'
  | 'task_outcome'
  | 'verification_result'
  | 'file_change'
  | 'symbol_trace'
  | 'dependency_trace';

export type MemoryFreshness = 'fresh' | 'stale' | 'expired';

export interface MemoryScope {
  repoFullName: string;
  branch?: string;
  chatId?: string;
  role?: 'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor' | 'planner';
  taskGraphId?: string;
  taskId?: string;
  runId?: string;
}

export interface MemorySource {
  kind: 'explorer' | 'coder' | 'task_graph' | 'review' | 'audit' | 'orchestrator';
  label: string;
  createdAt: number;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryRecordKind;
  summary: string;
  detail?: string;
  scope: MemoryScope;
  source: MemorySource;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  tags?: string[];
  freshness: MemoryFreshness;
  derivedFrom?: string[];
  invalidatedAt?: number;
  invalidationReason?: string;
}

export interface MemoryQuery {
  repoFullName: string;
  branch?: string;
  chatId?: string;
  role: AgentRole;
  taskText: string;
  fileHints?: string[];
  symbolHints?: string[];
  taskGraphId?: string;
  taskId?: string;
  maxRecords: number;
  includeStale?: boolean;
}

export interface MemoryScoreBreakdown {
  branch: number;
  taskLineage: number;
  taskText: number;
  fileOverlap: number;
  symbolOverlap: number;
  roleFamily: number;
  recency: number;
  freshness: number;
  total: number;
}

export interface ScoredMemoryRecord {
  record: MemoryRecord;
  score: number;
  breakdown: MemoryScoreBreakdown;
}

export interface MemoryRetrievalResult {
  records: ScoredMemoryRecord[];
  candidateCount: number;
  expiredExcluded: number;
  staleDropped: number;
}

// ---------------------------------------------------------------------------
// Run events and loop phases — canonical runtime vocabulary
// ---------------------------------------------------------------------------

/** Active loop phases that can be checkpointed or resumed mid-run. */
export type LoopPhase =
  | 'streaming_llm'
  | 'executing_tools'
  | 'delegating_coder'
  | 'delegating_explorer'
  | 'executing_task_graph';

/** Subagent labels used in run-event streams and delegation lifecycle updates. */
export type RunEventSubagent =
  | 'planner'
  | 'coder'
  | 'explorer'
  | 'reviewer'
  | 'auditor'
  | 'task_graph';

export type RunEventInput =
  | {
      type: 'assistant.turn_start';
      round: number;
    }
  | {
      type: 'assistant.turn_end';
      round: number;
      outcome: 'completed' | 'continued' | 'error' | 'aborted' | 'steered';
    }
  | {
      // Per-turn system-prompt composition snapshot. Emitted once at the
      // start of each LLM call so a debug surface can answer "what
      // exactly went to the model on turn N?" without re-running. Carries
      // section hashes and sizes — not the section content itself — so
      // the event is cheap to persist and safe to log even when sections
      // include sensitive context (project instructions, scratchpad).
      // Producers: orchestrator + role agents that build a system prompt.
      type: 'assistant.prompt_snapshot';
      round: number;
      role: AgentRole;
      totalChars: number;
      sections: Record<string, { hash: number; size: number; volatile: boolean }>;
    }
  | {
      type: 'tool.execution_start';
      round: number;
      executionId: string;
      toolName: string;
      toolSource: string;
    }
  | {
      type: 'tool.execution_complete';
      round: number;
      executionId: string;
      toolName: string;
      toolSource: string;
      durationMs: number;
      isError: boolean;
      preview: string;
    }
  | {
      type: 'tool.call_malformed';
      round: number;
      reason: string;
      toolName?: string;
      preview: string;
    }
  | {
      type: 'subagent.started';
      executionId: string;
      agent: RunEventSubagent;
      detail?: string;
    }
  | {
      type: 'subagent.completed';
      executionId: string;
      agent: RunEventSubagent;
      summary: string;
      /** Structured delegation outcome — present for coder/explorer delegations. */
      delegationOutcome?: DelegationOutcome;
      /** Advisory review payload — present for reviewer delegations. */
      reviewResult?: ReviewResult;
    }
  | {
      type: 'subagent.failed';
      executionId: string;
      agent: RunEventSubagent;
      error: string;
    }
  | {
      // Background AgentJob lifecycle — emitted by the AgentJob DO over its
      // SSE stream. Distinct from `subagent.*`, which is emitted by the
      // foreground delegation runtime in the browser tab. The two coexist
      // because they describe runs at different layers: `subagent.*` is a
      // delegated child run inside a parent agent's loop; `job.*` is a
      // server-owned run that survives client disconnect. Carries `role`
      // (not `agent`) to keep the event vocabulary role-aware as more
      // roles get migrated to AgentJob.
      type: 'job.started';
      executionId: string;
      role: AgentRole;
      detail?: string;
    }
  | {
      type: 'job.completed';
      executionId: string;
      role: AgentRole;
      summary: string;
      /** Structured delegation outcome — present for coder/explorer jobs
       * driven by a delegation envelope. Absent for future role
       * variants that aren't shaped as delegations. */
      delegationOutcome?: DelegationOutcome;
    }
  | {
      type: 'job.failed';
      executionId: string;
      role: AgentRole;
      error: string;
    }
  | {
      type: 'task_graph.task_ready';
      executionId: string;
      taskId: string;
      agent: 'explorer' | 'coder';
      detail?: string;
    }
  | {
      type: 'task_graph.task_started';
      executionId: string;
      taskId: string;
      agent: 'explorer' | 'coder';
      detail?: string;
    }
  | {
      type: 'task_graph.task_completed';
      executionId: string;
      taskId: string;
      agent: 'explorer' | 'coder';
      summary: string;
      elapsedMs?: number;
    }
  | {
      type: 'task_graph.task_failed';
      executionId: string;
      taskId: string;
      agent: 'explorer' | 'coder';
      error: string;
      elapsedMs?: number;
    }
  | {
      type: 'task_graph.task_cancelled';
      executionId: string;
      taskId: string;
      agent: 'explorer' | 'coder';
      reason: string;
      elapsedMs?: number;
    }
  | {
      type: 'task_graph.graph_completed';
      executionId: string;
      summary: string;
      success: boolean;
      aborted: boolean;
      nodeCount: number;
      totalRounds: number;
      wallTimeMs: number;
    }
  | {
      type: 'user.follow_up_queued';
      round: number;
      position: number;
      preview: string;
    }
  | {
      type: 'user.follow_up_steered';
      round: number;
      preview: string;
      replacedPending: boolean;
    };

export type RunEvent = RunEventInput & {
  id: string;
  timestamp: number;
};
