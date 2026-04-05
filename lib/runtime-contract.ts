/**
 * Shared runtime-contract types for agent delegation, task graphs, and
 * typed artifact memory.
 *
 * These are the semantic types that define how Push behaves as an agent
 * runtime, independent of whether the caller is the web app or the CLI.
 */

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
export type TaskGraphNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  type: 'task_ready' | 'task_started' | 'task_completed' | 'task_failed' | 'task_cancelled' | 'graph_complete';
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
  role: 'orchestrator' | 'explorer' | 'coder' | 'reviewer' | 'auditor';
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
