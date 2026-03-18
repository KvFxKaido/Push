// Verified
import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import type {
  ChatMessage,
  CIStatus,
  AgentStatus,
  AgentStatusEvent,
  AgentStatusSource,
  Conversation,
  ToolExecutionResult,
  CardAction,
  CommitReviewCardData,
  ChatCard,
  AttachmentData,
  AIProviderType,
  SandboxStateCardData,
  ActiveRepo,
  LoopPhase,
  RunCheckpoint,
  CoderWorkingMemory,
  WorkspaceContext,
  ChatSendOptions,
} from '@/types';
import { streamChat, getActiveProvider, estimateContextTokens, getContextBudget, type ActiveProvider } from '@/lib/orchestrator';
import { detectAnyToolCall, executeAnyToolCall, detectAllToolCalls } from '@/lib/tool-dispatch';
import { runCoderAgent, generateCheckpointAnswer } from '@/lib/coder-agent';
import { runExplorerAgent } from '@/lib/explorer-agent';
import { fileLedger } from '@/lib/file-awareness-ledger';
import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  buildToolResultMetaLine,
  getToolName,
  getToolStatusLabel,
  markLastAssistantToolCall,
} from '@/lib/chat-tool-messages';
import {
  execInSandbox,
  writeToSandbox,
  sandboxStatus,
  type SandboxStatusResult,
} from '@/lib/sandbox-client';
import { executeToolCall } from '@/lib/github-tools';
import { executeScratchpadToolCall } from '@/lib/scratchpad-tools';
import { getSandboxStartMode } from '@/lib/sandbox-start-mode';
import { getModelNameForProvider, setLastUsedProvider, type PreferredProvider } from '@/lib/providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import {
  migrateConversationsToIndexedDB,
  saveConversation as saveConversationToDB,
  deleteConversation as deleteConversationFromDB,
  replaceAllConversations as replaceAllConversationsInDB,
} from '@/lib/conversation-store';
import {
  acquireRunTabLock,
  buildCheckpointReconciliationMessage,
  buildRunCheckpoint,
  clearRunCheckpoint,
  detectInterruptedRun as detectInterruptedRunFromManager,
  getResumeEvents as getResumeEventsFromManager,
  heartbeatRunTabLock,
  recordResumeEvent,
  releaseRunTabLock,
  saveRunCheckpoint,
} from '@/lib/checkpoint-manager';
import { recordMalformedToolCallMetric } from '@/lib/tool-call-metrics';
import {
  buildToolCallParseErrorBlock,
  formatToolResultEnvelope,
  MAX_TOOL_CALL_DIAGNOSIS_RETRIES,
  resolveToolCallRecovery,
  type ToolCallRecoveryState,
} from '@/lib/tool-call-recovery';
import { getActiveGitHubToken, APP_TOKEN_STORAGE_KEY } from '@/lib/github-auth';
import { buildEditedReplay, buildRegeneratedReplay } from '@/lib/chat-replay';
import { runParallelDelegation, MAX_PARALLEL_DELEGATE_TASKS } from '@/lib/parallel-delegation';
import { formatElapsedTime } from '@/lib/utils';

export {
  detectInterruptedRunFromManager as detectInterruptedRun,
  getResumeEventsFromManager as getResumeEvents,
};

const CONVERSATIONS_KEY = 'diff_conversations';
const ACTIVE_CHAT_KEY = 'diff_active_chat';
const OLD_STORAGE_KEY = 'diff_chat_history';
const ACTIVE_REPO_KEY = 'active_repo';
const APP_COMMIT_IDENTITY_KEY = 'github_app_commit_identity';
const MAX_AGENT_EVENTS_PER_CHAT = 200;
const AGENT_EVENT_DEDUPE_WINDOW_MS = 1500;

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// formatElapsedTime moved to lib/utils.ts

// Parallel delegation helpers moved to lib/parallel-delegation.ts






/**
 * Derive a status label from coder results. If acceptance criteria were run
 * and any failed, report CHECKS_FAILED instead of OK to avoid misleading the user.
 */
function getTaskStatusLabel(criteriaResults?: import('@/types').CriterionResult[]): string {
  if (!criteriaResults || criteriaResults.length === 0) return 'OK';
  const allPassed = criteriaResults.every(r => r.passed);
  return allPassed ? 'OK' : 'CHECKS_FAILED';
}

