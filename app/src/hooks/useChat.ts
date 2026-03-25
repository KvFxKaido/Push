// Verified
import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import type {
  AgentStatus,
  AgentStatusEvent,
  AIProviderType,
  AttachmentData,
  ChatMessage,
  ChatSendOptions,
  Conversation,
  WorkspaceContext,
} from '@/types';
import { getActiveProvider, estimateContextTokens, getContextBudget, type ActiveProvider } from '@/lib/orchestrator';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { getSandboxStartMode } from '@/lib/sandbox-start-mode';
import {
  getModelNameForProvider,
  setLastUsedProvider,
  type PreferredProvider,
} from '@/lib/providers';
import {
  migrateConversationsToIndexedDB,
  saveConversation as saveConversationToDB,
  deleteConversation as deleteConversationFromDB,
} from '@/lib/conversation-store';
import {
  acquireRunTabLock,
  clearRunCheckpoint,
  heartbeatRunTabLock,
  releaseRunTabLock,
} from '@/lib/checkpoint-manager';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import {
  generateTitle,
  loadActiveChatId,
  loadConversations,
  normalizeConversationModel,
  saveActiveChatId,
  shouldPrewarmSandbox,
  createId,
} from '@/hooks/chat-persistence';
import { useAgentDelegation } from './useAgentDelegation';
import { useCIPoller } from './useCIPoller';
import { useChatCardActions } from './chat-card-actions';
import { useChatManagement } from './chat-management';
import { useChatReplay } from './chat-replay';
import { useChatCheckpoint } from './useChatCheckpoint';
import {
  streamAssistantRound,
  processAssistantTurn,
  type SendLoopContext,
} from './chat-send';

// Re-export public interfaces from chat-send (avoids circular imports)
export type { ScratchpadHandlers, UsageHandler, ChatRuntimeHandlers } from './chat-send';

// Re-export checkpoint utilities for consumers who import them from useChat
export {
  detectInterruptedRun,
  getResumeEvents,
} from '@/lib/checkpoint-manager';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ChatDraftSelection {
  provider: AIProviderType | null;
  model: string | null;
}

type SendMessageOptions = Partial<ChatDraftSelection> &
  ChatSendOptions & {
    chatId?: string;
    baseMessages?: ChatMessage[];
    existingUserMessage?: ChatMessage;
    titleOverride?: string;
  };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

import type { ScratchpadHandlers, UsageHandler, ChatRuntimeHandlers } from './chat-send';

