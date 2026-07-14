import type { RepoAppearance } from '@/lib/repo-appearance';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type { GitHubTokenKind } from '@/lib/github-auth';
import type {
  AcceptanceCriterion,
  AgentRole,
  DelegationOutcome,
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
import type {
  AIProviderType,
  LlmContentPart,
  LlmToolResultBlock,
  LlmToolUseBlock,
  ReasoningBlock,
  UrlCitation,
} from '@push/lib/provider-contract';
export type { ReasoningBlock, UrlCitation } from '@push/lib/provider-contract';
export type {
  AIProviderType,
  PreCompactEvent,
  ReviewComment,
  ReviewResult,
} from '@push/lib/provider-contract';
export type {
  WorkspacePatchApplyKind,
  WorkspacePatchApplyState,
  WorkspacePatchCardData,
  WorkspacePatchRefusalReason,
} from '@push/lib/protocol-schema';
export type { AuditVerdictCardData } from '@push/lib/auditor-agent';

// User profile — canonical shape lives in lib/user-identity.ts; re-exported
// here so existing Web call sites using `@/types` don't have to churn.
import type { UserProfile } from '@push/lib/user-identity';
export type { UserProfile } from '@push/lib/user-identity';

export type WorkspaceMode = 'repo' | 'scratch' | 'chat' | 'relay';

/**
 * Loopback pushd daemon connection params used by low-level daemon adapters.
 */
export interface LoopbackDaemonBinding {
  port: number;
  token: string;
  /**
   * Token id printed by `push daemon pair`. Optional in PR 3b: the
   * web side learns the bearer at paste time but has no WS request
   * type to fetch the matching tokenId from the daemon yet. A future
   * `daemon_identify` round-trip (PR 3c) will fill this in; until
   * then the paired-state UI may show `(unknown)` or omit it.
   */
  tokenId?: string;
  /**
   * Origin the CLI bound the token to at mint time. Today the web
   * pairing flow always pairs from `window.location.origin`, so this
   * field is effectively that value — but storing it explicitly lets
   * a future flow (e.g. paste a token minted with a different origin)
   * surface mismatch cleanly.
   */
  boundOrigin: string;
}

/**
 * Identity of a paired remote pushd reached through the Worker
 * relay. Carries the three pieces the relay WS dial needs
 * (deploymentUrl, sessionId, attach token) plus diagnostic surface for the
 * mode chip / paired-state UI.
 *
 * Discriminated by the presence of `deploymentUrl`.
 */
export interface RelayBinding {
  deploymentUrl: string;
  /** Opaque routing key chosen by pushd; shared via the pair bundle. */
  sessionId: string;
  /**
   * Attach-token bearer (`pushd_da_*`). Never log, never copy
   * outside the transport + storage modules.
   */
  token: string;
  /**
   * Phase 3 slice 2 attach tokenId (`pdat_*`). Optional because the
   * web pair flow learns it via the bundle but a future protocol
   * change may emit it post-attach instead. Shown in the paired-
   * state UI for revocation guidance.
   */
  attachTokenId?: string;
  /** Parent device tokenId, for `push daemon revoke <tokenId>`. */
  deviceTokenId?: string;
  /** Existing daemon session the phone should attach to, when present. */
  targetSessionId?: string;
  /**
   * Bearer for `targetSessionId`. Stored with the Remote binding only
   * when the bundle was minted from an active daemon/TUI session.
   */
  targetAttachToken?: string;
}

/**
 * Workspace session identity for the active repo or scratch workspace.
 * `id` is a stable logical identity that survives sandbox restarts.
 * `sandboxId` is the runtime container id (null until the container starts).
 *
 * Cloud-sandbox is implicit on scratch/repo/chat — those records keep
 * their existing shape on disk. Remote carries a relay binding because it
 * attaches to daemon sessions over the Worker relay.
 */
export type WorkspaceSession =
  | { id: string; kind: 'scratch'; sandboxId: string | null }
  | { id: string; kind: 'repo'; repo: ActiveRepo; sandboxId: string | null }
  | { id: string; kind: 'chat'; sandboxId: null }
  | { id: string; kind: 'relay'; binding: RelayBinding; sandboxId: null };

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
// Harness profile — base scaffolding + behavior-driven adaptation
// ---------------------------------------------------------------------------

/**
 * Harness profile label. There is a single static base tier now: the
 * model-name "frontier detector" that once split `standard` vs `heavy`
 * was removed — it was a drifted regex allowlist, and the only thing it
 * gated (context resets) is driven instead by `computeAdaptiveProfile`
 * from *observed* signals (context-pressure events) at runtime. So every
 * run starts from `standard` and `harness-profiles.ts` adapts it.
 */
export type HarnessProfile = 'standard';

/** Concrete settings derived from a HarnessProfile tier. */
export interface HarnessProfileSettings {
  profile: HarnessProfile;
  /** Max rounds for a single Coder delegation. */
  maxCoderRounds: number;
  /** Whether context resets are enabled between Coder phases. */
  contextResetsEnabled: boolean;
  /** Whether the Auditor evaluation runs after every Coder delegation. */
  evaluateAfterCoder: boolean;
  /** Per-run token budget — halts a run once it has consumed this many tokens
   *  (a consumption circuit breaker complementing `maxCoderRounds`). `null` /
   *  omitted ⇒ uncapped. Resolved/accounted by the shared
   *  `lib/run-cost-budget.ts`; the kernel consumes it as `harnessTokenBudget`.
   *  Unlike the auto-computed `maxCoderRounds`, this carries the user's
   *  configured preference (web settings / CLI config). */
  runTokenBudget?: number | null;
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
  /** Salient argument for a compact settled summary — the file path, command,
   *  or query (`getToolStatusDetail`), already truncated. Lets the tool group
   *  render "Read config.json" instead of "Read a file". Undefined for tools
   *  with no useful target (and for error/rejection paths). */
  target?: string;
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
  /** Structured reasoning blocks captured from providers that return signed
   *  thinking (Anthropic). When the next request goes back to that
   *  provider, these blocks must be re-sent verbatim as the FIRST entries
   *  of the assistant `content[]` — Anthropic 400s the request otherwise
   *  when extended thinking + tool use are combined. The display channel
   *  (`thinking` text) is independent and may be present without these
   *  blocks for providers that emit reasoning as plain text. */
  reasoningBlocks?: ReasoningBlock[];
  /** Web-search sources surfaced by a provider's native search (OpenRouter's
   *  `openrouter:web_search`). Display-only — never sent back to the model;
   *  rendered as a "Sources" footer beneath the assistant's answer. Deduped
   *  by url at accumulation time. */
  citations?: UrlCitation[];
  cards?: ChatCard[];
  attachments?: AttachmentData[]; // User-attached files
  /** Pre-converted multimodal content for the wire. Set by the Coder kernel's
   *  initial turn (surface-agnostic `lib/` only knows provider content parts,
   *  not `AttachmentData`). When present, the request serializers
   *  (`toLLMMessages`, the coder-job stream adapter) send it verbatim instead
   *  of rebuilding from `attachments` — so kernel-lane turns carry images. */
  contentParts?: LlmContentPart[];
  isToolCall?: boolean; // Assistant message that requested a tool
  isToolResult?: boolean; // Synthetic user message carrying tool data
  isMalformed?: boolean; // Assistant message that attempted a tool call but produced invalid JSON
  /**
   * Structured tool-call sidecar — the Anthropic-canonical `tool_use` blocks
   * parsed from this assistant turn (one per call; a turn can batch several).
   * Additive + optional, written alongside the fenced-JSON text in `content`
   * (the model-facing boundary): `toLLMMessages` maps it to
   * `LlmMessage.contentBlocks` so serializers downcast structure instead of the
   * Anthropic bridge re-parsing text. Absent on old transcripts → the text arm
   * still serves them (the per-exchange fallback). See
   * `docs/decisions/Structured Tool-Call Sourcing.md`. Slice 1 writes this
   * producer sidecar; Slice 2 maps it onto `LlmMessage.contentBlocks`.
   */
  toolUses?: LlmToolUseBlock[];
  /**
   * Structured tool-result sidecar — the `tool_result` blocks on a result
   * message, each linked to its call via `tool_use_id`. Plural: a parallel batch
   * lands as one result message per call (one block each), a file-mutation batch
   * as one combined message (several blocks). Same additive/dual-read contract as
   * {@link toolUses}.
   */
  toolResults?: LlmToolResultBlock[];
  /** Provenance metadata — present on tool result messages for audit trail. */
  toolMeta?: ToolMeta;
  /** Branch active when this message was authored. New persisted messages are
   *  stamped at write time; legacy unstamped messages are backfilled during
   *  conversation hydration before `conv.branch` mutates as session state. */
  branch?: string;
  /** Discriminator for synthetic message kinds. Plain user/assistant messages
   *  leave this undefined. */
  kind?: 'branch_forked' | 'branch_merged' | 'compaction' | 'tool_prose';
  /** For `kind: 'tool_prose'` — id of the assistant tool-call message this
   *  narration preceded. The prose the model streams before a tool call is
   *  split into its own display-only message at write time (so it stays
   *  visible between collapsed tool groups); this link is what makes the
   *  split idempotent when the same round is re-marked. */
  toolProseFor?: string;
  /** Payload for `kind: 'compaction'` events. Records that the runtime
   *  trimmed the working context to fit the model's window at this point in
   *  the conversation. Rendered as a centered transcript divider; never
   *  model-visible (`visibleToModel: false`). */
  compactionMeta?: CompactionMeta;
  /** Payload for `kind: 'branch_forked'` events. Records the branch
   *  transition that happened at this point in the conversation. */
  branchForkedMeta?: BranchForkedMeta;
  /** Payload for `kind: 'branch_merged'` events. Records the merge that
   *  caused the conversation to migrate to the default branch. */
  branchMergedMeta?: BranchMergedMeta;
  /** When explicitly `false`, this message is transcript metadata only —
   *  filtered out of every prompt-pack path. Default behavior (undefined)
   *  is model-visible. Used for system events like `branch_forked` that
   *  must not be misread as model-directed instructions. */
  visibleToModel?: boolean;
}

/** Where a branch-switch result originated. Not user-facing; aids debugging
 *  and tests. */
export type BranchSwitchSource =
  | 'sandbox_create_branch'
  | 'sandbox_switch_branch'
  | 'github_create_branch'
  | 'release_draft'
  | 'ui'
  | 'ui-merge'
  | 'branch_desync'
  | 'merge_detected'
  | 'merge_pr';

/** Normalized payload for a branch transition reported by a tool result.
 *  `kind` is passive source context only; all branch changes now share the
 *  same app behavior: warm-follow the sandbox branch and update the active
 *  conversation's mutable `branch` state in place. */
export interface BranchSwitchPayload {
  name: string;
  kind: 'forked' | 'switched' | 'merged';
  /** Source branch (for forked: the base; for switched: optional context). */
  from?: string;
  /** Branch the sandbox was on immediately before this switch. Captured by
   *  producers that read HEAD pre-switch (e.g. `sandbox_switch_branch`).
   *  Useful for UI context (e.g. "switched main → feat/foo") and future
   *  rollback/debug affordances. Optional because not all producers know
   *  the previous branch (UI flows can pass it explicitly). */
  previous?: string;
  /** Commit SHA of the new branch's HEAD, when known. */
  sha?: string;
  /** PR number whose merge triggered this transition. Only meaningful when
   *  `kind === 'merged'`; forked/switched producers leave it unset. Threaded
   *  through to the `branch_merged` event so the chat divider can reference
   *  the PR that shipped. */
  prNumber?: number;
  /** Producer that emitted this payload. */
  source?: BranchSwitchSource;
}

/** Payload for a `kind: 'branch_forked'` system event in the conversation.
 *  Mirrors `BranchSwitchPayload` but tied to the message rather than a tool
 *  result, since the event lives in chat history after the migration. */
export interface BranchForkedMeta {
  from: string;
  to: string;
  sha?: string;
  source?: BranchSwitchSource;
}

/** Payload for a `kind: 'branch_merged'` system event. Records that the
 *  conversation migrated because the source branch was merged via a PR.
 *  Optional `prNumber` lets the renderer surface the PR that triggered it. */
export interface BranchMergedMeta {
  from: string;
  to: string;
  prNumber?: number;
  source?: BranchSwitchSource;
}

/** Payload for `kind: 'compaction'` transcript markers. The net token figures
 *  are the working-set estimate before and after the runtime trimmed the
 *  window for the turn; `phase` is the heaviest stage that ran. */
export interface CompactionMeta {
  beforeTokens: number;
  afterTokens: number;
  phase: 'summarization' | 'digest_drop' | 'hard_trim';
  /** Number of whole messages dropped (0 when only summarization ran). */
  messagesDropped: number;
  /** 1-based ordinal of this compaction within the conversation. Drives the
   *  "multiple compactions can blur older context" degradation nudge in the UI
   *  once it crosses `COMPACTION_DEGRADATION_THRESHOLD`. Optional for back-compat
   *  with markers persisted before this field existed. */
  compactionCount?: number;
}

/** Per-chat persistence slot: `chatId → { jobId → JobPersistenceEntry }`.
 * Written through the normal setConversations path so `saveConversation`
 * picks it up on the next flush. `lastEventId` is the RunEvent.id most
 * recently observed over SSE and is sent as Last-Event-ID on reconnect. */
export interface BackgroundJobPersistenceEntry {
  jobId: string;
  status: BackgroundJobStatus;
  lastEventId: string | null;
  startedAt: number;
  updatedAt: number;
  taskPreview?: string;
  /** Distinguishes main-chat bg turns from `delegate_coder` background
   *  delegations. Both go through the same hook plumbing but have
   *  different semantics: only main-chat entries are valid prior-turn
   *  candidates for chatRef.checkpointId auto-fill (PR 3). Undefined
   *  on entries written before the field was introduced — those are
   *  treated as ineligible by the auto-fill scan. */
  source?: 'main-chat' | 'delegation';
}

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
  | 'AUDITOR_UNAVAILABLE'
  | 'PROTECT_MAIN_BLOCKED'
  | 'PRE_HOOK_BLOCKED'
  | 'APPROVAL_GATE_BLOCKED'
  | 'ROLE_CAPABILITY_DENIED'
  | 'ROLE_REQUIRED'
  | 'ROLE_INVALID'
  | 'LOCAL_DAEMON_TOOL_UNSUPPORTED'
  | 'NATIVE_TOOL_UNSUPPORTED'
  | 'INVALID_ARG'
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
  /** When set, the sandbox has switched to this branch (e.g. draft checkout
   *  or model-initiated fork). The app syncs its active branch state without
   *  tearing down the sandbox. The `kind` field distinguishes a *fork* (new
   *  branch created from current state — conversation should follow) from a
   *  *switch* (branch changed but conversation stays put). See
   *  `BranchSwitchPayload` for the field contract. */
  branchSwitch?: BranchSwitchPayload;
  /** Workspace git branch stamped after sandbox_exec. `HEAD` means detached;
   *  omitted means the provider did not supply a stamp. */
  branch?: string;
  /** Structured delegation outcome — present when this result came from a delegated agent. */
  delegationOutcome?: DelegationOutcome;
  /** Foreground branch active when the delegated run was dispatched. Set by
   *  delegation handlers (Coder/Explorer/task graph) and used at message
   *  construction time to stamp `branch: originBranch` on the result message,
   *  binding the result to its launch branch even if the foreground has
   *  since forked. Undefined for non-delegate tool results. See R11 in the
   *  slice 2 design doc. */
  originBranch?: string;
  /** Post-hook policy action: inject this message after the tool result. */
  postHookInject?: ChatMessage;
  /** Post-hook policy action: halt the agent loop with this summary. */
  postHookHalt?: string;
}

