import type { RepoAppearance } from '@/lib/repo-appearance';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type {
  AcceptanceCriterion,
  AgentRole,
  DelegationGateVerdict,
  DelegationOutcome,
  DelegationStatus,
  LoopPhase,
  RunEvent,
} from '@push/lib/runtime-contract';
export type {
  AcceptanceCriterion,
  AgentRole,
  DelegationCheck,
  DelegationEvidence,
  DelegationGateVerdict,
  DelegationOutcome,
  DelegationStatus,
  LoopPhase,
  MemoryFreshness,
  MemoryQuery,
  MemoryRecord,
  MemoryRecordKind,
  MemoryRetrievalResult,
  MemoryScope,
  MemoryScoreBreakdown,
  MemorySource,
  RunEvent,
  RunEventInput,
  RunEventSubagent,
  ScoredMemoryRecord,
  TaskGraphArgs,
  TaskGraphMemoryEntry,
  TaskGraphNode,
  TaskGraphNodeState,
  TaskGraphNodeStatus,
  TaskGraphProgressEvent,
  TaskGraphResult,
} from '@push/lib/runtime-contract';
import type { AIProviderType } from '@push/lib/provider-contract';
export type {
  AIProviderType,
  PreCompactEvent,
  ReviewComment,
  ReviewResult,
} from '@push/lib/provider-contract';
import type { AuditVerdictCardData } from '@push/lib/auditor-agent';
export type { AuditVerdictCardData } from '@push/lib/auditor-agent';

// User profile — canonical shape lives in lib/user-identity.ts; re-exported
// here so existing Web call sites using `@/types` don't have to churn.
import type { UserProfile } from '@push/lib/user-identity';
export type { UserProfile } from '@push/lib/user-identity';

export type WorkspaceMode = 'repo' | 'scratch' | 'chat';

/**
 * Workspace session identity for the active repo or scratch workspace.
 * `id` is a stable logical identity that survives sandbox restarts.
 * `sandboxId` is the runtime container id (null until the container starts).
 */
export type WorkspaceSession =
  | { id: string; kind: 'scratch'; sandboxId: string | null }
  | { id: string; kind: 'repo'; repo: ActiveRepo; sandboxId: string | null }
  | { id: string; kind: 'chat'; sandboxId: null };

/** Structured workspace context passed through the streaming pipeline to toLLMMessages. */
export interface WorkspaceContext {
  /** Workspace description text injected into the system prompt */
  description: string;
  /** Whether to include GitHub tool protocol (false for scratch workspaces) */
  includeGitHubTools: boolean;
  /** Logical workspace mode for runtime/session prompt blocks. */
  mode: WorkspaceMode;
  /** Session-level verification policy — injected into the system prompt when present. */
  verificationPolicy?: VerificationPolicy;
}

export interface WorkspaceCapabilities {
  canManageBranches: boolean;
  canBrowsePullRequests: boolean;
  canCommitAndPush: boolean;
}

export interface WorkspaceScratchActions {
  statusText: string;
  tone: 'default' | 'stale';
  canSaveSnapshot: boolean;
  canRestoreSnapshot: boolean;
  canDownloadWorkspace: boolean;
  snapshotSaving: boolean;
  snapshotRestoring: boolean;
  downloadingWorkspace: boolean;
  onSaveSnapshot: () => void;
  onRestoreSnapshot: () => void;
  onDownloadWorkspace: () => void;
}

export interface QuickPrompt {
  label: string;
  expandedPrompt?: string;
  suggestedAskUserPath?: AskUserCardData;
}

export interface ChatSendOptions {
  displayText?: string;
  streamingBehavior?: 'queue' | 'steer';
}

export const USER_PROFILE_DEFAULTS: UserProfile = {
  displayName: '',
  githubLogin: undefined,
  bio: '',
};

// ---------------------------------------------------------------------------
// Reviewer agent types (ReviewComment / ReviewResult are re-exported from
// @push/lib/provider-contract above)
// ---------------------------------------------------------------------------

export type ReviewDepth = 'quick' | 'deep';

/** Runtime callbacks for the Deep Reviewer agent loop. */
export interface DeepReviewCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
}

export type ModelCapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface ModelCapabilities {
  visionInput: ModelCapabilitySupport;
  imageGeneration: ModelCapabilitySupport;
  toolCalls: ModelCapabilitySupport;
  jsonMode: ModelCapabilitySupport;
  streaming: ModelCapabilitySupport;
}

