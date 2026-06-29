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

function buildEmptyConversation(
  id: string,
  repoFullName: string | null,
  branch: string | undefined,
  workspaceMode: WorkspaceMode | null,
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
}: ChatManagementParams) {
  const createNewChat = useCallback((): string => {
    const id = createId();
    const bi = branchInfoRef.current;
    const branch = bi?.currentBranch || bi?.defaultBranch || 'main';
    const newConv = buildEmptyConversation(
      id,
      activeRepoFullName,
      branch,
      workspaceModeRef.current,
    );
    setConversations((prev) => {
      const updated = { ...prev, [id]: newConv };
      dirtyConversationIdsRef.current.add(id);
      return updated;
    });
    activeChatIdRef.current = id;
    setActiveChatId(id);
    saveActiveChatId(id);
    return id;
  }, [
    activeRepoFullName,
    activeChatIdRef,
    branchInfoRef,
    dirtyConversationIdsRef,
    setActiveChatId,
    setConversations,
    workspaceModeRef,
  ]);

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
