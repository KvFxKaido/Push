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
  RunEventInput,
  VerificationRuntimeState,
} from '@/types';
import type { ToolDispatchBinding } from '@/lib/local-daemon-sandbox-client';
import { buildAgentEventsByChat, buildQueuedFollowUpsByChat } from '@/lib/chat-runtime-state';
import {
  getActiveProvider,
  estimateContextTokens,
  getContextBudget,
  type ActiveProvider,
} from '@/lib/orchestrator';
import { getModelNameForProvider } from '@/lib/providers';
import { migrateConversationsToIndexedDB } from '@/lib/conversation-store';
import {
  loadActiveChatId,
  loadConversations,
  normalizeConversationModel,
} from '@/hooks/chat-persistence';
import { useConversationPersistence } from './useConversationPersistence';
import { useAgentDelegation } from './useAgentDelegation';
import { useBackgroundCoderJob } from './useBackgroundCoderJob';
import { isBackgroundModeEnabled } from '@/lib/background-mode-settings';
import {
  hasActiveBackgroundJob,
  resolveSendEngineTrigger,
  startBackgroundMainChatTurn,
} from './chat-send-background';
import { startInlineCoderTurn } from './chat-send-inline';
import { useCIPoller } from './useCIPoller';
import { useChatCardActions } from './chat-card-actions';
import { useFullAutoCommitApproval } from './chat-full-auto-approvals';
import { useChatManagement } from './chat-management';
import { useChatReplay } from './chat-replay';
import { useChatCheckpoint } from './useChatCheckpoint';
import { type SendLoopContext } from './chat-send';
import { runRoundLoop } from './chat-round-loop';
import { maybeCompactBeforeTurn } from './chat-compaction';
import { routeActiveRunInput } from './chat-active-run-router';
import { prepareSendContext } from './chat-prepare-send';
import { acquireRunSession, finalizeRunSession } from './chat-run-session';
import { createTurnQuiescedEvent } from '@push/lib/turn-quiescence';
import { useQueuedFollowUps } from './useQueuedFollowUps';
import { mergeRunEventStreams } from '@/lib/chat-run-events';
import { expireBranchScopedMemory } from '@/lib/context-memory';
import { updateJournalVerificationState } from '@/lib/run-journal';
import { useRunEventStream } from './useRunEventStream';
import { useWorkspacePatchCapture, useWorkspacePatchReplay } from './useWorkspacePatchCapture';
import { useRunEngine } from './useRunEngine';
import { useVerificationState } from './useVerificationState';
import { usePendingSteer } from './usePendingSteer';
import { useBranchSwitchActions } from './useBranchSwitchActions';
import { updateActiveConversationBranchInPlace } from '@/lib/branch-fork-migration';

// Re-export public interfaces from chat-send (avoids circular imports)
export type { ScratchpadHandlers, ChatRuntimeHandlers } from './chat-send';

export { detectInterruptedRun, getResumeEvents } from '@/lib/checkpoint-manager';

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

type AbortStreamOptions = { clearQueuedFollowUps?: boolean };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

import type { ScratchpadHandlers, TodoHandlers, ChatRuntimeHandlers } from './chat-send';