// ---------------------------------------------------------------------------
// Harness profile — model-dependent scaffolding tiers
// ---------------------------------------------------------------------------

/**
 * Harness profile tier: controls how much scaffolding the harness applies
 * around agent runs (context resets, planner, evaluation, round caps).
 *
 * - 'standard': Opus-class / large models — compaction only, planner optional,
 *   full round budget, evaluation at end only.
 * - 'heavy': Sonnet-class / smaller models — context resets between phases,
 *   planner enforced, tighter round caps, evaluation after every phase.
 */
export type HarnessProfile = 'standard' | 'heavy';

/** Concrete settings derived from a HarnessProfile tier. */
export interface HarnessProfileSettings {
  profile: HarnessProfile;
  /** Max rounds for a single Coder delegation. */
  maxCoderRounds: number;
  /** Whether the planner pre-pass is required before Coder delegation. */
  plannerRequired: boolean;
  /** Whether context resets are enabled between Coder phases. */
  contextResetsEnabled: boolean;
  /** Whether the Auditor evaluation runs after every Coder delegation. */
  evaluateAfterCoder: boolean;
}

export interface AIModel {
  id: string;
  name: string;
  provider: AIProviderType;
  role?: AgentRole;
  context?: number;
  capabilities: ModelCapabilities;
}

export interface AIProviderConfig {
  type: AIProviderType;
  name: string;
  description: string;
  models: AIModel[];
  envKey: string;
  envUrl?: string;
}

// Phase 1 — Repo Awareness

export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  description: string | null;
  open_issues_count: number;
  pushed_at: string;
  default_branch: string;
  language: string | null;
  avatar_url: string;
}

export interface RepoActivity {
  open_prs: number;
  recent_commits: number;
  has_new_activity: boolean;
  last_synced: string | null;
}

export interface RepoWithActivity extends RepoSummary {
  activity: RepoActivity;
}

// Chat types

export interface AttachmentData {
  id: string;
  type: 'image' | 'code' | 'document';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: string; // base64 data URL for images, text for code/docs
  thumbnail?: string; // small preview for images
}

/** Provenance metadata attached to tool result messages for audit trail. */
export interface ToolMeta {
  /** The tool that was executed (e.g. 'sandbox_write_file', 'delegate_coder'). */
  toolName: string;
  /** Tool dispatch source ('github' | 'sandbox' | 'delegate' | 'scratchpad' | 'web-search'). */
  source: string;
  /** Provider locked to the conversation when the tool was executed. */
  provider?: AIProviderType;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
  /** Whether the tool returned an error. */
  isError?: boolean;
  /** Who/what triggered the execution: 'assistant' (model emitted tool call) | 'system' (auto-action like CI fetch). */
  triggeredBy: 'assistant' | 'system';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string;
  timestamp: number;
  status?: 'sending' | 'streaming' | 'done' | 'error';
  thinking?: string;
  cards?: ChatCard[];
  attachments?: AttachmentData[]; // User-attached files
  isToolCall?: boolean; // Assistant message that requested a tool
  isToolResult?: boolean; // Synthetic user message carrying tool data
  isMalformed?: boolean; // Assistant message that attempted a tool call but produced invalid JSON
  /** Provenance metadata — present on tool result messages for audit trail. */
  toolMeta?: ToolMeta;
}

// Discriminated union for rich inline cards
export type ChatCard =
  | { type: 'pr'; data: PRCardData }
  | { type: 'pr-list'; data: PRListCardData }
  | { type: 'commit-list'; data: CommitListCardData }
  | { type: 'file'; data: FileCardData }
  | { type: 'branch-list'; data: BranchListCardData }
  | { type: 'file-list'; data: FileListCardData }
  | { type: 'sandbox'; data: SandboxCardData }
  | { type: 'sandbox-state'; data: SandboxStateCardData }
  | { type: 'diff-preview'; data: DiffPreviewCardData }
  | { type: 'audit-verdict'; data: AuditVerdictCardData }
  | { type: 'commit-review'; data: CommitReviewCardData }
  | { type: 'ci-status'; data: CIStatusCardData }
  | { type: 'editor'; data: EditorCardData }
  | { type: 'file-search'; data: FileSearchCardData }
  | { type: 'commit-files'; data: CommitFilesCardData }
  | { type: 'test-results'; data: TestResultsCardData }
  | { type: 'type-check'; data: TypeCheckCardData }
  | { type: 'sandbox-download'; data: SandboxDownloadCardData }
  | { type: 'workflow-runs'; data: WorkflowRunsCardData }
  | { type: 'workflow-logs'; data: WorkflowLogsCardData }
  | { type: 'web-search'; data: WebSearchCardData }
  | { type: 'delegation-result'; data: DelegationResultCardData }
  | { type: 'ask-user'; data: AskUserCardData }
  | { type: 'coder-progress'; data: CoderWorkingMemory };

