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
import { getSandboxStartMode } from '@/lib/sandbox-start-mode';
import { getActiveProvider, isProviderAvailable, type ActiveProvider } from '@/lib/orchestrator';
import { setLastUsedProvider, type PreferredProvider } from '@/lib/providers';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';
import { type ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import { createId, generateTitle, shouldPrewarmSandbox } from './chat-persistence';
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
): Promise<PrepareSendResult> {
  const { trimmedText, attachments, options, chatId, skipStreamingPlaceholder } = args;

  const displayText = options?.displayText?.trim();
  const userMessage: ChatMessage =
    options?.existingUserMessage ?? buildRuntimeUserMessage(trimmedText, attachments, displayText);

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

  const firstAssistant: ChatMessage = {
    id: createId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: 'streaming',
  };

  callbacks.updateConversations((prev) => {
    const messages = skipStreamingPlaceholder
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

  // Pre-warm sandbox if the start mode opts in. Best effort — a failed
  // prewarm doesn't block the chat flow; the run loop will lazily
  // ensure the sandbox if a tool call needs it later.
  const sandboxStartMode = getSandboxStartMode();
  const shouldAutoStartSandbox =
    sandboxStartMode === 'always' ||
    (sandboxStartMode === 'smart' && shouldPrewarmSandbox(trimmedText, attachments));
  if (!refs.sandboxIdRef.current && refs.ensureSandboxRef.current && shouldAutoStartSandbox) {
    callbacks.updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
    try {
      const prewarmedId = await refs.ensureSandboxRef.current();
      if (prewarmedId) refs.sandboxIdRef.current = prewarmedId;
    } catch {
      // Best effort prewarm; continue chat flow without sandbox.
    }
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
