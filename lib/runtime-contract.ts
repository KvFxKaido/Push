/**
 * Shared runtime-contract types for agent delegation, task graphs, and
 * typed artifact memory.
 *
 * These are the semantic types that define how Push behaves as an agent
 * runtime, independent of whether the caller is the web app or the CLI.
 */

import type { EditDiff } from './edit-diff.js';
// Type-only, and deliberately circular: `tool-cards.ts` imports the delegation
// types from here (a delegation-result card renders a DelegationStatus), and the
// run event here carries a card. The render vocabulary and the runtime protocol
// genuinely reference each other. `import type` is erased at build time, so no
// runtime cycle is emitted.
import type { ToolCard } from './tool-cards.js';
import type { ReviewResult } from './provider-contract.js';
import type { PromptSnapshot } from './system-prompt-builder.js';

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
  /**
   * Short rationale for why this node advances the user's goal. Free-form
   * but expected to reference a specific section of `goal.md` (or its
   * runtime-derived equivalent) — e.g. "Initial ask", "Current working
   * goal", or one of the named Constraints. Optional in the type so
   * pre-goal-aware emitters keep validating; `validateTaskGraphAgainstGoal`
   * (in `task-graph.ts`) promotes this to a hard requirement whenever a
   * `[USER_GOAL]` anchor is loaded for the conversation.
   */
  addresses?: string;
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

/**
 * Canonical list of memory record kinds — the single source of truth. The
 * `MemoryRecordKind` type derives from it, and runtime consumers that need to
 * validate model-supplied kinds (e.g. `lib/memory-tool-exec.ts`) iterate it
 * rather than re-hardcoding the literals.
 */
export const MEMORY_RECORD_KINDS = [
  'fact',
  'finding',
  'decision',
  'task_outcome',
  'verification_result',
  'file_change',
  'symbol_trace',
  'dependency_trace',
] as const;

export type MemoryRecordKind = (typeof MEMORY_RECORD_KINDS)[number];

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
  /**
   * Optional pointer into the append-only verbatim log (`lib/verbatim-log.ts`)
   * holding this record's full, untruncated source text. Set on write when
   * `detail` exceeds the typed-store cap, so `memory_expand` can return the true
   * original (LCM Phase 3) rather than the lossy 800/2000-char `detail`. Absent
   * when the record's `detail` already fits losslessly or no verbatim log is
   * configured — the record stays fully self-describing without it.
   */
  verbatimRef?: string;
  /**
   * Dense semantic embedding of the record's searchable text, computed
   * best-effort at write time when an EmbeddingProvider is configured (see
   * `lib/embedding-provider.ts`). Absent when no provider is available — the
   * scorer falls back to pure lexical overlap, so this is purely additive.
   */
  embedding?: number[];
  /**
   * Identifier of the model that produced `embedding`. Cosine similarity is
   * only meaningful between vectors from the same model, so retrieval skips
   * the semantic signal when this does not match the query embedding's model.
   */
  embeddingModel?: string;
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
  /**
   * Dense embedding of `taskText`, computed once before retrieval when an
   * EmbeddingProvider is configured. When present, the scorer blends cosine
   * similarity against each record's `embedding` into the score. Absent ⇒
   * retrieval is pure lexical (the prior behavior).
   */
  queryEmbedding?: number[];
  /** Model that produced `queryEmbedding`; gates same-model cosine. */
  queryEmbeddingModel?: string;
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
  /**
   * Semantic similarity contribution (cosine between the query embedding and
   * the record embedding, thresholded and scaled). Zero when either vector is
   * missing or the models differ, which makes retrieval degrade cleanly to the
   * lexical signals above.
   */
  semantic: number;
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
  // Deep Reviewer — the multi-round investigation reviewer. Runs under the
  // reviewer role but tagged distinctly in events so clients can tell a deep
  // review from a single-shot one (CLI delegate_deep_reviewer).
  | 'deep_reviewer'
  | 'auditor'
  | 'task_graph';

