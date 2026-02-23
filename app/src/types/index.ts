export type AppState = 'home' | 'running' | 'results' | 'repos';

// User profile — persisted in localStorage, injected into system prompt
export interface UserProfile {
  displayName: string;
  githubLogin?: string;
  bio: string;
}

export const USER_PROFILE_DEFAULTS: UserProfile = {
  displayName: '',
  githubLogin: undefined,
  bio: '',
};

export type AgentRole = 'orchestrator' | 'coder' | 'auditor';

export type AIProviderType = 'ollama' | 'mistral' | 'openrouter' | 'zai' | 'google' | 'zen' | 'demo';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProviderType;
  role?: AgentRole;
  context?: number;
}

export interface AIProviderConfig {
  type: AIProviderType;
  name: string;
  description: string;
  models: AIModel[];
  envKey: string;
  envUrl?: string;
}

export interface PRInput {
  owner: string;
  repo: string;
  prNumber: string;
}

export interface PRData {
  title: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  diff: string;
  files: PRFile[];
  _demo?: boolean;
}

export interface PRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface AnalysisResult {
  summary: string;
  risks: RiskItem[];
  diffNotes: DiffNote[];
  hotspots?: Hotspot[];
  _demo?: boolean;
}

export interface RiskItem {
  level: 'low' | 'medium' | 'high';
  category: string;
  description: string;
}

export interface DiffNote {
  file: string;
  line?: number;
  type: 'logic' | 'mechanical' | 'style';
  note: string;
}

export interface Hotspot {
  file: string;
  reason: string;
  complexity: number;
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
  content: string;      // base64 data URL for images, text for code/docs
  thumbnail?: string;   // small preview for images
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
  timestamp: number;
  status?: 'sending' | 'streaming' | 'done' | 'error';
  thinking?: string;
  cards?: ChatCard[];
  attachments?: AttachmentData[];  // User-attached files
  isToolCall?: boolean;    // Assistant message that requested a tool
  isToolResult?: boolean;  // Synthetic user message carrying tool data
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
  | { type: 'browser-screenshot'; data: BrowserScreenshotCardData }
  | { type: 'browser-extract'; data: BrowserExtractCardData }
  | { type: 'sandbox-download'; data: SandboxDownloadCardData }
  | { type: 'workflow-runs'; data: WorkflowRunsCardData }
  | { type: 'workflow-logs'; data: WorkflowLogsCardData }
  | { type: 'web-search'; data: WebSearchCardData };

// --- Coder working memory ---

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
}

// --- Acceptance criteria for Coder delegation ---

/** A single machine-checkable criterion the Coder must pass after task completion. */
export interface AcceptanceCriterion {
  id: string;
  /** Shell command to run in the sandbox. */
  check: string;
  /** Expected exit code (default: 0 = success). */
  exitCode?: number;
  /** Human-readable description of what's being checked. */
  description?: string;
}

/** Result of running one acceptance criterion. */
export interface CriterionResult {
  id: string;
  passed: boolean;
  exitCode: number;
  output: string;
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
  | 'EDIT_HASH_MISMATCH'
  | 'EDIT_CONTENT_NOT_FOUND'
  | 'AUTH_FAILURE'
  | 'RATE_LIMITED'
  | 'STALE_FILE'
  | 'EDIT_GUARD_BLOCKED'
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
  promotion?: {
    repo: ActiveRepo;
    pushed: boolean;
    warning?: string;
    htmlUrl?: string;
  };
  /** When set, the sandbox has switched to this branch (e.g. draft checkout).
   *  The app should sync its active branch state without tearing down the sandbox. */
  branchSwitch?: string;
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
}

