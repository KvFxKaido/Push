/**
 * RunCheckpoint v1 — the per-turn orchestrator run checkpoint for Durable
 * Runs (Adopt-on-Silence), Phase 1. See
 * `docs/decisions/Durable Runs — Adopt-on-Silence.md` (§Phase 1 and the
 * gap analysis recorded there).
 *
 * Design rules, in order of importance:
 *
 * 1. **Self-contained state.** The Resumable Sessions checkpoint
 *    (`app/src/types` RunCheckpoint) is a client-anchored delta — it
 *    indexes into the browser's IndexedDB conversation
 *    (`baseMessageCount`) and leans on live refs for everything else. A
 *    RunHost DO adopting a run has none of that, so this schema carries
 *    the full LLM-visible transcript and every piece of loop state the
 *    server-side kernels need to continue mid-run.
 *
 * 2. **Credentials are out-of-band, ALWAYS.** Sandbox owner tokens,
 *    provider API keys, and GitHub tokens are provisioned at adoption
 *    time (the CoderJobStartInput precedent), never persisted in a
 *    checkpoint. This is a hard runtime boundary, not a convention:
 *    `validateRunCheckpoint` rejects top-level fields whose names look
 *    credential-shaped.
 *
 * 3. **Permissive on benign extras.** Same discipline as
 *    `protocol-schema.ts`: unknown extra fields don't fail validation,
 *    so additive evolution doesn't break older validators. The exact
 *    required/optional field sets are pinned by
 *    `cli/tests/run-checkpoint-drift.test.mjs` — extending the schema
 *    means updating the pin in the same PR.
 *
 * Capture-side wiring (the web loop writing this shape per turn) is the
 * follow-up PR; checkpoint size/cost is measured there
 * (`estimateRunCheckpointBytes` is the instrument) and tiered if needed.
 */

import type { ApprovalMode } from './approval-gates.ts';
import type {
  LlmContentBlock,
  LlmContentPart,
  LlmToolResultBlock,
  LlmToolUseBlock,
  ReasoningBlock,
  ResponsesReasoningItem,
} from './provider-contract.ts';
import { parseResponsesReasoningItem } from './responses-reasoning-item.ts';
import { type ValidationIssue, isStrictModeEnabled } from './protocol-schema.ts';
import type { LoopPhase } from './runtime-contract.ts';
import type { VerificationPolicy } from './verification-policy.ts';
import type { CoderWorkingMemory } from './working-memory.ts';

export const RUN_CHECKPOINT_VERSION = 1;

/** Why this checkpoint was written. `turn` is the steady-state per-turn
 * capture adoption relies on; the other three carry over the Resumable
 * Sessions vocabulary for interrupt/expiry flows. */
export type RunCheckpointReason = 'turn' | 'interrupt' | 'expiry' | 'manual';

const REASONS: ReadonlySet<string> = new Set(['turn', 'interrupt', 'expiry', 'manual']);

const PHASES: ReadonlySet<string> = new Set([
  'streaming_llm',
  'executing_tools',
  'delegating_coder',
  'delegating_explorer',
  'executing_task_graph',
]);

const APPROVAL_MODES: ReadonlySet<string> = new Set(['supervised', 'autonomous', 'full-auto']);

/** One LLM-visible transcript entry. Reasoning blocks ride along so
 * Anthropic signed-reasoning turns round-trip verbatim after adoption;
 * `contentBlocks` carries the canonical multimodal representation for newly
 * captured attachment turns; `contentParts` remains for old checkpoints and
 * kernel-originated turns that already materialized the legacy shape. `content`
 * stays the text fallback, exactly the `LlmMessage` contract. A string-only
 * transcript would silently resume image-bearing runs as text-only. */
export interface RunCheckpointMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  contentBlocks?: LlmContentBlock[];
  contentParts?: LlmContentPart[];
  reasoningBlocks?: ReasoningBlock[];
  responsesReasoningItems?: ResponsesReasoningItem[];
  toolUses?: LlmToolUseBlock[];
  toolResults?: LlmToolResultBlock[];
  isToolCall?: boolean;
  isToolResult?: boolean;
}

/** Approval gate the run is parked on (supervised runs PAUSE here while
 * adopted — full-auto never sets this). */