// --- Coder working memory ---

export interface CoderObservation {
  /** Agent-assigned stable identifier, e.g. "adapter-pattern". */
  id: string;
  /** The conclusion being tracked. */
  text: string;
  /** File-level dependencies used for harness-driven invalidation. */
  dependsOn?: string[];
  /** Set by the harness when dependencies are mutated. */
  stale?: boolean;
  /** Human-readable invalidation reason, set by the harness. */
  staleReason?: string;
  /** Round when the observation was first added. */
  addedAtRound?: number;
  /** Round when the observation became stale — used for 5-round auto-expiry. */
  staleAtRound?: number;
}

/** Agent-internal working memory for the Coder. Resets per task. */
export interface CoderWorkingMemory {
  plan?: string;
  openTasks?: string[];
  filesTouched?: string[];
  assumptions?: string[];
  errorsEncountered?: string[];
  /** Current phase the Coder is working on (optional retroactive progress tracking) */
  currentPhase?: string;
  /** List of phases that have been completed (optional retroactive progress tracking) */
  completedPhases?: string[];
  observations?: CoderObservation[];
}

// --- Acceptance criteria for Coder delegation ---

/** Result of running one acceptance criterion. */
export interface CriterionResult {
  id: string;
  passed: boolean;
  exitCode: number;
  output: string;
}

export interface ToolMutationSpan {
  kind: 'hashline' | 'full_write';
  startLine?: number;
  endLine?: number;
  lineNumbers?: number[];
  refs?: string[];
  ops?: string[];
}

export interface ToolMutationFilePostcondition {
  path: string;
  mutation: 'edit' | 'write' | 'patchset';
  bytesWritten?: number;
  versionBefore?: string | null;
  versionAfter?: string | null;
  changedSpans?: ToolMutationSpan[];
}

export interface ToolMutationDiagnostic {
  scope: 'single-file' | 'project';
  label: string;
  path?: string;
  status: 'clean' | 'issues' | 'skipped';
  output?: string;
}

export interface ToolMutationCheckResult {
  command: string;
  passed: boolean;
  exitCode: number;
  output?: string;
}

export interface ToolMutationPostconditions {
  touchedFiles: ToolMutationFilePostcondition[];
  diagnostics?: ToolMutationDiagnostic[];
  checks?: ToolMutationCheckResult[];
  guardWarnings?: string[];
  writeVerified?: boolean;
  rollbackApplied?: boolean;
}

// --- Tool result meta envelope ---

/** Lightweight metadata prepended to every tool result text. */
export interface ToolResultMeta {
  /** Current round number in the tool loop. */
  round: number;
  /** Estimated context size in KB. */
  contextKb: number;
  /** Context budget cap in KB. */
  contextCapKb: number;
  /** Whether the sandbox working tree has uncommitted changes (cached per round). */
  gitDirty?: boolean;
  /** Number of modified files in sandbox (cached per round). */
  modifiedFiles?: number;
}

// --- Error taxonomy for structured tool errors ---

/** Canonical error types for all tool failures. */
export type ToolErrorType =
  | 'FILE_NOT_FOUND'
  | 'EXEC_TIMEOUT'
  | 'EXEC_NON_ZERO_EXIT'
  | 'SANDBOX_UNREACHABLE'
  | 'WORKSPACE_CHANGED'
  | 'EDIT_HASH_MISMATCH'
  | 'EDIT_CONTENT_NOT_FOUND'
  | 'AUTH_FAILURE'
  | 'RATE_LIMITED'
  | 'STALE_FILE'
  | 'EDIT_GUARD_BLOCKED'
  | 'GIT_GUARD_BLOCKED'
  | 'APPROVAL_GATE_BLOCKED'
  | 'WRITE_FAILED'
  | 'UNKNOWN';

/** Structured error attached to tool results when something goes wrong. */
export interface StructuredToolError {
  type: ToolErrorType;
  retryable: boolean;
  message: string;
  detail?: string;
}