// Phase 3 — Sandbox + Code Execution

// Phase 4 — User Confirmation + CI Status

export type CardAction =
  | { type: 'commit-approve'; messageId: string; cardIndex: number; commitMessage: string }
  | { type: 'commit-refresh'; messageId: string; cardIndex: number; commitMessage: string }
  | { type: 'commit-reject'; messageId: string; cardIndex: number }
  | { type: 'commit-switch-default'; messageId: string; cardIndex: number; targetBranch: string }
  | {
      type: 'commit-fork-from-here';
      messageId: string;
      cardIndex: number;
      fromBranch?: string;
    }
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
    }
  | { type: 'approval-approve'; messageId: string; cardIndex: number; approvalId: string }
  | { type: 'approval-reject'; messageId: string; cardIndex: number; approvalId: string };

export interface AgentStatus {
  active: boolean;
  phase: string;
  detail?: string;
  /** Wall-clock timestamp of when the current activity started. When
   *  set, the AgentStatusBar renders an elapsed-time suffix that ticks
   *  every second. Used by long-running tool executions (sandbox exec,
   *  delegations) so the user has a sense of progress beyond a generic
   *  "Executing in sandbox" + spinner. Omit for fast phases like
   *  "Thinking..." where the timer would be noise. */
  startedAt?: number;
  /** Themed thinking verbs (from `repo-vibe-verbs`) for the AgentStatusBar to
   *  rotate through during "dead air" between visible work. When present and
   *  non-empty the bar shows a rotating verb instead of `phase` (`phase`
   *  stays the static fallback for the event log). Ephemeral UI-only — never
   *  persisted (the agent event log is built from `phase`/`detail`). */
  verbs?: string[];
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

export interface PendingSteerRequest {
  text: string;
  attachments?: AttachmentData[];
  options?: QueuedFollowUpOptions;
  requestedAt: number;
}

import type {
  VerificationRequirementStatus,
  VerificationRequirementState,
  VerificationRuntimeState,
} from '@push/lib/verification-policy';
export type {
  VerificationRequirementStatus,
  VerificationRequirementState,
  VerificationRuntimeState,
};

export interface ConversationRunState {
  agentEvents?: AgentStatusEvent[];
  runEvents?: RunEvent[];
  queuedFollowUps?: QueuedFollowUp[];
  verificationState?: VerificationRuntimeState;
}

/**
 * A CLI/TUI-originated session discovered via the daemon's
 * `list_sessions` RPC. Not a `Conversation` — these rows are server-
 * side state with no IndexedDB message log on this device. The
 * drawer surfaces them in the daemon-mode sections so the user can
 * see what's already on the paired daemon; resume-into-mobile is a
 * separate flow that has to attach + replay events, intentionally
 * out of scope for the visibility-first iteration that introduced
 * this type.
 */
export interface DaemonCliSession {
  sessionId: string;
  updatedAt: number;
  provider: string;
  model: string;
  cwd: string;
  /** Optional human-set label (`./push resume rename`). Empty when unnamed. */
  sessionName: string;
  /** First non-envelope user message preview from the session log. May be empty. */
  lastUserMessage: string;
  /** Origin surface — `'tui'` / `'interactive'` / `'headless'` / …. */
  mode: string;
  /** Live state at the time of the listing fetch. */
  state: 'idle' | 'running';
  /** When `state === 'running'`, the run id. Otherwise null. */
  activeRunId: string | null;
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
  /**
   * The daemon-side session this local chat mirrors, for `mode: 'relay'`
   * conversations. Connected sessions / tap-to-resume can target N distinct
   * daemon sessions, so `mode` alone can't find-or-create the right local
   * chat — without this, every tap collapsed onto whichever relay chat
   * happened to be active before. Undefined for legacy relay chats predating
   * this field.
   */
  daemonSessionId?: string;
  /**
   * Background Coder jobs the chat has kicked off. Keyed by jobId.
   * Non-terminal entries are replayed on foreground via the
   * `visibilitychange` listener in `useBackgroundCoderJob`. Terminal
   * entries are kept so the JobCard stays rendered in the transcript.
   */
  pendingJobIds?: Record<string, BackgroundJobPersistenceEntry>;
  /**
   * Library v2b linkage — IDs of `Library` collections (see
   * `chat-library-types.ts`) whose contents are auto-injected into the
   * system message on every turn of this chat, fetched fresh from KV.
   * The content itself is NOT persisted into chat history; only the
   * IDs live here. Survives provider/model switches because the
   * linkage is chat-scoped, not provider-scoped.
   */
  linkedLibraryIds?: string[];
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
export type AppShellScreen =
  | 'onboarding'
  | 'home'
  | 'workspace'
  | 'draft-composer'
  | 'relay-pairing';

/**
 * Pre-flight composer seed: optional context to prefill when opening the
 * draft composer. Lets callers (drawer "+ New chat", launcher tiles, etc.)
 * pre-populate the target repo/branch/mode so the user only changes what
 * they need to.
 */
export interface DraftComposerSeed {
  mode?: 'repo' | 'chat' | 'scratch';
  repoFullName?: string | null;
  branch?: string | null;
}

// File browser types (re-exported from sandbox-client for convenience)
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}

// Developer productivity tools — search, tests, type checking

// GitHub Actions workflow types

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

// --- Resumable Sessions ---

// ---------------------------------------------------------------------------
// Tool hooks — pre/post execution interception
// ---------------------------------------------------------------------------

/**
 * Tool-hook types now live in `lib/tool-hooks.ts` so both web and CLI
 * surfaces evaluate the same hooks. Re-exported here for back-compat
 * with existing `@/types` import sites.
 */
export type {
  ToolHookContext,
  PreToolUseResult,
  PostToolUseResult,
} from '@push/lib/tool-hooks';

// ---------------------------------------------------------------------------
// Approval gates — runtime gate checks for approval-sensitive actions.
// Types live in `lib/approval-gates.ts`; re-exported here for back-compat.
// ---------------------------------------------------------------------------

export type {
  ApprovalGateCategory,
  ApprovalGateDecision,
  ApprovalGateRule,
  ApprovalGateBlockedResult,
} from '@push/lib/approval-gates';

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
  /**
   * The orchestrator-level user goal that motivated this delegation. The
   * Coder/Explorer brief renders it as a `[USER_GOAL]` block so delegated
   * agents see the same goal constraint the orchestrator was bound by —
   * making the goal load-bearing at every layer, not just at the
   * orchestrator boundary. Plumbed via task-graph node + delegation
   * envelope; absent on legacy non-graph delegations.
   */
  userGoal?: import('@push/lib/user-goal-anchor').UserGoalAnchor;
  /**
   * Per-task rationale copied from the source `TaskGraphNode.addresses`.
   * Renders as `Addresses: ...` in the brief alongside `userGoal`. Soft
   * field — omitted when the orchestrator didn't populate it (no goal
   * loaded, or pre-`addresses` emission path).
   */
  addresses?: string;
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
  /** Current-turn attachments for main-chat engine turns. */
  attachments?: AttachmentData[];
  files: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  branchContext?: {
    activeBranch: string;
    defaultBranch: string;
    protectMain: boolean;
  };
  /** Branch active in the foreground when this delegation was dispatched.
   *  Bound to the delegate for the lifetime of the run; the result message
   *  stamps `branch: originBranch` even when the foreground has since
   *  forked away. See R11 in the slice 2 design doc. Distinct from
   *  `branchContext.activeBranch`, which the agent reads as runtime state;
   *  this field is provenance, not policy. */
  originBranch?: string;
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
  /**
   * This background job IS the conversational lead's own turn (the main-chat
   * turn routed to the server via `chat-send-background.ts`), not a delegated
   * sub-Coder. When set, `coder-job-do.ts` runs the kernel in `leadMode` — the
   * high invisible round backstop and the lead's graceful, name-free close
   * instead of the delegated "[Coder stopped after N rounds…]" wall and the
   * Coder identity/voice. Genuinely delegated sub-Coders leave it unset.
   */
  leadMode?: boolean;
  /** Session-level verification policy passed through from the conversation. */
  verificationPolicy?: VerificationPolicy;
  /**
   * Capabilities declared for this delegation run.
   * When present, the capability ledger enforces that only declared
   * capabilities are used. Logged for post-run audit.
   */
  declaredCapabilities?: import('../lib/capabilities').Capability[];
  /**
   * Passive correlation tags carried across the delegation boundary so
   * tool-execution spans can attach `push.chat_id`, `push.execution_id`,
   * `push.task_graph_id`, etc. See `lib/correlation-context.ts` for the
   * hard rule that these fields never alter tool behavior.
   */
  correlation?: import('@push/lib/correlation-context').CorrelationContext;
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
  /** Foreground branch at dispatch — see {@link DelegationEnvelope.originBranch}. */
  originBranch?: string;
  provider: AIProviderType;
  model?: string;
  projectInstructions?: string;
  instructionFilename?: string;
}