export interface RunCheckpointPendingApproval {
  approvalId: string;
  kind: string;
  /** The gated tool, carried explicitly so a Phase 3 approval grant can be
   * matched on relaunch without parsing the approvalId. */
  tool?: string;
  /** Deterministic fingerprint of the gated call's arguments
   * (`fingerprintApprovalArgs` in run-adoption-loop.ts). An approval grant
   * is bound to tool + fingerprint, so the user approves THIS action — a
   * same-tool call with different arguments re-pauses instead of riding
   * the grant. */
  argsFingerprint?: string;
  title?: string;
  summary?: string;
}

export interface RunCheckpointV1 {
  v: typeof RUN_CHECKPOINT_VERSION;

  // --- Identity & scope (durable identifiers first — web chatId is
  // durable, but repoFullName+branch is the cross-surface scope key) ---
  chatId: string;
  repoFullName: string;
  branch: string;
  workspaceSessionId?: string;
  runId?: string;

  // --- Run position ---
  round: number;
  phase: LoopPhase;
  savedAt: number;
  reason: RunCheckpointReason;
  userAborted?: boolean;

  // --- Self-contained loop state ---
  /** Full LLM-visible transcript including tool results. NOT a delta. */
  messages: RunCheckpointMessage[];
  /** Partial assistant text of the in-flight turn (empty when the
   * checkpoint was written at a turn boundary). */
  accumulated: string;
  thinkingAccumulated: string;
  /** The user-goal anchor: the original task / latest user intent, so an
   * adopted run can re-ground without re-deriving it from the transcript. */
  userGoal: string;

  // --- Provider lock (the chat lock travels with the run) ---
  provider: string;
  model: string;
  /** Transport options the lock implies that aren't derivable server-side
   * (e.g. the Zen "Go" routing flag, which lives in browser localStorage). */
  providerOptions?: { zenGo?: boolean };

  // --- Semantics while adopted ---
  approvalMode: ApprovalMode;
  verificationPolicy?: VerificationPolicy;
  pendingApproval?: RunCheckpointPendingApproval | null;

  // --- Memory & delegation ---
  workingMemory?: CoderWorkingMemory;
  delegation?: { active: boolean; lastCoderState?: string | null };

  // --- Sandbox linkage: identity ONLY, never credentials ---
  sandboxSessionId?: string | null;
  /** Uncommitted-diff snapshot for cold resume (expiry flows). */
  savedDiff?: string;

  // --- Attach anchor (Phase 3): run-event seq the transcript is
  // consistent with, so a reattaching client can cursor-follow. ---
  lastEventSeq?: number;
}

// ---------------------------------------------------------------------------
// Field sets — exported so the drift pin asserts against the real thing
// ---------------------------------------------------------------------------

export const RUN_CHECKPOINT_REQUIRED_FIELDS = [
  'v',
  'chatId',
  'repoFullName',
  'branch',
  'round',
  'phase',
  'savedAt',
  'reason',
  'messages',
  'accumulated',
  'thinkingAccumulated',
  'userGoal',
  'provider',
  'model',
  'approvalMode',
] as const;

export const RUN_CHECKPOINT_OPTIONAL_FIELDS = [
  'workspaceSessionId',
  'runId',
  'userAborted',
  'providerOptions',
  'verificationPolicy',
  'pendingApproval',
  'workingMemory',
  'delegation',
  'sandboxSessionId',
  'savedDiff',
  'lastEventSeq',
] as const;

/**
 * Hard boundary: a checkpoint is durable storage, and credentials never
 * enter durable storage (Universal Session Bearer / owner-token discipline).
 * Field names matching this pattern fail validation outright — at ANY
 * nesting depth, so a sanctioned object field (`providerOptions`,
 * `workingMemory`, a benign unknown extra) can't smuggle a secret through.
 * Adoption-time provisioning is the only path for secrets.
 *
 * Exemption: `reasoningBlocks` and `responsesReasoningItems` subtrees are
 * provider-authored replay blobs that must round-trip byte-identical; their
 * keys are provider vocabulary, not ours, so they're skipped.
 */
export const CREDENTIAL_FIELD_PATTERN = /token|secret|password|credential|bearer|api.?key/i;

const CREDENTIAL_SCAN_EXEMPT_KEYS: ReadonlySet<string> = new Set([
  'reasoningBlocks',
  'responsesReasoningItems',
]);
const CREDENTIAL_SCAN_MAX_DEPTH = 12;

