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

import type { BranchForkedMeta, BranchSwitchSource, ChatMessage } from '@/types';

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