export interface ExplorerCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  /**
   * Optional run-event sink. Forwarded to the lib kernel so the
   * `assistant.prompt_snapshot` event reaches the chat run-event stream
   * for this delegation. When unset, no event is emitted.
   */
  onRunEvent?: (event: import('@push/lib/runtime-contract').RunEventInput) => void;
}

export interface ExplorerResult {
  summary: string;
  cards: ChatCard[];
  rounds: number;
  /** True when the loop exhausted MAX_EXPLORER_ROUNDS without a clean finish. */
  hitRoundCap?: boolean;
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
  /** Foreground branch at dispatch — see {@link DelegationEnvelope.originBranch}. */
  originBranch?: string;
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
  tokenKind: GitHubTokenKind;
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
  | 'tokenKind'
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
  /** Phase 2.f Remote (relay) tile. Optional so a build without
   * VITE_RELAY_MODE doesn't need to plumb a no-op handler. */
  onStartRelay?: () => void;
  /** Tap-to-resume: enter (or re-target) the Remote chat surface
   * attached to a specific daemon session. Callers supply the
   * per-session bearer they obtained via `grant_session_attach`.
   * Optional for the same VITE_RELAY_MODE reason as onStartRelay. */
  onResumeRelaySession?: (targetSessionId: string, targetAttachToken: string) => void;
  onEndWorkspace: () => void;
  /** Opens the pre-flight composer overlay. Callers can pass a seed
   * to prefill the target repo/branch/mode (e.g. "new chat in this repo"). */
  onOpenDraftComposer: (seed?: DraftComposerSeed | null) => void;
}

