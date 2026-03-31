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
  RunEventInput,
  VerificationRuntimeState,
  WorkspaceContext,
  WorkspaceMode,
} from '@/types';
import {
  buildAgentEventsByChat,
  buildQueuedFollowUpsByChat,
  setConversationRunEvents,
  setConversationQueuedFollowUps,
  setConversationVerificationState,
} from '@/lib/chat-runtime-state';
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
import {
  appendQueuedItem,
  clearQueuedItems,
  shiftQueuedItem,
  type QueuedItemsByChat,
} from './chat-queue';
import {
  mergeRunEventStreams,
  shouldPersistRunEvent,
  trimRunEvents,
} from '@/lib/chat-run-events';
import {
  IDLE_RUN_STATE,
  isRunActive,
  runEngineReducer,
  type RunEngineEvent,
  type RunEngineState,
} from '@/lib/run-engine';
import {
  appendJournalEvent,
  createJournalEntry,
  finalizeJournalEntry,
  loadJournalEntriesForChat,
  pruneJournalEntries,
  recordDelegationOutcome,
  saveJournalEntry,
  updateJournalPhase,
  updateJournalVerificationState,
  markJournalCheckpoint,
  type RunJournalEntry,
} from '@/lib/run-journal';
import {
  getDefaultVerificationPolicy,
  resolveVerificationPolicy,
  type VerificationPolicy,
} from '@/lib/verification-policy';
import {
  hydrateVerificationRuntimeState,
} from '@/lib/verification-runtime';

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

type AbortStreamOptions = {
  clearQueuedFollowUps?: boolean;
};

interface PendingSteerRequest {
  text: string;
  attachments?: AttachmentData[];
  options?: QueuedFollowUpOptions;
  requestedAt: number;
}

type PendingSteersByChat = Record<string, PendingSteerRequest>;

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
  const attachmentLabel = attachmentCount > 0
    ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
    : '';

  const base = candidate
    ? attachmentLabel
      ? `${candidate} (+${attachmentLabel})`
      : candidate
    : attachmentLabel || '[no text]';

  return base.length <= maxLength
    ? base
    : `${base.slice(0, maxLength - 1).trimEnd()}...`;
}

function buildRuntimeUserMessage(
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
    displayContent: trimmedDisplayText && trimmedDisplayText !== trimmedText
      ? trimmedDisplayText
      : undefined,
    timestamp: Date.now(),
    status: 'done',
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  };
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

import type { ScratchpadHandlers, UsageHandler, ChatRuntimeHandlers } from './chat-send';

