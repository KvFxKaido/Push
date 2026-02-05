export type AppState = 'home' | 'running' | 'results' | 'repos';

export type AgentRole = 'orchestrator' | 'coder' | 'auditor';

export type AIProviderType = 'moonshot';

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
  | { type: 'diff-preview'; data: DiffPreviewCardData }
  | { type: 'audit-verdict'; data: AuditVerdictCardData }
  | { type: 'commit-review'; data: CommitReviewCardData }
  | { type: 'ci-status'; data: CIStatusCardData }
  | { type: 'editor'; data: EditorCardData }
  | { type: 'file-search'; data: FileSearchCardData }
  | { type: 'commit-files'; data: CommitFilesCardData }
  | { type: 'test-results'; data: TestResultsCardData }
  | { type: 'type-check'; data: TypeCheckCardData };

// Tool execution returns text for the LLM + optional structured card for UI
export interface ToolExecutionResult {
  text: string;
  card?: ChatCard;
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
  | { type: 'editor-save'; messageId: string; cardIndex: number; path: string; content: string; sandboxId: string };

export interface AgentStatus {
  active: boolean;
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
}

// Onboarding + Active Repo types

export interface ActiveRepo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  default_branch: string;
  private: boolean;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
}

export type AppScreen = 'onboarding' | 'repo-picker' | 'chat' | 'file-browser';

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
