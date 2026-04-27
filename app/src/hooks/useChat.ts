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
  QueuedFollowUp,
  QueuedFollowUpOptions,
  RunEvent,
  VerificationRuntimeState,
} from '@/types';
import { buildAgentEventsByChat, buildQueuedFollowUpsByChat } from '@/lib/chat-runtime-state';
import {
  getActiveProvider,
  estimateContextTokens,
  getContextBudget,
  type ActiveProvider,
} from '@/lib/orchestrator';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { getModelNameForProvider } from '@/lib/providers';
import {
  migrateConversationsToIndexedDB,
  saveConversation as saveConversationToDB,
  deleteConversation as deleteConversationFromDB,
} from '@/lib/conversation-store';
import { acquireRunTabLock, heartbeatRunTabLock } from '@/lib/checkpoint-manager';
import {
  loadActiveChatId,
  loadConversations,
  normalizeConversationModel,
  saveActiveChatId,
  createId,
} from '@/hooks/chat-persistence';
import { useAgentDelegation } from './useAgentDelegation';
import { useBackgroundCoderJob } from './useBackgroundCoderJob';
import { isBackgroundModeEnabled } from '@/lib/background-mode-settings';
import { useCIPoller } from './useCIPoller';
import { useChatCardActions } from './chat-card-actions';
import { useChatManagement } from './chat-management';
import { useChatReplay } from './chat-replay';
import { useChatCheckpoint } from './useChatCheckpoint';
import { streamAssistantRound, processAssistantTurn, type SendLoopContext } from './chat-send';
import { buildRuntimeUserMessage, prepareSendContext } from './chat-prepare-send';
import { finalizeRunSession } from './chat-run-session';
import { useQueuedFollowUps } from './useQueuedFollowUps';
import { mergeRunEventStreams } from '@/lib/chat-run-events';
import { expireBranchScopedMemory } from '@/lib/context-memory';
import { isRunActive } from '@/lib/run-engine';
import { updateJournalVerificationState, markJournalCheckpoint } from '@/lib/run-journal';
import { useRunEventStream } from './useRunEventStream';
import { useRunEngine } from './useRunEngine';
import { useVerificationState } from './useVerificationState';
import { usePendingSteer, type PendingSteerRequest } from './usePendingSteer';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';
import { getMigrationMarker } from '@/lib/branch-migration-marker';
import { applyBranchSwitchPayload } from '@/lib/branch-fork-migration';
import {
  forkBranchInWorkspace,
  type ForkBranchInWorkspaceResult,
} from '@/lib/fork-branch-in-workspace';
import { useBranchForkGuard } from './useBranchForkGuard';

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

export type SendMessageOptions = Partial<ChatDraftSelection> &
  ChatSendOptions & {
    chatId?: string;
    baseMessages?: ChatMessage[];
    existingUserMessage?: ChatMessage;
    titleOverride?: string;
  };

type AbortStreamOptions = {
  clearQueuedFollowUps?: boolean;
};

function getQueuedFollowUpOptions(options?: SendMessageOptions): QueuedFollowUpOptions | undefined {
  const queuedOptions = {
    provider: options?.provider ?? undefined,
    model: options?.model ?? undefined,
    displayText: options?.displayText?.trim() || undefined,
  };

  return Object.values(queuedOptions).some(Boolean) ? queuedOptions : undefined;
}

