/**
 * useChatCheckpoint.ts
 *
 * Extracted from useChat.ts — checkpoint and resume lifecycle.
 *
 * Owns the apiMessages ref, the visibility-change flush, the interrupted-run
 * detection effect, and the resume/dismiss callbacks.
 *
 * Track A cutover: checkpoint state (phase, round, accumulated, thinking,
 * chatId, provider, model, baseMessageCount, tabLockId) is now read from
 * the authoritative RunEngineState ref. Only apiMessages remains as a
 * separate ref because it is too large for the serializable engine state.
 *
 * Also owns appendAgentEvent / updateAgentStatus — these live here because
 * they are the primary mutation path for the checkpoint phase annotations.
 * The agentStatus and agentEventsByChat state objects remain in useChat (so
 * the hook returns them) but their mutation goes only through the callbacks
 * returned here.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  AgentStatus,
  AgentStatusEvent,
  AgentStatusSource,
  AIProviderType,
  ChatMessage,
  Conversation,
  CoderWorkingMemory,
  RunCheckpoint,
} from '@/types';
import {
  buildCheckpointReconciliationMessage,
  buildRunCheckpoint,
  checkpointRequiresLiveSandboxStatus,
  clearRunCheckpoint,
  detectInterruptedRun as detectInterruptedRunFromManager,
  recordResumeEvent,
  saveRunCheckpoint,
} from '@/lib/checkpoint-manager';
import { isRunActive, type RunEnginePhase, type RunEngineState } from '@/lib/run-engine';
import { setConversationAgentEvents } from '@/lib/chat-runtime-state';
import type { LoopPhase } from '@/types';
import { sandboxStatus, type SandboxStatusResult } from '@/lib/sandbox-client';
import { createId } from '@/hooks/chat-persistence';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_AGENT_EVENTS_PER_CHAT = 200;
const AGENT_EVENT_DEDUPE_WINDOW_MS = 1500;

/**
 * Coerce RunEnginePhase to LoopPhase for checkpoint serialization.
 * Lifecycle bookend phases ('idle', 'starting', 'completed', 'aborted', 'failed')
 * default to 'streaming_llm' — checkpoints are only saved during active runs,
 * so this fallback is a safety net, not a normal path.
 */
function toLoopPhase(phase: RunEnginePhase): LoopPhase {
  switch (phase) {
    case 'streaming_llm':
    case 'executing_tools':
    case 'delegating_coder':
    case 'delegating_explorer':
      return phase;
    default:
      return 'streaming_llm';
  }
}

const EMPTY_SANDBOX_STATUS: SandboxStatusResult = {
  head: 'unknown',
  dirtyFiles: [],
  diffStat: '',
  changedFiles: [],
};

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ChatCheckpointParams {
  // Run engine state — authoritative source for phase, round, accumulated, etc.
  runEngineStateRef: MutableRefObject<RunEngineState>;
  // Session identity refs (stay in useChat, passed by ref so always fresh)
  sandboxIdRef: MutableRefObject<string | null>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  repoRef: MutableRefObject<string | null>;
  workspaceSessionIdRef: MutableRefObject<string | null>;
  ensureSandboxRef: MutableRefObject<(() => Promise<string | null>) | null>;
  abortRef: MutableRefObject<boolean>;
  // Conversation mutation
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  conversations: Record<string, Conversation>;
  // Agent status — state lives in useChat, setters passed in
  setAgentStatus: Dispatch<SetStateAction<AgentStatus>>;
  agentEventsByChatRef: MutableRefObject<Record<string, AgentStatusEvent[]>>;
  replaceAgentEvents: (next: Record<string, AgentStatusEvent[]>) => void;
  activeChatIdRef: MutableRefObject<string>;
  // Resume wiring — ref to sendMessage, populated after sendMessage is defined
  sendMessageRef: MutableRefObject<((text: string) => Promise<void>) | null>;
  // Streaming state (drives the detection effect)
  isStreaming: boolean;
  activeChatId: string;
}

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