export interface WorkspaceScreenHomeBridgeProps {
  pendingResumeChatId: string | null;
  onConversationIndexChange: (index: ConversationIndex) => void;
  /** Set by the pre-flight menu on confirm. The workspace drains it by
   * ensuring an empty chat exists, then — when `provider` is set —
   * upserting that chat's draft so the first-send-anchors-lock
   * mechanism pins the chat to the menu's pick without touching the
   * catalog-wide default. Cross-context commits remount the workspace
   * and rely on the chat-management auto-create effect to land on an
   * empty chat; same-context commits keep the session and the drain
   * has to mint the fresh chat itself. */
  pendingNewChat: PendingNewChat | null;
  onPendingNewChatConsumed: () => void;
  /** Invoked when the user taps a chat in the in-workspace Chats drawer.
   * The App handler migrates the workspace session to match the chat's
   * mode/repo/branch (preserving the existing session when the context
   * already matches), then sets pendingResumeChatId so
   * useWorkspaceSessionBridge routes activeChatId to the tapped chat. */
  onResumeChatFromDrawer: (chatId: string) => void;
}

export interface PendingNewChat {
  key: string;
  provider: import('@/lib/providers').PreferredProvider | null;
  model: string | null;
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
  /** Shared model catalog instance. Lifted to App so the pre-flight
   * composer can show the same configured-provider list as the
   * in-workspace ChatInput without double-mounting `useModelCatalog`. */
  catalog: import('@/hooks/useModelCatalog').ModelCatalog;
}

