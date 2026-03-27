/**
 * chat-management.ts
 *
 * Extracted from useChat.ts — CRUD operations on conversations.
 * createNewChat, switchChat, renameChat, deleteChat, deleteAllChats.
 */

import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentStatusEvent, Conversation } from '@/types';
import { createId, saveActiveChatId } from '@/hooks/chat-persistence';
import { replaceAllConversations as replaceAllConversationsInDB } from '@/lib/conversation-store';

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
}: ChatManagementParams) {
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
  }, [activeRepoFullName, branchInfoRef, dirtyConversationIdsRef, setActiveChatId, setConversations]);

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
              branch: currentRepo
                ? branchInfoRef.current?.currentBranch ||
                  branchInfoRef.current?.defaultBranch ||
                  'main'
                : undefined,
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
    ],
  );

  const deleteAllChats = useCallback(() => {
    const currentRepo = repoRef.current;
    const chatBranch = currentRepo
      ? branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || 'main'
      : undefined;
    const removedIds = Object.entries(conversations)
      .filter(([, conv]) => (
        currentRepo
          ? conv.repoFullName === currentRepo
          : !conv.repoFullName
      ))
      .map(([cid]) => cid);

    removedIds.forEach((removedId) => {
      clearQueuedFollowUps(removedId);
    });

    setConversations((prev) => {
      const kept: Record<string, Conversation> = {};
      for (const [cid, conv] of Object.entries(prev)) {
        const belongsToCurrentRepo = currentRepo
          ? conv.repoFullName === currentRepo
          : !conv.repoFullName;
        if (!belongsToCurrentRepo) {
          kept[cid] = conv;
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
  }, [branchInfoRef, clearQueuedFollowUps, conversations, repoRef, setActiveChatId, setAgentEventsByChat, setConversations]);

  return { createNewChat, switchChat, renameChat, deleteChat, deleteAllChats };
}
