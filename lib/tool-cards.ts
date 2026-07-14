/**
 * tool-cards.ts — the canonical tool render-payload vocabulary.
 *
 * A tool result has two audiences and they are NOT the same object:
 *
 *   - `text`  → what the MODEL reads. Prose, truncated, token-budgeted.
 *   - `card`  → what the USER sees. Typed, structured, and NEVER sent to
 *               the model.
 *
 * This module is the single definition of the `card` half. It lives in `lib/`
 * because it is cross-surface semantics: the web `CardRenderer` and the TUI
 * both dispatch on `ToolCard['type']`, and a vocabulary that lives on one
 * surface is a vocabulary the other surface has to *guess* at — which is
 * exactly how the TUI ended up regex-sniffing tool output for diffs.
 *
 * Presentation is DECLARED by the tool, never inferred from its output.
 *
 * See `docs/decisions/Tool Render Payload — Cards Are Declared, Not Sniffed.md`.
 * This module is Slice 0: a pure move of the vocabulary out of
 * `app/src/types/index.ts`, which re-exports every name below for back-compat.
 *
 * Card data shapes that already lived in `lib/` are imported, not redefined —
 * see the imports below. Adding a card type here (rather than on a surface) is
 * the whole point; keep it type-only so `lib/` stays runtime-free at this seam.
 */

import type { ArtifactRecord } from './artifacts/types.js';
import type { ApprovalGateCategory } from './approval-gates.js';
import type { AskUserCardData } from './ask-user-tools.js';
import type { AuditVerdictCardData } from './auditor-agent.js';
import type { WorkspacePatchCardData } from './protocol-schema.js';
import type { DelegationGateVerdict, DelegationStatus } from './runtime-contract.js';
import type { CoderWorkingMemory } from './working-memory.js';

export type {
  ArtifactRecord,
  AskUserCardData,
  AuditVerdictCardData,
  CoderWorkingMemory,
  WorkspacePatchCardData,
};

/**
 * Confirmation-card severity band. A structural alias of the runtime's
 * `ApprovalGateCategory` — NOT a copy. The web previously re-declared these
 * four members as a local literal "so web types don't import lib runtime
 * types"; a type-only import is erased at build time, so that concern does not
 * apply and the duplicate is removed.
 */
export type ApprovalCardCategory = ApprovalGateCategory;

// Discriminated union for rich inline cards
export type ToolCard =
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
  | { type: 'evaluation'; data: EvaluationCardData }
  | { type: 'ask-user'; data: AskUserCardData }
  | { type: 'approval'; data: ApprovalCardData }
  | { type: 'coder-progress'; data: CoderWorkingMemory }
  | { type: 'coder-job'; data: CoderJobCardData }
  | { type: 'artifact'; data: ArtifactCardData }
  | { type: 'workspace-patch'; data: WorkspacePatchCardData };

/** Inline artifact card — wraps a fully-formed `ArtifactRecord` so the renderer
 *  can dispatch on `record.kind` without a second fetch. */
export interface ArtifactCardData {
  record: ArtifactRecord;
}