// ─── Tool render-payload vocabulary ────────────────────────────────────────
// Defined ONCE in `lib/tool-cards.ts`; imported here so declarations in this
// file can reference the names, and re-exported so every existing
// `from '@/types'` import keeps working. It is cross-surface semantics — the
// TUI dispatches on the same union — so it must NOT be redeclared on a surface.
// Add new card types in lib/, never here. Guarded by
// `cli/tests/tool-cards-drift.test.mjs`.
// See `docs/decisions/Tool Render Payload — Cards Are Declared, Not Sniffed.md`.
import type {
  ToolCard,
  ApprovalCardCategory,
  ApprovalCardData,
  ArtifactCardData,
  BackgroundJobStatus,
  BranchListCardData,
  CICheck,
  CIOverallStatus,
  CIStatus,
  CIStatusCardData,
  CoderJobCardData,
  CommitFilesCardData,
  CommitListCardData,
  CommitReviewCardData,
  DelegationResultCardData,
  DiffPreviewCardData,
  EditorCardData,
  EvaluationCardData,
  FileCardData,
  FileListCardData,
  FileSearchCardData,
  FileSearchMatch,
  PRCardData,
  PRIssueComment,
  PRListCardData,
  PRReviewComment,
  PushPlanSummary,
  SandboxCardData,
  SandboxDownloadCardData,
  SandboxStateCardData,
  TestResultsCardData,
  TypeCheckCardData,
  WebSearchCardData,
  WebSearchResult,
  WorkflowJob,
  WorkflowJobStep,
  WorkflowLogsCardData,
  WorkflowRunItem,
  WorkflowRunsCardData,
} from '@push/lib/tool-cards';
// These two were DUPLICATED here and in lib/; `CoderWorkingMemory` had already
// drifted (the web copy was missing `validationCommands`). Now single-sourced.
import type { CoderWorkingMemory } from '@push/lib/working-memory';
import type { AskUserCardData } from '@push/lib/ask-user-tools';

/** @deprecated Prefer `ToolCard`. Kept so existing call sites compile. */
export type ChatCard = ToolCard;

export type {
  ToolCard,
  AskUserCardData,
  CoderWorkingMemory,
  ApprovalCardCategory,
  ApprovalCardData,
  ArtifactCardData,
  BackgroundJobStatus,
  BranchListCardData,
  CICheck,
  CIOverallStatus,
  CIStatus,
  CIStatusCardData,
  CoderJobCardData,
  CommitFilesCardData,
  CommitListCardData,
  CommitReviewCardData,
  DelegationResultCardData,
  DiffPreviewCardData,
  EditorCardData,
  EvaluationCardData,
  FileCardData,
  FileListCardData,
  FileSearchCardData,
  FileSearchMatch,
  PRCardData,
  PRIssueComment,
  PRListCardData,
  PRReviewComment,
  PushPlanSummary,
  SandboxCardData,
  SandboxDownloadCardData,
  SandboxStateCardData,
  TestResultsCardData,
  TypeCheckCardData,
  WebSearchCardData,
  WebSearchResult,
  WorkflowJob,
  WorkflowJobStep,
  WorkflowLogsCardData,
  WorkflowRunItem,
  WorkflowRunsCardData,
};