function scanCredentialKeys(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  depth = 0,
): void {
  if (depth > CREDENTIAL_SCAN_MAX_DEPTH) return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => scanCredentialKeys(entry, `${path}[${i}]`, issues, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (CREDENTIAL_FIELD_PATTERN.test(key)) {
      issues.push(
        issue(
          childPath,
          `credential-shaped field "${childPath}" must never be stored in a checkpoint`,
        ),
      );
      continue;
    }
    if (CREDENTIAL_SCAN_EXEMPT_KEYS.has(key)) continue;
    scanCredentialKeys(child, childPath, issues, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Validation — hand-rolled, dependency-free, permissive on benign extras
// ---------------------------------------------------------------------------

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateContentPart(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'content part must be an object'));
    return;
  }
  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      issues.push(issue(`${path}.text`, 'text part must carry a string `text`'));
    }
  } else if (value.type === 'image_url') {
    const imageUrl = value.image_url;
    if (!isPlainObject(imageUrl) || typeof imageUrl.url !== 'string') {
      issues.push(issue(`${path}.image_url`, 'image_url part must carry `image_url.url` string'));
    }
  } else {
    issues.push(issue(`${path}.type`, `unknown content part type: ${String(value.type)}`));
  }
}

function validateImageSource(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'image source must be an object'));
    return;
  }
  if (value.type === 'base64') {
    if (typeof value.media_type !== 'string' || value.media_type.length === 0) {
      issues.push(issue(`${path}.media_type`, 'base64 image source must carry media_type'));
    }
    if (typeof value.data !== 'string') {
      issues.push(issue(`${path}.data`, 'base64 image source must carry data'));
    }
  } else if (value.type === 'url') {
    if (typeof value.url !== 'string' || value.url.length === 0) {
      issues.push(issue(`${path}.url`, 'url image source must carry url'));
    }
  } else {
    issues.push(issue(`${path}.type`, `unknown image source type: ${String(value.type)}`));
  }
}

function validateContentBlock(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'content block must be an object'));
    return;
  }
  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      issues.push(issue(`${path}.text`, 'text block must carry a string `text`'));
    }
  } else if (value.type === 'image') {
    validateImageSource(value.source, `${path}.source`, issues);
  } else if (value.type === 'thinking') {
    if (typeof value.text !== 'string') {
      issues.push(issue(`${path}.text`, 'thinking block must carry a string `text`'));
    }
    if (typeof value.signature !== 'string') {
      issues.push(issue(`${path}.signature`, 'thinking block must carry a string `signature`'));
    }
  } else if (value.type === 'redacted_thinking') {
    if (typeof value.data !== 'string') {
      issues.push(issue(`${path}.data`, 'redacted_thinking block must carry a string `data`'));
    }
  } else if (value.type === 'tool_use') {
    validateToolUseBlock(value, path, issues);
  } else if (value.type === 'tool_result') {
    validateToolResultBlock(value, path, issues);
  } else {
    issues.push(issue(`${path}.type`, `unknown content block type: ${String(value.type)}`));
  }
}

function validateToolUseBlock(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'tool_use block must be an object'));
    return;
  }
  if (value.type !== 'tool_use') {
    issues.push(issue(`${path}.type`, 'tool_use block must carry type "tool_use"'));
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    issues.push(issue(`${path}.id`, 'tool_use block must carry a non-empty id'));
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    issues.push(issue(`${path}.name`, 'tool_use block must carry a non-empty name'));
  }
  if (!isPlainObject(value.input)) {
    issues.push(issue(`${path}.input`, 'tool_use block input must be an object'));
  }
}

function validateToolResultBlock(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'tool_result block must be an object'));
    return;
  }
  if (value.type !== 'tool_result') {
    issues.push(issue(`${path}.type`, 'tool_result block must carry type "tool_result"'));
  }
  if (typeof value.tool_use_id !== 'string' || value.tool_use_id.length === 0) {
    issues.push(
      issue(`${path}.tool_use_id`, 'tool_result block must carry a non-empty tool_use_id'),
    );
  }
  if (typeof value.content !== 'string') {
    issues.push(issue(`${path}.content`, 'tool_result block content must be a string'));
  }
  if (value.is_error !== undefined && typeof value.is_error !== 'boolean') {
    issues.push(issue(`${path}.is_error`, 'tool_result block is_error must be a boolean'));
  }
}

