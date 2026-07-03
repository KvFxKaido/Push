/**
 * chat-management.ts
 *
 * Extracted from useChat.ts — CRUD operations on conversations.
 * createNewChat, switchChat, renameChat, deleteChat, deleteAllChats.
 */

import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentStatusEvent, Conversation, WorkspaceMode } from '@/types';
import { createId, saveActiveChatId } from '@/hooks/chat-persistence';
import type { TodoHandlers } from '@/hooks/chat-send-types';
import { replaceAllConversations as replaceAllConversationsInDB } from '@/lib/conversation-store';
import { getDefaultVerificationPolicy } from '@/lib/verification-policy';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ChatManagementParams {
  conversations: Record<string, Conversation>;
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  setActiveChatId: Dispatch<SetStateAction<string>>;
  setAgentEventsByChat: Dispatch<SetStateAction<Record<string, AgentStatusEvent[]>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  deletedConversationIdsRef: MutableRefObject<Set<string>>;
  activeChatId: string;
  activeChatIdRef: MutableRefObject<string | null>;
  activeRepoFullName: string | null;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  repoRef: MutableRefObject<string | null>;
  isStreaming: boolean;
  abortStream: (options?: { clearQueuedFollowUps?: boolean }) => void;
  clearQueuedFollowUps: (chatId: string) => void;
  workspaceModeRef: MutableRefObject<WorkspaceMode | null>;
  /**
   * Todo-list handlers from the hosting surface. Minting a fresh chat wipes
   * the (repo-scoped) todo list: the list is working state for the current
   * effort, and a new chat starts a new effort. Without this, a stale [TODO]
   * block leaks into the fresh chat's system prompt and the model treats the
   * previous session's work as its own.
   */
  todoRef: MutableRefObject<TodoHandlers | undefined>;
}

function getWorkspaceScopedMode(
  repoFullName: string | null,
  workspaceMode: WorkspaceMode | null,
): WorkspaceMode | undefined {
  if (repoFullName) return workspaceMode ?? 'repo';
  return workspaceMode ?? undefined;
}

export function conversationBelongsToWorkspace(
  conversation: Conversation,
  repoFullName: string | null,
  workspaceMode: WorkspaceMode | null,
): boolean {
  if (repoFullName) {
    return conversation.repoFullName === repoFullName;
  }

  if (workspaceMode === 'chat') {
    return !conversation.repoFullName && conversation.mode === 'chat';
  }

  if (workspaceMode === 'scratch') {
    return !conversation.repoFullName && conversation.mode !== 'chat';
  }

  // Daemon-backed workspaces (local-pc / relay) scope to the matching
  // mode tag so cross-mode actions (e.g. Settings → "Delete all chats"
  // from a local-PC session) don't sweep up chats from chat mode,
  // scratch, or the other daemon mode.
  if (workspaceMode === 'local-pc' || workspaceMode === 'relay') {
    return !conversation.repoFullName && conversation.mode === workspaceMode;
  }

  return !conversation.repoFullName;
}

// ---------------------------------------------------------------------------
// Workspace chat auto-resolution
// ---------------------------------------------------------------------------

/**
 * Decides what the WorkspaceSessionScreen auto-effect should do when a
 * session mounts/restores: keep the current chat, switch to an existing
 * workspace chat, or mint a new one. Extracted as a pure function so the
 * ordering guards (especially the `conversationsLoaded` hydration gate) are
 * unit-testable without mounting the whole screen.
 */
export type WorkspaceChatAction =
  | { kind: 'noop' }
  | { kind: 'switch'; chatId: string }
  | { kind: 'create' };

export interface ResolveWorkspaceChatActionParams {
  conversations: Record<string, Conversation>;
  activeChatId: string;
  repoFullName: string | null;
  workspaceMode: WorkspaceMode;
  conversationsLoaded: boolean;
  /** Truthy when a resume is pending — the resume path owns chat selection. */
  hasPendingResume: boolean;
  /** Truthy when the pre-flight menu's drain effect owns chat minting. */
  hasPendingNewChat: boolean;
}