export function useChat(
  activeRepoFullName: string | null,
  scratchpad?: ScratchpadHandlers,
  runtimeHandlers?: ChatRuntimeHandlers,
  branchInfo?: { currentBranch?: string; defaultBranch?: string },
  todo?: TodoHandlers,
) {
  const [initialConversations] = useState<Record<string, Conversation>>(() => loadConversations());
  const [initialAgentEventsByChat] = useState<Record<string, AgentStatusEvent[]>>(() =>
    buildAgentEventsByChat(initialConversations),
  );
  const [initialQueuedFollowUpsByChat] = useState(() =>
    buildQueuedFollowUpsByChat(initialConversations),
  );

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
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // --- Conversation persistence (dirty/deleted sets + flush lifecycle) ---
  const { dirtyConversationIdsRef, deletedConversationIdsRef } = useConversationPersistence({
    conversationsLoaded,
    conversationsRef,
  });

  const agentEventsByChatRef = useRef<Record<string, AgentStatusEvent[]>>(initialAgentEventsByChat);
  useEffect(() => {
    agentEventsByChatRef.current = agentEventsByChat;
  }, [agentEventsByChat]);
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
  const ensureSandboxRef = useRef<(() => Promise<string | null>) | null>(null);
  // Paired daemon binding. Null on cloud sessions; set by the Remote workspace
  // screen so a sandbox tool call this turn routes through `pushd`.
  const localDaemonBindingRef = useRef<ToolDispatchBinding | null>(null);

  // --- Prop mirror refs (always up-to-date in callbacks) ---
  const repoRef = useRef(activeRepoFullName);
  const scratchpadRef = useRef(scratchpad);
  const todoRef = useRef(todo);
  const runtimeHandlersRef = useRef(runtimeHandlers);
  const branchInfoRef = useRef(branchInfo);
  useEffect(() => {
    repoRef.current = activeRepoFullName;
    scratchpadRef.current = scratchpad;
    todoRef.current = todo;
    runtimeHandlersRef.current = runtimeHandlers;
    branchInfoRef.current = branchInfo;
  }, [activeRepoFullName, scratchpad, todo, runtimeHandlers, branchInfo]);
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

  useEffect(() => {
    const branch = branchInfo?.currentBranch;
    if (!activeRepoFullName || !branch) return;
    const activeConversation = conversationsRef.current[activeChatIdRef.current ?? ''];
    if (!activeConversation || activeConversation.repoFullName !== activeRepoFullName) return;

    updateActiveConversationBranchInPlace(
      {
        activeChatIdRef,
        conversationsRef,
        setConversations: updateConversations,
        dirtyConversationIdsRef,
      },
      branch,
    );
  }, [
    activeRepoFullName,
    activeChatId,
    branchInfo?.currentBranch,
    conversations,
    updateConversations,
    dirtyConversationIdsRef,
  ]);

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

  // --- Checkpoint + resume lifecycle (incl. Phase 3 run-host attach) ---
  const {
    updateAgentStatus,
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    runHostAttach,
    saveExpiryCheckpoint,
    flushCheckpoint,
    checkpointRefs,
    runtimeContextRef,
    resetRuntimeContextForRun,
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
    getVerificationPolicyForChat,
  });

  // Composition wrapper: useVerificationState owns the ref + conversation
  // write; useRunEngine owns the journal ref + persistRunJournal. When the
  // in-flight run's verification state updates, the journal also updates.
  // Composing here in useChat avoids a circular dep between the two hooks.
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

  // --- Sorted chat IDs (filtered by workspace repo/mode, not branch) ---
  const sortedChatIds = useMemo(() => {
    return Object.keys(conversations)
      .filter((id) => {
        const conv = conversations[id];
        if (!activeRepoFullName) return !conv.repoFullName;
        return conv.repoFullName === activeRepoFullName;
      })
      .sort((a, b) => conversations[b].lastMessageAt - conversations[a].lastMessageAt);
  }, [conversations, activeRepoFullName]);

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

  const setLocalDaemonBinding = useCallback((binding: ToolDispatchBinding | null) => {
    localDaemonBindingRef.current = binding;
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

  // IDB migration: `.finally` flips `conversationsLoaded` on reject too (the auto-switch + drain + screen effects gate on it); isMountedRef skips late settles.
  useEffect(() => {
    migrateConversationsToIndexedDB()
      .then((convs) => {
        if (!isMountedRef.current) return;
        hydratePersistedRunState(convs);
        if (Object.keys(convs).length === 0) return;
        updateConversations(convs);
        setActiveChatId((prev) => (prev && convs[prev] ? prev : loadActiveChatId(convs)));
      })
      .catch((err) => console.warn('[useChat] Conversation hydration failed', err))
      .finally(() => isMountedRef.current && setConversationsLoaded(true));
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
  const chatMgmt = useChatManagement({
    conversations,
    setConversations: updateConversations,
    setActiveChatId,
    setAgentEventsByChat,
    dirtyConversationIdsRef,
    deletedConversationIdsRef,
    activeChatId,
    activeChatIdRef,
    activeRepoFullName,
    branchInfoRef,
    repoRef,
    isStreaming,
    abortStream,
    clearQueuedFollowUps,
    workspaceModeRef,
    todoRef,
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

  const { captureWorkspacePatchAtRoundEnd } = useWorkspacePatchCapture({
    sandboxIdRef,
    repoRef,
    branchInfoRef,
    setConversations: updateConversations,
    dirtyConversationIdsRef,
  });
  const { replayOnFreshSandbox } = useWorkspacePatchReplay({
    setConversations: updateConversations,
    dirtyConversationIdsRef,
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
    runtimeContextRef,
    backgroundCoderJob,
    // Phase 1: global toggle; per-chat override is a later layer (docs/archive/runbooks/Background Coder Tasks Phase 1.md §4).
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
      const targetChat = options?.chatId || activeChatIdRef.current;
      const routeEvents: RunEventInput[] = [];
      // biome-ignore format: engine routing + eligibility live in resolveSendEngineTrigger (chat-send-background.ts); opts stay inline for the file line cap.
      const engineTrigger = resolveSendEngineTrigger({ repoRef, branchInfoRef, conversationsRef, chatId: targetChat, requestedProvider: options?.provider ?? null, messageText: trimmedText, hasAttachments, onRouteEvent: (event) => routeEvents.push(event) });
      // Dispatch: 'background-mode' → CoderJob DO; 'inline-delegation' → foreground inline lane; null → Orchestrator loop.
      const routeToEngine = engineTrigger === 'background-mode';
      if (targetChat && hasActiveBackgroundJob(conversationsRef.current[targetChat])) return;

      // biome-ignore format: mechanical router wiring; kept compact for the file line cap.
      const routed = routeActiveRunInput({ trimmedText, attachments, hasAttachments, options }, { runEngineStateRef, activeChatIdRef, queuedFollowUpsRef, enqueuePendingSteer, enqueueQueuedFollowUp, emitRunEngineEvent, appendRunEvent });
      if (routed.handled) return;

      let chatId = options?.chatId || activeChatIdRef.current;
      const conversationsSnapshot = conversationsRef.current;
      if (!chatId || !conversationsSnapshot[chatId]) {
        chatId = chatMgmt.createNewChat();
      }
      for (const event of routeEvents) appendRunEvent(chatId, event);
      const prepared = await prepareSendContext(
        { trimmedText, attachments, options, chatId, skipStreamingPlaceholder: routeToEngine },
        {
          conversationsRef,
          dirtyConversationIdsRef,
          sandboxIdRef,
          ensureSandboxRef,
          abortRef,
          abortControllerRef,
        },
        { updateConversations, setIsStreaming, updateAgentStatus },
        // Branch-on-first-prompt wiring; decision + fork logic live in
        // first-prompt-branch.ts. useChat only threads refs (it's at its cap).
        {
          repoFullName: repoRef.current,
          branchInfoRef,
          runtimeHandlersRef,
        },
      );
      const lockedProviderForChat = prepared.lockedProvider;
      const resolvedModelForChat = prepared.resolvedModel;
      const apiMessages = prepared.apiMessages;
      const toolCallRecoveryState = prepared.recoveryState; // Orchestrator loop only; the inline lane ignores it.

      if (routeToEngine) {
        // biome-ignore format: keep refs inline so this branch stays under the file line cap.
        const refs = { sandboxIdRef, repoRef, branchInfoRef, isMainProtectedRef, agentsMdRef, instructionFilenameRef };
        // Prior-turn attachments are sourced server-side from the job chain
        // walk (see coder-job-do executeCoderJob), keeping them in lockstep
        // with the prior-turn summaries — no client-carried list needed.
        const r = await startBackgroundMainChatTurn({
          chatId,
          trimmedText,
          attachments,
          lockedProvider: lockedProviderForChat,
          resolvedModel: resolvedModelForChat ?? undefined,
          refs,
          backgroundCoderJob,
          engineTrigger: engineTrigger ?? undefined,
          ensureSandbox: () => ensureSandboxRef.current?.() ?? Promise.resolve(null),
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

      const runtimeContext = resetRuntimeContextForRun(chatId);
      const loopCtx: SendLoopContext = {
        chatId,
        lockedProvider: lockedProviderForChat,
        resolvedModel: resolvedModelForChat ?? undefined,
        abortRef,
        abortControllerRef,
        sandboxIdRef,
        ensureSandboxRef,
        localDaemonBindingRef,
        scratchpadRef,
        todoRef,
        workspaceContextRef,
        runtimeHandlersRef,
        repoRef,
        isMainProtectedRef,
        branchInfoRef,
        runtimeContext,
        checkpointRefs,
        processedContentRef,
        setConversations: updateConversations,
        dirtyConversationIdsRef,
        updateAgentStatus,
        appendRunEvent,
        flushCheckpoint,
        getVerificationState: getVerificationStateForChat,
        updateVerificationState: updateVerificationStateForChat,
        executeDelegateCall,
        emitRunEngineEvent,
        captureWorkspacePatchAtRoundEnd,
        activeChatIdRef,
        conversationsRef,
      };

      let loopCompletedNormally = false;
      try {
        if (engineTrigger === 'inline-delegation') {
          // biome-ignore format: one-call lane dispatch; the lane module (chat-send-inline.ts) owns the logic.
          const lane = await startInlineCoderTurn(loopCtx, { trimmedText, attachments, apiMessages, runId: runEngineStateRef.current.runId, agentsMdRef, instructionFilenameRef, getVerificationPolicyForChat });
          loopCompletedNormally = lane.completedNormally;
        } else {
          // Pre-turn LLM compaction (fails soft; sync heuristic backstops). Coordinator: chat-compaction.ts.
          // biome-ignore format: kept compact for the useChat max-lines cap.
          const compacted = await maybeCompactBeforeTurn(loopCtx, { apiMessages, provider: lockedProviderForChat, model: resolvedModelForChat ?? undefined });
          // biome-ignore format: kept compact for the useChat max-lines cap.
          const result = await runRoundLoop(loopCtx, { apiMessages: compacted, recoveryState: toolCallRecoveryState }, { runJournalEntryRef, persistRunJournal, dequeuePendingSteer, pendingSteersByChatRef });
          loopCompletedNormally = result.loopCompletedNormally;
        }
      } catch (err) {
        emitRunEngineEvent({
          type: 'LOOP_FAILED',
          timestamp: Date.now(),
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        const finishedRun = runEngineStateRef.current;
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
        if (!nextFollowUp) {
          const quiesced = createTurnQuiescedEvent(
            finishedRun.runId,
            finishedRun.phase === 'failed'
              ? 'failed'
              : loopCompletedNormally
                ? 'completed'
                : 'aborted',
          );
          if (quiesced) appendRunEvent(chatId, quiesced);
        }
        if (nextFollowUp && isMountedRef.current) {
          queueMicrotask(() => {
            if (!isMountedRef.current) return;
            void sendMessage(nextFollowUp.text, nextFollowUp.attachments, nextFollowUp.options);
          });
        }
      }
    },
    [
      chatMgmt,
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
      resetRuntimeContextForRun,
      tabLockIntervalRef,
      dirtyConversationIdsRef,
      updateConversations,
      appendRunEvent,
      emitRunEngineEvent,
      getVerificationStateForChat,
      getVerificationPolicyForChat,
      persistRunJournal,
      updateVerificationStateForChat,
      backgroundCoderJob,
      captureWorkspacePatchAtRoundEnd,
    ],
  );

  // Wire sendMessageRef so useChatCheckpoint's resumeInterruptedRun can call it
  useEffect(() => {
    sendMessageRef.current = sendMessage as (text: string) => Promise<void>;
  }, [sendMessage]);

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

  // Full Auto: auto-approve the Auditor's SAFE commit-review card (sibling hook).
  useFullAutoCommitApproval({ conversations, activeChatId, handleCardAction });

  // UI branch transitions (fork: slice 2.1; switch: warm-switch doc) wrap the
  // typed sandbox branch tools so the UI buttons and the model emit the same
  // operations, then dispatch the BranchSwitchPayload through
  // UI branch operations (fork / switch / merge) + the shared migration entry
  // point. Extracted to a sibling hook so useChat stays under its line cap; see
  // useBranchSwitchActions.ts.
  const { applyBranchSwitchFromUI, forkBranchFromUI, switchBranchFromUI, mergeBranchInUI } =
    useBranchSwitchActions({
      activeChatIdRef,
      conversationsRef,
      branchInfoRef,
      setConversations: updateConversations,
      dirtyConversationIdsRef,
      runtimeHandlersRef,
      sandboxIdRef,
    });

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
    ...chatMgmt,
    regenerateLastResponse,
    editMessageAndResend,

    // Workspace context
    setWorkspaceContext,
    setWorkspaceMode,

    // Sandbox
    setSandboxId,
    setWorkspaceSessionId,
    setEnsureSandbox,
    setLocalDaemonBinding,
    setIsMainProtected,
    // Ambient event sink: lets the sandbox controller forward the live
    // workspace-state timeline onto the active chat's run-event stream.
    appendRunEvent,

    // AGENTS.md
    setAgentsMd,
    setInstructionFilename,
    injectAssistantCardMessage,
    handleCardAction,

    // Context usage (for meter UI)
    contextUsage,
    abortStream,

    // Resumable Sessions + Durable Runs Phase 3 attach
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    runHostAttach,
    saveExpiryCheckpoint,
    ciStatus,
    diagnoseCIFailure,
    replayOnFreshSandbox,
    applyBranchSwitchFromUI,
    forkBranchFromUI,
    switchBranchFromUI,
    mergeBranchInUI,
  };
}