function summarizeQueuedInputPreview(
  text: string,
  attachments?: AttachmentData[],
  displayText?: string,
  maxLength = 96,
): string {
  const candidate = displayText?.trim() || text.trim();
  const attachmentCount = attachments?.length ?? 0;
  const attachmentLabel =
    attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}` : '';

  const base = candidate
    ? attachmentLabel
      ? `${candidate} (+${attachmentLabel})`
      : candidate
    : attachmentLabel || '[no text]';

  return base.length <= maxLength ? base : `${base.slice(0, maxLength - 1).trimEnd()}...`;
}

function toQueuedFollowUp(
  text: string,
  attachments?: AttachmentData[],
  options?: SendMessageOptions,
): QueuedFollowUp {
  return {
    text,
    attachments,
    options: getQueuedFollowUpOptions(options),
    queuedAt: Date.now(),
  };
}

function toPendingSteerRequest(
  text: string,
  attachments?: AttachmentData[],
  options?: SendMessageOptions,
): PendingSteerRequest {
  return {
    text,
    attachments,
    options: getQueuedFollowUpOptions(options),
    requestedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

import type {
  ScratchpadHandlers,
  TodoHandlers,
  UsageHandler,
  ChatRuntimeHandlers,
} from './chat-send';

export function useChat(
  activeRepoFullName: string | null,
  scratchpad?: ScratchpadHandlers,
  usageHandler?: UsageHandler,
  runtimeHandlers?: ChatRuntimeHandlers,
  branchInfo?: { currentBranch?: string; defaultBranch?: string },
  todo?: TodoHandlers,
) {
  const initialConversationsRef = useRef<Record<string, Conversation> | null>(null);
  if (initialConversationsRef.current === null) {
    initialConversationsRef.current = loadConversations();
  }
  const initialConversations = initialConversationsRef.current;
  const initialAgentEventsByChat = buildAgentEventsByChat(initialConversations);
  const initialQueuedFollowUpsByChat = buildQueuedFollowUpsByChat(initialConversations);

  // --- Core state ---
  const [conversations, setConversations] =
    useState<Record<string, Conversation>>(initialConversations);
  const [activeChatId, setActiveChatId] = useState<string>(() =>
    loadActiveChatId(initialConversations),
  );
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ active: false, phase: '' });
  const [agentEventsByChat, setAgentEventsByChat] =
    useState<Record<string, AgentStatusEvent[]>>(initialAgentEventsByChat);

  // --- Persistence refs ---
  const dirtyConversationIdsRef = useRef(new Set<string>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const saveRetryCountsRef = useRef<Map<string, number>>(new Map());

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const agentEventsByChatRef = useRef<Record<string, AgentStatusEvent[]>>(initialAgentEventsByChat);
  agentEventsByChatRef.current = agentEventsByChat;
  const activeChatIdRef = useRef(activeChatId);
  const abortRef = useRef(false);
  const processedContentRef = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelStatusTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  // --- Session identity refs ---
  const sandboxIdRef = useRef<string | null>(null);
  const workspaceSessionIdRef = useRef<string | null>(null);
  const isMainProtectedRef = useRef(false);
  const autoCreateRef = useRef(false);
  const ensureSandboxRef = useRef<(() => Promise<string | null>) | null>(null);

  // --- Prop mirror refs (always up-to-date in callbacks) ---
  const repoRef = useRef(activeRepoFullName);
  repoRef.current = activeRepoFullName;
  const scratchpadRef = useRef(scratchpad);
  scratchpadRef.current = scratchpad;
  const todoRef = useRef(todo);
  todoRef.current = todo;
  const usageHandlerRef = useRef(usageHandler);
  usageHandlerRef.current = usageHandler;
  const runtimeHandlersRef = useRef(runtimeHandlers);
  runtimeHandlersRef.current = runtimeHandlers;
  const branchInfoRef = useRef(branchInfo);
  branchInfoRef.current = branchInfo;
  const previousMemoryBranchScopeRef = useRef<{
    repoFullName: string;
    branch: string;
  } | null>(null);

  // --- Instruction refs ---
  const agentsMdRef = useRef<string | null>(null);
  const instructionFilenameRef = useRef<string | null>(null);

  // --- sendMessage forward ref (populated after sendMessage is defined) ---
  // Passed to useChatCheckpoint so resumeInterruptedRun can call it.
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    const resolvedBranch = branchInfo?.currentBranch || branchInfo?.defaultBranch;
    const currentMemoryScope =
      activeRepoFullName && resolvedBranch
        ? {
            repoFullName: activeRepoFullName,
            branch: resolvedBranch,
          }
        : null;
    const previousMemoryScope = previousMemoryBranchScopeRef.current;

    if (
      previousMemoryScope &&
      (!currentMemoryScope ||
        previousMemoryScope.repoFullName !== currentMemoryScope.repoFullName ||
        previousMemoryScope.branch !== currentMemoryScope.branch)
    ) {
      void expireBranchScopedMemory(previousMemoryScope).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[context-memory] expiring branch-scoped memory failed; continuing without cleanup. ${message}`,
        );
      });
    }

    previousMemoryBranchScopeRef.current = currentMemoryScope;
  }, [activeRepoFullName, branchInfo?.currentBranch, branchInfo?.defaultBranch]);

  const updateConversations = useCallback(
    (
      updater:
        | Record<string, Conversation>
        | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
    ) => {
      setConversations((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        conversationsRef.current = next;
        return next;
      });
    },
    [],
  );

  const {
    queuedFollowUpsByChat,
    queuedFollowUpsRef,
    enqueue: enqueueQueuedFollowUp,
    dequeue: dequeueQueuedFollowUp,
    clear: clearQueuedFollowUps,
    hydrate: hydrateQueuedFollowUps,
  } = useQueuedFollowUps({
    initial: initialQueuedFollowUpsByChat,
    updateConversations,
    dirtyConversationIdsRef,
    isMountedRef,
  });

  const replaceAgentEvents = useCallback((next: Record<string, AgentStatusEvent[]>) => {
    agentEventsByChatRef.current = next;
    if (isMountedRef.current) {
      setAgentEventsByChat(next);
    }
  }, []);

  const flushDirty = useCallback(async () => {
    if (!conversationsLoaded) return;
    const dirty = dirtyConversationIdsRef.current;
    const deleted = deletedConversationIdsRef.current;
    if (dirty.size === 0 && deleted.size === 0) return;

    const dirtyIds = [...dirty];
    const deletedIds = [...deleted];
    dirty.clear();
    deleted.clear();

    const currentConvs = conversationsRef.current;
    for (const id of dirtyIds) {
      const conv = currentConvs[id];
      if (conv) {
        try {
          await saveConversationToDB(conv);
          saveRetryCountsRef.current.delete(id);
        } catch (err) {
          const count = saveRetryCountsRef.current.get(id) || 0;
          if (count < 3) {
            saveRetryCountsRef.current.set(id, count + 1);
            dirty.add(id);
          } else {
            console.warn(
              `Failed to save conversation ${id} after 3 retries. Dropping update.`,
              err,
            );
            saveRetryCountsRef.current.delete(id);
          }
        }
      }
    }
    for (const id of deletedIds) {
      try {
        await deleteConversationFromDB(id);
        saveRetryCountsRef.current.delete(id);
      } catch (err) {
        const count = saveRetryCountsRef.current.get(id) || 0;
        if (count < 3) {
          saveRetryCountsRef.current.set(id, count + 1);
          deleted.add(id);
        } else {
          console.warn(
            `Failed to delete conversation ${id} after 3 retries. Dropping deletion.`,
            err,
          );
          saveRetryCountsRef.current.delete(id);
        }
      }
    }
  }, [conversationsLoaded]);

  // Periodic flush
  useEffect(() => {
    const interval = setInterval(flushDirty, 3000);
    return () => clearInterval(interval);
  }, [flushDirty]);

  // Emergency save on visibility change (mobile app-switch/lock)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushDirty();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [flushDirty]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const {
    getVerificationPolicyForChat,
    getVerificationStateForChat,
    writeVerificationStateForChat,
    setWorkspaceContext,
    setWorkspaceMode,
    workspaceContextRef,
    workspaceModeRef,
  } = useVerificationState({
    activeChatId,
    activeConversationVerificationPolicy: conversations[activeChatId]?.verificationPolicy,
    activeChatIdRef,
    conversationsRef,
    updateConversations,
    dirtyConversationIdsRef,
  });

  const { runEngineStateRef, runJournalEntryRef, emitRunEngineEvent, persistRunJournal } =
    useRunEngine({ getVerificationStateForChat });

  const {
    pendingSteersByChat,
    pendingSteersByChatRef,
    setPendingSteer,
    consumePendingSteer,
    clearPendingSteer,
  } = usePendingSteer({ isMountedRef });

  // --- Checkpoint + resume lifecycle ---
  const {
    updateAgentStatus,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    saveExpiryCheckpoint,
    flushCheckpoint,
    checkpointRefs,
    lastCoderStateRef,
    tabLockIntervalRef,
  } = useChatCheckpoint({
    runEngineStateRef,
    sandboxIdRef,
    branchInfoRef,
    repoRef,
    workspaceSessionIdRef,
    ensureSandboxRef,
    abortRef,
    setConversations: updateConversations,
    dirtyConversationIdsRef,
    conversations,
    setAgentStatus,
    agentEventsByChatRef,
    replaceAgentEvents,
    activeChatIdRef,
    sendMessageRef,
    isStreaming,
    activeChatId,
  });

  // Composition wrapper: useVerificationState owns the ref + conversation
  // write; useRunEngine owns the journal ref + persistRunJournal. When
  // verification state updates for the in-flight run's chat, the journal
  // also updates. Keeping this composition in useChat avoids a circular
  // dep between the two hooks.
  const persistVerificationState = useCallback(
    (chatId: string, verificationState: VerificationRuntimeState) => {
      writeVerificationStateForChat(chatId, verificationState);
      if (runJournalEntryRef.current?.chatId === chatId) {
        runJournalEntryRef.current = updateJournalVerificationState(
          runJournalEntryRef.current,
          verificationState,
        );
        persistRunJournal(runJournalEntryRef.current);
      }
    },
    [writeVerificationStateForChat, runJournalEntryRef, persistRunJournal],
  );

  const updateVerificationStateForChat = useCallback(
    (
      chatId: string,
      updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
    ): VerificationRuntimeState => {
      const current = getVerificationStateForChat(chatId);
      const next = updater(current);
      persistVerificationState(chatId, next);
      return next;
    },
    [getVerificationStateForChat, persistVerificationState],
  );

  // --- CI poller ---
  const { ciStatus } = useCIPoller(activeChatId, activeRepoFullName, branchInfo);

  const activeConversation = activeChatId ? conversations[activeChatId] : undefined;
  const activePersistedRunEventCount = activeConversation?.runState?.runEvents?.length ?? 0;

  const { liveRunEventsByChat, journalRunEventsByChat, appendRunEvent } = useRunEventStream({
    activeChatId,
    activePersistedRunEventCount,
    runJournalEntryRef,
    updateConversations,
    dirtyConversationIdsRef,
    isMountedRef,
  });

  // --- Derived state ---
  const messages = useMemo(() => activeConversation?.messages ?? [], [activeConversation]);
  const agentEvents = useMemo(
    () => agentEventsByChat[activeChatId] ?? [],
    [agentEventsByChat, activeChatId],
  );
  const runEvents = useMemo<RunEvent[]>(
    () =>
      mergeRunEventStreams(
        activeConversation?.runState?.runEvents ?? journalRunEventsByChat[activeChatId] ?? [],
        liveRunEventsByChat[activeChatId] ?? [],
      ),
    [activeConversation, activeChatId, journalRunEventsByChat, liveRunEventsByChat],
  );
  const conversationProvider = activeConversation?.provider;
  const conversationModel = normalizeConversationModel(
    conversationProvider,
    activeConversation?.model,
  );

  const contextUsage = useMemo(() => {
    const contextProvider =
      (conversationProvider as ActiveProvider | undefined) || getActiveProvider();
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
  const queuedFollowUpCount = activeChatId ? (queuedFollowUpsByChat[activeChatId]?.length ?? 0) : 0;
  const pendingSteerCount = activeChatId && pendingSteersByChat[activeChatId] ? 1 : 0;

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

  // Slice 2 conversation-fork migration guard. The hook owns the ref + the
  // state-observed clear effect; the auto-switch effect below early-returns
  // while the ref is set. Declared above the effect so the ref identity can
  // sit in the effect's dependency array. See useBranchForkGuard for D2.
  const skipAutoCreateRef = useBranchForkGuard(conversations, sortedChatIds);

  // --- Auto-switch effect ---
  useEffect(() => {
    // Slice 2: suppress auto-switch while a fork migration is in flight. Both
    // branches below (auto-create AND chat-id reassignment) would otherwise
    // disrupt the active chat during the transition. The in-tab `skipAutoCreateRef`
    // covers the migrating tab; `getMigrationMarker()` (cross-tab localStorage)
    // covers other tabs that observe the persisted state changes mid-migration.
    if (skipAutoCreateRef.current) return;
    if (getMigrationMarker()) return;

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
          verificationPolicy: getDefaultVerificationPolicy(),
        };
        updateConversations((prev) => {
          const updated = { ...prev, [id]: newConv };
          dirtyConversationIdsRef.current.add(id);
          return updated;
        });
        setActiveChatId(id);
        saveActiveChatId(id);
        setTimeout(() => {
          autoCreateRef.current = false;
        }, 0);
      }
    } else if (sortedChatIds.length > 0 && !sortedChatIds.includes(activeChatId)) {
      setActiveChatId(sortedChatIds[0]);
      saveActiveChatId(sortedChatIds[0]);
    }
  }, [sortedChatIds, activeChatId, activeRepoFullName, updateConversations, skipAutoCreateRef]);

  // --- Sandbox setters ---
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

  const hydratePersistedRunState = useCallback(
    (convs: Record<string, Conversation>) => {
      replaceAgentEvents(buildAgentEventsByChat(convs));
      hydrateQueuedFollowUps(convs);
    },
    [replaceAgentEvents, hydrateQueuedFollowUps],
  );

  // --- IndexedDB migration ---
  useEffect(() => {
    migrateConversationsToIndexedDB().then((convs) => {
      hydratePersistedRunState(convs);
      if (Object.keys(convs).length > 0) {
        updateConversations(convs);
        setActiveChatId((prev) => {
          if (prev && convs[prev]) return prev;
          return loadActiveChatId(convs);
        });
      }
      setConversationsLoaded(true);
    });
  }, [hydratePersistedRunState, updateConversations]);

  // --- Abort stream ---
  const abortStream = useCallback(
    (options?: AbortStreamOptions) => {
      if (options?.clearQueuedFollowUps) {
        const runningChatId = runEngineStateRef.current.chatId || activeChatIdRef.current;
        if (runningChatId) {
          const hadQueuedFollowUps = (queuedFollowUpsRef.current[runningChatId]?.length ?? 0) > 0;
          clearQueuedFollowUps(runningChatId);
          if (hadQueuedFollowUps) {
            emitRunEngineEvent({ type: 'FOLLOW_UP_QUEUE_CLEARED', timestamp: Date.now() });
          }
        }
      }
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
    },
    [
      clearQueuedFollowUps,
      emitRunEngineEvent,
      queuedFollowUpsRef,
      runEngineStateRef,
      updateAgentStatus,
    ],
  );

  useEffect(() => {
    return () => {
      if (cancelStatusTimerRef.current !== null) {
        window.clearTimeout(cancelStatusTimerRef.current);
      }
    };
  }, []);

  // --- Chat management ---
  const { createNewChat, switchChat, renameChat, deleteChat, deleteAllChats } = useChatManagement({
    conversations,
    setConversations: updateConversations,
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
    clearQueuedFollowUps,
    workspaceModeRef,
  });

  // --- Background Coder jobs (PR #3b) ---
  // Owns its own module per AGENTS.md §"new feature checklist #2" —
  // this hook instantiates it here solely to thread the handle into
  // `useAgentDelegation`. No logic lives in this file.
  const backgroundCoderJob = useBackgroundCoderJob({
    setConversations: updateConversations,
    conversationsRef,
    appendRunEvent,
    updateAgentStatus,
  });

  // --- Agent delegation ---
  const { executeDelegateCall } = useAgentDelegation({
    setConversations: updateConversations,
    updateAgentStatus,
    appendRunEvent,
    emitRunEngineEvent,
    getVerificationPolicyForChat,
    updateVerificationStateForChat,
    branchInfoRef,
    isMainProtectedRef,
    agentsMdRef,
    instructionFilenameRef,
    sandboxIdRef,
    repoRef,
    abortControllerRef,
    abortRef,
    lastCoderStateRef,
    backgroundCoderJob,
    // Phase 1: single global toggle. Per-chat override is a later
    // layer — see docs/runbooks/Background Coder Tasks Phase 1.md §4.
    isBackgroundModeEnabledForChat: () => isBackgroundModeEnabled(),
  });

  // ---------------------------------------------------------------------------
  // sendMessage — loop orchestrator
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (text: string, attachments?: AttachmentData[], options?: SendMessageOptions) => {
      const trimmedText = text.trim();
      const hasAttachments = Boolean(attachments && attachments.length > 0);
      if (!trimmedText && !hasAttachments) return;

      if (isRunActive(runEngineStateRef.current)) {
        const runningChatId = runEngineStateRef.current.chatId;
        const targetChatId = options?.chatId || activeChatIdRef.current || runningChatId;
        if (!runningChatId || (targetChatId && targetChatId !== runningChatId)) return;

        const inputPreview = summarizeQueuedInputPreview(
          trimmedText,
          hasAttachments ? attachments : undefined,
          options?.displayText,
        );
        const round = runEngineStateRef.current.round;
        if (options?.streamingBehavior === 'steer') {
          const replacedPending = Boolean(pendingSteersByChatRef.current[runningChatId]);
          setPendingSteer(
            runningChatId,
            toPendingSteerRequest(trimmedText, hasAttachments ? attachments : undefined, options),
          );
          emitRunEngineEvent({
            type: 'STEER_SET',
            timestamp: Date.now(),
            preview: inputPreview,
          });
          appendRunEvent(runningChatId, {
            type: 'user.follow_up_steered',
            round,
            preview: inputPreview,
            replacedPending,
          });
          return;
        }

        const queuePosition = (queuedFollowUpsRef.current[runningChatId]?.length ?? 0) + 1;
        const queuedFollowUp = toQueuedFollowUp(
          trimmedText,
          hasAttachments ? attachments : undefined,
          options,
        );
        enqueueQueuedFollowUp(runningChatId, queuedFollowUp);
        emitRunEngineEvent({
          type: 'FOLLOW_UP_ENQUEUED',
          timestamp: Date.now(),
          followUp: queuedFollowUp,
        });
        appendRunEvent(runningChatId, {
          type: 'user.follow_up_queued',
          round,
          position: queuePosition,
          preview: inputPreview,
        });
        return;
      }

      let chatId = options?.chatId || activeChatIdRef.current;
      const conversationsSnapshot = conversationsRef.current;
      if (!chatId || !conversationsSnapshot[chatId]) {
        chatId = createNewChat();
      }

      // --- Prepare context ---
      const prepared = await prepareSendContext(
        { trimmedText, attachments, options, chatId },
        {
          conversationsRef,
          dirtyConversationIdsRef,
          sandboxIdRef,
          ensureSandboxRef,
          abortRef,
          abortControllerRef,
        },
        { updateConversations, setIsStreaming, updateAgentStatus },
      );
      const lockedProviderForChat = prepared.lockedProvider;
      const resolvedModelForChat = prepared.resolvedModel;
      let apiMessages = prepared.apiMessages;
      let toolCallRecoveryState = prepared.recoveryState;

      // --- Initialize run ---
      // apiMessages is the only checkpoint ref; all other state is
      // managed by the engine via emitRunEngineEvent.
      checkpointRefs.apiMessages.current = apiMessages;
      emitRunEngineEvent({
        type: 'RUN_STARTED',
        timestamp: Date.now(),
        runId: createId(),
        chatId,
        provider: lockedProviderForChat,
        model: resolvedModelForChat || '',
        baseMessageCount: apiMessages.length,
      });

      // Acquire multi-tab lock
      const acquiredTabId = acquireRunTabLock(chatId);
      if (!acquiredTabId) {
        emitRunEngineEvent({ type: 'TAB_LOCK_DENIED', timestamp: Date.now() });
        setIsStreaming(false);
        updateAgentStatus({ active: false, phase: '' });
        updateConversations((prev) => {
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
      emitRunEngineEvent({
        type: 'TAB_LOCK_ACQUIRED',
        timestamp: Date.now(),
        tabLockId: acquiredTabId,
      });
      if (tabLockIntervalRef.current) clearInterval(tabLockIntervalRef.current);
      tabLockIntervalRef.current = setInterval(
        () => heartbeatRunTabLock(chatId, acquiredTabId),
        15_000,
      );

      // --- Build loop context (constant for this call) ---
      const loopCtx: SendLoopContext = {
        chatId,
        lockedProvider: lockedProviderForChat,
        resolvedModel: resolvedModelForChat ?? undefined,
        abortRef,
        abortControllerRef,
        sandboxIdRef,
        ensureSandboxRef,
        scratchpadRef,
        todoRef,
        usageHandlerRef,
        workspaceContextRef,
        runtimeHandlersRef,
        repoRef,
        isMainProtectedRef,
        branchInfoRef,
        checkpointRefs,
        processedContentRef,
        lastCoderStateRef,
        setConversations: updateConversations,
        dirtyConversationIdsRef,
        updateAgentStatus,
        appendRunEvent,
        flushCheckpoint,
        getVerificationState: getVerificationStateForChat,
        updateVerificationState: updateVerificationStateForChat,
        executeDelegateCall,
        emitRunEngineEvent,
        // Slice 2: chat-send sets this when a 'forked' branchSwitch arrives,
        // suppressing useChat's auto-switch effect during migration.
        skipAutoCreateRef,
        activeChatIdRef,
        // applyBranchSwitchPayload reads this to verify the target conversation
        // exists BEFORE setting guards (Codex P1 review feedback).
        conversationsRef,
      };

      let loopCompletedNormally = false;
      try {
        for (let round = 0; ; round++) {
          if (abortRef.current) break;
          fileLedger.advanceRound();

          emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: Date.now(), round });
          appendRunEvent(chatId, { type: 'assistant.turn_start', round });

          if (round > 0) {
            const newAssistant: ChatMessage = {
              id: createId(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              status: 'streaming',
            };
            updateConversations((prev) => {
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

          if (abortRef.current) {
            appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'aborted' });
            break;
          }

          if (error) {
            emitRunEngineEvent({
              type: 'LOOP_FAILED',
              timestamp: Date.now(),
              reason: error.message,
            });
            appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'error' });
            updateConversations((prev) => {
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
          emitRunEngineEvent({
            type: 'STREAMING_COMPLETED',
            timestamp: Date.now(),
            accumulated,
            thinking: thinkingAccumulated,
          });

          const pendingSteerBeforeToolDispatch = consumePendingSteer(chatId);
          if (pendingSteerBeforeToolDispatch) {
            emitRunEngineEvent({ type: 'STEER_CONSUMED', timestamp: Date.now() });
            const steerUserMessage = buildRuntimeUserMessage(
              pendingSteerBeforeToolDispatch.text,
              pendingSteerBeforeToolDispatch.attachments,
              pendingSteerBeforeToolDispatch.options?.displayText,
            );
            const shouldKeepAssistantDraft = accumulated.trim().length > 0;

            updateConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = [...conv.messages];
              const lastIdx = msgs.length - 1;
              if (msgs[lastIdx]?.role === 'assistant') {
                if (shouldKeepAssistantDraft) {
                  msgs[lastIdx] = {
                    ...msgs[lastIdx],
                    content: accumulated,
                    thinking: thinkingAccumulated || undefined,
                    status: 'done',
                  };
                } else {
                  msgs.pop();
                }
              }
              const updated = {
                ...prev,
                [chatId]: {
                  ...conv,
                  messages: [...msgs, steerUserMessage],
                  lastMessageAt: Date.now(),
                },
              };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });

            apiMessages = [
              ...apiMessages,
              ...(shouldKeepAssistantDraft
                ? [
                    {
                      id: createId(),
                      role: 'assistant' as const,
                      content: accumulated,
                      timestamp: Date.now(),
                      status: 'done' as const,
                    },
                  ]
                : []),
              steerUserMessage,
            ];
            checkpointRefs.apiMessages.current = apiMessages;
            flushCheckpoint();
            emitRunEngineEvent({ type: 'TURN_STEERED', timestamp: Date.now() });
            appendRunEvent(chatId, { type: 'assistant.turn_end', round, outcome: 'steered' });
            continue;
          }

          // Checkpoint after streaming, before tool dispatch
          emitRunEngineEvent({ type: 'TOOLS_STARTED', timestamp: Date.now() });
          flushCheckpoint();
          if (runJournalEntryRef.current) {
            runJournalEntryRef.current = markJournalCheckpoint(runJournalEntryRef.current, true);
            persistRunJournal(runJournalEntryRef.current);
          }

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

          const pendingSteerAfterTurn = consumePendingSteer(chatId);
          if (pendingSteerAfterTurn) {
            emitRunEngineEvent({ type: 'STEER_CONSUMED', timestamp: Date.now() });
            const steerUserMessage = buildRuntimeUserMessage(
              pendingSteerAfterTurn.text,
              pendingSteerAfterTurn.attachments,
              pendingSteerAfterTurn.options?.displayText,
            );
            updateConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const updated = {
                ...prev,
                [chatId]: {
                  ...conv,
                  messages: [...conv.messages, steerUserMessage],
                  lastMessageAt: Date.now(),
                },
              };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });
            apiMessages = [...apiMessages, steerUserMessage];
            checkpointRefs.apiMessages.current = apiMessages;
            flushCheckpoint();
            emitRunEngineEvent({ type: 'TURN_STEERED', timestamp: Date.now() });
            appendRunEvent(chatId, {
              type: 'assistant.turn_end',
              round,
              outcome: 'steered',
            });
            continue;
          }

          const turnOutcome =
            turnResult.loopAction === 'continue'
              ? 'continued'
              : turnResult.loopCompletedNormally
                ? 'completed'
                : 'aborted';
          if (turnResult.loopCompletedNormally) loopCompletedNormally = true;
          appendRunEvent(chatId, {
            type: 'assistant.turn_end',
            round,
            outcome: turnOutcome,
          });
          if (turnResult.loopAction === 'break') break;
          emitRunEngineEvent({ type: 'TURN_CONTINUED', timestamp: Date.now() });
          // 'continue' → next round
        }
      } catch (err) {
        emitRunEngineEvent({
          type: 'LOOP_FAILED',
          timestamp: Date.now(),
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        const { nextFollowUp } = finalizeRunSession(
          { chatId, loopCompletedNormally },
          {
            runEngineStateRef,
            cancelStatusTimerRef,
            abortControllerRef,
            tabLockIntervalRef,
            activeChatIdRef,
            queuedFollowUpsRef,
          },
          {
            emitRunEngineEvent,
            setIsStreaming,
            updateAgentStatus,
            clearPendingSteer,
            dequeueQueuedFollowUp,
            clearQueuedFollowUps,
          },
        );
        if (nextFollowUp && isMountedRef.current) {
          queueMicrotask(() => {
            if (!isMountedRef.current) return;
            void sendMessage(nextFollowUp.text, nextFollowUp.attachments, nextFollowUp.options);
          });
        }
      }
    },
    [
      createNewChat,
      updateAgentStatus,
      flushCheckpoint,
      executeDelegateCall,
      checkpointRefs,
      consumePendingSteer,
      clearPendingSteer,
      dequeueQueuedFollowUp,
      clearQueuedFollowUps,
      enqueueQueuedFollowUp,
      queuedFollowUpsRef,
      runEngineStateRef,
      runJournalEntryRef,
      pendingSteersByChatRef,
      setPendingSteer,
      workspaceContextRef,
      lastCoderStateRef,
      tabLockIntervalRef,
      dirtyConversationIdsRef,
      updateConversations,
      appendRunEvent,
      emitRunEngineEvent,
      getVerificationStateForChat,
      persistRunJournal,
      updateVerificationStateForChat,
      skipAutoCreateRef,
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
  const { injectAssistantCardMessage, handleCardAction } = useChatCardActions({
    setConversations: updateConversations,
    dirtyConversationIdsRef,
    activeChatId,
    sandboxIdRef,
    isMainProtectedRef,
    branchInfoRef,
    repoRef,
    lockedProvider,
    lockedModel,
    updateAgentStatus,
    sendMessageRef: sendMessageRef as import('react').MutableRefObject<
      ((text: string) => Promise<void>) | null
    >,
    isStreaming,
    messages,
  });

  // ---------------------------------------------------------------------------
  // UI-initiated branch fork (slice 2.1)
  // ---------------------------------------------------------------------------

  // Wraps the sandbox_create_branch tool path so the UI button and the model
  // emit the same operation, then dispatches the resulting BranchSwitchPayload
  // through applyBranchSwitchPayload so conversation migration fires the same
  // way it does for model-initiated forks. Single source of truth for the
  // migration logic — no parallel implementation in the UI handler.
  const forkBranchFromUI = useCallback(
    async (name: string, from?: string): Promise<ForkBranchInWorkspaceResult> => {
      const result = await forkBranchInWorkspace(sandboxIdRef.current, name, from);
      if (!result.ok || !result.branchSwitch) return result;
      applyBranchSwitchPayload(result.branchSwitch, {
        activeChatIdRef,
        conversationsRef,
        branchInfoRef,
        skipAutoCreateRef,
        setConversations: updateConversations,
        dirtyConversationIdsRef,
        runtimeHandlersRef,
      });
      return result;
    },
    [updateConversations, skipAutoCreateRef],
  );

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    // Active chat
    messages,
    sendMessage,
    agentStatus,
    agentEvents,
    runEvents,
    isStreaming,
    queuedFollowUpCount,
    pendingSteerCount,
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
    setWorkspaceMode,

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

    // Slice 2.1 UI-initiated fork
    forkBranchFromUI,
  };
}