export function resolveWorkspaceChatAction({
  conversations,
  activeChatId,
  repoFullName,
  workspaceMode,
  conversationsLoaded,
  hasPendingResume,
  hasPendingNewChat,
}: ResolveWorkspaceChatActionParams): WorkspaceChatAction {
  if (hasPendingResume) return { kind: 'noop' };
  // Pre-flight menu owns chat minting on commit — let its drain effect
  // create the fresh chat in the right context. Without this guard the
  // auto-effect can race the drain on a cross-context commit, switching the
  // user into a matching existing chat before the drain runs.
  if (hasPendingNewChat) return { kind: 'noop' };
  // Wait for IDB hydration before deciding there's no chat to resume. The
  // synchronous localStorage seed in useChat is replaced wholesale once
  // `migrateConversationsToIndexedDB` resolves; running against the
  // pre-hydration map can find no workspace match and mint a throwaway chat —
  // the user sees a "new chat" flash before the real chat loads, and the
  // transient swap can flip `current_branch` and tear down the sandbox.
  if (!conversationsLoaded) return { kind: 'noop' };

  const activeConversation = conversations[activeChatId];
  if (
    activeConversation &&
    conversationBelongsToWorkspace(activeConversation, repoFullName, workspaceMode)
  ) {
    return { kind: 'noop' };
  }

  const matchingConversations = Object.values(conversations)
    .filter((conversation) =>
      conversationBelongsToWorkspace(conversation, repoFullName, workspaceMode),
    )
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  if (matchingConversations.length > 0) {
    return { kind: 'switch', chatId: matchingConversations[0].id };
  }

  return { kind: 'create' };
}

/**
 * Decides what DaemonChatBody's mount effect should do for a daemon-backed
 * (local-pc / relay) screen: keep the current chat, switch to an existing
 * one, or mint a new one. Sibling of `resolveWorkspaceChatAction` for the
 * daemon screens (which have no repo identity to scope by) — extracted as a
 * pure function for the same reason: the ordering/scoping logic is
 * unit-testable without mounting the whole screen.
 *
 * Relay sessions are individually addressable — Connected sessions / tap-to-
 * resume can target N distinct daemon sessions — so `mode` alone can't
 * find-or-create the right local chat: without `daemonSessionId` scoping,
 * every tap just re-confirmed whichever relay chat happened to already be
 * active (`activeChatId` persists across the remount a target switch causes;
 * 2026-07-03 report). Local-PC has no picker (always the one session), and an
 * untargeted relay screen (no `targetSessionId` yet) falls back to the same
 * most-recent-chat-of-this-mode behavior repo mode's fallback path uses.
 */
export type DaemonChatAction =
  | { kind: 'noop' }
  | { kind: 'switch'; chatId: string }
  | { kind: 'create'; daemonSessionId?: string };

export interface ResolveDaemonChatActionParams {
  conversations: Record<string, Conversation>;
  activeChatId: string;
  mode: Extract<WorkspaceMode, 'local-pc' | 'relay'>;
  targetSessionId: string | null;
  conversationsLoaded: boolean;
}

export function resolveDaemonChatAction({
  conversations,
  activeChatId,
  mode,
  targetSessionId,
  conversationsLoaded,
}: ResolveDaemonChatActionParams): DaemonChatAction {
  if (!conversationsLoaded) return { kind: 'noop' };

  const activeConversation = conversations[activeChatId];

  if (mode === 'relay' && targetSessionId) {
    if (
      activeConversation?.mode === mode &&
      activeConversation.daemonSessionId === targetSessionId
    ) {
      return { kind: 'noop' };
    }
    const scoped = Object.values(conversations)
      .filter((c) => c.mode === mode && c.daemonSessionId === targetSessionId)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    if (scoped.length > 0) return { kind: 'switch', chatId: scoped[0].id };
    return { kind: 'create', daemonSessionId: targetSessionId };
  }

  if (activeConversation?.mode === mode) return { kind: 'noop' };
  const modeChats = Object.values(conversations)
    .filter((c) => c.mode === mode)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  if (modeChats.length > 0) return { kind: 'switch', chatId: modeChats[0].id };
  return { kind: 'create' };
}