export interface PRListCardData {
  repo: string;
  state: string;
  prs: { number: number; title: string; author: string; additions?: number; deletions?: number; createdAt: string }[];
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

export interface BrowserToolError {
  code: string;
  message: string;
}

export interface BrowserScreenshotCardData {
  url: string;
  finalUrl: string;
  title: string;
  statusCode: number | null;
  mimeType: string;
  imageBase64: string;
  truncated: boolean;
  error?: BrowserToolError;
}

export interface BrowserExtractCardData {
  url: string;
  finalUrl: string;
  title: string;
  statusCode: number | null;
  instruction?: string;
  content: string;
  truncated: boolean;
  error?: BrowserToolError;
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

export interface AuditVerdictCardData {
  verdict: 'safe' | 'unsafe';
  summary: string;
  risks: { level: 'low' | 'medium' | 'high'; description: string }[];
  filesReviewed: number;
}

// Phase 4 — User Confirmation + CI Status

export interface CommitReviewCardData {
  diff: DiffPreviewCardData;
  auditVerdict: AuditVerdictCardData;
  commitMessage: string;
  status: 'pending' | 'approved' | 'rejected' | 'committed' | 'pushing' | 'error';
  error?: string;
}

export interface CICheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  detailsUrl?: string;
}

export interface CIStatusCardData {
  repo: string;
  ref: string;
  checks: CICheck[];
  overall: 'pending' | 'success' | 'failure' | 'neutral' | 'no-checks';
  fetchedAt: string;
}

export type CardAction =
  | { type: 'commit-approve'; messageId: string; cardIndex: number; commitMessage: string }
  | { type: 'commit-reject'; messageId: string; cardIndex: number }
  | { type: 'ci-refresh'; messageId: string; cardIndex: number }
  | { type: 'sandbox-state-refresh'; messageId: string; cardIndex: number; sandboxId: string }
  | { type: 'editor-save'; messageId: string; cardIndex: number; path: string; content: string; sandboxId: string; expectedVersion?: string };

export interface AgentStatus {
  active: boolean;
  phase: string;
  detail?: string;
}

export type AgentStatusSource = 'orchestrator' | 'coder' | 'auditor' | 'system';

export interface AgentStatusEvent {
  id: string;
  timestamp: number;
  source: AgentStatusSource;
  phase: string;
  detail?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastMessageAt: number;
  repoFullName?: string;  // "owner/repo". Undefined = unscoped (legacy/demo).
  /** The branch that was active when the conversation was created. Optional for backwards compat. */
  branch?: string;
  /** The AI provider that was used when the first message was sent. Locked for the whole conversation. */
  provider?: AIProviderType;
  /** The model id used on first message for the locked provider (if known). */
  model?: string;
}

// Onboarding + Active Repo types

export interface ActiveRepo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  default_branch: string;
  current_branch?: string;  // User-selected branch for context awareness
  private: boolean;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
}

export type AppScreen = 'onboarding' | 'home' | 'chat' | 'file-browser';

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
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
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
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
  number: number;
}

export interface WorkflowJob {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'neutral' | null;
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

// --- Resumable Sessions (Phase 1) ---

export type LoopPhase = 'streaming_llm' | 'executing_tools' | 'delegating_coder';

export interface RunCheckpoint {
  chatId: string;
  round: number;
  phase: LoopPhase;
  /** Index into the persisted conversation's message array. */
  baseMessageCount: number;
  /** Messages added during the current run that aren't yet in the persisted conversation. */
  deltaMessages: Array<{ role: string; content: string }>;
  /** The accumulated assistant response for the current round (lost on interrupt without this). */
  accumulated: string;
  /** Thinking content if present. */
  thinkingAccumulated: string;
  /** Was there a Coder delegation in progress? */
  coderDelegationActive: boolean;
  /** Last known CODER_STATE (if delegation was active). */
  lastCoderState: string | null;
  /** Timestamp for staleness detection. */
  savedAt: number;
  /** Provider locked for this chat. */
  provider: AIProviderType;
  /** Model locked for this chat. */
  model: string;
  /** Sandbox session ID — used to validate the checkpoint matches the current sandbox. */
  sandboxSessionId: string;
  /** Active branch at checkpoint time. */
  activeBranch: string;
  /** Repo full name at checkpoint time. */
  repoId: string;
  /** True if user had requested abort before checkpoint was saved. */
  userAborted?: boolean;
}
