/**
 * Centralized factories for ChatMessage construction.
 *
 * Every message authored inside a branch-aware workspace records the branch
 * active at write time. That per-message stamp is durable provenance: once a
 * conversation's branch becomes mutable session state, read-time fallbacks to
 * `conv.branch` would rewrite history.
 */

import type {
  BranchForkedMeta,
  BranchMergedMeta,
  BranchSwitchSource,
  ChatMessage,
  CompactionMeta,
} from '@/types';

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
   *  branch context; read-side defaulting no longer consults conversation
   *  branch state. */
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

export interface BranchInfoLike {
  currentBranch?: string;
  defaultBranch?: string;
}

/** Resolve the branch to stamp on a newly-authored message. Prefer the live
 *  sandbox-tracked branch; fall back to the conversation branch when a caller is
 *  writing against persisted state; finally use the default branch when that is
 *  the only branch context available. */
export function resolveMessageWriteBranch(
  branchInfo: BranchInfoLike | undefined,
  conversationBranch?: string,
): string | undefined {
  return branchInfo?.currentBranch ?? conversationBranch ?? branchInfo?.defaultBranch;
}

/** Stamp a new message with branch provenance without clobbering a deliberate
 *  branch already set by the caller (for example delegate originBranch). */
export function stampMessageBranch<T extends { branch?: ChatMessage['branch'] }>(
  message: T,
  branch: string | undefined,
): T {
  if (message.branch !== undefined || branch === undefined) return message;
  return { ...message, branch };
}

export function stampMessagesBranch<T extends { branch?: ChatMessage['branch'] }>(
  messages: readonly T[],
  branch: string | undefined,
): T[] {
  if (branch === undefined) return [...messages];
  let changed = false;
  const stamped = messages.map((message) => {
    if (message.branch !== undefined) return message;
    changed = true;
    return { ...message, branch };
  });
  return changed ? stamped : [...messages];
}

export function backfillConversationMessageBranches<T extends ConversationLikeForBackfill>(
  conversation: T,
): { conversation: T; changed: boolean } {
  const branch = conversation.branch ?? (conversation.repoFullName ? 'main' : undefined);
  if (!branch) return { conversation, changed: false };
  let changed = false;
  const messages = conversation.messages.map((message) => {
    if (message.branch !== undefined) return message;
    changed = true;
    return { ...message, branch };
  });
  if (!changed) return { conversation, changed: false };
  return { conversation: { ...conversation, messages }, changed: true };
}

interface ConversationLikeForBackfill {
  messages: ChatMessage[];
  branch?: string;
  repoFullName?: string;
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

/** Compaction count at/above which the UI surfaces the "multiple compactions can
 *  blur older context — consider a fresh branch" degradation nudge. The first
 *  compaction is routine; the second is when "multiple compactions" becomes true
 *  (mirrors the same post-compaction warning Codex emits). */
export const COMPACTION_DEGRADATION_THRESHOLD = 2;

/** 1-based ordinal of the NEXT compaction marker for a conversation: counts every
 *  prior `kind:'compaction'` marker (they persist `visibleToModel:false`, so they
 *  stay in the message list). Shared by BOTH marker sites — the pre-turn LLM
 *  handoff (`chat-compaction.ts`) and the in-turn heuristic drain
 *  (`chat-stream-round.ts`) — so the degradation nudge counts every compaction,
 *  regardless of which path trimmed the window. */
export function nextCompactionCount(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.kind === 'compaction').length + 1;
}

interface CreateCompactionMessageInput extends CompactionMeta {
  /** Branch active when the compaction happened, stamped for attribution. */
  branch?: string;
  id?: string;
  timestamp?: number;
}

/** Create a typed `compaction` transcript marker for insertion when the
 *  runtime trims the working context for a turn. Mirrors the branch-event
 *  factories — `visibleToModel: false`, empty content, rendered by
 *  `MessageBubble.tsx` as a centered "Compacted context X → Y" divider. The
 *  durable counterpart to the transient "Compacting context…" status pill. */
export function createCompactionMessage(input: CreateCompactionMessageInput): ChatMessage {
  const meta: CompactionMeta = {
    beforeTokens: input.beforeTokens,
    afterTokens: input.afterTokens,
    phase: input.phase,
    messagesDropped: input.messagesDropped,
    ...(input.compactionCount !== undefined ? { compactionCount: input.compactionCount } : {}),
  };
  return {
    id: input.id ?? createMessageId(),
    role: 'assistant',
    content: '',
    timestamp: input.timestamp ?? Date.now(),
    ...(input.branch ? { branch: input.branch } : {}),
    kind: 'compaction',
    compactionMeta: meta,
    visibleToModel: false,
  };
}

/** Read-boundary attribution for already-loaded messages. Persistence backfills
 *  legacy messages before conversations can mutate branches, so conversation
 *  branch is no longer a read-time fallback. */
export function effectiveMessageBranch(
  msg: Pick<ChatMessage, 'branch'>,
  conversationBranch?: string,
): string {
  void conversationBranch;
  return msg.branch ?? 'main';
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