function buildEmptyConversation(
  id: string,
  repoFullName: string | null,
  branch: string | undefined,
  workspaceMode: WorkspaceMode | null,
  daemonSessionId?: string,
): Conversation {
  const now = Date.now();
  return {
    id,
    title: 'New Chat',
    messages: [],
    createdAt: now,
    lastMessageAt: now,
    repoFullName: repoFullName || undefined,
    branch: repoFullName ? branch : undefined,
    verificationPolicy: getDefaultVerificationPolicy(),
    mode: getWorkspaceScopedMode(repoFullName, workspaceMode),
    daemonSessionId,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatManagement({
  conversations,
  setConversations,
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
}: ChatManagementParams) {
  // Clear the todo list for a fresh-chat mint. `clear()` only schedules the
  // useTodo state update, but sendMessage can mint a chat and build the next
  // prompt in the same tick — chat-stream-round reads `todoRef.current.todos`
  // before any re-render refreshes the mirror — so the ref is also reset
  // synchronously (same pattern as chat-send-helpers' post-exec ref sync).
  const clearTodosForFreshChat = useCallback(() => {
    const handlers = todoRef.current;
    if (!handlers) return;
    handlers.clear();
    todoRef.current = { ...handlers, todos: [] };
  }, [todoRef]);

  const createNewChat = useCallback(
    (options?: { daemonSessionId?: string }): string => {
      const id = createId();
      const bi = branchInfoRef.current;
      const branch = bi?.currentBranch || bi?.defaultBranch || 'main';
      const newConv = buildEmptyConversation(
        id,
        activeRepoFullName,
        branch,
        workspaceModeRef.current,
        options?.daemonSessionId,
      );
      setConversations((prev) => {
        const updated = { ...prev, [id]: newConv };
        dirtyConversationIdsRef.current.add(id);
        return updated;
      });
      activeChatIdRef.current = id;
      setActiveChatId(id);
      saveActiveChatId(id);
      clearTodosForFreshChat();
      return id;
    },
    [
      activeRepoFullName,
      activeChatIdRef,
      branchInfoRef,
      clearTodosForFreshChat,
      dirtyConversationIdsRef,
      setActiveChatId,
      setConversations,
      workspaceModeRef,
    ],
  );

  const switchChat = useCallback(
    (id: string) => {
      if (id === activeChatId) return;
      if (isStreaming) {
        clearQueuedFollowUps(activeChatId);
        abortStream({ clearQueuedFollowUps: true });
      }
      activeChatIdRef.current = id;
      setActiveChatId(id);
      saveActiveChatId(id);
    },
    [
      activeChatId,
      activeChatIdRef,
      abortStream,
      clearQueuedFollowUps,
      isStreaming,
      setActiveChatId,
    ],
  );

  const renameChat = useCallback(
    (id: string, nextTitle: string) => {
      const trimmed = nextTitle.trim();
      if (!trimmed) return;

      setConversations((prev) => {
        const existing = prev[id];
        if (!existing || existing.title === trimmed) return prev;
        const updated = { ...prev, [id]: { ...existing, title: trimmed } };
        dirtyConversationIdsRef.current.add(id);
        return updated;
      });
    },
    [dirtyConversationIdsRef, setConversations],
  );

  /**
   * Library v2b — set the `linkedLibraryIds` array on a conversation.
   * Pass the full next-state array (not a delta); callers usually
   * splice via a quick map. Updates are persisted via the same
   * dirty-ref mechanism as rename — chat-stream-round reads the latest
   * via `conversationsRef` on every send, so the next assistant turn
   * picks up the change immediately.
   */
  const setChatLinkedLibraries = useCallback(
    (id: string, nextIds: readonly string[]) => {
      setConversations((prev) => {
        const existing = prev[id];
        if (!existing) return prev;
        // De-dup. Preserve user-add order in the persisted array (it
        // drives chip display order), but compare against the existing
        // state order-INSENSITIVELY so passing the same set of ids in
        // a different order doesn't churn React or hit IndexedDB.
        const deduped = Array.from(new Set(nextIds));
        const current = existing.linkedLibraryIds ?? [];
        if (deduped.length === current.length) {
          const currentSet = new Set(current);
          if (deduped.every((libId) => currentSet.has(libId))) {
            return prev;
          }
        }
        const updated = {
          ...prev,
          [id]: { ...existing, linkedLibraryIds: deduped.length > 0 ? deduped : undefined },
        };
        dirtyConversationIdsRef.current.add(id);
        return updated;
      });
    },
    [dirtyConversationIdsRef, setConversations],
  );

  const deleteChat = useCallback(
    (id: string) => {
      clearQueuedFollowUps(id);
      // Fresh-chat mint decision, computed outside the setConversations
      // updater so the updater stays pure (StrictMode double-invokes it).
      // Mirrors the `remaining` check inside the updater below.
      const hasRemainingWorkspaceChat = Object.values(conversations).some(
        (c) =>
          c.id !== id &&
          conversationBelongsToWorkspace(c, repoRef.current, workspaceModeRef.current),
      );
      if (id === activeChatId && !hasRemainingWorkspaceChat) {
        clearTodosForFreshChat();
      }
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
          const currentWorkspaceMode = workspaceModeRef.current;
          const remaining = Object.values(updated).filter((c) =>
            conversationBelongsToWorkspace(c, currentRepo, currentWorkspaceMode),
          );

          if (remaining.length > 0) {
            const mostRecent = remaining.sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
            setActiveChatId(mostRecent.id);
            saveActiveChatId(mostRecent.id);
          } else {
            const newId = createId();
            const branch = currentRepo
              ? branchInfoRef.current?.currentBranch ||
                branchInfoRef.current?.defaultBranch ||
                'main'
              : undefined;
            updated[newId] = buildEmptyConversation(
              newId,
              currentRepo,
              branch,
              currentWorkspaceMode,
            );
            setActiveChatId(newId);
            saveActiveChatId(newId);
          }
        }

        deletedConversationIdsRef.current.add(id);
        dirtyConversationIdsRef.current.delete(id);
        return updated;
      });
    },
    [
      activeChatId,
      branchInfoRef,
      clearQueuedFollowUps,
      clearTodosForFreshChat,
      conversations,
      deletedConversationIdsRef,
      dirtyConversationIdsRef,
      repoRef,
      setActiveChatId,
      setAgentEventsByChat,
      setConversations,
      workspaceModeRef,
    ],
  );

  const deleteAllChats = useCallback(() => {
    const currentRepo = repoRef.current;
    const currentWorkspaceMode = workspaceModeRef.current;
    const chatBranch = currentRepo
      ? branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || 'main'
      : undefined;
    const removedIds = Object.entries(conversations)
      .filter(([, conv]) => conversationBelongsToWorkspace(conv, currentRepo, currentWorkspaceMode))
      .map(([cid]) => cid);

    removedIds.forEach((removedId) => {
      clearQueuedFollowUps(removedId);
    });

    // deleteAllChats always mints a fresh chat below — reset the todo list
    // with it so the next effort starts clean.
    clearTodosForFreshChat();

    setConversations((prev) => {
      const kept: Record<string, Conversation> = {};
      for (const [cid, conv] of Object.entries(prev)) {
        if (!conversationBelongsToWorkspace(conv, currentRepo, currentWorkspaceMode)) {
          kept[cid] = conv;
        }
      }

      const id = createId();
      kept[id] = buildEmptyConversation(id, currentRepo, chatBranch, currentWorkspaceMode);

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
  }, [
    branchInfoRef,
    clearQueuedFollowUps,
    clearTodosForFreshChat,
    conversations,
    repoRef,
    setActiveChatId,
    setAgentEventsByChat,
    setConversations,
    workspaceModeRef,
  ]);

  return {
    createNewChat,
    switchChat,
    renameChat,
    setChatLinkedLibraries,
    deleteChat,
    deleteAllChats,
  };
}