/**
 * Checkpoint refs bundle — the only ref not covered by RunEngineState.
 *
 * apiMessages is kept as a separate ref because the full message array is
 * too large and non-serializable for the engine state model. Everything
 * else (phase, round, accumulated, thinking, chatId, provider, model,
 * baseMessageCount, tabLockId) is read from runEngineStateRef.
 */
export interface CheckpointRefs {
  apiMessages: MutableRefObject<ChatMessage[]>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatCheckpoint({
  runEngineStateRef,
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
  agentEventsByChatRef,
  replaceAgentEvents,
  activeChatIdRef,
  sendMessageRef,
  isStreaming,
  activeChatId,
}: ChatCheckpointParams) {
  // --- Checkpoint refs ---
  // Only apiMessages remains as a separate ref; everything else is read
  // from runEngineStateRef.current (the authoritative engine state).
  const checkpointApiMessagesRef = useRef<ChatMessage[]>([]);

  // Phase 3: last Coder working memory state
  const lastCoderStateRef = useRef<CoderWorkingMemory | null>(null);

  // Tab lock heartbeat interval (side-effect ref, not state)
  const tabLockIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resume state
  const [interruptedCheckpoint, setInterruptedCheckpoint] = useState<RunCheckpoint | null>(null);

  // --- Agent event tracking ---

  const appendAgentEvent = useCallback(
    (chatId: string, status: AgentStatus, source: AgentStatusSource = 'orchestrator') => {
      const phase = status.phase.trim();
      if (!chatId || !phase) return;
      const detail = status.detail?.trim();
      const now = Date.now();

      const existing = agentEventsByChatRef.current[chatId] || [];
      const last = existing[existing.length - 1];
      if (
        last &&
        last.source === source &&
        last.phase === phase &&
        (last.detail || '') === (detail || '') &&
        now - last.timestamp < AGENT_EVENT_DEDUPE_WINDOW_MS
      ) {
        return;
      }

      const nextEvent: AgentStatusEvent = {
        id: createId(),
        timestamp: now,
        source,
        phase,
        detail: detail || undefined,
      };

      const nextEvents = [...existing, nextEvent];
      if (nextEvents.length > MAX_AGENT_EVENTS_PER_CHAT) {
        nextEvents.splice(0, nextEvents.length - MAX_AGENT_EVENTS_PER_CHAT);
      }

      const nextAgentEventsByChat = {
        ...agentEventsByChatRef.current,
        [chatId]: nextEvents,
      };
      replaceAgentEvents(nextAgentEventsByChat);

      setConversations((prev) => {
        const conversation = prev[chatId];
        if (!conversation) return prev;
        dirtyConversationIdsRef.current.add(chatId);
        return {
          ...prev,
          [chatId]: setConversationAgentEvents(conversation, nextEvents),
        };
      });
    },
    [agentEventsByChatRef, dirtyConversationIdsRef, replaceAgentEvents, setConversations],
  );

  const updateAgentStatus = useCallback(
    (
      status: AgentStatus,
      options?: {
        chatId?: string;
        source?: AgentStatusSource;
        log?: boolean;
      },
    ) => {
      setAgentStatus(status);
      if (options?.log === false || !status.active) return;
      const phase = status.phase.trim();
      if (!phase) return;
      const targetChatId = options?.chatId || activeChatIdRef.current;
      if (!targetChatId) return;
      appendAgentEvent(targetChatId, { ...status, phase }, options?.source || 'orchestrator');
    },
    [activeChatIdRef, appendAgentEvent, setAgentStatus],
  );

  // --- saveExpiryCheckpoint ---

  const saveExpiryCheckpoint = useCallback(
    (savedDiff: string) => {
      const chatId = activeChatId;
      if (!chatId) return;
      const engineState = runEngineStateRef.current;
      // Skip if no agent work has happened this session (round 0, no diff).
      if (engineState.round === 0 && !savedDiff) return;

      const checkpoint = buildRunCheckpoint({
        chatId,
        round: engineState.round,
        phase: toLoopPhase(engineState.phase),
        baseMessageCount: engineState.baseMessageCount,
        apiMessages: checkpointApiMessagesRef.current,
        accumulated: '',
        thinkingAccumulated: '',
        lastCoderState: lastCoderStateRef.current,
        provider: engineState.provider as AIProviderType,
        model: engineState.model,
        sandboxSessionId: sandboxIdRef.current || '',
        activeBranch:
          branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || '',
        repoId: repoRef.current || '',
        workspaceSessionId: workspaceSessionIdRef.current || undefined,
        savedDiff: savedDiff || undefined,
        reason: 'expiry',
      });

      saveRunCheckpoint(checkpoint);
    },
    [activeChatId, branchInfoRef, repoRef, runEngineStateRef, sandboxIdRef, workspaceSessionIdRef],
  );

  // --- flushCheckpoint ---

  const flushCheckpoint = useCallback(() => {
    const engineState = runEngineStateRef.current;
    if (!engineState.chatId || !isRunActive(engineState)) return;

    const checkpoint = buildRunCheckpoint({
      chatId: engineState.chatId,
      round: engineState.round,
      phase: toLoopPhase(engineState.phase),
      baseMessageCount: engineState.baseMessageCount,
      apiMessages: checkpointApiMessagesRef.current,
      accumulated: engineState.accumulatedText,
      thinkingAccumulated: engineState.accumulatedThinking,
      lastCoderState: lastCoderStateRef.current,
      provider: engineState.provider as AIProviderType,
      model: engineState.model,
      sandboxSessionId: sandboxIdRef.current || '',
      activeBranch:
        branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || '',
      repoId: repoRef.current || '',
      userAborted: abortRef.current || undefined,
      workspaceSessionId: workspaceSessionIdRef.current || undefined,
    });

    saveRunCheckpoint(checkpoint);
  }, [abortRef, branchInfoRef, repoRef, runEngineStateRef, sandboxIdRef, workspaceSessionIdRef]);

  // --- Visibility change: flush on tab hide ---

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && isRunActive(runEngineStateRef.current)) {
        flushCheckpoint();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [flushCheckpoint, runEngineStateRef]);

