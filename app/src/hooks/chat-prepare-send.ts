/**
 * chat-prepare-send.ts
 *
 * First-phase extraction from `useChat.ts`'s `sendMessage`. Owns the
 * "Prepare context" work that has to run before the round loop kicks off:
 *
 *   - build the user message (or use the caller-provided one for replays)
 *   - resolve the conversation's locked provider/model selection
 *   - splice the user + initial streaming-assistant messages into the
 *     conversation (with title generation on first send)
 *   - mark the run as streaming and reset the abort signal
 *   - prewarm the sandbox when the start mode opts in
 *   - hand back the seed `apiMessages` and recovery state the loop needs
 *
 * Extraction rationale: `sendMessage` was 546 lines / 26 deps. The
 * post-stream phases were already extracted into `chat-send.ts`; what
 * remained inline was orchestration scaffolding plus this 90-line setup
 * block. Pulling it into a sibling module makes each phase testable in
 * isolation, lets the dispatcher's deps array shrink, and lets the
 * useChat.ts ESLint ceiling ratchet back down toward its prior cap.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { resolveChatProviderSelection } from '@/lib/provider-selection';
import { getActiveProvider, isProviderAvailable, type ActiveProvider } from '@/lib/orchestrator';
import { setLastUsedProvider, type PreferredProvider } from '@/lib/providers';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';
import { type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { resolveWebAutoBranchOnCommitEnabled } from '@/lib/ensure-commit-target-branch';
import { maybeBranchOnFirstPrompt } from '@/lib/first-prompt-branch';
import type { BranchForkMigrationContext } from '@/lib/branch-fork-migration';
import { resolveMessageWriteBranch, stampMessageBranch } from '@/lib/chat-message';
import { createId, generateTitle } from './chat-persistence';
import type {
  AgentStatus,
  AIProviderType,
  AttachmentData,
  ChatMessage,
  Conversation,
} from '@/types';
import type { SendMessageOptions } from './useChat';

// ---------------------------------------------------------------------------
// User message construction
// ---------------------------------------------------------------------------

/**
 * Build the canonical runtime user message that lands in the
 * conversation transcript. Trimmed text, optional `displayContent` for
 * cases where the rendered version differs from what the model sees,
 * and optional attachments. Exported so the in-loop steer-handling
 * paths in `useChat.ts` can build the same shape.
 */
export function buildRuntimeUserMessage(
  text: string,
  attachments?: AttachmentData[],
  displayText?: string,
  currentBranch?: string,
): ChatMessage {
  const trimmedText = text.trim();
  const trimmedDisplayText = displayText?.trim();
  return {
    id: createId(),
    role: 'user',
    content: trimmedText,
    displayContent:
      trimmedDisplayText && trimmedDisplayText !== trimmedText ? trimmedDisplayText : undefined,
    timestamp: Date.now(),
    status: 'done',
    ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  };
}

// ---------------------------------------------------------------------------
// prepareSendContext
// ---------------------------------------------------------------------------

export interface PrepareSendArgs {
  /** Already-trimmed user text. The caller does the trim + empty-input check. */
  trimmedText: string;
  attachments: AttachmentData[] | undefined;
  options: SendMessageOptions | undefined;
  /** Resolved chat id — caller guarantees a conversation exists for it. */
  chatId: string;
  /** Skip the foreground-only side effects: inserting the empty streaming
   *  assistant placeholder and toggling `isStreaming` on. The bg-mode
   *  main-chat path passes this `true` so its JobCard isn't shadowed by
   *  a placeholder message and the chat doesn't get stuck in a streaming
   *  state when sendMessage returns early. The user message, title
   *  generation, provider/model resolution, and sandbox prewarm still
   *  fire — the bg branch needs all of those. */
  skipStreamingPlaceholder?: boolean;
}

export interface PrepareSendRefs {
  conversationsRef: MutableRefObject<Record<string, Conversation>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  sandboxIdRef: MutableRefObject<string | null>;
  ensureSandboxRef: MutableRefObject<(() => Promise<string | null>) | null>;
  abortRef: MutableRefObject<boolean>;
  abortControllerRef: MutableRefObject<AbortController | null>;
}

export interface PrepareSendCallbacks {
  updateConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  updateAgentStatus: (status: AgentStatus, opts?: { chatId?: string }) => void;
}

/**
 * Extra wiring for branch-on-first-prompt. Kept as a discrete optional param so
 * `useChat` (at its line cap) only threads refs, and the decision + fork logic
 * stays in `first-prompt-branch.ts`. Field types are reused from the migration
 * context so no extra type imports are needed. Omit to disable branching for a
 * caller (e.g. the no-repo path or tests).
 */