// ---------------------------------------------------------------------------
// Live workspace / sandbox state (snapshot + delta)
// ---------------------------------------------------------------------------
//
// The authoritative view of *mutable session state that follows sandbox HEAD*
// — active branch, HEAD, dirty working tree, tracking position, and the
// guards (Protect Main, sandbox readiness) that gate delivery. Both surfaces
// reconstruct this today from `BranchSwitchPayload` moments plus ad hoc HEAD
// polling; these events make it a single diffable timeline instead.
//
// This is deliberately NOT the same vocabulary as `session_state_changed`,
// which carries *settings / session config* (provider, model, role routing).
// The split is load-bearing: config state and live workspace state change on
// different clocks and have different consumers. Keep them separate — see
// `docs/decisions/Workspace State Events — Snapshot + Delta.md`.

export type WorkspaceDirtyStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface WorkspaceDirtyFile {
  path: string;
  status: WorkspaceDirtyStatus;
}

export interface WorkspaceState {
  activeBranch: string;
  headSha: string;
  /** Tracking position vs upstream; omitted when there is no upstream. */
  ahead?: number;
  behind?: number;
  /** Uncommitted working-tree entries. */
  dirtyFiles: WorkspaceDirtyFile[];
  protectMain: boolean;
  sandboxReady: boolean;
}

/**
 * Closed op-set for `workspace.state_delta`. No JSON Pointer — every op names
 * a known field of `WorkspaceState`, so the wire is fully strict-validatable
 * (unlike raw RFC-6902). Ops apply in array order. `dirty_add` upserts by
 * `path`; `dirty_clear` empties the list (e.g. after a commit).
 */
export type WorkspaceStateDeltaOp =
  | { op: 'set_branch'; activeBranch: string; headSha: string }
  | { op: 'set_head'; headSha: string }
  | { op: 'set_tracking'; ahead?: number; behind?: number }
  | { op: 'dirty_add'; file: WorkspaceDirtyFile }
  | { op: 'dirty_remove'; path: string }
  | { op: 'dirty_clear' }
  | { op: 'set_protect_main'; protectMain: boolean }
  | { op: 'set_sandbox_ready'; sandboxReady: boolean };

