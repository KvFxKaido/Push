/**
 * Centralized factories for ChatMessage construction.
 *
 * Slice 2 (PR #TBD) introduces per-message branch attribution: each message
 * records the branch active at write time. To avoid scattering
 * `branch: currentBranch` stamps across every site that creates a message,
 * route new code through these factories — they capture branch (and any
 * other write-time provenance) in one place.
 *
 * Existing pre-slice-2 message creation sites are NOT migrated by this
 * commit; they continue to omit `branch`, and the read-boundary fallback
 * (`effectiveMessageBranch`) supplies `conv.branch` as the default when
 * messages are loaded. Slice 2's R12 mitigation backfills the field
 * atomically when a conversation is migrated to a new branch — see the
 * design doc for the invariant.
 */

import type { BranchForkedMeta, BranchMergedMeta, BranchSwitchSource, ChatMessage } from '@/types';

/** Generate a stable conversation-relative message id. Mirrors the existing
 *  inline `crypto.randomUUID()` calls scattered across message-creation
 *  sites. Centralized here so future changes to id format land in one place. */
function createMessageId(): string {
  return crypto.randomUUID();
}

interface CreateMessageInput {
  role: ChatMessage['role'];
  content: string;
  /** The branch active when this message is being created. Stamped onto the
   *  message at write time. Pass `undefined` for messages created outside a
   *  branch context (the `effectiveMessageBranch` fallback handles read-side
   *  defaulting). */
  currentBranch: string | undefined;
  /** Optional override for the auto-generated id (e.g. when reconstructing a
   *  message from a server-side identifier). */
  id?: string;
  /** Optional override for the auto-generated timestamp. */
  timestamp?: number;
  /** Additional ChatMessage fields the caller wants to set (cards, status,
   *  isToolCall, etc.). Passed through verbatim. */
  extra?: Partial<Omit<ChatMessage, 'id' | 'role' | 'content' | 'timestamp' | 'branch'>>;
}

/** Create a plain user/assistant message with branch stamped. */
export function createMessage(input: CreateMessageInput): ChatMessage {
  return {
    id: input.id ?? createMessageId(),
    role: input.role,
    content: input.content,
    timestamp: input.timestamp ?? Date.now(),
    ...(input.currentBranch !== undefined ? { branch: input.currentBranch } : {}),
    ...input.extra,
  };
}

interface CreateBranchForkedMessageInput {
  /** Source branch the fork came from. */
  from: string;
  /** Target branch the workspace switched to. */
  to: string;
  /** Commit SHA of the new branch's HEAD, when known. */
  sha?: string;
  /** Producer that triggered the fork (sandbox tool, UI button, etc.). */
  source?: BranchSwitchSource;
  /** Optional id override. */
  id?: string;
  /** Optional timestamp override. */
  timestamp?: number;
}

/** Create a typed `branch_forked` system event for insertion into a
 *  conversation after a successful fork. The event is `visibleToModel: false`
 *  by default — it's transcript metadata, not a model directive. The
 *  prompt-builder is responsible for synthesizing a directive from this
 *  event's payload when appropriate (see slice 2 D6).
 *
 *  The event stamps itself with the NEW branch (`to`), since by the time it
 *  is written the fork has already happened. */
export function createBranchForkedMessage(input: CreateBranchForkedMessageInput): ChatMessage {
  const meta: BranchForkedMeta = {
    from: input.from,
    to: input.to,
    ...(input.sha ? { sha: input.sha } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
  return {
    id: input.id ?? createMessageId(),
    // 'assistant' role keeps the message inside the existing role union (the
    // codebase doesn't currently model a `system` role on ChatMessage). The
    // `kind` discriminator + `visibleToModel: false` flag are what make this
    // a transcript event rather than a model-visible message.
    role: 'assistant',
    content: '',
    timestamp: input.timestamp ?? Date.now(),
    branch: input.to,
    kind: 'branch_forked',
    branchForkedMeta: meta,
    visibleToModel: false,
  };
}

interface CreateBranchMergedMessageInput {
  /** Source branch the PR merged from (now defunct in the workspace). */
  from: string;
  /** Target branch the workspace switched to (typically the default branch). */
  to: string;
  /** PR number that triggered this migration, when known. */
  prNumber?: number;
  /** Producer that triggered the merge transition. Currently always
   *  `'ui-merge'` (MergeFlowSheet); future model-driven merge paths will
   *  reuse this factory. */
  source?: BranchSwitchSource;
  id?: string;
  timestamp?: number;
}

/** Create a typed `branch_merged` system event for insertion into a
 *  conversation after a successful PR merge migrates the chat to the
 *  default branch. Mirrors `createBranchForkedMessage` — same transcript-
 *  metadata shape (`visibleToModel: false`, empty content, stamped with the
 *  NEW branch). Renderer in `MessageBubble.tsx` draws a centered "Merged
 *  X → Y" divider, parallel to the forked divider. */
export function createBranchMergedMessage(input: CreateBranchMergedMessageInput): ChatMessage {
  const meta: BranchMergedMeta = {
    from: input.from,
    to: input.to,
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
  return {
    id: input.id ?? createMessageId(),
    role: 'assistant',
    content: '',
    timestamp: input.timestamp ?? Date.now(),
    branch: input.to,
    kind: 'branch_merged',
    branchMergedMeta: meta,
    visibleToModel: false,
  };
}

/** Read-boundary fallback: returns the branch that should be attributed to
 *  this message. Stamped messages return their own `branch`; legacy messages
 *  fall back to the parent conversation's branch, then to `'main'`.
 *
 *  Apply this once at the persistence load layer or where branch attribution
 *  is needed for display / filtering. Do NOT scatter the `??` chain across
 *  render sites — fallback policy lives here. */
export function effectiveMessageBranch(
  msg: Pick<ChatMessage, 'branch'>,
  conversationBranch: string | undefined,
): string {
  return msg.branch ?? conversationBranch ?? 'main';
}

/** Centralized prompt-pack filter: strip messages explicitly marked
 *  `visibleToModel: false`. Apply at every site that converts ChatMessage[]
 *  into LLM-ready messages. Currently used by `toLLMMessages` in the
 *  orchestrator (foreground packer); the auditor/coder/explorer agents
 *  consume structured inputs (diff, task, file context) rather than raw
 *  conversation messages, so they don't need to filter.
 *
 *  Default behavior (undefined) is model-visible. Only an explicit `false`
 *  filters the message — slice 2's `branch_forked` event is the first
 *  consumer of the flag. */
export function filterModelVisibleMessages<M extends Pick<ChatMessage, 'visibleToModel'>>(
  messages: readonly M[],
): M[] {
  return messages.filter((m) => m.visibleToModel !== false);
}

/** In-memory guard for an in-progress conversation-fork migration. Held in a
 *  ref by the migrating tab. Set immediately when a `'forked'` branchSwitch
 *  arrives; cleared by a state-observed effect once the migration is
 *  observable in the rendered state. While set, `useChat`'s auto-switch
 *  effect early-returns to avoid auto-creating or chat-id-stealing during
 *  the in-flight transition.
 *
 *  Cross-tab coordination is separate (see `branch-migration-marker.ts`). */
export interface MigrationGuard {
  chatId: string;
  toBranch: string;
}