export interface FirstPromptBranchDeps {
  /** owner/name, or null for scratch / no-repo. */
  repoFullName: string | null;
  branchInfoRef: BranchForkMigrationContext['branchInfoRef'];
  runtimeHandlersRef: BranchForkMigrationContext['runtimeHandlersRef'];
}

export interface PrepareSendResult {
  /** Initial message stack the round loop streams against. */
  apiMessages: ChatMessage[];
  /** Provider locked for this conversation (existing lock or newly-resolved). */
  lockedProvider: ActiveProvider;
  /** Model locked for this conversation, or null if the provider's default applies. */
  resolvedModel: string | null;
  /** Fresh recovery state for the upcoming run. */
  recoveryState: ToolCallRecoveryState;
}

/**
 * Run the pre-loop setup for a `sendMessage` call. Returns the seed
 * data the loop body needs; mutates conversation state and refs as a
 * side effect (state setters and refs are passed in explicitly so the
 * helper stays testable without reaching for a hook context).
 */
export async function prepareSendContext(
  args: PrepareSendArgs,
  refs: PrepareSendRefs,
  callbacks: PrepareSendCallbacks,
  branchDeps?: FirstPromptBranchDeps,
): Promise<PrepareSendResult> {
  const { trimmedText, attachments, options, chatId, skipStreamingPlaceholder } = args;
  const currentWriteBranch = resolveMessageWriteBranch(
    branchDeps?.branchInfoRef.current,
    refs.conversationsRef.current[chatId]?.branch,
  );

  const displayText = options?.displayText?.trim();
  const userMessage: ChatMessage =
    options?.existingUserMessage !== undefined
      ? stampMessageBranch(options.existingUserMessage, currentWriteBranch)
      : buildRuntimeUserMessage(trimmedText, attachments, displayText, currentWriteBranch);

  const currentMessages =
    options?.baseMessages ?? (refs.conversationsRef.current[chatId]?.messages || []);
  const updatedWithUser = options?.existingUserMessage
    ? currentMessages
    : [...currentMessages, userMessage];

  const isFirstMessage = currentMessages.length === 0 && !options?.existingUserMessage;
  const newTitle =
    options?.titleOverride ||
    (isFirstMessage
      ? generateTitle(updatedWithUser)
      : refs.conversationsRef.current[chatId]?.title || 'New Chat');

  const existingConversation = refs.conversationsRef.current[chatId];
  const requestedProvider = options?.provider || null;
  const {
    provider: lockedProviderForChat,
    model: resolvedModelForChat,
    shouldPersistProvider,
    shouldPersistModel,
  } = resolveChatProviderSelection({
    existingProvider: existingConversation?.provider || null,
    existingModel: existingConversation?.model || null,
    requestedProvider,
    requestedModel: options?.model || null,
    fallbackProvider: getActiveProvider(),
    isProviderAvailable,
  });

  const buildStreamingAssistant = (branch: string | undefined): ChatMessage => ({
    id: createId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: 'streaming',
    ...(branch !== undefined ? { branch } : {}),
  });
  const firstAssistant = buildStreamingAssistant(currentWriteBranch);

  // When branch-on-first-prompt may fire below, defer the streaming-assistant
  // placeholder until *after* the fork so it is written with the post-fork
  // branch stamp. Over-approximated from pre-prewarm state (sandbox id isn't
  // known yet); the post-fork append fires whether or not the fork landed, so
  // the placeholder is always appended exactly once, last. Every other send
  // keeps the immediate single-render placeholder.
  const branchInfo = branchDeps?.branchInfoRef.current;
  // Mirror `shouldBranchOnFirstPrompt`'s branch gate: only a session positively
  // known to be on the default branch may fork. An unknown current branch is
  // *not* treated as the default, so a branch-started session keeps its
  // immediate placeholder instead of deferring for a fork that won't happen.
  const mayBranchOnFirstPrompt = Boolean(
    branchDeps &&
      isFirstMessage &&
      branchDeps.repoFullName &&
      branchInfo?.currentBranch &&
      branchInfo.currentBranch === (branchInfo.defaultBranch ?? 'main'),
  );

  callbacks.updateConversations((prev) => {
    const messages =
      skipStreamingPlaceholder || mayBranchOnFirstPrompt
        ? updatedWithUser
        : [...updatedWithUser, firstAssistant];
    const updated = {
      ...prev,
      [chatId]: {
        ...prev[chatId],
        messages,
        title: newTitle,
        lastMessageAt: Date.now(),
        verificationPolicy: prev[chatId]?.verificationPolicy ?? getDefaultVerificationPolicy(),
        ...(shouldPersistProvider ? { provider: lockedProviderForChat } : {}),
        ...(shouldPersistModel && resolvedModelForChat ? { model: resolvedModelForChat } : {}),
      },
    };
    refs.dirtyConversationIdsRef.current.add(chatId);
    return updated;
  });

  if (shouldPersistProvider && lockedProviderForChat !== 'demo') {
    setLastUsedProvider(lockedProviderForChat as PreferredProvider);
  }

  if (!skipStreamingPlaceholder) callbacks.setIsStreaming(true);
  refs.abortRef.current = false;

  // Always pre-warm the sandbox when one can actually be created. Best effort —
  // a failed prewarm doesn't block the chat flow; the run loop will lazily
  // ensure the sandbox if a tool call needs it later. (The off/smart/always
  // start-mode setting was removed — auto-start is now the only behavior.)
  //
  // Deliberately NO "Starting sandbox..." agent-status here: chat sessions still
  // register an ensureSandbox that resolves to null (no repo/scratch), so
  // announcing a start up front would append a phantom sandbox-start event into
  // chat-mode history for a sandbox that never exists. The sandbox's own
  // 'creating' status (the status chip) is the real start feedback for sandbox
  // workspaces; the prewarm itself stays silent.
  if (!refs.sandboxIdRef.current && refs.ensureSandboxRef.current) {
    try {
      const prewarmedId = await refs.ensureSandboxRef.current();
      if (prewarmedId) refs.sandboxIdRef.current = prewarmedId;
    } catch {
      // Best effort prewarm; continue chat flow without sandbox.
    }
  }

  // Branch-on-first-prompt: now that the sandbox has cloned `main`, fork a work
  // branch named from this prompt and update the conversation branch before the
  // round loop runs — so the session never works on the default branch. A no-op
  // for non-first messages, scratch/no-repo, or when already off main.
  if (branchDeps) {
    await maybeBranchOnFirstPrompt(
      {
        enabled: resolveWebAutoBranchOnCommitEnabled(),
        isFirstMessage,
        promptText: trimmedText,
        repoFullName: branchDeps.repoFullName,
        sandboxId: refs.sandboxIdRef.current,
        currentBranch: branchDeps.branchInfoRef.current?.currentBranch,
        defaultBranch: branchDeps.branchInfoRef.current?.defaultBranch,
      },
      {
        // Target THIS send's chat, not `activeChatIdRef` ("active at resolution
        // time"): the branch was created for this prompt, and across the
        // prewarm/fork awaits the active chat can drift (a just-created first-
        // message chat, or a user chat-switch). The deferred placeholder + the
        // stream both key off `chatId`, so the branch update must too.
        activeChatIdRef: { current: chatId },
        conversationsRef: refs.conversationsRef,
        branchInfoRef: branchDeps.branchInfoRef,
        setConversations: callbacks.updateConversations,
        dirtyConversationIdsRef: refs.dirtyConversationIdsRef,
        runtimeHandlersRef: branchDeps.runtimeHandlersRef,
      },
    );
  }

  // After branch-on-first-prompt: re-stamp the prompt onto the post-fork branch
  // AND append the deferred streaming placeholder with the same stamp, so the
  // whole opening exchange sits on ONE branch (the new work branch) rather than
  // splitting prompt=main / response=new. The prompt was stamped with the
  // pre-fork default above, so this is a deliberate *overwrite* (not the
  // no-clobber `stampMessageBranch`) — chosen for a simpler mental model and
  // cleaner branch-based navigation. `prev`-based so it lands after the branch
  // update regardless of state-flush timing; the branch re-stamp is a no-op
  // when the fork didn't land (conv.branch unchanged), and the placeholder
  // still appends.
  if (mayBranchOnFirstPrompt) {
    callbacks.updateConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const deferredBranch = resolveMessageWriteBranch(
        branchDeps?.branchInfoRef.current,
        conv.branch,
      );
      const restamped =
        deferredBranch !== undefined
          ? conv.messages.map((m) =>
              m.id === userMessage.id ? { ...m, branch: deferredBranch } : m,
            )
          : conv.messages;
      const messages = skipStreamingPlaceholder
        ? restamped
        : [...restamped, buildStreamingAssistant(deferredBranch)];
      refs.dirtyConversationIdsRef.current.add(chatId);
      return {
        ...prev,
        [chatId]: { ...conv, messages },
      };
    });
  }

  refs.abortControllerRef.current = new AbortController();

  return {
    apiMessages: [...updatedWithUser],
    lockedProvider: lockedProviderForChat as ActiveProvider,
    resolvedModel: resolvedModelForChat ?? null,
    recoveryState: { diagnosisRetries: 0, recoveryAttempted: false },
  };
}

// Convenience union for AIProviderType callers — exported so useChat
// can re-use it if it ever needs to pass through.
export type { AIProviderType };