// Tool execution returns text for the LLM + optional structured card for UI
export interface ToolExecutionResult {
  text: string;
  card?: ChatCard;
  /** Structured error metadata — present when the tool failed. */
  structuredError?: StructuredToolError;
  /** Structured write/mutation summary for ambient runtime awareness. */
  postconditions?: ToolMutationPostconditions;
  promotion?: {
    repo: ActiveRepo;
    pushed: boolean;
    warning?: string;
    htmlUrl?: string;
  };
  /** When set, the sandbox has switched to this branch (e.g. draft checkout).
   *  The app should sync its active branch state without tearing down the sandbox. */
  branchSwitch?: string;
  /** Structured delegation outcome — present when this result came from a delegated agent. */
  delegationOutcome?: DelegationOutcome;
  /** Post-hook policy action: inject this message after the tool result. */
  postHookInject?: ChatMessage;
  /** Post-hook policy action: halt the agent loop with this summary. */
  postHookHalt?: string;
}

export interface PRReviewComment {
  author: string;
  path?: string;
  line?: number;
  body: string;
}

export interface PRIssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface PRCardData {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  additions: number;
  deletions: number;
  changedFiles: number;
  branch: string;
  baseBranch: string;
  createdAt: string;
  description?: string;
  files?: { filename: string; status: string; additions: number; deletions: number }[];
  reviewComments?: PRReviewComment[];
  issueComments?: PRIssueComment[];
}

export interface PRListCardData {
  repo: string;
  state: string;
  prs: {
    number: number;
    title: string;
    author: string;
    additions?: number;
    deletions?: number;
    createdAt: string;
  }[];
}

export interface CommitListCardData {
  repo: string;
  commits: { sha: string; message: string; author: string; date: string }[];
}

export interface FileCardData {
  repo: string;
  path: string;
  content: string;
  language: string;
  truncated: boolean;
}

export interface BranchListCardData {
  repo: string;
  defaultBranch: string;
  branches: { name: string; isDefault: boolean; isProtected: boolean }[];
}

export interface FileListCardData {
  repo?: string;
  path: string;
  entries: { name: string; type: 'file' | 'directory'; size?: number }[];
}

export interface EditorCardData {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  /** SHA-256 version at read time (used for stale write detection) */
  version?: string;
  /** Monotonic workspace revision at read time (used for workspace-level stale detection) */
  workspaceRevision?: number;
  /** 'github' = read-only, 'sandbox' = editable with save */
  source: 'github' | 'sandbox';
  repo?: string;
  sandboxId?: string;
}

// Phase 3 — Sandbox + Code Execution

export interface SandboxCardData {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs?: number;
}

export interface SandboxStateCardData {
  sandboxId: string;
  repoPath: string;
  branch: string;
  statusLine?: string;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  preview: string[];
  fetchedAt: string;
}

export interface NewChatWorkspaceState {
  mode: 'repo' | 'scratch';
  sandboxId: string;
  branch: string;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  preview: string[];
  fetchedAt: string;
}

export interface SandboxDownloadCardData {
  path: string;
  format: string;
  sizeBytes: number;
  archiveBase64: string;
}

export interface DiffPreviewCardData {
  diff: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

// Phase 4 — User Confirmation + CI Status

export interface CommitReviewCardData {
  diff: DiffPreviewCardData;
  auditVerdict: AuditVerdictCardData;
  commitMessage: string;
  status: 'pending' | 'refreshing' | 'approved' | 'rejected' | 'committed' | 'pushing' | 'error';
  error?: string;
}

export interface CICheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  detailsUrl?: string;
}

export type CIOverallStatus = 'pending' | 'success' | 'failure' | 'neutral' | 'no-checks';

export interface CIStatus {
  overall: CIOverallStatus;
  repo: string;
  ref: string;
  fetchedAt: string;
  checks: CICheck[];
}

export interface CIStatusCardData extends CIStatus {
  type: 'ci-status';
}

export type CardAction =
  | { type: 'commit-approve'; messageId: string; cardIndex: number; commitMessage: string }
  | { type: 'commit-refresh'; messageId: string; cardIndex: number; commitMessage: string }
  | { type: 'commit-reject'; messageId: string; cardIndex: number }
  | { type: 'ci-refresh'; messageId: string; cardIndex: number }
  | { type: 'sandbox-state-refresh'; messageId: string; cardIndex: number; sandboxId: string }
  | {
      type: 'ask-user-submit';
      messageId: string;
      cardIndex: number;
      responseText: string;
      selectedOptionIds: string[];
    }
  | {
      type: 'editor-save';
      messageId: string;
      cardIndex: number;
      path: string;
      content: string;
      sandboxId: string;
      expectedVersion?: string;
      expectedWorkspaceRevision?: number;
    };

