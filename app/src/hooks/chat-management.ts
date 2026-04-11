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

  return !conversation.repoFullName;
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
    setActiveChatId(id);
    saveActiveChatId(id);
    return id;
  }, [
    activeRepoFullName,
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
      setActiveChatId(id);
      saveActiveChatId(id);
    },
    [activeChatId, abortStream, clearQueuedFollowUps, isStreaming, setActiveChatId],
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

  return { createNewChat, switchChat, renameChat, deleteChat, deleteAllChats };
}