  // --- Interrupted run detection ---

  // Detect interrupted runs when the chat becomes idle (not streaming, loop not active)
  useEffect(() => {
    if (isStreaming || isRunActive(runEngineStateRef.current)) return;
    if (!activeChatId) return;

    detectInterruptedRunFromManager(
      activeChatId,
      sandboxIdRef.current,
      branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || null,
      repoRef.current,
      workspaceSessionIdRef.current,
    ).then(setInterruptedCheckpoint);
  }, [activeChatId, branchInfoRef, isStreaming, repoRef, sandboxIdRef, workspaceSessionIdRef]);

  // --- Resume callbacks ---

  const dismissResume = useCallback(() => {
    if (interruptedCheckpoint) {
      clearRunCheckpoint(interruptedCheckpoint.chatId);
    }
    setInterruptedCheckpoint(null);
  }, [interruptedCheckpoint]);

  const resumeInterruptedRun = useCallback(async () => {
    const checkpoint = interruptedCheckpoint;
    if (!checkpoint) return;
    setInterruptedCheckpoint(null);

    const chatId = checkpoint.chatId;
    const currentSandboxId = sandboxIdRef.current;

    // Revalidate checkpoint identity at click-time (sandbox/branch/repo may have
    // changed while the resume banner was visible)
    const revalidated = await detectInterruptedRunFromManager(
      chatId,
      currentSandboxId,
      branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || null,
      repoRef.current,
      workspaceSessionIdRef.current,
    );
    if (!revalidated) {
      // Checkpoint no longer valid — silently discard
      return;
    }

    const resumeCheckpoint = revalidated;
    const requiresLiveSandboxStatus = checkpointRequiresLiveSandboxStatus(resumeCheckpoint);
    let resumeSandboxId = currentSandboxId;

    if (!requiresLiveSandboxStatus && !resumeSandboxId && ensureSandboxRef.current) {
      updateAgentStatus({ active: true, phase: 'Recreating sandbox...' }, { chatId });
      try {
        const recreatedSandboxId = await ensureSandboxRef.current();
        if (recreatedSandboxId) {
          resumeSandboxId = recreatedSandboxId;
          sandboxIdRef.current = recreatedSandboxId;
        }
      } catch {
        // Best effort only: expiry reconciliation can continue from the saved diff.
      }
    }

    if (requiresLiveSandboxStatus && !resumeSandboxId) {
      // Sandbox not available — can't reconcile. Clear and inform user.
      clearRunCheckpoint(chatId);
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const msg: ChatMessage = {
          id: createId(),
          role: 'assistant',
          content: 'Session was interrupted, but the sandbox is no longer available. Starting fresh.',
          timestamp: Date.now(),
          status: 'done',
        };
        const updated = {
          ...prev,
          [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() },
        };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
      return;
    }

    let sbStatus: SandboxStatusResult | null = null;
    if (requiresLiveSandboxStatus) {
      const liveSandboxId = resumeSandboxId;
      if (!liveSandboxId) {
        return;
      }
      // Normal resume path needs live sandbox truth before the model continues.
      updateAgentStatus({ active: true, phase: 'Resuming session...' }, { chatId });
      try {
        sbStatus = await sandboxStatus(liveSandboxId);
      } catch (err) {
        clearRunCheckpoint(chatId);
        updateAgentStatus({ active: false, phase: '' });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msg: ChatMessage = {
            id: createId(),
            role: 'assistant',
            content: `Session was interrupted, but sandbox status check failed: ${err instanceof Error ? err.message : String(err)}. Starting fresh.`,
            timestamp: Date.now(),
            status: 'done',
          };
          const updated = {
            ...prev,
            [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() },
          };
          dirtyConversationIdsRef.current.add(chatId);
          return updated;
        });
        return;
      }

      // Guard: if sandbox git commands failed, don't build reconciliation from bad data
      if (sbStatus.error) {
        const sandboxStateError = sbStatus.error;
        clearRunCheckpoint(chatId);
        updateAgentStatus({ active: false, phase: '' });
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) return prev;
          const msg: ChatMessage = {
            id: createId(),
            role: 'assistant',
            content: `Session was interrupted, but the sandbox is in an unexpected state: ${sandboxStateError}. Starting fresh.`,
            timestamp: Date.now(),
            status: 'done',
          };
          const updated = {
            ...prev,
            [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() },
          };
          dirtyConversationIdsRef.current.add(chatId);
          return updated;
        });
        return;
      }
    } else {
      updateAgentStatus(
        {
          active: true,
          phase: resumeSandboxId ? 'Restoring expired session...' : 'Resuming from saved checkpoint...',
        },
        { chatId },
      );
    }

    // Build reconciliation message
    const reconciliationContent = buildCheckpointReconciliationMessage(
      resumeCheckpoint,
      sbStatus ?? EMPTY_SANDBOX_STATUS,
    );

    const conv = conversations[chatId];
    if (!conv) {
      clearRunCheckpoint(chatId);
      updateAgentStatus({ active: false, phase: '' });
      return;
    }

    // Clear the checkpoint — the loop will create new checkpoints
    clearRunCheckpoint(chatId);

    // Track resume event
    recordResumeEvent(resumeCheckpoint);

    // Send the reconciliation content directly as the user message text.
    // We do NOT inject it via setConversations first because sendMessage captures
    // `conversations` from its closure — a preceding setConversations won't be
    // visible until the next render, so the reconciliation would be lost.
    if (sendMessageRef.current) {
      await sendMessageRef.current(reconciliationContent);
    }
  }, [
    branchInfoRef,
    conversations,
    dirtyConversationIdsRef,
    ensureSandboxRef,
    interruptedCheckpoint,
    repoRef,
    sandboxIdRef,
    sendMessageRef,
    setConversations,
    updateAgentStatus,
    workspaceSessionIdRef,
  ]);

  // --- Tab lock helpers (used by sendMessage) ---
  // These are returned as refs so sendMessage can manage them directly
  // without re-creating when the lock changes.

  const checkpointRefs: CheckpointRefs = {
    apiMessages: checkpointApiMessagesRef,
  };

  return {
    // Agent status
    updateAgentStatus,
    appendAgentEvent,
    // Resume
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    // Checkpoint I/O
    saveExpiryCheckpoint,
    flushCheckpoint,
    // Ref bundles
    checkpointRefs,
    lastCoderStateRef,
    tabLockIntervalRef,
  };
}