export interface AgentStatus {
  active: boolean;
  phase: string;
  detail?: string;
}

export type AgentStatusSource = 'orchestrator' | 'coder' | 'explorer' | 'auditor' | 'system';

export interface AgentStatusEvent {
  id: string;
  timestamp: number;
  source: AgentStatusSource;
  phase: string;
  detail?: string;
}

export interface QueuedFollowUpOptions {
  provider?: AIProviderType | null;
  model?: string | null;
  displayText?: string;
}

export interface QueuedFollowUp {
  text: string;
  attachments?: AttachmentData[];
  options?: QueuedFollowUpOptions;
  queuedAt: number;
}

export type VerificationRequirementStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'not_applicable';

export interface VerificationRequirementState {
  id: string;
  label: string;
  scope: 'always' | 'backend' | 'commit';
  kind: 'command' | 'evidence' | 'gate';
  command?: string;
  gate?: string;
  status: VerificationRequirementStatus;
  detail?: string;
  updatedAt: number;
}

export interface VerificationRuntimeState {
  policyName: string;
  backendTouched: boolean;
  requirements: VerificationRequirementState[];
  lastUpdatedAt: number;
}

export interface ConversationRunState {
  agentEvents?: AgentStatusEvent[];
  runEvents?: RunEvent[];
  queuedFollowUps?: QueuedFollowUp[];
  verificationState?: VerificationRuntimeState;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastMessageAt: number;
  repoFullName?: string; // "owner/repo". Undefined = unscoped (scratch or older chats).
  /** The branch that was active when the conversation was created. Optional for backwards compat. */
  branch?: string;
  /** The AI provider that was used when the first message was sent. Locked for the whole conversation. */
  provider?: AIProviderType;
  /** The model id used on first message for the locked provider (if known). */
  model?: string;
  /** Persisted, coarse-grained runtime state used to restore the console and queued follow-ups. */
  runState?: ConversationRunState;
  /** Session-level verification policy — durable reliability rules for this conversation. */
  verificationPolicy?: VerificationPolicy;
  /** Workspace mode the conversation was created in. Undefined = legacy repo/scratch chat. */
  mode?: WorkspaceMode;
}

// Onboarding + Active Repo types

export interface ActiveRepo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  default_branch: string;
  current_branch?: string;
  private: boolean;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
}

export type AppScreen = 'onboarding' | 'home' | 'chat' | 'file-browser';

/**
 * Screen type for the App routing shell after WorkspaceScreen extraction.
 * 'workspace' replaces the 'chat' | 'file-browser' split — internal routing
 * between chat and file browser moves inside WorkspaceScreen.
 */
export type AppShellScreen = 'onboarding' | 'home' | 'workspace';

// File browser types (re-exported from sandbox-client for convenience)
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}

// Developer productivity tools — search, tests, type checking

export interface FileSearchMatch {
  path: string;
  line: number;
  content: string;
}

export interface FileSearchCardData {
  repo: string;
  query: string;
  path?: string;
  matches: FileSearchMatch[];
  totalCount: number;
  truncated: boolean;
}

export interface CommitFilesCardData {
  repo: string;
  ref: string;
  sha: string;
  message: string;
  author: string;
  date: string;
  files: { filename: string; status: string; additions: number; deletions: number }[];
  totalChanges: { additions: number; deletions: number };
}

export interface TestResultsCardData {
  framework: 'npm' | 'pytest' | 'cargo' | 'go' | 'unknown';
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  exitCode: number;
  output: string;
  truncated: boolean;
}

export interface TypeCheckCardData {
  tool: 'tsc' | 'pyright' | 'mypy' | 'unknown';
  errors: { file: string; line: number; column: number; message: string; code?: string }[];
  errorCount: number;
  warningCount: number;
  exitCode: number;
  truncated: boolean;
}

// GitHub Actions workflow types

export interface WorkflowRunItem {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | null;
  branch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  runNumber: number;
  actor: string;
}

export interface WorkflowRunsCardData {
  repo: string;
  runs: WorkflowRunItem[];
  workflow?: string;
  truncated: boolean;
}

export interface WorkflowJobStep {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | null;
  number: number;
}

export interface WorkflowJob {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | null;
  steps: WorkflowJobStep[];
  htmlUrl: string;
}