function sanitizeSandboxStateCards(message: ChatMessage): ChatMessage | null {
  const cards = (message.cards || []).filter((card) => card.type !== 'sandbox-state');
  const sandboxAttachedBanner = /^Sandbox attached on `[^`]+`\.\s*$/;

  // Drop old auto-injected sandbox state messages entirely.
  if (
    message.role === 'assistant' &&
    sandboxAttachedBanner.test(message.content.trim()) &&
    cards.length === 0
  ) {
    return null;
  }

  if (!message.cards) return message;
  return { ...message, cards };
}

function generateTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New Chat';
  const content = (firstUser.displayContent ?? firstUser.content).trim();
  return content.length > 30 ? content.slice(0, 30) + '...' : content;
}

function getGitHubAppCommitIdentity(): { name: string; email: string } | undefined {
  const appToken = safeStorageGet(APP_TOKEN_STORAGE_KEY);
  if (!appToken) return undefined;
  try {
    const raw = safeStorageGet(APP_COMMIT_IDENTITY_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { name?: unknown; email?: unknown };
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return undefined;
    if (typeof parsed.email !== 'string' || !parsed.email.trim()) return undefined;
    return { name: parsed.name, email: parsed.email };
  } catch {
    return undefined;
  }
}

// --- persistence helpers ---

// Legacy sync save — kept only for old-format migration writes.
// Normal persistence is handled by the dirty-tracking flush effect.
function saveConversationsLegacy(convs: Record<string, Conversation>) {
  safeStorageSet(CONVERSATIONS_KEY, JSON.stringify(convs));
}

function saveActiveChatId(id: string) {
  safeStorageSet(ACTIVE_CHAT_KEY, id);
}

function getActiveRepoFullName(): string | null {
  try {
    const stored = safeStorageGet(ACTIVE_REPO_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed.full_name === 'string' && parsed.full_name.trim()) {
      return parsed.full_name;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function loadConversations(): Record<string, Conversation> {
  try {
    const stored = safeStorageGet(CONVERSATIONS_KEY);
    if (stored) {
      const convs: Record<string, Conversation> = JSON.parse(stored);
      for (const id of Object.keys(convs)) {
        const cleaned = (convs[id].messages || [])
          .map(sanitizeSandboxStateCards)
          .filter((m): m is ChatMessage => m !== null);
        convs[id] = { ...convs[id], messages: cleaned };
      }

      // Migration: stamp unscoped conversations with the current active repo
      const repoFullName = getActiveRepoFullName();
      if (repoFullName) {
        let migrated = false;
        for (const id of Object.keys(convs)) {
          if (!convs[id].repoFullName) {
            convs[id] = { ...convs[id], repoFullName };
            migrated = true;
          }
        }
        if (migrated) saveConversationsLegacy(convs);
      }

      return convs;
    }
  } catch {
    // Ignore parse errors
  }

  // Migration: check for old single-chat format
  try {
    const oldHistory = safeStorageGet(OLD_STORAGE_KEY);
    if (oldHistory) {
      const oldMessages: ChatMessage[] = JSON.parse(oldHistory);
      if (oldMessages.length > 0) {
        const id = createId();
        const repoFullName = getActiveRepoFullName();
        const migrated: Record<string, Conversation> = {
          [id]: {
            id,
            title: generateTitle(oldMessages),
            messages: oldMessages,
            createdAt: oldMessages[0]?.timestamp || Date.now(),
            lastMessageAt: oldMessages[oldMessages.length - 1]?.timestamp || Date.now(),
            repoFullName: repoFullName || undefined,
          },
        };
        saveConversationsLegacy(migrated);
        saveActiveChatId(id);
        safeStorageRemove(OLD_STORAGE_KEY);
        return migrated;
      }
    }
  } catch {
    // Ignore migration errors
  }

  return {};
}

function loadActiveChatId(conversations: Record<string, Conversation>): string {
  const stored = safeStorageGet(ACTIVE_CHAT_KEY);
  if (stored && conversations[stored]) return stored;
  // Default to most recent conversation or empty
  const ids = Object.keys(conversations);
  if (ids.length === 0) return '';
  return ids.sort((a, b) => conversations[b].lastMessageAt - conversations[a].lastMessageAt)[0];
}

function shouldPrewarmSandbox(text: string, attachments?: AttachmentData[]): boolean {
  const normalized = text.toLowerCase();
  const intentRegex = /\b(edit|modify|change|refactor|fix|implement|write|create|add|remove|rename|run|test|build|lint|compile|typecheck|type-check|commit|push|patch|bug|failing|error|debug)\b/;
  if (intentRegex.test(normalized)) return true;

  const fileHintRegex = /\b([a-z0-9_\-/]+\.(ts|tsx|js|jsx|py|rs|go|java|rb|css|html|json|md|yml|yaml|toml|sh))\b/i;
  if (fileHintRegex.test(text)) return true;

  if (attachments?.some((att) => att.type === 'code' || att.type === 'document')) {
    return true;
  }
  return false;
}

export interface ScratchpadHandlers {
  content: string;
  replace: (text: string) => void;
  append: (text: string) => void;
}

export interface UsageHandler {
  trackUsage: (model: string, inputTokens: number, outputTokens: number) => void;
}

export interface ChatRuntimeHandlers {
  onSandboxPromoted?: (repo: ActiveRepo) => void;
  bindSandboxSessionToRepo?: (repoFullName: string, branch?: string) => void;
  /** Called when a sandbox tool (e.g. sandbox_save_draft) switches branches internally.
   *  The app should update its branch state without tearing down the sandbox. */
  onBranchSwitch?: (branch: string) => void;
  /** Called when a tool result indicates the sandbox is unreachable.
   *  Allows the sandbox hook to transition to error state. */
  onSandboxUnreachable?: (reason: string) => void;
}

interface ChatDraftSelection {
  provider: AIProviderType | null;
  model: string | null;
}

type SendMessageOptions = Partial<ChatDraftSelection> & ChatSendOptions & {
  chatId?: string;
  baseMessages?: ChatMessage[];
  existingUserMessage?: ChatMessage;
  titleOverride?: string;
};

export function useChat(
  activeRepoFullName: string | null,
  scratchpad?: ScratchpadHandlers,
  usageHandler?: UsageHandler,
  runtimeHandlers?: ChatRuntimeHandlers,
  branchInfo?: { currentBranch?: string; defaultBranch?: string },
) {
  const [ciStatus, setCiStatus] = useState<CIStatus | null>(null);
  const [conversations, setConversations] = useState<Record<string, Conversation>>(loadConversations);
  const [activeChatId, setActiveChatId] = useState<string>(() => loadActiveChatId(conversations));
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const dirtyConversationIdsRef = useRef(new Set<string>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ active: false, phase: '' });
  const [agentEventsByChat, setAgentEventsByChat] = useState<Record<string, AgentStatusEvent[]>>({});
  const activeChatIdRef = useRef(activeChatId);
  const abortRef = useRef(false);
  // Track processed message content to prevent duplicate tokens during streaming glitches
  const processedContentRef = useRef<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelStatusTimerRef = useRef<number | null>(null);
  const workspaceContextRef = useRef<WorkspaceContext | null>(null);
  const sandboxIdRef = useRef<string | null>(null);
  const workspaceSessionIdRef = useRef<string | null>(null);
  const isMainProtectedRef = useRef(false);
  const autoCreateRef = useRef(false); // Guard against creation loops

  // --- IndexedDB migration: load conversations async, overwrite sync localStorage load ---
  useEffect(() => {
    migrateConversationsToIndexedDB().then((convs) => {
      if (Object.keys(convs).length > 0) {
        setConversations(convs);
        setActiveChatId((prev) => {
          // Re-derive active chat from migrated data if current ID is stale
          if (prev && convs[prev]) return prev;
          return loadActiveChatId(convs);
        });
      }
      setConversationsLoaded(true);
    });
  }, []);

  // --- Dirty conversation flush: incremental IndexedDB writes ---
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

  // --- Resumable Sessions: refs for synchronous checkpoint flushing ---
  // These refs track the latest accumulated state so flushCheckpoint() can
  // read them synchronously in the visibilitychange handler (React state lags).
  const checkpointAccumulatedRef = useRef('');
  const checkpointThinkingRef = useRef('');
  const checkpointRoundRef = useRef(0);
  const checkpointPhaseRef = useRef<LoopPhase>('streaming_llm');
  const checkpointApiMessagesRef = useRef<ChatMessage[]>([]);
  const checkpointBaseMessageCountRef = useRef(0);
  const checkpointChatIdRef = useRef<string | null>(null);
  const checkpointProviderRef = useRef<string>('');
  const checkpointModelRef = useRef<string>('');
  const loopActiveRef = useRef(false);

  // Ref-based access to sendMessage for resume callback (defined later in the hook)
  const sendMessageRef = useRef<((text: string, attachments?: AttachmentData[], options?: SendMessageOptions) => Promise<void>) | null>(null);

  // Keep activeRepoFullName in a ref so callbacks always see the latest value
  const repoRef = useRef(activeRepoFullName);
  repoRef.current = activeRepoFullName;

  // Keep scratchpad handlers in a ref so callbacks always see the latest
  const scratchpadRef = useRef(scratchpad);
  scratchpadRef.current = scratchpad;

  // Keep usage handler in a ref so callbacks always see the latest
  const usageHandlerRef = useRef(usageHandler);
  usageHandlerRef.current = usageHandler;
  const runtimeHandlersRef = useRef(runtimeHandlers);
  runtimeHandlersRef.current = runtimeHandlers;

  // Keep branch info in a ref so callbacks always see the latest
  const branchInfoRef = useRef(branchInfo);
  branchInfoRef.current = branchInfo;

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  // --- Resumable Sessions: flush checkpoint on visibility change ---


  useEffect(() => {
    const repo = repoRef.current;
    const branch = branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch;
    if (!repo || !branch) {
      setCiStatus(null);
      return;
    }

    let aborted = false;
    const poll = async () => {
      try {
        const result = await executeToolCall(
          { tool: 'fetch_checks', args: { repo, ref: branch } },
          repo
        );
        if (!aborted && result.card?.type === 'ci-status') {
          setCiStatus(result.card.data as CIStatus);
        }
      } catch (err) {
        console.error('[Push] CI poll failed:', err);
      }
    };

    poll();
    const interval = setInterval(poll, 60_000);

    return () => {
      aborted = true;
      clearInterval(interval);
    };
  }, [activeChatId, activeRepoFullName, branchInfo?.currentBranch]);

  const flushCheckpoint = useCallback(() => {
    const chatId = checkpointChatIdRef.current;
    if (!chatId || !loopActiveRef.current) return;

    const checkpoint = buildRunCheckpoint({
      chatId,
      round: checkpointRoundRef.current,
      phase: checkpointPhaseRef.current,
      baseMessageCount: checkpointBaseMessageCountRef.current,
      apiMessages: checkpointApiMessagesRef.current,
      accumulated: checkpointAccumulatedRef.current,
      thinkingAccumulated: checkpointThinkingRef.current,
      lastCoderState: lastCoderStateRef.current,
      provider: checkpointProviderRef.current as AIProviderType,
      model: checkpointModelRef.current,
      sandboxSessionId: sandboxIdRef.current || '',
      activeBranch: branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || '',
      repoId: repoRef.current || '',
      userAborted: abortRef.current || undefined,
      workspaceSessionId: workspaceSessionIdRef.current || undefined,
    });

    saveRunCheckpoint(checkpoint);
  }, []);

  // Ref for Phase 3: last Coder working memory state
  const lastCoderStateRef = useRef<CoderWorkingMemory | null>(null);

  // Tab lock refs
  const tabLockIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tabLockIdRef = useRef<string | null>(null);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && loopActiveRef.current) {
        flushCheckpoint();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [flushCheckpoint]);

  // --- Resumable Sessions Phase 2: resume state (callbacks defined after updateAgentStatus) ---
  const [interruptedCheckpoint, setInterruptedCheckpoint] = useState<RunCheckpoint | null>(null);

  const appendAgentEvent = useCallback(
    (chatId: string, status: AgentStatus, source: AgentStatusSource = 'orchestrator') => {
      const phase = status.phase.trim();
      if (!chatId || !phase) return;
      const detail = status.detail?.trim();
      const now = Date.now();

      setAgentEventsByChat((prev) => {
        const existing = prev[chatId] || [];
        const last = existing[existing.length - 1];
        if (
          last &&
          last.source === source &&
          last.phase === phase &&
          (last.detail || '') === (detail || '') &&
          now - last.timestamp < AGENT_EVENT_DEDUPE_WINDOW_MS
        ) {
          return prev;
        }

        const nextEvent: AgentStatusEvent = {
          id: createId(),
          timestamp: now,
          source,
          phase,
          detail: detail || undefined,
        };

        const next = [...existing, nextEvent];
        if (next.length > MAX_AGENT_EVENTS_PER_CHAT) {
          next.splice(0, next.length - MAX_AGENT_EVENTS_PER_CHAT);
        }

        return { ...prev, [chatId]: next };
      });
    },
    [],
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
    [appendAgentEvent],
  );

  // --- Resumable Sessions Phase 2: detection + resume callbacks ---
  // (Placed after updateAgentStatus to avoid block-scoping issues with tsc -b)

  // Detect interrupted runs when the chat becomes idle (not streaming, loop not active)
  useEffect(() => {
    if (isStreaming || loopActiveRef.current) return;
    if (!activeChatId) return;

    detectInterruptedRunFromManager(
      activeChatId,
      sandboxIdRef.current,
      branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || null,
      repoRef.current,
      workspaceSessionIdRef.current,
    ).then(setInterruptedCheckpoint);
  }, [activeChatId, isStreaming]);

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

    if (!currentSandboxId) {
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
        const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
      return;
    }

    // Fetch sandbox truth
    updateAgentStatus({ active: true, phase: 'Resuming session...' }, { chatId });
    let sbStatus: SandboxStatusResult;
    try {
      sbStatus = await sandboxStatus(currentSandboxId);
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
        const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
      return;
    }

    // Guard: if sandbox git commands failed, don't build reconciliation from bad data
    if (sbStatus.error) {
      clearRunCheckpoint(chatId);
      updateAgentStatus({ active: false, phase: '' });
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const msg: ChatMessage = {
          id: createId(),
          role: 'assistant',
          content: `Session was interrupted, but the sandbox is in an unexpected state: ${sbStatus.error}. Starting fresh.`,
          timestamp: Date.now(),
          status: 'done',
        };
        const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
      return;
    }

    // Build reconciliation message
    const reconciliationContent = buildCheckpointReconciliationMessage(checkpoint, sbStatus);

    const conv = conversations[chatId];
    if (!conv) {
      clearRunCheckpoint(chatId);
      updateAgentStatus({ active: false, phase: '' });
      return;
    }

    // Clear the checkpoint — the loop will create new checkpoints
    clearRunCheckpoint(chatId);

    // Track resume event
    recordResumeEvent(checkpoint);

    // Send the reconciliation content directly as the user message text.
    // We do NOT inject it via setConversations first because sendMessage captures
    // `conversations` from its closure — a preceding setConversations won't be
    // visible until the next render, so the reconciliation would be lost.
    if (sendMessageRef.current) {
      await sendMessageRef.current(reconciliationContent, undefined);
    }
  }, [interruptedCheckpoint, conversations, updateAgentStatus]);

  // Derived state
  const messages = useMemo(
    () => conversations[activeChatId]?.messages ?? [],
    [conversations, activeChatId],
  );
  const agentEvents = useMemo(
    () => agentEventsByChat[activeChatId] ?? [],
    [agentEventsByChat, activeChatId],
  );
  const conversationProvider = conversations[activeChatId]?.provider;
  const conversationModel = conversations[activeChatId]?.model;

  // Context usage — estimate tokens for the meter
  const contextUsage = useMemo(() => {
    const contextProvider = (conversationProvider as ActiveProvider | undefined) || getActiveProvider();
    const contextModel = conversationModel || getModelNameForProvider(contextProvider);
    const budget = getContextBudget(contextProvider, contextModel);
    const used = estimateContextTokens(messages);
    const max = budget.maxTokens;
    return { used, max, percent: Math.min(100, Math.round((used / max) * 100)) };
  }, [messages, conversationProvider, conversationModel]);

  // Check if this conversation has user messages (i.e., provider is locked)
  // Lock status is conversation-scoped and persisted on first user message.
  const isProviderLocked = Boolean(conversationProvider);
  const isModelLocked = Boolean(conversationModel || conversationProvider);
  // The locked provider/model for this conversation (if any).
  const lockedProvider: AIProviderType | null = conversationProvider || null;
  const lockedModel: string | null = conversationModel || null;

  // Filter sortedChatIds by active repo + branch
  const currentBranch = branchInfo?.currentBranch;
  const defaultBranch = branchInfo?.defaultBranch;
  const sortedChatIds = useMemo(() => {
      return Object.keys(conversations)
        .filter((id) => {
          const conv = conversations[id];
          if (!activeRepoFullName) return !conv.repoFullName; // repo-less workspace or legacy chat
          if (conv.repoFullName !== activeRepoFullName) return false;

        // Branch filtering: show chats for the current branch.
        // Legacy chats (no branch field) appear when viewing the default branch.
        if (!currentBranch) return true; // no branch context yet — show all
        const isOnDefaultBranch = currentBranch === (defaultBranch || 'main');
        if (!conv.branch) return isOnDefaultBranch; // legacy chat — show on default branch only
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

  // --- Workspace context (set from App.tsx, read during sendMessage) ---

  const setWorkspaceContext = useCallback((ctx: WorkspaceContext | null) => {
    workspaceContextRef.current = ctx;
  }, []);

  // --- Sandbox ID setter (set from App.tsx) ---

  const setSandboxId = useCallback((id: string | null) => {
    sandboxIdRef.current = id;
  }, []);

  const setWorkspaceSessionId = useCallback((id: string | null) => {
    workspaceSessionIdRef.current = id;
  }, []);

  const setIsMainProtected = useCallback((value: boolean) => {
    isMainProtectedRef.current = value;
  }, []);

  // --- Lazy sandbox auto-spin (set from App.tsx) ---

  const ensureSandboxRef = useRef<(() => Promise<string | null>) | null>(null);

  const setEnsureSandbox = useCallback((fn: (() => Promise<string | null>) | null) => {
    ensureSandboxRef.current = fn;
  }, []);

  // --- Effective project instructions (repo file + built-in app context) ---

  const agentsMdRef = useRef<string | null>(null);
  const instructionFilenameRef = useRef<string | null>(null);

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

  const createNewChat = useCallback((): string => {
    const id = createId();
    const bi = branchInfoRef.current;
    const branch = bi?.currentBranch || bi?.defaultBranch || 'main';
    const newConv: Conversation = {
      id,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      repoFullName: activeRepoFullName || undefined,
      branch: activeRepoFullName ? branch : undefined,
    };
    setConversations((prev) => {
      const updated = { ...prev, [id]: newConv };
      dirtyConversationIdsRef.current.add(id);
      return updated;
    });
    setActiveChatId(id);
    saveActiveChatId(id);
    return id;
  }, [activeRepoFullName]);

  const switchChat = useCallback(
    (id: string) => {
      if (id === activeChatId) return;
      if (isStreaming) {
        abortStream();
      }
      setActiveChatId(id);
      saveActiveChatId(id);
    },
    [activeChatId, isStreaming, abortStream],
  );

  const renameChat = useCallback((id: string, nextTitle: string) => {
    const trimmed = nextTitle.trim();
    if (!trimmed) return;

    setConversations((prev) => {
      const existing = prev[id];
      if (!existing || existing.title === trimmed) return prev;
      const updated = {
        ...prev,
        [id]: {
          ...existing,
          title: trimmed,
        },
      };
      dirtyConversationIdsRef.current.add(id);
      return updated;
    });
  }, []);

  const deleteChat = useCallback(
    (id: string) => {
      setAgentEventsByChat((prev) => {
        if (!prev[id]) return prev;
        const updated = { ...prev };
        delete updated[id];
        return updated;
      });
      setConversations((prev) => {
        const updated = { ...prev };
        delete updated[id];

        if (id === activeChatId) {
          const currentRepo = repoRef.current;
          const remaining = Object.values(updated).filter((c) => {
            if (!currentRepo) return !c.repoFullName;
            return c.repoFullName === currentRepo;
          });

          if (remaining.length > 0) {
            const mostRecent = remaining.sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
            setActiveChatId(mostRecent.id);
            saveActiveChatId(mostRecent.id);
          } else {
            const newId = createId();
            updated[newId] = {
              id: newId,
              title: 'New Chat',
              messages: [],
              createdAt: Date.now(),
              lastMessageAt: Date.now(),
              repoFullName: currentRepo || undefined,
              branch: currentRepo ? (branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || 'main') : undefined,
            };
            setActiveChatId(newId);
            saveActiveChatId(newId);
          }
        }

        deletedConversationIdsRef.current.add(id);
        dirtyConversationIdsRef.current.delete(id);
        return updated;
      });
    },
    [activeChatId],
  );

  const deleteAllChats = useCallback(() => {
    const currentRepo = repoRef.current;
    const chatBranch = currentRepo ? (branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || 'main') : undefined;
    setConversations((prev) => {
      const kept: Record<string, Conversation> = {};
      const removedIds: string[] = [];
      for (const [cid, conv] of Object.entries(prev)) {
        const belongsToCurrentRepo = currentRepo
          ? conv.repoFullName === currentRepo
          : !conv.repoFullName;
        if (!belongsToCurrentRepo) {
          kept[cid] = conv;
        } else {
          removedIds.push(cid);
        }
      }

      const id = createId();
      kept[id] = {
        id,
        title: 'New Chat',
        messages: [],
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
        repoFullName: currentRepo || undefined,
        branch: chatBranch,
      };

      setActiveChatId(id);
      saveActiveChatId(id);
      // Full replace — deleteAllChats nukes and recreates
      void replaceAllConversationsInDB(kept);

      if (removedIds.length > 0) {
        setAgentEventsByChat((prevEvents) => {
          let changed = false;
          const next = { ...prevEvents };
          for (const removedId of removedIds) {
            if (next[removedId]) {
              delete next[removedId];
              changed = true;
            }
          }
          return changed ? next : prevEvents;
        });
      }
      return kept;
    });
  }, []);

  // --- Send message with tool execution loop ---

  const sendMessage = useCallback(
    async (text: string, attachments?: AttachmentData[], options?: SendMessageOptions) => {
      if ((!text.trim() && (!attachments || attachments.length === 0)) || isStreaming) return;

      let chatId = options?.chatId || activeChatIdRef.current;
      if (!chatId || !conversations[chatId]) {
        chatId = createNewChat();
      }

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
      const updatedWithUser = options?.existingUserMessage ? currentMessages : [...currentMessages, userMessage];

      const isFirstMessage = currentMessages.length === 0 && !options?.existingUserMessage;
      const newTitle = options?.titleOverride || (isFirstMessage ? generateTitle(updatedWithUser) : conversations[chatId]?.title || 'New Chat');

      const existingConversation = conversations[chatId];
      const requestedProvider = options?.provider || null;
      const requestedModel = options?.model?.trim() || null;
      const lockedProviderForChat = (
        existingConversation?.provider ||
        requestedProvider ||
        getActiveProvider()
      ) as ActiveProvider;
      const existingLockedModel = existingConversation?.model;
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

      // Remember this provider for auto mode (skip demo — not a real choice).
      if (shouldPersistProvider && lockedProviderForChat !== 'demo') {
        setLastUsedProvider(lockedProviderForChat as PreferredProvider);
      }

      setIsStreaming(true);
      abortRef.current = false;

      const sandboxStartMode = getSandboxStartMode();
      const shouldAutoStartSandbox = sandboxStartMode === 'always'
        || (sandboxStartMode === 'smart' && shouldPrewarmSandbox(trimmedText, attachments));
      if (!sandboxIdRef.current && ensureSandboxRef.current && shouldAutoStartSandbox) {
        updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
        try {
          const prewarmedId = await ensureSandboxRef.current();
          if (prewarmedId) {
            sandboxIdRef.current = prewarmedId;
          }
        } catch {
          // Best effort prewarm; continue chat flow without sandbox.
        }
      }

      // Create new AbortController for this stream
      abortControllerRef.current = new AbortController();

      let apiMessages = [...updatedWithUser];
      let toolCallRecoveryState: ToolCallRecoveryState = {
        diagnosisRetries: 0,
        recoveryAttempted: false,
      };

      // --- Resumable Sessions: initialize checkpoint refs ---
      checkpointChatIdRef.current = chatId;
      checkpointProviderRef.current = lockedProviderForChat;
      checkpointModelRef.current = resolvedModelForChat || '';
      checkpointBaseMessageCountRef.current = updatedWithUser.length;
      checkpointApiMessagesRef.current = apiMessages;
      checkpointAccumulatedRef.current = '';
      checkpointThinkingRef.current = '';
      loopActiveRef.current = true;

      // Acquire multi-tab lock — abort if another tab already holds it
      const acquiredTabId = acquireRunTabLock(chatId);
      if (!acquiredTabId) {
        loopActiveRef.current = false;
        setIsStreaming(false);
        updateAgentStatus({ active: false, phase: '' });
        // Update the placeholder assistant message with an explanation
        setConversations((prev) => {
          const existing = prev[chatId];
          if (!existing) return prev;
          const msgs = existing.messages.map((m) =>
            m.status === 'streaming' ? { ...m, content: 'This chat is active in another tab. Please switch tabs or wait for the other session to finish.', status: 'done' as const } : m,
          );
          const updated = { ...prev, [chatId]: { ...existing, messages: msgs, lastMessageAt: Date.now() } };
          dirtyConversationIdsRef.current.add(chatId);
          return updated;
        });
        return;
      }
      tabLockIdRef.current = acquiredTabId;
      // Heartbeat every 15s to keep the lock alive
      if (tabLockIntervalRef.current) clearInterval(tabLockIntervalRef.current);
      tabLockIntervalRef.current = setInterval(
        () => heartbeatRunTabLock(chatId, acquiredTabId),
        15_000,
      );

      let loopCompletedNormally = false;
      try {
        for (let round = 0; ; round++) {
          if (abortRef.current) break;
          fileLedger.advanceRound();

          // --- Checkpoint: update round refs ---
          checkpointRoundRef.current = round;
          checkpointAccumulatedRef.current = '';
          checkpointThinkingRef.current = '';
          checkpointPhaseRef.current = 'streaming_llm';

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

          let accumulated = '';
          let thinkingAccumulated = '';

          // Re-check sandbox on every round so auto-spun sandboxes are visible to the LLM
          const hasSandboxThisRound = Boolean(sandboxIdRef.current);

          // Per-round sandbox status cache for meta envelope (fetched lazily on first tool result)
          let roundSandboxStatus: { dirty: boolean; files: number } | null = null;
          let roundSandboxStatusFetched = false;
          const getRoundSandboxStatus = async (): Promise<{ dirty: boolean; files: number } | null> => {
            if (roundSandboxStatusFetched) return roundSandboxStatus;
            roundSandboxStatusFetched = true;
            if (!sandboxIdRef.current) return null;
            try {
              const statusResult = await execInSandbox(sandboxIdRef.current, 'cd /workspace && git status --porcelain 2>/dev/null | head -20');
              const lines = statusResult.stdout.trim().split('\n').filter(Boolean);
              roundSandboxStatus = { dirty: lines.length > 0, files: lines.length };
            } catch {
              // Best-effort — don't block tool execution
            }
            return roundSandboxStatus;
          };

          const streamError = await new Promise<Error | null>((resolve) => {
            streamChat(
              apiMessages,
              (token) => {
                if (abortRef.current) return;
                // Simple dedup: skip exact duplicate tokens at same position
                const contentKey = `${round}:${accumulated.length}:${token}`;
                if (processedContentRef.current.has(contentKey)) return;
                processedContentRef.current.add(contentKey);
                accumulated += token;
                checkpointAccumulatedRef.current = accumulated;
                updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
                setConversations((prev) => {
                  const conv = prev[chatId];
                  if (!conv) return prev;
                  const msgs = [...conv.messages];
                  const lastIdx = msgs.length - 1;
                  if (msgs[lastIdx]?.role === 'assistant') {
                    msgs[lastIdx] = { ...msgs[lastIdx], content: accumulated, status: 'streaming' };
                  }
                  return { ...prev, [chatId]: { ...conv, messages: msgs } };
                });
              },
              (usage) => {
                // Track usage if handler is available
                if (usage && usageHandlerRef.current) {
                  usageHandlerRef.current.trackUsage('k2p5', usage.inputTokens, usage.outputTokens);
                }
                resolve(null);
              },
              (error) => resolve(error),
              (token) => {
                if (abortRef.current) return;
                if (token === null) {
                  updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
                  return;
                }
                // Simple dedup for thinking tokens
                const thinkingKey = `think:${round}:${thinkingAccumulated.length}:${token}`;
                if (processedContentRef.current.has(thinkingKey)) return;
                processedContentRef.current.add(thinkingKey);
                thinkingAccumulated += token;
                checkpointThinkingRef.current = thinkingAccumulated;
                updateAgentStatus({ active: true, phase: 'Reasoning...' }, { chatId, log: false });
                setConversations((prev) => {
                  const conv = prev[chatId];
                  if (!conv) return prev;
                  const msgs = [...conv.messages];
                  const lastIdx = msgs.length - 1;
                  if (msgs[lastIdx]?.role === 'assistant') {
                    msgs[lastIdx] = { ...msgs[lastIdx], thinking: thinkingAccumulated, status: 'streaming' };
                  }
                  return { ...prev, [chatId]: { ...conv, messages: msgs } };
                });
              },
              workspaceContextRef.current ?? undefined,
              hasSandboxThisRound,
              scratchpadRef.current?.content,
              abortControllerRef.current?.signal,
              lockedProviderForChat,
              resolvedModelForChat,
            );
          });

          if (abortRef.current) break;

          if (streamError) {
            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = [...conv.messages];
              const lastIdx = msgs.length - 1;
              if (msgs[lastIdx]?.role === 'assistant') {
                msgs[lastIdx] = {
                  ...msgs[lastIdx],
                  content: `Something went wrong: ${streamError.message}`,
                  status: 'error',
                };
              }
              const updated = { ...prev, [chatId]: { ...conv, messages: msgs } };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });
            break;
          }

          // --- Checkpoint: streaming complete, flush before tool detection ---
          checkpointPhaseRef.current = 'executing_tools';
          flushCheckpoint();

          // Check for multiple independent read-only tool calls in one turn.
          // These can be executed safely in parallel (no shared-state mutation).
          const detected = detectAllToolCalls(accumulated);
          const parallelToolCalls = detected.readOnly;
          if (detected.extraMutations.length > 0) {
            const rejectedMutations = detected.mutating
              ? [detected.mutating, ...detected.extraMutations]
              : detected.extraMutations;
            const rejectedToolNames = rejectedMutations.map((call) => getToolName(call));
            const parseErrorHeader = buildToolCallParseErrorBlock({
              errorType: 'multiple_mutating_calls',
              problem: `Only one mutating tool call can run per turn. Received ${rejectedToolNames.length}: ${rejectedToolNames.join(', ')}.`,
              hint: 'Put read-only tools first and one mutating tool last. For multiple coding tasks, use one delegate_coder call with "tasks".',
            });
            const primaryMutation = rejectedMutations[0];
            const errorMsg: ChatMessage = {
              id: createId(),
              role: 'user',
              content: formatToolResultEnvelope(parseErrorHeader),
              timestamp: Date.now(),
              status: 'done',
              isToolResult: true,
              toolMeta: buildToolMeta({
                toolName: rejectedToolNames[0] || 'unknown',
                source: primaryMutation?.source || 'sandbox',
                provider: lockedProviderForChat,
                durationMs: 0,
                isError: true,
              }),
            };

            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const toolMeta = buildToolMeta({
                toolName: rejectedToolNames[0] || 'unknown',
                source: primaryMutation?.source || 'sandbox',
                provider: lockedProviderForChat,
                durationMs: 0,
                isError: true,
              });
              const msgs = markLastAssistantToolCall(conv.messages, {
                content: accumulated,
                thinking: thinkingAccumulated,
                malformed: true,
                toolMeta,
              });
              return { ...prev, [chatId]: { ...conv, messages: [...msgs, errorMsg] } };
            });

            apiMessages = [
              ...apiMessages,
              { id: createId(), role: 'assistant' as const, content: accumulated, timestamp: Date.now(), status: 'done' as const },
              errorMsg,
            ];
            checkpointApiMessagesRef.current = apiMessages;
            continue;
          }

          if (parallelToolCalls.length > 1 || (parallelToolCalls.length > 0 && Boolean(detected.mutating))) {
            console.log(`[Push] Parallel tool calls detected:`, parallelToolCalls);

            // Mark assistant message as tool call
            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = markLastAssistantToolCall(conv.messages, {
                content: accumulated,
                thinking: thinkingAccumulated,
              });
              return { ...prev, [chatId]: { ...conv, messages: msgs } };
            });

            updateAgentStatus(
              { active: true, phase: `Executing ${parallelToolCalls.length} tool calls...` },
              { chatId },
            );

            const hasParallelSandboxCalls = parallelToolCalls.some((call) => call.source === 'sandbox');
            if (hasParallelSandboxCalls && !sandboxIdRef.current && ensureSandboxRef.current) {
              updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
              const newId = await ensureSandboxRef.current();
              if (newId) sandboxIdRef.current = newId;
            }

            const toolRepoFullName = repoRef.current;
            const parallelResults = await Promise.all(
              parallelToolCalls.map(async (call) => {
                const callStart = Date.now();
                let result: ToolExecutionResult;
                if (call.source === 'github' && !toolRepoFullName) {
                  result = { text: '[Tool Error] No active repo selected — please select a repo in the UI.' };
                } else {
                  result = await executeAnyToolCall(
                    call,
                    toolRepoFullName || '',
                    sandboxIdRef.current,
                    isMainProtectedRef.current,
                    branchInfoRef.current?.defaultBranch,
                    lockedProviderForChat,
                    resolvedModelForChat,
                  );
                }
                return {
                  call,
                  result,
                  durationMs: Date.now() - callStart,
                };
              }),
            );

            if (abortRef.current) break;

            // Notify sandbox hook if any tool indicates the container is unreachable
            for (const { result } of parallelResults) {
              if (result.structuredError?.type === 'SANDBOX_UNREACHABLE') {
                runtimeHandlersRef.current?.onSandboxUnreachable?.(result.structuredError.message);
                break;
              }
            }

            const cards = parallelResults
              .map((entry) => entry.result.card)
              .filter((card): card is ChatCard => !!card && card.type !== 'sandbox-state');

            if (cards.length > 0) {
              setConversations((prev) => {
                const conv = prev[chatId];
                if (!conv) return prev;
                const msgs = appendCardsToLatestToolCall(conv.messages, cards);
                return { ...prev, [chatId]: { ...conv, messages: msgs } };
              });
            }

            const parallelSandboxStatus = await getRoundSandboxStatus();
            const parallelMetaLine = buildToolResultMetaLine(
              round,
              apiMessages,
              lockedProviderForChat,
              resolvedModelForChat,
              parallelSandboxStatus,
            );
            const toolResultMessages: ChatMessage[] = parallelResults.map(({ call, result, durationMs }) =>
              buildToolResultMessage({
                id: createId(),
                timestamp: Date.now(),
                text: result.text,
                metaLine: parallelMetaLine,
                toolMeta: buildToolMeta({
                  toolName: getToolName(call),
                  source: call.source,
                  provider: lockedProviderForChat,
                  durationMs,
                  isError: result.text.includes('[Tool Error]'),
                }),
              }),
            );

            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const updated = {
                ...prev,
                [chatId]: {
                  ...conv,
                  messages: [...conv.messages, ...toolResultMessages],
                  lastMessageAt: Date.now(),
                },
              };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });

            apiMessages = [
              ...apiMessages,
              {
                id: createId(),
                role: 'assistant' as const,
                content: accumulated,
                timestamp: Date.now(),
                status: 'done' as const,
              },
              ...toolResultMessages,
            ];
            checkpointApiMessagesRef.current = apiMessages;

            // --- Checkpoint: parallel read-only tool results received ---
            flushCheckpoint();

            // If there's a trailing mutation after the reads, execute it now
            // instead of re-streaming (saves a full LLM round).
            // Re-check cancellation — user may have aborted while reads were in flight
            if (detected.mutating && abortRef.current) break;
            if (detected.mutating) {
              const mutCall = detected.mutating;
              console.log(`[Push] Trailing mutation after parallel reads:`, mutCall);
              updateAgentStatus({ active: true, phase: getToolStatusLabel(mutCall) }, { chatId });

              // Auto-spin sandbox if needed
              if ((mutCall.source === 'sandbox' || (mutCall.source === 'delegate' && mutCall.call.tool === 'delegate_coder')) && !sandboxIdRef.current && ensureSandboxRef.current) {
                updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
                const newId = await ensureSandboxRef.current();
                if (newId) sandboxIdRef.current = newId;
              }

              const mutStart = Date.now();
              const mutResult = await executeAnyToolCall(
                mutCall,
                repoRef.current || '',
                sandboxIdRef.current,
                isMainProtectedRef.current,
                branchInfoRef.current?.defaultBranch,
                lockedProviderForChat,
                resolvedModelForChat,
              );
              const mutDuration = Date.now() - mutStart;

              // Notify sandbox hook if mutation indicates container is unreachable
              if (mutResult.structuredError?.type === 'SANDBOX_UNREACHABLE') {
                runtimeHandlersRef.current?.onSandboxUnreachable?.(mutResult.structuredError.message);
              }

              if (mutResult.card) {
                const mutCard = mutResult.card;
                setConversations((prev) => {
                  const conv = prev[chatId];
                  if (!conv) return prev;
                  const msgs = appendCardsToLatestToolCall(conv.messages, [mutCard]);
                  return { ...prev, [chatId]: { ...conv, messages: msgs } };
                });
              }

              const mutSandboxStatus = await getRoundSandboxStatus();
              const mutMetaLine = buildToolResultMetaLine(
                round,
                apiMessages,
                lockedProviderForChat,
                resolvedModelForChat,
                mutSandboxStatus,
              );
              const mutResultMsg = buildToolResultMessage({
                id: createId(),
                timestamp: Date.now(),
                text: mutResult.text,
                metaLine: mutMetaLine,
                toolMeta: buildToolMeta({
                  toolName: getToolName(mutCall),
                  source: mutCall.source,
                  provider: lockedProviderForChat,
                  durationMs: mutDuration,
                  isError: mutResult.text.includes('[Tool Error]'),
                }),
              });

              setConversations((prev) => {
                const conv = prev[chatId];
                if (!conv) return prev;
                return { ...prev, [chatId]: { ...conv, messages: [...conv.messages, mutResultMsg], lastMessageAt: Date.now() } };
              });
              apiMessages = [...apiMessages, mutResultMsg];
              checkpointApiMessagesRef.current = apiMessages;

              // --- Checkpoint: trailing mutation result received ---
              flushCheckpoint();
            }

            continue;
          }

          // Check for tool call in the response (unified dispatch)
          const toolCall = detectAnyToolCall(accumulated);

          if (!toolCall) {
            const recoveryResult = resolveToolCallRecovery(accumulated, toolCallRecoveryState);
            toolCallRecoveryState = recoveryResult.nextState;

            const diagnosis =
              recoveryResult.kind === 'telemetry_only' ||
              recoveryResult.kind === 'diagnosis_exhausted' ||
              (recoveryResult.kind === 'feedback' && recoveryResult.diagnosis)
                ? recoveryResult.diagnosis
                : null;

            if (diagnosis) {
              recordMalformedToolCallMetric({
                provider: lockedProviderForChat,
                model: resolvedModelForChat,
                reason: diagnosis.reason,
                toolName: diagnosis.toolName,
              });
              console.warn(`[Push] Tool call diagnosis: ${diagnosis.reason}${diagnosis.toolName ? ` (${diagnosis.toolName})` : ''}${diagnosis.telemetryOnly ? ' (telemetry-only)' : ''}`);
            }

            if (recoveryResult.kind === 'feedback') {
              if (recoveryResult.feedback.mode === 'unimplemented_tool') {
                console.warn(`[Push] Unimplemented tool call detected: ${recoveryResult.feedback.toolName}`);
              } else if (recoveryResult.feedback.mode === 'recover_plain_text') {
                console.warn(
                  `[Push] Diagnosis retry cap reached (${MAX_TOOL_CALL_DIAGNOSIS_RETRIES}) — injecting recovery message`,
                );
              }

              const feedbackMsg: ChatMessage = {
                id: createId(),
                role: 'user',
                content: recoveryResult.feedback.content,
                timestamp: Date.now(),
                status: 'done',
                isToolResult: true,
                toolMeta: buildToolMeta({
                  toolName: recoveryResult.feedback.toolName,
                  source: recoveryResult.feedback.source,
                  provider: lockedProviderForChat,
                  durationMs: 0,
                  isError: true,
                }),
              };

              setConversations((prev) => {
                const conv = prev[chatId];
                if (!conv) return prev;
                const assistantToolMeta =
                  recoveryResult.feedback.mode === 'unimplemented_tool'
                    ? undefined
                    : buildToolMeta({
                        toolName: recoveryResult.feedback.toolName,
                        source: recoveryResult.feedback.source,
                        provider: lockedProviderForChat,
                        durationMs: 0,
                        isError: true,
                      });
                const msgs = markLastAssistantToolCall(conv.messages, {
                  content: accumulated,
                  thinking: thinkingAccumulated,
                  malformed: recoveryResult.feedback.markMalformed,
                  toolMeta: assistantToolMeta,
                });
                return { ...prev, [chatId]: { ...conv, messages: [...msgs, feedbackMsg] } };
              });

              apiMessages = [
                ...apiMessages,
                { id: createId(), role: 'assistant' as const, content: accumulated, timestamp: Date.now(), status: 'done' as const },
                feedbackMsg,
              ];
              continue;
            }

            if (recoveryResult.kind === 'diagnosis_exhausted') {
              console.warn('[Push] Recovery also failed — letting message through');
            }

            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = [...conv.messages];
              const lastIdx = msgs.length - 1;
              if (msgs[lastIdx]?.role === 'assistant') {
                msgs[lastIdx] = {
                  ...msgs[lastIdx],
                  content: accumulated,
                  thinking: thinkingAccumulated || undefined,
                  status: 'done',
                };
              }
              const updated = { ...prev, [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() } };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });
            loopCompletedNormally = true;
            break;
          }

          // --- Tool call detected ---
          console.log(`[Push] Tool call detected:`, toolCall);

          // Mark assistant message as tool call
          setConversations((prev) => {
            const conv = prev[chatId];
            if (!conv) return prev;
            const msgs = markLastAssistantToolCall(conv.messages, {
              content: accumulated,
              thinking: thinkingAccumulated,
            });
            return { ...prev, [chatId]: { ...conv, messages: msgs } };
          });

          // Execute tool — track timing for provenance
          const toolExecStart = Date.now();
          const statusLabel = getToolStatusLabel(toolCall);
          updateAgentStatus({ active: true, phase: statusLabel }, { chatId });

          let toolExecResult: ToolExecutionResult;

          // Lazy auto-spin: create sandbox on demand when a sandbox tool or Coder delegation needs one.
          if ((toolCall.source === 'sandbox' || (toolCall.source === 'delegate' && toolCall.call.tool === 'delegate_coder')) && !sandboxIdRef.current) {
            if (ensureSandboxRef.current) {
              updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
              const newId = await ensureSandboxRef.current();
              if (newId) {
                sandboxIdRef.current = newId;
              }
            }
          }

          if (toolCall.source === 'scratchpad') {
            // Handle scratchpad tools
            const sp = scratchpadRef.current;
            if (!sp) {
              toolExecResult = { text: '[Tool Error] Scratchpad not available. The scratchpad may not be initialized — try again after the UI loads.' };
            } else {
              const result = executeScratchpadToolCall(
                toolCall.call,
                sp.content,
                sp.replace,
                sp.append,
              );
              // Eagerly update the ref so the next LLM round sees the new content
              // (React state is async, but the ref is read synchronously in streamChat)
              // Only update if the operation succeeded.
              if (result.ok) {
                if (toolCall.call.tool === 'set_scratchpad') {
                  scratchpadRef.current = { ...sp, content: toolCall.call.content };
                } else if (toolCall.call.tool === 'append_scratchpad') {
                  const prev = sp.content.trim();
                  scratchpadRef.current = {
                    ...sp,
                    content: prev ? `${prev}\n\n${toolCall.call.content}` : toolCall.call.content,
                  };
                }
              }
              toolExecResult = { text: result.text };
            }
          } else if (toolCall.source === 'delegate') {
            if (toolCall.call.tool === 'delegate_explorer') {
              checkpointPhaseRef.current = 'delegating_explorer';
              const explorerTask = toolCall.call.args.task?.trim();
              if (!explorerTask) {
                toolExecResult = { text: '[Tool Error] delegate_explorer requires a non-empty "task" string.' };
              } else {
                try {
                  const explorerResult = await runExplorerAgent(
                    {
                      task: explorerTask,
                      files: toolCall.call.args.files || [],
                      intent: toolCall.call.args.intent,
                      constraints: toolCall.call.args.constraints,
                      branchContext: branchInfoRef.current?.currentBranch ? {
                        activeBranch: branchInfoRef.current.currentBranch,
                        defaultBranch: branchInfoRef.current.defaultBranch || 'main',
                        protectMain: isMainProtectedRef.current,
                      } : undefined,
                      provider: lockedProviderForChat,
                      model: resolvedModelForChat || undefined,
                      projectInstructions: agentsMdRef.current || undefined,
                      instructionFilename: instructionFilenameRef.current || undefined,
                    },
                    sandboxIdRef.current,
                    repoRef.current || '',
                    {
                      onStatus: (phase, detail) => {
                        updateAgentStatus(
                          { active: true, phase, detail },
                          { chatId, source: 'explorer' },
                        );
                      },
                      signal: abortControllerRef.current?.signal,
                    },
                  );

                  if (explorerResult.cards.length > 0) {
                    setConversations((prev) => {
                      const conv = prev[chatId];
                      if (!conv) return prev;
                      const msgs = appendCardsToLatestToolCall(conv.messages, explorerResult.cards);
                      return { ...prev, [chatId]: { ...conv, messages: msgs } };
                    });
                  }

                  toolExecResult = {
                    text: `[Tool Result — delegate_explorer]\n${explorerResult.summary}\n(${explorerResult.rounds} round${explorerResult.rounds !== 1 ? 's' : ''})`,
                  };
                } catch (err) {
                  const isAbort = err instanceof DOMException && err.name === 'AbortError';
                  if (isAbort || abortRef.current) {
                    toolExecResult = { text: '[Tool Result — delegate_explorer]\nExplorer cancelled by user.' };
                  } else {
                    const msg = err instanceof Error ? err.message : String(err);
                    toolExecResult = { text: `[Tool Error] Explorer failed: ${msg}` };
                  }
                }
              }
            } else {
              // Handle Coder delegation (Phase 3b)
              checkpointPhaseRef.current = 'delegating_coder';
              lastCoderStateRef.current = null; // Will be populated by onWorkingMemoryUpdate callback
              const currentSandboxId = sandboxIdRef.current;
              if (!currentSandboxId) {
                toolExecResult = { text: '[Tool Error] Failed to start sandbox automatically. Try again.' };
              } else {
                try {
                  const delegateArgs = toolCall.call.args;
                  const taskList = Array.isArray(delegateArgs.tasks)
                    ? delegateArgs.tasks.filter((t) => typeof t === 'string' && t.trim())
                    : [];
                  if (delegateArgs.task?.trim()) {
                    taskList.unshift(delegateArgs.task.trim());
                  }

                  if (taskList.length === 0) {
                    toolExecResult = { text: '[Tool Error] delegate_coder requires "task" or non-empty "tasks" array.' };
                  } else {
                  const allCards: ChatCard[] = [];
                  const summaries: string[] = [];
                  let totalRounds = 0;
                  let totalCheckpoints = 0;
                  let parallelIsolationNote = '';

                  let parallelSetupFailed = false;
                  const canRunParallelDelegates = (
                    taskList.length > 1
                    && taskList.length <= MAX_PARALLEL_DELEGATE_TASKS
                    && Boolean(repoRef.current)
                  );

	                  if (canRunParallelDelegates) {
                    const bi = branchInfoRef.current;
                    const parallelResult = await runParallelDelegation(
                      {
                        tasks: taskList,
                        files: delegateArgs.files || [],
                        acceptanceCriteria: delegateArgs.acceptanceCriteria,
                        intent: delegateArgs.intent,
                        constraints: delegateArgs.constraints,
                        branchContext: bi?.currentBranch ? {
                          activeBranch: bi.currentBranch,
                          defaultBranch: bi.defaultBranch || 'main',
                          protectMain: isMainProtectedRef.current,
                        } : undefined,
                        provider: lockedProviderForChat,
                        model: resolvedModelForChat || undefined,
                        projectInstructions: agentsMdRef.current || undefined,
                        instructionFilename: instructionFilenameRef.current || undefined,
                        activeSandboxId: currentSandboxId,
                        sourceRepo: repoRef.current!,
                        sourceBranch: bi?.currentBranch || bi?.defaultBranch || 'main',
                        authToken: getActiveGitHubToken(),
                        appCommitIdentity: getGitHubAppCommitIdentity(),
                        recentChatHistory: apiMessages.slice(-6),
                      },
                      {
                        onStatus: (phase, detail) => {
                          updateAgentStatus(
                            { active: true, phase, detail },
                            { chatId, source: 'coder' },
                          );
                        },
                        signal: abortControllerRef.current?.signal,
                        onWorkingMemoryUpdate: (state) => { lastCoderStateRef.current = state; },
                        getActiveSandboxId: () => sandboxIdRef.current,
                      },
                    );

                    if (parallelResult.outcome === 'setup_failed') {
                      parallelSetupFailed = true;
                      updateAgentStatus(
                        { active: true, phase: 'Worker setup failed, falling back to sequential execution...' },
                        { chatId, source: 'coder' },
                      );
                    } else {
                      totalRounds = parallelResult.totalRounds;
                      totalCheckpoints = parallelResult.totalCheckpoints;
                      allCards.push(...parallelResult.cards);
                      for (const taskResult of parallelResult.tasks) {
                        const elapsed = formatElapsedTime(taskResult.elapsedMs);
                        summaries.push(`Task ${taskResult.taskIndex + 1} [${taskResult.status}, ${elapsed}]: ${taskResult.summary}`);
                      }
                      parallelIsolationNote = parallelResult.mergeNote;
                    }
                  }

                  if (!canRunParallelDelegates || parallelSetupFailed) {
                    for (let taskIndex = 0; taskIndex < taskList.length; taskIndex++) {
                      const task = taskList[taskIndex];

                      // Interactive Checkpoint callback: when the Coder pauses to ask
                      // the Orchestrator for guidance, this generates an answer using the
                      // Orchestrator's LLM with recent chat history for context.
                      const handleCheckpoint = async (question: string, context: string): Promise<string> => {
                        const prefix = taskList.length > 1 ? `[${taskIndex + 1}/${taskList.length}] ` : '';
                        updateAgentStatus(
                          { active: true, phase: `${prefix}Coder checkpoint`, detail: question },
                          { chatId, source: 'coder' },
                        );

                        const answer = await generateCheckpointAnswer(
                          question,
                          context,
                          apiMessages.slice(-6), // recent chat for user intent context
                          abortControllerRef.current?.signal,
                          lockedProviderForChat,
                          resolvedModelForChat || undefined,
                        );

                        updateAgentStatus(
                          { active: true, phase: `${prefix}Coder resuming...` },
                          { chatId, source: 'coder' },
                        );
                        return answer;
                      };

                      // Apply acceptance criteria to every task — validates each independently.
                      // For sequential single-sandbox mode this also catches regressions
                      // introduced by earlier tasks before they compound.
                      const seqTaskStart = Date.now();
                      const seqBi = branchInfoRef.current;
                      const coderResult = await runCoderAgent(
                        task,
                        currentSandboxId,
                        delegateArgs.files || [],
                        (phase, detail) => {
                          const prefix = taskList.length > 1 ? `[${taskIndex + 1}/${taskList.length}] ` : '';
                          updateAgentStatus(
                            { active: true, phase: `${prefix}${phase}`, detail },
                            { chatId, source: 'coder' },
                          );
                        },
                        agentsMdRef.current || undefined,
                        abortControllerRef.current?.signal,
                        handleCheckpoint,
                        delegateArgs.acceptanceCriteria,
                        (state) => { lastCoderStateRef.current = state; },
                        lockedProviderForChat,
                        resolvedModelForChat || undefined,
                        {
                          intent: delegateArgs.intent,
                          constraints: delegateArgs.constraints,
                          branchContext: seqBi?.currentBranch ? {
                            activeBranch: seqBi.currentBranch,
                            defaultBranch: seqBi.defaultBranch || 'main',
                            protectMain: isMainProtectedRef.current,
                          } : undefined,
                          instructionFilename: instructionFilenameRef.current || undefined,
                        },
                      );
                      const seqElapsed = formatElapsedTime(Date.now() - seqTaskStart);
                      const seqStatus = getTaskStatusLabel(coderResult.criteriaResults);
                      totalRounds += coderResult.rounds;
                      totalCheckpoints += coderResult.checkpoints;
                      if (taskList.length > 1) {
                        summaries.push(`Task ${taskIndex + 1} [${seqStatus}, ${seqElapsed}]: ${coderResult.summary}`);
                      } else {
                        summaries.push(`${coderResult.summary} (${seqElapsed})`);
                      }
                      allCards.push(...coderResult.cards);
                    }
                  }

                  // Attach all Coder cards to the assistant message
                  if (allCards.length > 0) {
                    setConversations((prev) => {
                      const conv = prev[chatId];
                      if (!conv) return prev;
                      const msgs = appendCardsToLatestToolCall(conv.messages, allCards);
                      return { ...prev, [chatId]: { ...conv, messages: msgs } };
                    });
                  }

                  const checkpointNote = totalCheckpoints > 0
                    ? `, ${totalCheckpoints} checkpoint${totalCheckpoints !== 1 ? 's' : ''}`
                    : '';
                  toolExecResult = {
                    text: `[Tool Result — delegate_coder]\n${summaries.join('\n')}\n(${totalRounds} round${totalRounds !== 1 ? 's' : ''}${checkpointNote})${parallelIsolationNote}`,
                  };
                }
                } catch (err) {
                  const isAbort = err instanceof DOMException && err.name === 'AbortError';
                  if (isAbort || abortRef.current) {
                    toolExecResult = { text: '[Tool Result — delegate_coder]\nCoder cancelled by user.' };
                  } else {
                    const msg = err instanceof Error ? err.message : String(err);
                    toolExecResult = { text: `[Tool Error] Coder failed: ${msg}` };
                  }
                }
              }
            }
            // Reset phase — delegation finished (success or error)
            checkpointPhaseRef.current = 'executing_tools';
            lastCoderStateRef.current = null;
          } else {
            // GitHub or Sandbox tools
            const toolRepoFullName = repoRef.current;
            if (toolCall.source === 'github' && !toolRepoFullName) {
              toolExecResult = { text: '[Tool Error] No active repo selected — please select a repo in the UI.' };
            } else {
              toolExecResult = await executeAnyToolCall(
                toolCall,
                toolRepoFullName || '',
                sandboxIdRef.current,
                isMainProtectedRef.current,
                branchInfoRef.current?.defaultBranch,
                lockedProviderForChat,
                resolvedModelForChat,
              );
            }
          }

          if (abortRef.current) break;

          if (toolExecResult.promotion?.repo) {
            const promotedRepo = toolExecResult.promotion.repo;
            repoRef.current = promotedRepo.full_name;

            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const updated = {
                ...prev,
                [chatId]: {
                  ...conv,
                  repoFullName: promotedRepo.full_name,
                  lastMessageAt: Date.now(),
                },
              };
              dirtyConversationIdsRef.current.add(chatId);
              return updated;
            });

            runtimeHandlersRef.current?.bindSandboxSessionToRepo?.(
              promotedRepo.full_name,
              promotedRepo.default_branch,
            );
            runtimeHandlersRef.current?.onSandboxPromoted?.(promotedRepo);
          }

          // Sync app branch state when sandbox switches branches (e.g. draft checkout)
          if (toolExecResult.branchSwitch) {
            runtimeHandlersRef.current?.onBranchSwitch?.(toolExecResult.branchSwitch);
          }

          // Notify sandbox hook if tool indicates the container is unreachable
          if (toolExecResult.structuredError?.type === 'SANDBOX_UNREACHABLE') {
            runtimeHandlersRef.current?.onSandboxUnreachable?.(toolExecResult.structuredError.message);
          }

          // Attach card to the assistant message that triggered the tool call
          if (toolExecResult.card) {
            if (toolExecResult.card.type === 'sandbox-state') {
              // No longer render or persist sandbox state cards in chat.
              continue;
            }
            const toolCard = toolExecResult.card;
            setConversations((prev) => {
              const conv = prev[chatId];
              if (!conv) return prev;
              const msgs = appendCardsToLatestToolCall(conv.messages, [toolCard]);
              return { ...prev, [chatId]: { ...conv, messages: msgs } };
            });
          }

          // Create tool result message with provenance metadata + meta envelope
          const toolExecDurationMs = Date.now() - toolExecStart;
          const sandboxStatus = await getRoundSandboxStatus();
          const metaLine = buildToolResultMetaLine(
            round,
            apiMessages,
            lockedProviderForChat,
            resolvedModelForChat,
            sandboxStatus,
          );
          const toolResultMsg = buildToolResultMessage({
            id: createId(),
            timestamp: Date.now(),
            text: toolExecResult.text,
            metaLine,
            toolMeta: buildToolMeta({
              toolName: getToolName(toolCall),
              source: toolCall.source,
              provider: lockedProviderForChat,
              durationMs: toolExecDurationMs,
              isError: toolExecResult.text.includes('[Tool Error]'),
            }),
          });

          setConversations((prev) => {
            const conv = prev[chatId];
            if (!conv) return prev;
            const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, toolResultMsg] } };
            dirtyConversationIdsRef.current.add(chatId);
            return updated;
          });

          apiMessages = [
            ...apiMessages,
            {
              id: createId(),
              role: 'assistant' as const,
              content: accumulated,
              timestamp: Date.now(),
              status: 'done' as const,
            },
            toolResultMsg,
          ];
          checkpointApiMessagesRef.current = apiMessages;

          // --- Checkpoint: tool result received ---
          flushCheckpoint();
        }
      } finally {
        setIsStreaming(false);
        if (cancelStatusTimerRef.current === null) {
          updateAgentStatus({ active: false, phase: '' });
        }
        abortControllerRef.current = null;

        // --- Checkpoint: clear only on normal completion ---
        loopActiveRef.current = false;
        checkpointChatIdRef.current = null;
        if (loopCompletedNormally) {
          clearRunCheckpoint(chatId);
        }

        // Release multi-tab lock (only if we own it)
        releaseRunTabLock(chatId, tabLockIdRef.current);
        tabLockIdRef.current = null;
        if (tabLockIntervalRef.current) {
          clearInterval(tabLockIntervalRef.current);
          tabLockIntervalRef.current = null;
        }
      }
    },
    [conversations, isStreaming, createNewChat, updateAgentStatus, flushCheckpoint],
  );

  // Wire sendMessageRef so resume callback can reach it (defined after sendMessage)
  sendMessageRef.current = sendMessage;

  const regenerateLastResponse = useCallback(async () => {
    if (isStreaming) return;

    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    const conversation = conversations[chatId];
    if (!conversation) return;

    const replay = buildRegeneratedReplay(conversation.messages);
    if (!replay) return;

    await sendMessage(
      replay.existingUserMessage.content,
      replay.existingUserMessage.attachments,
      {
        chatId,
        baseMessages: replay.baseMessages,
        existingUserMessage: replay.existingUserMessage,
        titleOverride: conversation.title,
      },
    );
  }, [conversations, isStreaming, sendMessage]);

  const editMessageAndResend = useCallback(async (
    messageId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: ChatSendOptions,
  ) => {
    if (isStreaming) return;

    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    const conversation = conversations[chatId];
    if (!conversation) return;

    const replay = buildEditedReplay(
      conversation.messages,
      messageId,
      text,
      attachments,
      options?.displayText,
    );
    if (!replay) return;

    await sendMessage(
      replay.existingUserMessage.content,
      replay.existingUserMessage.attachments,
      {
        chatId,
        baseMessages: replay.baseMessages,
        existingUserMessage: replay.existingUserMessage,
        titleOverride: conversation.title,
      },
    );
  }, [conversations, isStreaming, sendMessage]);

  const diagnoseCIFailure = useCallback(async () => {
    if (!repoRef.current || !ciStatus || ciStatus.overall !== 'failure') return;
    const failedChecks = ciStatus.checks
      .filter((c) => c.conclusion === 'failure')
      .map((c) => c.name)
      .join(', ');
    await sendMessage(`CI is failing on ${ciStatus.ref}. Failed checks: ${failedChecks}. Diagnose and fix the failures.`);
  }, [ciStatus, sendMessage]);

  // --- Card action handler (Phase 4 — commit review + CI) ---

  const updateCardInMessage = useCallback(
    (chatId: string, messageId: string, cardIndex: number, updater: (card: ChatCard) => ChatCard) => {
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const msgs = conv.messages.map((msg) => {
          if (msg.id !== messageId || !msg.cards) return msg;
          const cards = msg.cards.map((card, i) => (i === cardIndex ? updater(card) : card));
          return { ...msg, cards };
        });
        const updated = { ...prev, [chatId]: { ...conv, messages: msgs } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [],
  );

  const injectSyntheticMessage = useCallback(
    (chatId: string, content: string) => {
      const msg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status: 'done',
      };
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [],
  );

  const injectAssistantCardMessage = useCallback(
    (chatId: string, content: string, card: ChatCard) => {
      if (card.type === 'sandbox-state') {
        return;
      }
      const msg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status: 'done',
        cards: [card],
      };
      setConversations((prev) => {
        const conv = prev[chatId];
        if (!conv) return prev;
        const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, msg], lastMessageAt: Date.now() } };
        dirtyConversationIdsRef.current.add(chatId);
        return updated;
      });
    },
    [],
  );

  const handleCardAction = useCallback(
    async (action: CardAction) => {
      const chatId = activeChatId;
      if (!chatId) return;

      switch (action.type) {
        case 'commit-approve': {
          const sandboxId = sandboxIdRef.current;
          if (!sandboxId) {
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              return { ...card, data: { ...card.data, status: 'error', error: 'Sandbox expired. Start a new sandbox.' } as CommitReviewCardData };
            });
            return;
          }

          // Enforce Protect Main for UI-driven commits
          if (isMainProtectedRef.current) {
            try {
              const branchResult = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
              const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout?.trim() : null;
              const mainBranches = new Set(['main', 'master']);
              const defBranch = branchInfoRef.current?.defaultBranch;
              if (defBranch) mainBranches.add(defBranch);
              if (!currentBranch || mainBranches.has(currentBranch)) {
                updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                  if (card.type !== 'commit-review') return card;
                  return { ...card, data: { ...card.data, status: 'error', error: 'Protect Main is enabled. Create a feature branch before committing.' } as CommitReviewCardData };
                });
                return;
              }
            } catch {
              // Fail-safe: block if we can't determine the branch
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return { ...card, data: { ...card.data, status: 'error', error: 'Protect Main is enabled and branch could not be verified.' } as CommitReviewCardData };
              });
              return;
            }
          }

          // Step 1: Mark as approved (prevents double-tap)
          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'commit-review') return card;
            return { ...card, data: { ...card.data, status: 'approved', commitMessage: action.commitMessage } as CommitReviewCardData };
          });

          updateAgentStatus(
            { active: true, phase: 'Committing & pushing...' },
            { chatId, source: 'system' },
          );

          try {
            const normalizedCommitMessage = action.commitMessage.replace(/[\r\n]+/g, ' ').trim();
            if (!normalizedCommitMessage) {
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return { ...card, data: { ...card.data, status: 'error', error: 'Commit message cannot be empty.' } as CommitReviewCardData };
              });
              return;
            }

            const safeCommitMessage = normalizedCommitMessage.replace(/'/g, `'"'"'`);

            // Step 2: Commit in sandbox
            const commitResult = await execInSandbox(
              sandboxId,
              `cd /workspace && git add -A && git commit -m '${safeCommitMessage}'`,
              undefined,
              { markWorkspaceMutated: true },
            );

            if (commitResult.exitCode !== 0) {
              const errorDetail = commitResult.stderr || commitResult.stdout || 'Unknown error';
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return { ...card, data: { ...card.data, status: 'error', error: `Commit failed: ${errorDetail}` } as CommitReviewCardData };
              });
              return;
            }

            // Step 3: Push
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              return { ...card, data: { ...card.data, status: 'pushing' } as CommitReviewCardData };
            });

            const pushResult = await execInSandbox(
              sandboxId,
              'cd /workspace && git push origin HEAD',
              undefined,
              { markWorkspaceMutated: true },
            );

            if (pushResult.exitCode !== 0) {
              const pushErrorDetail = pushResult.stderr || pushResult.stdout || 'Unknown error';
              updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
                if (card.type !== 'commit-review') return card;
                return { ...card, data: { ...card.data, status: 'error', error: `Push failed: ${pushErrorDetail}` } as CommitReviewCardData };
              });
              return;
            }

            // Step 4: Success
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'commit-review') return card;
              return { ...card, data: { ...card.data, status: 'committed' } as CommitReviewCardData };
            });

            injectSyntheticMessage(chatId, `Committed and pushed: "${action.commitMessage}"`);

            // Step 5: Auto-fetch CI after 3s delay
            const repo = repoRef.current;
            if (repo) {
              setTimeout(async () => {
                try {
                  const ciResult = await executeToolCall(
                    { tool: 'fetch_checks', args: { repo, ref: 'HEAD' } },
                    repo,
                  );
                  if (ciResult.card) {
                    const ciMsg: ChatMessage = {
                      id: createId(),
                      role: 'assistant',
                      content: 'CI status after push:',
                      timestamp: Date.now(),
                      status: 'done',
                      cards: [ciResult.card],
                    };
                    setConversations((prev) => {
                      const conv = prev[chatId];
                      if (!conv) return prev;
                      const updated = { ...prev, [chatId]: { ...conv, messages: [...conv.messages, ciMsg], lastMessageAt: Date.now() } };
                      dirtyConversationIdsRef.current.add(chatId);
                      return updated;
                    });
                  }
                } catch {
                  // CI fetch is best-effort
                }
              }, 3000);
            }
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'commit-reject': {
          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'commit-review') return card;
            return { ...card, data: { ...card.data, status: 'rejected' } as CommitReviewCardData };
          });
          injectSyntheticMessage(chatId, 'Commit cancelled.');
          break;
        }

        case 'ci-refresh': {
          const repo = repoRef.current;
          if (!repo) return;

          updateAgentStatus(
            { active: true, phase: 'Refreshing CI status...' },
            { chatId, source: 'system' },
          );
          try {
            const ciResult = await executeToolCall(
              { tool: 'fetch_checks', args: { repo, ref: 'HEAD' } },
              repo,
            );
            if (ciResult.card && ciResult.card.type === 'ci-status') {
              updateCardInMessage(chatId, action.messageId, action.cardIndex, () => ciResult.card!);
            }
          } catch {
            // Best-effort
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'sandbox-state-refresh': {
          updateAgentStatus(
            { active: true, phase: 'Refreshing sandbox state...' },
            { chatId, source: 'system' },
          );
          try {
            const statusResult = await execInSandbox(
              action.sandboxId,
              'cd /workspace && git status -sb --porcelain=1',
            );
            if (statusResult.exitCode !== 0) {
              break;
            }

            const lines = statusResult.stdout
              .split('\n')
              .map((line) => line.trimEnd())
              .filter(Boolean);
            const statusLine = lines.find((line) => line.startsWith('##'))?.slice(2).trim() || 'unknown';
            const branch = statusLine.split('...')[0].trim() || 'unknown';
            const entries = lines.filter((line) => !line.startsWith('##'));

            let stagedFiles = 0;
            let unstagedFiles = 0;
            let untrackedFiles = 0;

            for (const entry of entries) {
              const x = entry[0] || ' ';
              const y = entry[1] || ' ';
              if (x === '?' && y === '?') {
                untrackedFiles++;
                continue;
              }
              if (x !== ' ') stagedFiles++;
              if (y !== ' ') unstagedFiles++;
            }

            const nextData: SandboxStateCardData = {
              sandboxId: action.sandboxId,
              repoPath: '/workspace',
              branch,
              statusLine,
              changedFiles: entries.length,
              stagedFiles,
              unstagedFiles,
              untrackedFiles,
              preview: entries.slice(0, 6).map((line) => (line.length > 120 ? `${line.slice(0, 120)}...` : line)),
              fetchedAt: new Date().toISOString(),
            };

            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'sandbox-state') return card;
              return { ...card, data: nextData };
            });
          } catch {
            // Best-effort refresh
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }

        case 'ask-user-submit': {
          const responseText = action.responseText.trim();
          if (!responseText || isStreaming || !sendMessageRef.current) {
            return;
          }

          const sourceMessage = messages.find((message) => message.id === action.messageId);
          const sourceCard = sourceMessage?.cards?.[action.cardIndex];
          const question = sourceCard?.type === 'ask-user' ? sourceCard.data.question.trim() : '';

          updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
            if (card.type !== 'ask-user') return card;
            return {
              ...card,
              data: {
                ...card.data,
                responseText,
                selectedOptionIds: action.selectedOptionIds,
              },
            };
          });

          const contextualReply = question
            ? `Answer to your question "${question}": ${responseText}`
            : responseText;

          await sendMessageRef.current(contextualReply);
          break;
        }

        case 'editor-save': {
          updateAgentStatus(
            { active: true, phase: 'Saving file...' },
            { chatId, source: 'system' },
          );
          try {
            const writeResult = await writeToSandbox(
              action.sandboxId,
              action.path,
              action.content,
              action.expectedVersion,
              action.expectedWorkspaceRevision,
            );

            if (!writeResult.ok) {
              if (writeResult.code === 'WORKSPACE_CHANGED') {
                const expected = writeResult.expected_workspace_revision ?? action.expectedWorkspaceRevision ?? 'unknown';
                const current = writeResult.current_workspace_revision ?? writeResult.workspace_revision ?? 'unknown';
                injectSyntheticMessage(
                  chatId,
                  `Save blocked for ${action.path}: workspace changed since last read (expected revision ${expected}, current ${current}). Re-open and retry.`,
                );
              } else if (writeResult.code === 'STALE_FILE') {
                const expected = writeResult.expected_version || action.expectedVersion || 'unknown';
                const current = writeResult.current_version || 'missing';
                injectSyntheticMessage(
                  chatId,
                  `Save blocked for ${action.path}: file changed since last read (expected ${expected}, current ${current}). Re-open and retry.`,
                );
              } else {
                injectSyntheticMessage(chatId, `Save failed for ${action.path}: ${writeResult.error || 'Unknown error'}`);
              }
              break;
            }

            fileLedger.recordMutation(action.path, 'user');
            updateCardInMessage(chatId, action.messageId, action.cardIndex, (card) => {
              if (card.type !== 'editor') return card;
              return {
                ...card,
                data: {
                  ...card.data,
                  content: action.content,
                  truncated: false,
                  version: typeof writeResult.new_version === 'string' ? writeResult.new_version : card.data.version,
                  workspaceRevision: typeof writeResult.workspace_revision === 'number' ? writeResult.workspace_revision : card.data.workspaceRevision,
                },
              };
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            injectSyntheticMessage(chatId, `Save failed for ${action.path}: ${message}`);
          } finally {
            updateAgentStatus({ active: false, phase: '' });
          }
          break;
        }
      }
    },
    [activeChatId, injectSyntheticMessage, isStreaming, messages, updateCardInMessage, updateAgentStatus],
  );

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

    // Card actions (Phase 4)
    handleCardAction,

    // Context usage (for meter UI)
    contextUsage,

    // Abort stream
    abortStream,

    // Resumable Sessions (Phase 2)
    interruptedCheckpoint,
    resumeInterruptedRun,
    dismissResume,
    ciStatus,
    diagnoseCIFailure,
  };
}