export function useChat(
  activeRepoFullName: string | null,
  scratchpad?: ScratchpadHandlers,
  usageHandler?: UsageHandler,
  runtimeHandlers?: ChatRuntimeHandlers,
  branchInfo?: { currentBranch?: string; defaultBranch?: string },
) {
  // --- Core state ---
  const [conversations, setConversations] = useState<Record<string, Conversation>>(loadConversations);
  const [activeChatId, setActiveChatId] = useState<string>(() => loadActiveChatId(conversations));
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ active: false, phase: '' });
  const [agentEventsByChat, setAgentEventsByChat] = useState<Record<string, AgentStatusEvent[]>>({});

  // --- Persistence refs ---
  const dirtyConversationIdsRef = useRef(new Set<string>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const activeChatIdRef = useRef(activeChatId);
  const abortRef = useRef(false);
  const processedContentRef = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelStatusTimerRef = useRef<number | null>(null);

  // --- Session identity refs ---
  const sandboxIdRef = useRef<string | null>(null);
  const workspaceSessionIdRef = useRef<string | null>(null);
  const isMainProtectedRef = useRef(false);
  const autoCreateRef = useRef(false);
  const workspaceContextRef = useRef<WorkspaceContext | null>(null);
  const ensureSandboxRef = useRef<(() => Promise<string | null>) | null>(null);

  // --- Prop mirror refs (always up-to-date in callbacks) ---
  const repoRef = useRef(activeRepoFullName);
  repoRef.current = activeRepoFullName;
  const scratchpadRef = useRef(scratchpad);
  scratchpadRef.current = scratchpad;
  const usageHandlerRef = useRef(usageHandler);
  usageHandlerRef.current = usageHandler;
  const runtimeHandlersRef = useRef(runtimeHandlers);
  runtimeHandlersRef.current = runtimeHandlers;
  const branchInfoRef = useRef(branchInfo);
  branchInfoRef.current = branchInfo;

  // --- Instruction refs ---
  const agentsMdRef = useRef<string | null>(null);
  const instructionFilenameRef = useRef<string | null>(null);

  // --- sendMessage forward ref (populated after sendMessage is defined) ---
  // Passed to useChatCheckpoint so resumeInterruptedRun can call it.
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  // --- IndexedDB migration ---
  useEffect(() => {
    migrateConversationsToIndexedDB().then((convs) => {
      if (Object.keys(convs).length > 0) {
        setConversations(convs);
        setActiveChatId((prev) => {
          if (prev && convs[prev]) return prev;
          return loadActiveChatId(convs);
        });
      }
      setConversationsLoaded(true);
    });
  }, []);

  // --- Dirty conversation flush ---
  useEffect(() => {
    if (!conversationsLoaded) return;
    const dirty = dirtyConversationIdsRef.current;
    const deleted = deletedConversationIdsRef.current;
    if (dirty.size === 0 && deleted.size === 0) return;

    const dirtyIds = [...dirty];
    const deletedIds = [...deleted];
    dirty.clear();
    deleted.clear();

    for (const id of dirtyIds) {
      const conv = conversations[id];
      if (conv) void saveConversationToDB(conv).catch(() => { dirty.add(id); });
    }
    for (const id of deletedIds) {
      void deleteConversationFromDB(id).catch(() => { deleted.add(id); });
    }
  }, [conversations, conversationsLoaded]);

  // --- Checkpoint + resume lifecycle ---
  const {
    updateAgentStatus,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    saveExpiryCheckpoint,
    flushCheckpoint,
    checkpointRefs,
    loopActiveRef,
    lastCoderStateRef,
    tabLockIntervalRef,
    tabLockIdRef,
  } = useChatCheckpoint({
    sandboxIdRef,
    branchInfoRef,
    repoRef,
    workspaceSessionIdRef,
    ensureSandboxRef,
    abortRef,
    setConversations,
    dirtyConversationIdsRef,
    conversations,
    setAgentStatus,
    setAgentEventsByChat,
    activeChatIdRef,
    sendMessageRef,
    isStreaming,
    activeChatId,
  });

  // --- CI poller ---
  const { ciStatus } = useCIPoller(activeChatId, activeRepoFullName, branchInfo);

  // --- Derived state ---
  const messages = useMemo(
    () => conversations[activeChatId]?.messages ?? [],
    [conversations, activeChatId],
  );
  const agentEvents = useMemo(
    () => agentEventsByChat[activeChatId] ?? [],
    [agentEventsByChat, activeChatId],
  );
  const conversationProvider = conversations[activeChatId]?.provider;
  const conversationModel = normalizeConversationModel(
    conversationProvider,
    conversations[activeChatId]?.model,
  );

  const contextUsage = useMemo(() => {
    const contextProvider = (conversationProvider as ActiveProvider | undefined) || getActiveProvider();
    const contextModel = conversationModel || getModelNameForProvider(contextProvider);
    const budget = getContextBudget(contextProvider, contextModel);
    const used = estimateContextTokens(messages);
    const max = budget.maxTokens;
    return { used, max, percent: Math.min(100, Math.round((used / max) * 100)) };
  }, [messages, conversationProvider, conversationModel]);

  const isProviderLocked = Boolean(conversationProvider);
  const isModelLocked = Boolean(conversationModel || conversationProvider);
  const lockedProvider: AIProviderType | null = conversationProvider || null;
  const lockedModel: string | null = conversationModel || null;

  // --- Sorted chat IDs (filtered by repo + branch) ---
  const currentBranch = branchInfo?.currentBranch;
  const defaultBranch = branchInfo?.defaultBranch;
  const sortedChatIds = useMemo(() => {
    return Object.keys(conversations)
      .filter((id) => {
        const conv = conversations[id];
        if (!activeRepoFullName) return !conv.repoFullName;
        if (conv.repoFullName !== activeRepoFullName) return false;
        if (!currentBranch) return true;
        const isOnDefaultBranch = currentBranch === (defaultBranch || 'main');
        if (!conv.branch) return isOnDefaultBranch;
        return conv.branch === currentBranch;
      })
      .sort((a, b) => conversations[b].lastMessageAt - conversations[a].lastMessageAt);
  }, [conversations, activeRepoFullName, currentBranch, defaultBranch]);

  // --- Auto-switch effect ---
  useEffect(() => {
    if (sortedChatIds.length === 0 && activeRepoFullName) {
      if (!autoCreateRef.current) {
        autoCreateRef.current = true;
        const id = createId();
        const bi = branchInfoRef.current;
        const branch = bi?.currentBranch || bi?.defaultBranch || 'main';
        const newConv: Conversation = {
          id,
          title: 'New Chat',
          messages: [],
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
          repoFullName: activeRepoFullName,
          branch,
        };
        setConversations((prev) => {
          const updated = { ...prev, [id]: newConv };
          dirtyConversationIdsRef.current.add(id);
          return updated;
        });
        setActiveChatId(id);
        saveActiveChatId(id);
        setTimeout(() => { autoCreateRef.current = false; }, 0);
      }
    } else if (sortedChatIds.length > 0 && !sortedChatIds.includes(activeChatId)) {
      setActiveChatId(sortedChatIds[0]);
      saveActiveChatId(sortedChatIds[0]);
    }
  }, [sortedChatIds, activeChatId, activeRepoFullName]);

  // --- Workspace context / sandbox setters ---
  const setWorkspaceContext = useCallback((ctx: WorkspaceContext | null) => {
    workspaceContextRef.current = ctx;
  }, []);

  const setSandboxId = useCallback((id: string | null) => {
    sandboxIdRef.current = id;
  }, []);

  const setWorkspaceSessionId = useCallback((id: string | null) => {
    workspaceSessionIdRef.current = id;
  }, []);

  const setIsMainProtected = useCallback((value: boolean) => {
    isMainProtectedRef.current = value;
  }, []);

  const setEnsureSandbox = useCallback((fn: (() => Promise<string | null>) | null) => {
    ensureSandboxRef.current = fn;
  }, []);

  const setAgentsMd = useCallback((md: string | null) => {
    agentsMdRef.current = md;
  }, []);

  const setInstructionFilename = useCallback((filename: string | null) => {
    instructionFilenameRef.current = filename;
  }, []);

  // --- Abort stream ---
  const abortStream = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setIsStreaming(false);
    if (cancelStatusTimerRef.current !== null) {
      window.clearTimeout(cancelStatusTimerRef.current);
    }
    updateAgentStatus({ active: true, phase: 'Cancelled' });
    cancelStatusTimerRef.current = window.setTimeout(() => {
      updateAgentStatus({ active: false, phase: '' });
      cancelStatusTimerRef.current = null;
    }, 1200);
  }, [updateAgentStatus]);

  useEffect(() => {
    return () => {
      if (cancelStatusTimerRef.current !== null) {
        window.clearTimeout(cancelStatusTimerRef.current);
      }
    };
  }, []);

  // --- Chat management ---
  const { createNewChat, switchChat, renameChat, deleteChat, deleteAllChats } = useChatManagement({
    setConversations,
    setActiveChatId,
    setAgentEventsByChat,
    dirtyConversationIdsRef,
    deletedConversationIdsRef,
    activeChatId,
    activeRepoFullName,
    branchInfoRef,
    repoRef,
    isStreaming,
    abortStream,
  });

  // --- Agent delegation ---
  const { executeDelegateCall } = useAgentDelegation({
    setConversations,
    updateAgentStatus,
    branchInfoRef,
    isMainProtectedRef,
    agentsMdRef,
    instructionFilenameRef,
    sandboxIdRef,
    repoRef,
    abortControllerRef,
    abortRef,
    checkpointPhaseRef: checkpointRefs.phase as unknown as import('react').MutableRefObject<string | null>,
    lastCoderStateRef,
  });

  // ---------------------------------------------------------------------------
  // sendMessage — loop orchestrator
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (text: string, attachments?: AttachmentData[], options?: SendMessageOptions) => {
      if ((!text.trim() && (!attachments || attachments.length === 0)) || isStreaming) return;

      let chatId = options?.chatId || activeChatIdRef.current;
      if (!chatId || !conversations[chatId]) {
        chatId = createNewChat();
      }

      // --- Prepare context ---
      const trimmedText = text.trim();
      const displayText = options?.displayText?.trim();
      const userMessage: ChatMessage = options?.existingUserMessage ?? {
        id: createId(),
        role: 'user',
        content: trimmedText,
        displayContent: displayText && displayText !== trimmedText ? displayText : undefined,
        timestamp: Date.now(),
        status: 'done',
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      };

      const currentMessages = options?.baseMessages ?? (conversations[chatId]?.messages || []);
      const updatedWithUser = options?.existingUserMessage
        ? currentMessages
        : [...currentMessages, userMessage];

      const isFirstMessage = currentMessages.length === 0 && !options?.existingUserMessage;
      const newTitle =
        options?.titleOverride ||
        (isFirstMessage
          ? generateTitle(updatedWithUser)
          : conversations[chatId]?.title || 'New Chat');

      const existingConversation = conversations[chatId];
      const requestedProvider = options?.provider || null;
      const requestedModel = normalizeConversationModel(requestedProvider, options?.model || null);
      const lockedProviderForChat = (
        existingConversation?.provider ||
        requestedProvider ||
        getActiveProvider()
      ) as ActiveProvider;
      const existingLockedModel = normalizeConversationModel(
        existingConversation?.provider || null,
        existingConversation?.model || null,
      );
      const resolvedModelForChat =
        existingLockedModel ||
        requestedModel ||
        getModelNameForProvider(lockedProviderForChat);

      const shouldPersistProvider = isFirstMessage && !existingConversation?.provider;
      const shouldPersistModel =
        (isFirstMessage || (!!existingConversation?.provider && !existingConversation?.model)) &&
        !!resolvedModelForChat;

      const firstAssistant: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
      };

      setConversations((prev) => {
        const updated = {
          ...prev,
          [chatId]: {
            ...prev[chatId],
            messages: [...updatedWithUser, firstAssistant],
            title: newTitle,
            lastMessageAt: Date.now(),
            ...(shouldPersistProvider ? { provider: lockedProviderForChat } : {}),
            ...(shouldPersistModel && resolvedModelForChat ? { model: resolvedModelForChat } : {}),
          },
        };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });

      if (shouldPersistProvider && lockedProviderForChat !== 'demo') {
        setLastUsedProvider(lockedProviderForChat as PreferredProvider);
      }

      setIsStreaming(true);
      abortRef.current = false;

      // Pre-warm sandbox if needed
      const sandboxStartMode = getSandboxStartMode();
      const shouldAutoStartSandbox =
        sandboxStartMode === 'always' ||
        (sandboxStartMode === 'smart' && shouldPrewarmSandbox(trimmedText, attachments));
      if (!sandboxIdRef.current && ensureSandboxRef.current && shouldAutoStartSandbox) {
        updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
        try {
          const prewarmedId = await ensureSandboxRef.current();
          if (prewarmedId) sandboxIdRef.current = prewarmedId;
        } catch {
          // Best effort prewarm; continue chat flow without sandbox.
        }
      }

      abortControllerRef.current = new AbortController();

      let apiMessages = [...updatedWithUser];
      let toolCallRecoveryState: ToolCallRecoveryState = {
        diagnosisRetries: 0,
        recoveryAttempted: false,
      };

      // --- Initialize checkpoint refs ---
      checkpointRefs.chatId.current = chatId;
      checkpointRefs.provider.current = lockedProviderForChat;
      checkpointRefs.model.current = resolvedModelForChat || '';
      checkpointRefs.baseMessageCount.current = updatedWithUser.length;
      checkpointRefs.apiMessages.current = apiMessages;
      checkpointRefs.accumulated.current = '';
      checkpointRefs.thinking.current = '';
      loopActiveRef.current = true;

      // Acquire multi-tab lock
      const acquiredTabId = acquireRunTabLock(chatId);
      if (!acquiredTabId) {
        loopActiveRef.current = false;
        setIsStreaming(false);
        updateAgentStatus({ active: false, phase: '' });
        setConversations((prev) => {
          const existing = prev[chatId];
          if (!existing) return prev;
          const msgs = existing.messages.map((m) =>
            m.status === 'streaming'
              ? {
                  ...m,
                  content:
                    'This chat is active in another tab. Please switch tabs or wait for the other session to finish.',
                  status: 'done' as const,
                }
              : m,
          );
          const updated = {
            ...prev,
            [chatId]: { ...existing, messages: msgs, lastMessageAt: Date.now() },
          };
          dirtyConversationIdsRef.current.add(chatId);
          return updated;
        });
        return;
      }
      tabLockIdRef.current = acquiredTabId;
      if (tabLockIntervalRef.current) clearInterval(tabLockIntervalRef.current);
      tabLockIntervalRef.current = setInterval(
        () => heartbeatRunTabLock(chatId, acquiredTabId),
        15_000,
      );

      // --- Build loop context (constant for this call) ---
      const loopCtx: SendLoopContext = {
        chatId,
        lockedProvider: lockedProviderForChat,
        resolvedModel: resolvedModelForChat,
        abortRef,
        abortControllerRef,
        sandboxIdRef,
        ensureSandboxRef,
        scratchpadRef,
        usageHandlerRef,
        workspaceContextRef,
        runtimeHandlersRef,
        repoRef,
        isMainProtectedRef,
        branchInfoRef,
        checkpointRefs,
        processedContentRef,
        lastCoderStateRef,
        setConversations,
        dirtyConversationIdsRef,
        updateAgentStatus,
        flushCheckpoint,
        executeDelegateCall,
      };

      let loopCompletedNormally = false;
      try {
        for (let round = 0; ; round++) {
          if (abortRef.current) break;
          fileLedger.advanceRound();

          // Update round checkpoint refs
          checkpointRefs.round.current = round;
          checkpointRefs.accumulated.current = '';
          checkpointRefs.thinking.current = '';
          checkpointRefs.phase.current = 'streaming_llm';

          if (round > 0) {
            const newAssistant: ChatMessage = {
              id: createId(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              status: 'streaming',
            };
            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              return { ...prev, [chatId]: { ...conv, messages: [...conv.messages, newAssistant] } };
            });
          }

          updateAgentStatus(
            { active: true, phase: round === 0 ? 'Thinking...' : 'Responding...' },
            { chatId },
          );

          // --- Stream ---
          const { accumulated, thinkingAccumulated, error } = await streamAssistantRound(
            round,
            apiMessages,
            loopCtx,
          );

          if (abortRef.current) break;

          if (error) {
            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = [...conv.messages];
              const lastIdx = msgs.length - 1;
              if (msgs[lastIdx]?.role === 'assistant') {
                msgs[lastIdx] = {
                  ...msgs[lastIdx],
                  content: `Something went wrong: ${error.message}`,
                  status: 'error',
                };
              }
              const updated = { ...prev, [chatId]: { ...conv, messages: msgs } };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });
            break;
          }

          // Checkpoint after streaming, before tool dispatch
          checkpointRefs.phase.current = 'executing_tools';
          flushCheckpoint();

          // --- Process the assistant's response ---
          const turnResult = await processAssistantTurn(
            round,
            accumulated,
            thinkingAccumulated,
            apiMessages,
            loopCtx,
            toolCallRecoveryState,
          );

          apiMessages = turnResult.nextApiMessages;
          toolCallRecoveryState = turnResult.nextRecoveryState;
          checkpointRefs.apiMessages.current = apiMessages;

          if (turnResult.loopCompletedNormally) loopCompletedNormally = true;
          if (turnResult.loopAction === 'break') break;
          // 'continue' → next round
        }
      } finally {
        setIsStreaming(false);
        if (cancelStatusTimerRef.current === null) {
          updateAgentStatus({ active: false, phase: '' });
        }
        abortControllerRef.current = null;

        loopActiveRef.current = false;
        checkpointRefs.chatId.current = null;
        if (loopCompletedNormally) {
          clearRunCheckpoint(chatId);
        }

        releaseRunTabLock(chatId, tabLockIdRef.current);
        tabLockIdRef.current = null;
        if (tabLockIntervalRef.current) {
          clearInterval(tabLockIntervalRef.current);
          tabLockIntervalRef.current = null;
        }
      }
    },
    [
      conversations,
      isStreaming,
      createNewChat,
      updateAgentStatus,
      flushCheckpoint,
      executeDelegateCall,
      checkpointRefs,
      loopActiveRef,
      lastCoderStateRef,
      tabLockIntervalRef,
      tabLockIdRef,
      dirtyConversationIdsRef,
    ],
  );

  // Wire sendMessageRef so useChatCheckpoint's resumeInterruptedRun can call it
  sendMessageRef.current = sendMessage as (text: string) => Promise<void>;

  // --- Chat replay (regenerate, editAndResend, diagnoseCIFailure) ---
  const { regenerateLastResponse, editMessageAndResend, diagnoseCIFailure } = useChatReplay({
    conversations,
    activeChatIdRef,
    isStreaming,
    ciStatus,
    lockedProvider,
    lockedModel,
    sendMessage,
  });

  // --- Card actions ---
  const { injectAssistantCardMessage, handleCardAction } =
    useChatCardActions({
      setConversations,
      dirtyConversationIdsRef,
      activeChatId,
      sandboxIdRef,
      isMainProtectedRef,
      branchInfoRef,
      repoRef,
      updateAgentStatus,
      sendMessageRef: sendMessageRef as import('react').MutableRefObject<((text: string) => Promise<void>) | null>,
      isStreaming,
      messages,
    });

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    // Active chat
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    isStreaming,
    lockedProvider,
    isProviderLocked,
    lockedModel,
    isModelLocked,

    // Multi-chat management
    conversations,
    conversationsLoaded,
    activeChatId,
    sortedChatIds,
    switchChat,
    renameChat,
    createNewChat,
    deleteChat,
    deleteAllChats,
    regenerateLastResponse,
    editMessageAndResend,

    // Workspace context
    setWorkspaceContext,

    // Sandbox
    setSandboxId,
    setWorkspaceSessionId,
    setEnsureSandbox,

    // Protect Main
    setIsMainProtected,

    // AGENTS.md
    setAgentsMd,
    setInstructionFilename,
    injectAssistantCardMessage,

    // Card actions
    handleCardAction,

    // Context usage (for meter UI)
    contextUsage,

    // Abort stream
    abortStream,

    // Resumable Sessions
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    saveExpiryCheckpoint,
    ciStatus,
    diagnoseCIFailure,
  };
}