// --- Background Coder Job ---
// Mirrors CoderJobStatus in app/src/worker/coder-job-do.ts. Kept in the
// client types so the hook + card can reference it without importing
// Worker-side modules.
export type BackgroundJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CoderJobCardData {
  jobId: string;
  chatId: string;
  status: BackgroundJobStatus;
  /** Client-side wall clock of the POST /api/jobs/start response. */
  startedAt: number;
  /** Set when status transitions to a terminal value. Used by
   * JobCard to freeze the elapsed timer at the real end time
   * instead of resetting it to 0. */
  finishedAt?: number;
  /** Client-side wall clock of the most recent SSE event received for
   * this job. Updated on every dispatched run event (started, completed,
   * failed, and any future progress events). Paired with `status ===
   * 'running'` to detect runs that have gone quiet past a stall
   * threshold — lets the JobCard surface a cancel affordance before the
   * DO's 30-minute wall-clock alarm eventually fires. */
  lastEventAt?: number;
  /** Last `job.started` detail or `job.completed` summary. */
  latestStatusLine?: string;
  /** Populated on terminal completed/cancelled events. */
  summary?: string;
  /** Populated on job.failed events. */
  error?: string;
  /** Short preview of the originating task; surfaced in the card header. */
  taskPreview?: string;
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
  branches: {
    name: string;
    isDefault: boolean;
    isProtected: boolean;
    pr?: { number: number; state: 'open' | 'merged' | 'closed'; title: string };
    prLookupOk?: boolean;
  }[];
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

/**
 * Display-only summary of the ref-only push plan (`computePushPlan`) carried on
 * a push-kind review card. `kind` mirrors `RefMoveKind` from
 * `lib/git/push-plan.ts` minus `force` (a diverged push is blocked before a card
 * exists, so it never reaches the UI). `ahead`/`behind` are commit counts vs
 * origin, null when not computable.
 */
export interface PushPlanSummary {
  kind: 'create' | 'fast-forward' | 'skip' | 'unknown';
  ahead: number | null;
  behind: number | null;
}

export interface CommitReviewCardData {
  /**
   * Which delivery step this card gates (Gate-at-Push Move A):
   *   - `'commit'` (default when absent, for back-compat): the legacy
   *     prepare-commit card — approval commits the working tree then pushes.
   *   - `'push'`: the diff is the *cumulative push diff* and the commits
   *     already exist locally (made silently via `sandbox_commit`), so
   *     approval runs the push only — no commit step. `commitMessage` is
   *     not required for this kind.
   */
  kind?: 'commit' | 'push';
  /**
   * For a `kind: 'push'` card: the HEAD sha the Auditor verdict was computed
   * against (the tip being pushed). Approval re-reads HEAD and compares — if a
   * `sandbox_commit` landed after this review, the sha differs and the approved
   * push is refused (the pinned verdict no longer covers the new commits), so
   * work can't ship unaudited through a stale card. Absent on legacy cards.
   */
  auditedHeadSha?: string;
  /**
   * For a `kind: 'push'` card: the git surface used for the audit. Approval
   * refuses if the active surface flips before push (for example native clone
   * becomes unavailable and the call would otherwise fall back to sandbox).
   */
  auditedGitSurface?: 'sandbox' | 'native';
  /**
   * For a `kind: 'push'` card: the sandbox branch and upstream destination in
   * effect when the Auditor verdict was computed. Approval re-reads both and
   * refuses stale cards if the destination changed while HEAD stayed the same.
   */
  auditedBranch?: string;
  auditedUpstream?: string;
  /**
   * For a `kind: 'push'` card: origin's resolved push URL when the verdict was
   * computed. The upstream *ref* (`origin/foo`) survives a remote repoint, and
   * `git push origin HEAD` can use `remote.origin.pushurl`; this pin catches
   * origin being aimed at another repo between review and push. Approval
   * re-reads it and fails closed on mismatch.
   */
  auditedRemoteUrl?: string;
  /**
   * For a `kind: 'push'` card: origin's LIVE tip sha for the pushed branch when
   * the verdict was computed — the force-with-lease value (`computePushPlan`).
   * `'0000…0'` (ZERO_OID) encodes "no remote branch yet" (a create) so it stays
   * distinguishable from an absent pin. Unlike the other pins, this is read over
   * the network (`ls-remote`), so it's only set when origin was reachable;
   * approval re-reads the live tip and refuses the push if it moved (the audited
   * diff was computed against the old base). Absent on legacy cards and when
   * origin was unreadable at audit time — the lease check then no-ops (git's own
   * non-fast-forward rejection remains the backstop).
   */
  auditedRemoteTipSha?: string;
  /**
   * For a `kind: 'push'` card: the classified ref move surfaced to the user —
   * whether the push creates the branch or fast-forwards it, and by how many
   * commits. Display-only; the prepare step already blocks a `force`/diverged
   * push before a card is ever produced.
   */
  pushPlan?: PushPlanSummary;
  diff: DiffPreviewCardData;
  auditVerdict: AuditVerdictCardData;
  commitMessage: string;
  status: 'pending' | 'refreshing' | 'approved' | 'rejected' | 'committed' | 'pushing' | 'error';
  error?: string;
  /** Branch where the approved commit landed. Stamped on success so
   * contextual post-commit actions do not infer from mutable route state. */
  committedBranch?: string;
  defaultBranch?: string;
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

/**
 * Inline completion-evaluation verdict, surfaced as a structured card on the
 * inline lead lane instead of an appended `[Evaluation: …]` prose line. This
 * is the task-completion gate (`complete | incomplete`), distinct from the
 * commit-safety `audit-verdict` card (`safe | unsafe`). In practice only the
 * `incomplete` verdict is rendered — a `complete` turn surfaces no card (a
 * successful answer doesn't need a self-grade footer). See
 * `chat-send-inline.ts`.
 */
export interface EvaluationCardData {
  verdict: 'complete' | 'incomplete';
  summary: string;
  /** Specific items the turn left incomplete or missing. */
  gaps: string[];
  confidence: 'high' | 'medium' | 'low';
}

/** Runtime-driven approval card — rendered when a policy gate SUSPENDS a tool
 *  call awaiting the user's decision (see `lib/approval-bridge.ts`). */
export interface ApprovalCardData {
  approvalId: string;
  toolName: string;
  category: ApprovalCardCategory;
  /** Human lead line describing what was held. */
  summary: string;
  /** The intercepted command / target, shown verbatim. */
  command?: string;
  /** Gate reason + recovery path, shown as a meta line while pending. */
  reason: string;
  /** Undefined/'pending' = awaiting decision; set on resolve. 'expired' = the
   *  card was actioned after its waiter was gone (refresh/Stop) — nothing ran. */
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
}