export function useChat(
  activeRepoFullName: string | null,
  scratchpad?: ScratchpadHandlers,
  usageHandler?: UsageHandler,
  runtimeHandlers?: ChatRuntimeHandlers,
  branchInfo?: { currentBranch?: string; defaultBranch?: string },
) {
  const initialConversationsRef = useRef<Record<string, Conversation> | null>(null);
  if (initialConversationsRef.current === null) {
    initialConversationsRef.current = loadConversations();
  }
  const initialConversations = initialConversationsRef.current;
  const initialAgentEventsByChat = buildAgentEventsByChat(initialConversations);
  const initialQueuedFollowUpsByChat = buildQueuedFollowUpsByChat(initialConversations);

  // --- Core state ---
  const [conversations, setConversations] = useState<Record<string, Conversation>>(initialConversations);
  const [activeChatId, setActiveChatId] = useState<string>(() => loadActiveChatId(initialConversations));
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ active: false, phase: '' });
  const [agentEventsByChat, setAgentEventsByChat] = useState<Record<string, AgentStatusEvent[]>>(initialAgentEventsByChat);
  const [queuedFollowUpsByChat, setQueuedFollowUpsByChat] = useState<QueuedItemsByChat<QueuedFollowUp>>(initialQueuedFollowUpsByChat);
  const [liveRunEventsByChat, setLiveRunEventsByChat] = useState<Record<string, RunEvent[]>>({});
  const [journalRunEventsByChat, setJournalRunEventsByChat] = useState<Record<string, RunEvent[]>>({});
  const [pendingSteersByChat, setPendingSteersByChat] = useState<PendingSteersByChat>({});

  // --- Persistence refs ---
  const dirtyConversationIdsRef = useRef(new Set<string>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const saveRetryCountsRef = useRef<Map<string, number>>(new Map());

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const agentEventsByChatRef = useRef<Record<string, AgentStatusEvent[]>>(initialAgentEventsByChat);
  agentEventsByChatRef.current = agentEventsByChat;
  const liveRunEventsByChatRef = useRef<Record<string, RunEvent[]>>({});
  liveRunEventsByChatRef.current = liveRunEventsByChat;
  const activeChatIdRef = useRef(activeChatId);
  const abortRef = useRef(false);
  const processedContentRef = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelStatusTimerRef = useRef<number | null>(null);
  const queuedFollowUpsRef = useRef<QueuedItemsByChat<QueuedFollowUp>>(initialQueuedFollowUpsByChat);
  queuedFollowUpsRef.current = queuedFollowUpsByChat;
  const pendingSteersByChatRef = useRef<PendingSteersByChat>({});
  pendingSteersByChatRef.current = pendingSteersByChat;
  const isMountedRef = useRef(true);

  // --- Session identity refs ---
  const sandboxIdRef = useRef<string | null>(null);
  const workspaceSessionIdRef = useRef<string | null>(null);
  const isMainProtectedRef = useRef(false);
  const autoCreateRef = useRef(false);
  const workspaceContextRef = useRef<WorkspaceContext | null>(null);
  const workspaceModeRef = useRef<WorkspaceMode | null>(null);
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
  const runEngineStateRef = useRef<RunEngineState>(IDLE_RUN_STATE);
  const runJournalEntryRef = useRef<RunJournalEntry | null>(null);
  const baseWorkspaceContextRef = useRef<WorkspaceContext | null>(null);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const updateConversations = useCallback(
    (updater: Record<string, Conversation> | ((prev: Record<string, Conversation>) => Record<string, Conversation>)) => {
      setConversations((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        conversationsRef.current = next;
        return next;
      });
    },
    [],
  );

  const replaceAgentEvents = useCallback((next: Record<string, AgentStatusEvent[]>) => {
    agentEventsByChatRef.current = next;
    if (isMountedRef.current) {
      setAgentEventsByChat(next);
    }
  }, []);

  const replaceLiveRunEvents = useCallback((next: Record<string, RunEvent[]>) => {
    liveRunEventsByChatRef.current = next;
    if (isMountedRef.current) {
      setLiveRunEventsByChat(next);
    }
  }, []);

  const replacePendingSteers = useCallback((next: PendingSteersByChat) => {
    pendingSteersByChatRef.current = next;
    if (isMountedRef.current) {
      setPendingSteersByChat(next);
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
            console.warn(`Failed to save conversation ${id} after 3 retries. Dropping update.`, err);
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
          console.warn(`Failed to delete conversation ${id} after 3 retries. Dropping deletion.`, err);
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
  const appendRunEvent = useCallback((chatId: string, event: RunEventInput) => {
    const nextEvent: RunEvent = {
      id: createId(),
      timestamp: Date.now(),
      ...event,
    };

    // Track B: append persisted events to the journal entry
    if (shouldPersistRunEvent(event) && runJournalEntryRef.current) {
      runJournalEntryRef.current = appendJournalEvent(
        runJournalEntryRef.current,
        nextEvent,
      );
      if (event.type === 'subagent.completed' && event.delegationOutcome) {
        runJournalEntryRef.current = recordDelegationOutcome(
          runJournalEntryRef.current,
          event.delegationOutcome,
        );
      }
      void saveJournalEntry(runJournalEntryRef.current);
    }

    if (!shouldPersistRunEvent(event)) {
      replaceLiveRunEvents({
        ...liveRunEventsByChatRef.current,
        [chatId]: trimRunEvents([
          ...(liveRunEventsByChatRef.current[chatId] || []),
          nextEvent,
        ]),
      });
      return;
    }

    updateConversations((prev) => {
      const conversation = prev[chatId];
      if (!conversation) return prev;
      const runEvents = conversation.runState?.runEvents || [];
      dirtyConversationIdsRef.current.add(chatId);
      return {
        ...prev,
        [chatId]: setConversationRunEvents(conversation, [
          ...runEvents,
          nextEvent,
        ]),
      };
    });
  }, [replaceLiveRunEvents, updateConversations]);

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

  const getVerificationPolicyForChat = useCallback((chatId: string | null | undefined): VerificationPolicy => {
    if (!chatId) return getDefaultVerificationPolicy();
    return resolveVerificationPolicy(conversationsRef.current[chatId]?.verificationPolicy);
  }, []);

  const verificationStateByChatRef = useRef<Record<string, VerificationRuntimeState>>({});

  const getVerificationStateForChat = useCallback((chatId: string | null | undefined): VerificationRuntimeState => {
    const policy = getVerificationPolicyForChat(chatId);
    const key = chatId || '';
    const cached = verificationStateByChatRef.current[key];
    const persisted = chatId
      ? conversationsRef.current[chatId]?.runState?.verificationState
      : undefined;
    const hydrated = hydrateVerificationRuntimeState(policy, cached ?? persisted);
    verificationStateByChatRef.current[key] = hydrated;
    return hydrated;
  }, [getVerificationPolicyForChat]);

  const applyWorkspaceContext = useCallback((ctx: WorkspaceContext | null, chatId: string | null | undefined) => {
    if (!ctx) {
      workspaceContextRef.current = null;
      return;
    }
    workspaceContextRef.current = {
      ...ctx,
      verificationPolicy: getVerificationPolicyForChat(chatId),
    };
  }, [getVerificationPolicyForChat]);

  const persistRunJournal = useCallback((entry: RunJournalEntry | null, options?: { prune?: boolean }) => {
    if (!entry) return;
    void saveJournalEntry(entry);
    if (options?.prune) {
      void pruneJournalEntries();
    }
  }, []);

  const persistVerificationState = useCallback((chatId: string, verificationState: VerificationRuntimeState) => {
    verificationStateByChatRef.current[chatId] = verificationState;

    if (runJournalEntryRef.current?.chatId === chatId) {
      runJournalEntryRef.current = updateJournalVerificationState(
        runJournalEntryRef.current,
        verificationState,
      );
      persistRunJournal(runJournalEntryRef.current);
    }

    updateConversations((prev) => {
      const conversation = prev[chatId];
      if (!conversation) return prev;
      dirtyConversationIdsRef.current.add(chatId);
      return {
        ...prev,
        [chatId]: setConversationVerificationState(conversation, verificationState),
      };
    });
  }, [persistRunJournal, updateConversations]);

  const updateVerificationStateForChat = useCallback((
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ): VerificationRuntimeState => {
    const current = getVerificationStateForChat(chatId);
    const next = updater(current);
    persistVerificationState(chatId, next);
    return next;
  }, [getVerificationStateForChat, persistVerificationState]);

  /**
   * Emit a run engine event — the single mutation path for run state.
   *
   * Track A cutover: the engine is now authoritative. All run state reads
   * (phase, round, accumulated, chatId, tabLockId, etc.) come from
   * runEngineStateRef.current.
   *
   * Track B: also maintains the run journal entry for lifecycle persistence.
   */
  const emitRunEngineEvent = useCallback((event: RunEngineEvent) => {
    runEngineStateRef.current = runEngineReducer(runEngineStateRef.current, event);

    // --- Track B: journal lifecycle ---
    const engineState = runEngineStateRef.current;
    switch (event.type) {
      case 'RUN_STARTED':
        runJournalEntryRef.current = createJournalEntry({
          runId: event.runId,
          chatId: event.chatId,
          provider: event.provider,
          model: event.model,
          baseMessageCount: event.baseMessageCount,
          startedAt: event.timestamp,
        });
        runJournalEntryRef.current = updateJournalVerificationState(
          runJournalEntryRef.current,
          getVerificationStateForChat(event.chatId),
        );
        persistRunJournal(runJournalEntryRef.current);
        break;

      case 'ROUND_STARTED':
        if (runJournalEntryRef.current) {
          runJournalEntryRef.current = updateJournalPhase(
            runJournalEntryRef.current,
            engineState.phase,
            event.round,
          );
          persistRunJournal(runJournalEntryRef.current);
        }
        break;

      case 'LOOP_COMPLETED':
        if (runJournalEntryRef.current) {
          runJournalEntryRef.current = finalizeJournalEntry(
            runJournalEntryRef.current, 'completed',
          );
          persistRunJournal(runJournalEntryRef.current, { prune: true });
          runJournalEntryRef.current = null;
        }
        break;

      case 'LOOP_ABORTED':
        if (runJournalEntryRef.current) {
          runJournalEntryRef.current = finalizeJournalEntry(
            runJournalEntryRef.current, 'aborted',
          );
          persistRunJournal(runJournalEntryRef.current, { prune: true });
          runJournalEntryRef.current = null;
        }
        break;

      case 'LOOP_FAILED':
        if (runJournalEntryRef.current) {
          runJournalEntryRef.current = finalizeJournalEntry(
            runJournalEntryRef.current, 'failed', event.reason,
          );
          persistRunJournal(runJournalEntryRef.current, { prune: true });
          runJournalEntryRef.current = null;
        }
        break;

      case 'ACCUMULATED_UPDATED':
        break;

      default:
        // Phase updates for delegation, tools, etc.
        if (runJournalEntryRef.current) {
          runJournalEntryRef.current = updateJournalPhase(
            runJournalEntryRef.current,
            engineState.phase,
            engineState.round,
          );
          persistRunJournal(runJournalEntryRef.current);
        }
        break;
    }
  }, [getVerificationStateForChat, persistRunJournal]);

  // --- CI poller ---
  const { ciStatus } = useCIPoller(activeChatId, activeRepoFullName, branchInfo);

  const activeConversation = activeChatId ? conversations[activeChatId] : undefined;
  const activePersistedRunEventCount = activeConversation?.runState?.runEvents?.length ?? 0;

  useEffect(() => {
    if (!activeChatId) return;
    if (activePersistedRunEventCount > 0) {
      setJournalRunEventsByChat((prev) => {
        if (!prev[activeChatId]) return prev;
        const next = { ...prev };
        delete next[activeChatId];
        return next;
      });
      return;
    }

    let cancelled = false;
    void loadJournalEntriesForChat(activeChatId)
      .then((entries) => {
        if (cancelled) return;
        const latestEvents = entries[0]?.events ?? [];
        setJournalRunEventsByChat((prev) => {
          if (latestEvents.length === 0) {
            if (!prev[activeChatId]) return prev;
            const next = { ...prev };
            delete next[activeChatId];
            return next;
          }
          const existing = prev[activeChatId];
          if (
            existing?.length === latestEvents.length &&
            existing[existing.length - 1]?.id === latestEvents[latestEvents.length - 1]?.id
          ) {
            return prev;
          }
          return {
            ...prev,
            [activeChatId]: latestEvents,
          };
        });
      })
      .catch(() => {
        // Journal fallback is best-effort only.
      });

    return () => {
      cancelled = true;
    };
  }, [activeChatId, activePersistedRunEventCount]);

  // --- Derived state ---
  const messages = useMemo(
    () => activeConversation?.messages ?? [],
    [activeConversation],
  );
  const agentEvents = useMemo(
    () => agentEventsByChat[activeChatId] ?? [],
    [agentEventsByChat, activeChatId],
  );
  const runEvents = useMemo<RunEvent[]>(
    () => mergeRunEventStreams(
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
          verificationPolicy: getDefaultVerificationPolicy(),
        };
        updateConversations((prev) => {
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
  }, [sortedChatIds, activeChatId, activeRepoFullName, updateConversations]);

  // --- Workspace context / sandbox setters ---
  const setWorkspaceContext = useCallback((ctx: WorkspaceContext | null) => {
    baseWorkspaceContextRef.current = ctx;
    workspaceModeRef.current = ctx?.mode ?? null;
    applyWorkspaceContext(ctx, activeChatIdRef.current);
  }, [applyWorkspaceContext]);

  /** Synchronous mode setter — call during render to avoid stale ref between workspace transitions. */
  const setWorkspaceMode = useCallback((mode: WorkspaceMode | null) => {
    workspaceModeRef.current = mode;
  }, []);

  useEffect(() => {
    applyWorkspaceContext(baseWorkspaceContextRef.current, activeChatId);
  }, [activeChatId, activeConversation?.verificationPolicy, applyWorkspaceContext]);

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

  const persistQueuedFollowUps = useCallback((chatId: string, queuedFollowUps: QueuedFollowUp[]) => {
    updateConversations((prev) => {
      const conversation = prev[chatId];
      if (!conversation) return prev;
      dirtyConversationIdsRef.current.add(chatId);
      return {
        ...prev,
        [chatId]: setConversationQueuedFollowUps(conversation, queuedFollowUps),
      };
    });
  }, [updateConversations]);

  const replaceQueuedFollowUps = useCallback((
    next: QueuedItemsByChat<QueuedFollowUp>,
    options?: { persist?: boolean },
  ) => {
    const previous = queuedFollowUpsRef.current;
    queuedFollowUpsRef.current = next;
    if (isMountedRef.current) {
      setQueuedFollowUpsByChat(next);
    }
    if (!options?.persist) return;

    const changedChatIds = new Set([
      ...Object.keys(previous),
      ...Object.keys(next),
    ]);

    changedChatIds.forEach((chatId) => {
      if (previous[chatId] === next[chatId]) return;
      persistQueuedFollowUps(chatId, next[chatId] || []);
    });
  }, [persistQueuedFollowUps]);

  const enqueueQueuedFollowUp = useCallback((chatId: string, followUp: QueuedFollowUp) => {
    replaceQueuedFollowUps(
      appendQueuedItem(queuedFollowUpsRef.current, chatId, followUp),
      { persist: true },
    );
  }, [replaceQueuedFollowUps]);

  const dequeueQueuedFollowUp = useCallback((chatId: string): QueuedFollowUp | null => {
    const { next, item } = shiftQueuedItem(queuedFollowUpsRef.current, chatId);
    if (!item) return null;
    replaceQueuedFollowUps(next, { persist: true });
    return item;
  }, [replaceQueuedFollowUps]);

  const clearQueuedFollowUps = useCallback((chatId: string) => {
    replaceQueuedFollowUps(
      clearQueuedItems(queuedFollowUpsRef.current, chatId),
      { persist: true },
    );
  }, [replaceQueuedFollowUps]);

  const setPendingSteer = useCallback((chatId: string, steer: PendingSteerRequest) => {
    replacePendingSteers({
      ...pendingSteersByChatRef.current,
      [chatId]: steer,
    });
  }, [replacePendingSteers]);

  const consumePendingSteer = useCallback((chatId: string): PendingSteerRequest | null => {
    const current = pendingSteersByChatRef.current[chatId];
    if (!current) return null;
    const next = { ...pendingSteersByChatRef.current };
    delete next[chatId];
    replacePendingSteers(next);
    return current;
  }, [replacePendingSteers]);

  const clearPendingSteer = useCallback((chatId: string): boolean => {
    if (!pendingSteersByChatRef.current[chatId]) return false;
    const next = { ...pendingSteersByChatRef.current };
    delete next[chatId];
    replacePendingSteers(next);
    return true;
  }, [replacePendingSteers]);

  const hydratePersistedRunState = useCallback((convs: Record<string, Conversation>) => {
    replaceAgentEvents(buildAgentEventsByChat(convs));
    replaceQueuedFollowUps(buildQueuedFollowUpsByChat(convs));
  }, [replaceAgentEvents, replaceQueuedFollowUps]);

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
  const abortStream = useCallback((options?: AbortStreamOptions) => {
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
  }, [clearQueuedFollowUps, emitRunEngineEvent, updateAgentStatus]);

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
        const queuedFollowUp = toQueuedFollowUp(trimmedText, hasAttachments ? attachments : undefined, options);
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
      const displayText = options?.displayText?.trim();
      const userMessage: ChatMessage = options?.existingUserMessage
        ?? buildRuntimeUserMessage(trimmedText, attachments, displayText);

      const currentMessages = options?.baseMessages ?? (conversationsRef.current[chatId]?.messages || []);
      const updatedWithUser = options?.existingUserMessage
        ? currentMessages
        : [...currentMessages, userMessage];

      const isFirstMessage = currentMessages.length === 0 && !options?.existingUserMessage;
      const newTitle =
        options?.titleOverride ||
        (isFirstMessage
          ? generateTitle(updatedWithUser)
          : conversationsRef.current[chatId]?.title || 'New Chat');

      const existingConversation = conversationsRef.current[chatId];
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

      updateConversations((prev) => {
        const updated = {
          ...prev,
          [chatId]: {
            ...prev[chatId],
            messages: [...updatedWithUser, firstAssistant],
            title: newTitle,
            lastMessageAt: Date.now(),
            verificationPolicy: prev[chatId]?.verificationPolicy ?? getDefaultVerificationPolicy(),
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
        baseMessageCount: updatedWithUser.length,
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
      emitRunEngineEvent({ type: 'TAB_LOCK_ACQUIRED', timestamp: Date.now(), tabLockId: acquiredTabId });
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
        setConversations: updateConversations,
        dirtyConversationIdsRef,
        updateAgentStatus,
        appendRunEvent,
        flushCheckpoint,
        getVerificationState: getVerificationStateForChat,
        updateVerificationState: updateVerificationStateForChat,
        executeDelegateCall,
        emitRunEngineEvent,
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
                ? [{
                    id: createId(),
                    role: 'assistant' as const,
                    content: accumulated,
                    timestamp: Date.now(),
                    status: 'done' as const,
                  }]
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

          const turnOutcome = turnResult.loopAction === 'continue'
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
        // Capture tab lock ID before the terminal event clears it.
        const tabLockToRelease = runEngineStateRef.current.tabLockId;

        const currentRunPhase = runEngineStateRef.current.phase;
        const runAlreadyTerminal =
          currentRunPhase === 'completed'
          || currentRunPhase === 'aborted'
          || currentRunPhase === 'failed';
        if (!runAlreadyTerminal) {
          emitRunEngineEvent({
            type: loopCompletedNormally ? 'LOOP_COMPLETED' : 'LOOP_ABORTED',
            timestamp: Date.now(),
          });
        }
        setIsStreaming(false);
        if (cancelStatusTimerRef.current === null) {
          updateAgentStatus({ active: false, phase: '' });
        }
        abortControllerRef.current = null;

        if (loopCompletedNormally) {
          clearRunCheckpoint(chatId);
        }

        releaseRunTabLock(chatId, tabLockToRelease);
        if (tabLockIntervalRef.current) {
          clearInterval(tabLockIntervalRef.current);
          tabLockIntervalRef.current = null;
        }

        if (activeChatIdRef.current !== chatId) {
          if (clearPendingSteer(chatId)) {
            emitRunEngineEvent({ type: 'STEER_CLEARED', timestamp: Date.now() });
          }
          const hadQueuedFollowUps = (queuedFollowUpsRef.current[chatId]?.length ?? 0) > 0;
          clearQueuedFollowUps(chatId);
          if (hadQueuedFollowUps) {
            emitRunEngineEvent({ type: 'FOLLOW_UP_QUEUE_CLEARED', timestamp: Date.now() });
          }
        } else {
          if (clearPendingSteer(chatId)) {
            emitRunEngineEvent({ type: 'STEER_CLEARED', timestamp: Date.now() });
          }
          const nextQueuedFollowUp = dequeueQueuedFollowUp(chatId);
          if (nextQueuedFollowUp) {
            emitRunEngineEvent({ type: 'FOLLOW_UP_DEQUEUED', timestamp: Date.now() });
          }
          if (nextQueuedFollowUp && isMountedRef.current) {
            queueMicrotask(() => {
              if (!isMountedRef.current) return;
              void sendMessage(
                nextQueuedFollowUp.text,
                nextQueuedFollowUp.attachments,
                nextQueuedFollowUp.options,
              );
            });
          }
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
      setPendingSteer,
      lastCoderStateRef,
      tabLockIntervalRef,
      dirtyConversationIdsRef,
      updateConversations,
      appendRunEvent,
      emitRunEngineEvent,
      getVerificationStateForChat,
      persistRunJournal,
      updateVerificationStateForChat,
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
      setConversations: updateConversations,
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
  };
}