export interface WorkflowLogsCardData {
  runId: number;
  runName: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  jobs: WorkflowJob[];
  htmlUrl: string;
  repo: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchCardData {
  query: string;
  results: WebSearchResult[];
}

export interface DelegationResultCardData {
  agent: 'explorer' | 'coder' | 'task_graph';
  status: DelegationStatus;
  summary: string;
  verifiedText?: string;
  openText?: string;
  checksPassed?: number;
  checksTotal?: number;
  fileCount?: number;
  taskCount?: number;
  rounds: number;
  checkpoints: number;
  elapsedMs: number;
  gateVerdicts: DelegationGateVerdict[];
  missingRequirements: string[];
  nextRequiredAction?: string | null;
}

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskUserCardData {
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
  selectedOptionIds?: string[];
  responseText?: string;
}

// --- Resumable Sessions ---

// ---------------------------------------------------------------------------
// Tool hooks — pre/post execution interception
// ---------------------------------------------------------------------------

/** Context passed to tool hooks for decision-making. */
export interface ToolHookContext {
  sandboxId: string | null;
  allowedRepo: string;
  activeProvider?: string;
  activeModel?: string;
  /** When present, the capability ledger for the current run. */
  capabilityLedger?: import('../lib/capabilities').CapabilityLedger;
}

/** Result from a PreToolUse hook. */
export interface PreToolUseResult {
  /** 'deny' blocks execution, 'allow' permits (and may carry modifiedArgs), 'passthrough' defers to next hook. */
  decision: 'allow' | 'deny' | 'passthrough';
  reason?: string;
  /** Replacement args — applied when decision is 'allow'. */
  modifiedArgs?: Record<string, unknown>;
  /** Appended to the tool result text after execution. */
  systemMessage?: string;
}

/** Result from a PostToolUse hook. */
export interface PostToolUseResult {
  /** Appended to the tool result text after execution. */
  systemMessage?: string;
  /** When set, replaces the tool result text sent to the model. */
  resultOverride?: string;
  /**
   * Runtime action requested by a post-tool policy.
   * - 'inject':  append an advisory message after the tool result
   * - 'halt':    stop the agent loop (e.g., repeated mutation failures)
   * When absent, the hook only modifies the result text (legacy behavior).
   */
  action?: 'inject' | 'halt';
  /**
   * Message to inject into the conversation (when action === 'inject').
   * Structured as a ChatMessage so it appears in the conversation history.
   */
  injectMessage?: ChatMessage;
  /**
   * Summary reason for halting (when action === 'halt').
   * Used for status display and journal recording.
   */
  haltSummary?: string;
}

// ---------------------------------------------------------------------------
// Approval gates — runtime gate checks for approval-sensitive actions
// ---------------------------------------------------------------------------

/** Categories of actions that require explicit approval or a safe audited path. */
export type ApprovalGateCategory =
  | 'destructive_sandbox'
  | 'git_override'
  | 'remote_side_effect'
  | 'capability_violation';

/**
 * Result of an approval gate check.
 * - 'allowed':  action may proceed
 * - 'blocked':  action is blocked; model gets structured explanation + recovery path
 * - 'ask_user': action requires explicit user approval via ask_user tool
 */
export type ApprovalGateDecision = 'allowed' | 'blocked' | 'ask_user';

/**
 * A registered approval gate rule. Evaluated before tool execution for
 * actions that should not rely solely on prompt guidance.
 */
export interface ApprovalGateRule {
  /** Unique rule identifier for telemetry and debugging. */
  id: string;
  /** Human-readable description of what this gate protects. */
  label: string;
  /** Category for grouping and override logic. */
  category: ApprovalGateCategory;
  /** Tool name matcher — regex or pipe-delimited string. */
  matcher: RegExp | string;
  /**
   * Evaluate whether the action is allowed.
   * Receives tool name, args, and current context.
   */
  evaluate: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolHookContext,
  ) => ApprovalGateDecision | Promise<ApprovalGateDecision>;
  /** Structured reason shown to the model when blocked. */
  blockedReason: string;
  /** Recovery guidance — the safest next action the model should take. */
  recoveryPath: string;
}

/**
 * Result returned when an approval gate blocks an action.
 * Provides the model with structured information about why the action
 * was blocked and what to do instead.
 */
export interface ApprovalGateBlockedResult {
  gateId: string;
  category: ApprovalGateCategory;
  decision: 'blocked' | 'ask_user';
  reason: string;
  recoveryPath: string;
}