function validateMessage(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'message must be an object'));
    return;
  }
  const role = value.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    issues.push(issue(`${path}.role`, `invalid role: ${String(role)}`));
  }
  if (typeof value.content !== 'string') {
    issues.push(issue(`${path}.content`, 'content must be a string'));
  }
  if (value.contentParts !== undefined) {
    if (!Array.isArray(value.contentParts)) {
      issues.push(issue(`${path}.contentParts`, 'contentParts must be an array when present'));
    } else {
      value.contentParts.forEach((p, i) =>
        validateContentPart(p, `${path}.contentParts[${i}]`, issues),
      );
    }
  }
  if (value.contentBlocks !== undefined) {
    if (!Array.isArray(value.contentBlocks)) {
      issues.push(issue(`${path}.contentBlocks`, 'contentBlocks must be an array when present'));
    } else {
      value.contentBlocks.forEach((block, i) =>
        validateContentBlock(block, `${path}.contentBlocks[${i}]`, issues),
      );
    }
  }
  if (value.reasoningBlocks !== undefined && !Array.isArray(value.reasoningBlocks)) {
    issues.push(issue(`${path}.reasoningBlocks`, 'reasoningBlocks must be an array when present'));
  }
  if (value.responsesReasoningItems !== undefined) {
    if (!Array.isArray(value.responsesReasoningItems)) {
      issues.push(
        issue(
          `${path}.responsesReasoningItems`,
          'responsesReasoningItems must be an array when present',
        ),
      );
    } else {
      value.responsesReasoningItems.forEach((item, i) => {
        if (!parseResponsesReasoningItem(item)) {
          issues.push(
            issue(
              `${path}.responsesReasoningItems[${i}]`,
              'invalid encrypted Responses reasoning item',
            ),
          );
        }
      });
    }
  }
  if (value.toolUses !== undefined) {
    if (!Array.isArray(value.toolUses)) {
      issues.push(issue(`${path}.toolUses`, 'toolUses must be an array when present'));
    } else {
      value.toolUses.forEach((block, i) =>
        validateToolUseBlock(block, `${path}.toolUses[${i}]`, issues),
      );
    }
  }
  if (value.toolResults !== undefined) {
    if (!Array.isArray(value.toolResults)) {
      issues.push(issue(`${path}.toolResults`, 'toolResults must be an array when present'));
    } else {
      value.toolResults.forEach((block, i) =>
        validateToolResultBlock(block, `${path}.toolResults[${i}]`, issues),
      );
    }
  }
}

