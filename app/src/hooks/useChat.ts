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
import { getModelNameForProvider } from '@/lib/providers';
import { migrateConversationsToIndexedDB } from '@/lib/conversation-store';
import { createId } from '@push/lib/id-utils';
import {
  loadActiveChatId,
  loadConversations,
  normalizeConversationModel,
  saveActiveChatId,
} from '@/hooks/chat-persistence';
import { useConversationPersistence } from './useConversationPersistence';
import { useAgentDelegation } from './useAgentDelegation';
import { useBackgroundCoderJob } from './useBackgroundCoderJob';
import { isBackgroundModeEnabled } from '@/lib/background-mode-settings';
import { hasActiveBackgroundJob, startBackgroundMainChatTurn } from './chat-send-background';
import { useCIPoller } from './useCIPoller';
import { useChatCardActions } from './chat-card-actions';
import { useChatManagement } from './chat-management';
import { useChatReplay } from './chat-replay';
import { useChatCheckpoint } from './useChatCheckpoint';
import { type SendLoopContext } from './chat-send';
import { runRoundLoop } from './chat-round-loop';
import { routeActiveRunInput } from './chat-active-run-router';
import { prepareSendContext } from './chat-prepare-send';
import { acquireRunSession, finalizeRunSession } from './chat-run-session';
import { useQueuedFollowUps } from './useQueuedFollowUps';
import { mergeRunEventStreams } from '@/lib/chat-run-events';
import { expireBranchScopedMemory } from '@/lib/context-memory';
import { updateJournalVerificationState } from '@/lib/run-journal';
import { useRunEventStream } from './useRunEventStream';
import { useRunEngine } from './useRunEngine';
import { useVerificationState } from './useVerificationState';
import { usePendingSteer } from './usePendingSteer';
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

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // --- Conversation persistence (dirty/deleted sets + flush lifecycle) ---
  const { dirtyConversationIdsRef, deletedConversationIdsRef } = useConversationPersistence({
    conversationsLoaded,
    conversationsRef,
  });

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
    enqueuePendingSteer,
    dequeuePendingSteer,
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
  const pendingSteerCount = activeChatId ? (pendingSteersByChat[activeChatId]?.length ?? 0) : 0;

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
  }, [
    sortedChatIds,
    activeChatId,
    activeRepoFullName,
    updateConversations,
    skipAutoCreateRef,
    dirtyConversationIdsRef,
  ]);

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
      // Attachments still fall through to foreground until PR 3+ envelopes them.
      const useBgMode = isBackgroundModeEnabled() && !hasAttachments;

      const bgChat = options?.chatId || activeChatIdRef.current;
      if (bgChat && hasActiveBackgroundJob(conversationsRef.current[bgChat])) return;

      const routed = routeActiveRunInput(
        { trimmedText, attachments, hasAttachments, options },
        {
          runEngineStateRef,
          activeChatIdRef,
          queuedFollowUpsRef,
          enqueuePendingSteer,
          enqueueQueuedFollowUp,
          emitRunEngineEvent,
          appendRunEvent,
        },
      );
      if (routed.handled) return;

      let chatId = options?.chatId || activeChatIdRef.current;
      const conversationsSnapshot = conversationsRef.current;
      if (!chatId || !conversationsSnapshot[chatId]) {
        chatId = createNewChat();
      }

      // --- Prepare context ---
      const prepared = await prepareSendContext(
        { trimmedText, attachments, options, chatId, skipStreamingPlaceholder: useBgMode },
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
      const apiMessages = prepared.apiMessages;
      const toolCallRecoveryState = prepared.recoveryState;

      if (useBgMode) {
        // biome-ignore format: keep refs inline so this branch stays under the file line cap.
        const refs = { sandboxIdRef, repoRef, branchInfoRef, isMainProtectedRef, agentsMdRef, instructionFilenameRef };
        const r = await startBackgroundMainChatTurn({
          chatId,
          trimmedText,
          lockedProvider: lockedProviderForChat,
          resolvedModel: resolvedModelForChat ?? undefined,
          refs,
          backgroundCoderJob,
        });
        if (!r.ok) updateAgentStatus({ active: false, phase: r.error }, { chatId, log: true });
        return;
      }

      // --- Acquire run session ---
      const { acquired } = acquireRunSession(
        {
          chatId,
          lockedProvider: lockedProviderForChat,
          resolvedModel: resolvedModelForChat,
          apiMessages,
        },
        {
          dirtyConversationIdsRef,
          tabLockIntervalRef,
          checkpointApiMessagesRef: checkpointRefs.apiMessages,
        },
        { emitRunEngineEvent, setIsStreaming, updateAgentStatus, updateConversations },
      );
      if (!acquired) return;

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
        const result = await runRoundLoop(
          loopCtx,
          { apiMessages, recoveryState: toolCallRecoveryState },
          { runJournalEntryRef, persistRunJournal, dequeuePendingSteer, pendingSteersByChatRef },
        );
        loopCompletedNormally = result.loopCompletedNormally;
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
      dequeuePendingSteer,
      clearPendingSteer,
      dequeueQueuedFollowUp,
      clearQueuedFollowUps,
      enqueueQueuedFollowUp,
      queuedFollowUpsRef,
      runEngineStateRef,
      runJournalEntryRef,
      pendingSteersByChatRef,
      enqueuePendingSteer,
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
      backgroundCoderJob,
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
    [updateConversations, skipAutoCreateRef, dirtyConversationIdsRef],
  );

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