export type RunEventInput =
  | {
      // Pre-loop routing decision emitted for route decisions we need to bake
      // and compare. This makes route changes visible in the same structured
      // event stream as tool and lifecycle events, without relying on ad hoc
      // browser console logs.
      type: 'turn.route';
      route: 'orchestrator' | 'inline-delegation' | 'background-mode';
      // `conversational_downgrade` and `conversational_escape_hatch` are
      // legacy: never emitted by current code, but kept in the union so
      // persisted/replayed events from older clients read back and validate.
      // Current emitters use only `conversational_inline`.
      reason: 'conversational_inline' | 'conversational_escape_hatch' | 'conversational_downgrade';
      suppressedRoute?: 'inline-delegation' | 'background-mode';
      intent: 'conversational' | 'task';
      repoBranchReady: boolean;
    }
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
      /**
       * User-visible prose prefix from a round that proceeds to tool
       * execution. Render-only: it is never appended to the model message
       * list. Emitted once per tool round before that round's first tool event.
       */
      type: 'assistant.tool_prose';
      round: number;
      text: string;
    }
  | {
      // Terminal lifecycle receipt for a foreground turn. Unlike
      // `assistant.turn_end`, this fires only after run cleanup completes and
      // no queued follow-up will immediately begin another turn.
      type: 'turn.quiesced';
      runId: string;
      outcome: 'completed' | 'aborted' | 'failed';
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
      sections: PromptSnapshot;
    }
  | {
      // Per-turn context-compaction event. Emitted when the message
      // history is rewritten to fit a token budget — summarization of
      // verbose tool results, digest-grouping of older messages, or
      // hard-trimming. Before this event existed, compaction was a
      // silent operation: the model saw a context different from what
      // appeared on previous turns and could not tell why. Carries
      // token counts before/after and a `cause` for summarization
      // calls. `messagesDropped` is the count of messages collapsed
      // into a digest (zero for summarization-only passes that rewrite
      // in place).
      type: 'context.compaction';
      round: number;
      phase: 'summarization' | 'digest_drop' | 'hard_trim';
      beforeTokens: number;
      afterTokens: number;
      messagesDropped: number;
      provider?: string;
      cause?: 'tool_output' | 'long_message' | 'mixed';
    }
  | {
      // CLI eval-harness round-budget adaptation. Emitted only when the
      // effective max-round cap changes, so measurement scripts can count real
      // shrink/growth decisions instead of inferring them from final outcomes.
      type: 'harness.adaptation';
      round: number;
      fromMaxRounds: number;
      toMaxRounds: number;
      reasons: string[];
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
      /** Compact target label: path, command, query, or task summary when available. */
      target?: string;
      /** Workspace git branch stamped after sandbox_exec; omitted when unavailable. */
      branch?: string;
      /** Structured line diff for file-mutation tools (`edit_file` /
       *  `write_file`). Bounded by lib/edit-diff.ts caps; rendered by the
       *  TUI as a line-numbered edit card. Omitted for non-mutation tools,
       *  no-op edits, and oversized files. */
      diff?: EditDiff;
      /**
       * Typed render payload for this tool result — what the USER sees.
       *
       * NEVER sent to the model: the model reads the tool's `text`, the shells
       * render this. Both the web `CardRenderer` and the TUI dispatch on
       * `card.type`, so neither has to infer presentation from the model-facing
       * output — which is how the TUI ended up regex-sniffing for diffs.
       *
       * `diff` above is the same idea, predating this field and specialised to
       * one tool; it stays until the edit card folds into the union.
       *
       * See `docs/decisions/Tool Render Payload — Cards Are Declared, Not Sniffed.md`.
       */
      card?: ToolCard;
    }
  | {
      type: 'branch_desync';
      expected: string;
      actual: string;
      command: string;
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
      /**
       * UTF-8 byte length of the compact tool-result payload that lands in
       * the Orchestrator's message list (`toolExecResult.text`). Computed
       * via `utf8ByteLength` so the number matches what providers and
       * transports actually count, not JS string length. Set only by
       * foreground delegation emitters that produce orchestrator-visible
       * payloads (coder / explorer / task_graph terminal events); omitted
       * for nested subagents whose output stays inside the parent loop
       * (planner inside coder, auditor inside coder/graph) and for daemon
       * emitters that route through a different transport.
       *
       * This is the inner payload size — `buildToolResultMessage` later
       * wraps the text in a `[Tool Result — <tool>] / [/Tool Result]`
       * envelope (and possibly a `[meta]` line), adding a small fixed
       * overhead that consumers should account for if they need final
       * message-list bytes.
       */
      orchestratorBytes?: number;
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
    }
  | {
      // Full authoritative snapshot of live workspace state. Emitted on
      // sandbox (re)start, on chat resume/reconnect, and as the resync anchor
      // after a delta gap. `rev` is monotonic *within a `workspaceId`* — a new
      // `workspaceId` (sandbox restart, different repo) starts a fresh timeline
      // at rev 0. Snapshots are always ground truth: a consumer adopts them
      // unconditionally.
      type: 'workspace.state_snapshot';
      workspaceId: string;
      rev: number;
      state: WorkspaceState;
    }
  | {
      // Patch against the snapshot at (`workspaceId`, `baseRev`). `rev` =
      // `baseRev + 1`. A delta applies ONLY when both the consumer's current
      // `workspaceId` matches AND its last-applied rev === `baseRev`; on any
      // mismatch the consumer drops the delta and waits for the next snapshot.
      // Deltas are a disposable bandwidth optimization for the hot path
      // (dirty-file churn during editing), never the source of truth.
      type: 'workspace.state_delta';
      workspaceId: string;
      rev: number;
      baseRev: number;
      ops: WorkspaceStateDeltaOp[];
    };

export type RunEvent = RunEventInput & {
  id: string;
  timestamp: number;
};