/** Validate a candidate RunCheckpoint. Returns [] when valid. */
export function validateRunCheckpoint(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(value)) {
    return [issue('', 'checkpoint must be an object')];
  }

  // Credential boundary first — deep scan, so nested objects (sanctioned
  // or unknown-extra) can't smuggle a secret past a top-level-only check.
  scanCredentialKeys(value, '', issues);

  if (value.v !== RUN_CHECKPOINT_VERSION) {
    issues.push(issue('v', `expected version ${RUN_CHECKPOINT_VERSION}, got ${String(value.v)}`));
  }
  for (const key of ['chatId', 'repoFullName', 'branch'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      issues.push(issue(key, `${key} must be a non-empty string`));
    }
  }
  if (typeof value.round !== 'number' || !Number.isInteger(value.round) || value.round < 0) {
    issues.push(issue('round', 'round must be a non-negative integer'));
  }
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) {
    issues.push(issue('phase', `invalid phase: ${String(value.phase)}`));
  }
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt <= 0) {
    issues.push(issue('savedAt', 'savedAt must be a positive epoch-ms number'));
  }
  if (typeof value.reason !== 'string' || !REASONS.has(value.reason)) {
    issues.push(issue('reason', `invalid reason: ${String(value.reason)}`));
  }
  if (!Array.isArray(value.messages)) {
    issues.push(issue('messages', 'messages must be an array'));
  } else {
    value.messages.forEach((m, i) => validateMessage(m, `messages[${i}]`, issues));
  }
  for (const key of ['accumulated', 'thinkingAccumulated', 'userGoal'] as const) {
    if (typeof value[key] !== 'string') {
      issues.push(issue(key, `${key} must be a string`));
    }
  }
  for (const key of ['provider', 'model'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      issues.push(issue(key, `${key} must be a non-empty string`));
    }
  }
  if (typeof value.approvalMode !== 'string' || !APPROVAL_MODES.has(value.approvalMode)) {
    issues.push(issue('approvalMode', `invalid approvalMode: ${String(value.approvalMode)}`));
  }

  // Optional fields — typed when present.
  if (value.workspaceSessionId !== undefined && typeof value.workspaceSessionId !== 'string') {
    issues.push(issue('workspaceSessionId', 'must be a string when present'));
  }
  if (value.runId !== undefined && typeof value.runId !== 'string') {
    issues.push(issue('runId', 'must be a string when present'));
  }
  if (value.userAborted !== undefined && typeof value.userAborted !== 'boolean') {
    issues.push(issue('userAborted', 'must be a boolean when present'));
  }
  if (value.providerOptions !== undefined && !isPlainObject(value.providerOptions)) {
    issues.push(issue('providerOptions', 'must be an object when present'));
  }
  if (value.pendingApproval !== undefined && value.pendingApproval !== null) {
    if (!isPlainObject(value.pendingApproval)) {
      issues.push(issue('pendingApproval', 'must be an object or null when present'));
    } else {
      if (
        typeof value.pendingApproval.approvalId !== 'string' ||
        value.pendingApproval.approvalId.length === 0
      ) {
        issues.push(issue('pendingApproval.approvalId', 'must be a non-empty string'));
      }
      if (typeof value.pendingApproval.kind !== 'string') {
        issues.push(issue('pendingApproval.kind', 'must be a string'));
      }
      if (
        value.pendingApproval.tool !== undefined &&
        typeof value.pendingApproval.tool !== 'string'
      ) {
        issues.push(issue('pendingApproval.tool', 'must be a string when present'));
      }
      if (
        value.pendingApproval.argsFingerprint !== undefined &&
        typeof value.pendingApproval.argsFingerprint !== 'string'
      ) {
        issues.push(issue('pendingApproval.argsFingerprint', 'must be a string when present'));
      }
    }
  }
  if (value.workingMemory !== undefined && !isPlainObject(value.workingMemory)) {
    issues.push(issue('workingMemory', 'must be an object when present'));
  }
  if (value.delegation !== undefined) {
    if (!isPlainObject(value.delegation) || typeof value.delegation.active !== 'boolean') {
      issues.push(issue('delegation', 'must be an object with boolean `active` when present'));
    }
  }
  if (
    value.sandboxSessionId !== undefined &&
    value.sandboxSessionId !== null &&
    typeof value.sandboxSessionId !== 'string'
  ) {
    issues.push(issue('sandboxSessionId', 'must be a string or null when present'));
  }
  if (value.savedDiff !== undefined && typeof value.savedDiff !== 'string') {
    issues.push(issue('savedDiff', 'must be a string when present'));
  }
  if (value.lastEventSeq !== undefined) {
    if (
      typeof value.lastEventSeq !== 'number' ||
      !Number.isInteger(value.lastEventSeq) ||
      value.lastEventSeq < 0
    ) {
      issues.push(issue('lastEventSeq', 'must be a non-negative integer when present'));
    }
  }

  return issues;
}

/** True when `value` is a structurally valid RunCheckpointV1. */
export function isValidRunCheckpoint(value: unknown): value is RunCheckpointV1 {
  return validateRunCheckpoint(value).length === 0;
}

/**
 * Throw on an invalid checkpoint. Same contract as
 * `protocol-schema.assertValidEvent`: the throw is unconditional once
 * called — callers gate on `isStrictModeEnabled()` for observe-mode
 * deployments (use `shouldAssertRunCheckpoints()` for the common gate).
 */
export function assertValidRunCheckpoint(value: unknown): asserts value is RunCheckpointV1 {
  const issues = validateRunCheckpoint(value);
  if (issues.length > 0) {
    const detail = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    throw new Error(`Invalid RunCheckpoint: ${detail}`);
  }
}

/** The common strict-mode gate, re-exported so checkpoint writers don't
 * need to import protocol-schema directly. */
export function shouldAssertRunCheckpoints(): boolean {
  return isStrictModeEnabled();
}

/**
 * Size instrument for the Phase 1 "checkpoint size/cost per turn" risk —
 * UTF-8 byte length of the serialized checkpoint. Tiering decisions key
 * off this; capture-side code should log it per write.
 */
export function estimateRunCheckpointBytes(checkpoint: RunCheckpointV1): number {
  return new TextEncoder().encode(JSON.stringify(checkpoint)).length;
}