// ---------------------------------------------------------------------------
// PreCompact event — fired before context window compaction
// ---------------------------------------------------------------------------

// PreCompactEvent is re-exported from @push/lib/provider-contract above.

// ---------------------------------------------------------------------------
// Delegation envelope — structured contract between Orchestrator and Coder
// ---------------------------------------------------------------------------

/**
 * Everything the Orchestrator sends to the Coder in a single typed envelope.
 * Captures the task spec and context — runtime plumbing (callbacks, signals)
 * lives in CoderCallbacks.
 */
export interface DelegationBriefFields {
  files?: string[];
  intent?: string;
  deliverable?: string;
  knownContext?: string[];
  constraints?: string[];
}

export interface CoderDelegationArgs extends DelegationBriefFields {
  task?: string;
  tasks?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Optional capability budget — narrows the Coder's permissions for this delegation. */
  declaredCapabilities?: import('../lib/capabilities').Capability[];
}

export interface ExplorerDelegationArgs extends DelegationBriefFields {
  task?: string;
}

export interface DelegationEnvelope extends DelegationBriefFields {
  task: string;
  files: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  branchContext?: {
    activeBranch: string;
    defaultBranch: string;
    protectMain: boolean;
  };
  /** Explicit provider for this delegation (not inherited from chat). */
  provider: AIProviderType;
  /** Explicit model override (not inherited from chat). */
  model?: string;
  /** Project instructions (AGENTS.md / CLAUDE.md content). */
  projectInstructions?: string;
  /** Filename of the instructions file (for sandbox_read_file hint). */
  instructionFilename?: string;
  /** Harness profile settings — controls scaffolding level for this delegation. */
  harnessSettings?: HarnessProfileSettings;
  /** Pre-computed planner brief to inject into the Coder's task preamble. */
  plannerBrief?: string;
  /** Session-level verification policy passed through from the conversation. */
  verificationPolicy?: VerificationPolicy;
  /**
   * Capabilities declared for this delegation run.
   * When present, the capability ledger enforces that only declared
   * capabilities are used. Logged for post-run audit.
   */
  declaredCapabilities?: import('../lib/capabilities').Capability[];
}

/** Runtime callbacks for the Coder agent loop. */
export interface CoderCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  onCheckpoint?: (question: string, context: string) => Promise<string>;
  onWorkingMemoryUpdate?: (state: CoderWorkingMemory) => void;
}

/** Return value from a Coder agent run. */
export interface CoderResult {
  summary: string;
  cards: ChatCard[];
  rounds: number;
  checkpoints: number;
  criteriaResults?: CriterionResult[];
  /** Post-run capability audit: declared vs actually-used capabilities. */
  capabilitySnapshot?: import('../lib/capabilities').CapabilityLedgerSnapshot;
}

export interface ExplorerDelegationEnvelope extends DelegationBriefFields {
  task: string;
  files: string[];
  branchContext?: {
    activeBranch: string;
    defaultBranch: string;
    protectMain: boolean;
  };
  provider: AIProviderType;
  model?: string;
  projectInstructions?: string;
  instructionFilename?: string;
}

export interface ExplorerCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
}

export interface ExplorerResult {
  summary: string;
  cards: ChatCard[];
  rounds: number;
  /** Post-run capability audit: declared vs actually-used capabilities. */
  capabilitySnapshot?: import('../lib/capabilities').CapabilityLedgerSnapshot;
}

// ---------------------------------------------------------------------------
// Structured delegation outcome — machine-readable result contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parallel delegation — multi-task Coder fan-out with merge
// ---------------------------------------------------------------------------

export type ParallelDelegationOutcome =
  | 'merged'
  | 'merge_conflicts'
  | 'merge_checks_failed'
  | 'active_changed'
  | 'merge_error'
  | 'partial_failure'
  | 'setup_failed';

export interface ParallelDelegationTaskResult {
  taskIndex: number;
  status: 'OK' | 'CHECKS_FAILED' | 'FAILED';
  summary: string;
  elapsedMs: number;
  cards: ChatCard[];
  rounds: number;
  checkpoints: number;
  criteriaResults?: CriterionResult[];
}

export interface ParallelDelegationEnvelope {
  tasks: string[];
  files: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  intent?: string;
  constraints?: string[];
  branchContext?: {
    activeBranch: string;
    defaultBranch: string;
    protectMain: boolean;
  };
  provider: AIProviderType;
  model?: string;
  projectInstructions?: string;
  instructionFilename?: string;
  activeSandboxId: string;
  sourceRepo: string;
  sourceBranch: string;
  authToken: string;
  appCommitIdentity?: { name: string; email: string };
  recentChatHistory: ChatMessage[];
}

export interface ParallelDelegationCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  onWorkingMemoryUpdate?: (state: CoderWorkingMemory) => void;
  getActiveSandboxId?: () => string | null;
}

export interface ParallelDelegationResult {
  outcome: ParallelDelegationOutcome;
  tasks: ParallelDelegationTaskResult[];
  totalRounds: number;
  totalCheckpoints: number;
  cards: ChatCard[];
  mergeNote: string;
  wallTimeMs: number;
  mergeCheckResults?: CriterionResult[];
  filesMerged: number;
}

export interface RunCheckpoint {
  chatId: string;
  round: number;
  phase: LoopPhase;
  baseMessageCount: number;
  deltaMessages: Array<{ role: string; content: string }>;
  accumulated: string;
  thinkingAccumulated: string;
  coderDelegationActive: boolean;
  lastCoderState: string | null;
  savedAt: number;
  provider: AIProviderType;
  model: string;
  sandboxSessionId: string;
  activeBranch: string;
  repoId: string;
  userAborted?: boolean;
  /** Logical workspace session identity (Sprint 2f). Old checkpoints without this field are unresumable. */
  workspaceSessionId?: string;
  /** Full git diff of uncommitted changes captured at save time (cold resume). */
  savedDiff?: string;
  /** How this checkpoint was created — determines resume behavior. */
  reason?: 'expiry' | 'manual' | 'interrupt';
}

// ---------------------------------------------------------------------------
// WorkspaceScreen extraction — Phase 1 boundary types
// ---------------------------------------------------------------------------

/**
 * Slim conversation metadata without the message array.
 * Used as the App-level bridge so HomeScreen can display conversation history
 * without pulling the full message trees out of WorkspaceScreen.
 */
export type ConversationMeta = Omit<Conversation, 'messages' | 'runState'>;

/**
 * Keyed map of slim conversation metadata, emitted upward from WorkspaceScreen
 * via onConversationIndexChange so App and HomeScreen can stay current.
 */
export type ConversationIndex = Record<string, ConversationMeta>;

export interface GitHubAuthSession {
  status: 'signed_out' | 'pat' | 'app';
  token: string | null;
  patToken: string | null;
  validatedUser: GitHubUser | null;
  isAppAuth: boolean;
  installationId: string | null;
  loading: boolean;
  error: string | null;
  appLoading: boolean;
  appError: string | null;
  connectPat: (token: string) => Promise<boolean>;
  connectApp: () => void;
  installApp: () => void;
  setInstallationIdManually: (id: string) => Promise<boolean>;
  disconnect: () => void;
}

export interface WorkspaceScreenSessionProps {
  workspaceSession: WorkspaceSession;
  onWorkspaceSessionChange: (session: WorkspaceSession | null) => void;
}

export interface WorkspaceScreenRepoShellProps {
  setActiveRepo: (repo: ActiveRepo) => void;
  setCurrentBranch: (branch: string) => void;
  repos: RepoWithActivity[];
  reposLoading: boolean;
  reposError: string | null;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
}

export type WorkspaceScreenAuthProps = Pick<
  GitHubAuthSession,
  | 'token'
  | 'patToken'
  | 'validatedUser'
  | 'isAppAuth'
  | 'installationId'
  | 'appLoading'
  | 'appError'
  | 'connectApp'
  | 'installApp'
  | 'setInstallationIdManually'
>;

export interface WorkspaceScreenNavigationProps {
  onDisconnect: () => void;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onStartScratchWorkspace: () => void;
  onStartChat: () => void;
  onEndWorkspace: () => void;
}

export interface WorkspaceScreenHomeBridgeProps {
  pendingResumeChatId: string | null;
  onConversationIndexChange: (index: ConversationIndex) => void;
}

/**
 * Props passed from App (routing shell) into WorkspaceScreen.
 * Everything workspace/chat/sandbox-specific lives inside WorkspaceScreen;
 * this interface is the grouped surface area between the shell and workspace.
 */
export interface WorkspaceScreenProps {
  workspace: WorkspaceScreenSessionProps;
  repoShell: WorkspaceScreenRepoShellProps;
  auth: WorkspaceScreenAuthProps;
  navigation: WorkspaceScreenNavigationProps;
  homeBridge: WorkspaceScreenHomeBridgeProps;
}
