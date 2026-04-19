import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import {
  buildQueuedFollowUpsByChat,
  setConversationQueuedFollowUps,
} from '@/lib/chat-runtime-state';
import type { Conversation, QueuedFollowUp } from '@/types';
import {
  appendQueuedItem,
  clearQueuedItems,
  shiftQueuedItem,
  type QueuedItemsByChat,
} from './chat-queue';

export interface UseQueuedFollowUpsParams {
  initial: QueuedItemsByChat<QueuedFollowUp>;
  updateConversations: (
    updater:
      | Record<string, Conversation>
      | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
  ) => void;
  dirtyConversationIdsRef: React.MutableRefObject<Set<string>>;
  isMountedRef: React.MutableRefObject<boolean>;
}

export interface UseQueuedFollowUpsResult {
  queuedFollowUpsByChat: QueuedItemsByChat<QueuedFollowUp>;
  queuedFollowUpsRef: React.MutableRefObject<QueuedItemsByChat<QueuedFollowUp>>;
  enqueue: (chatId: string, followUp: QueuedFollowUp) => void;
  dequeue: (chatId: string) => QueuedFollowUp | null;
  clear: (chatId: string) => void;
  hydrate: (convs: Record<string, Conversation>) => void;
}

// Owns the per-chat queued-follow-ups state, its ref mirror, and the
// persist-on-mutate contract. `persist` and `replace` are deliberately
// kept private: every public mutator (enqueue/dequeue/clear) routes
// through `replace({ persist: true })`, and `hydrate` is the only
// sanctioned bulk-replacement path — it never persists, matching the
// semantics of the IndexedDB-migration hydration in useChat.
export function useQueuedFollowUps({
  initial,
  updateConversations,
  dirtyConversationIdsRef,
  isMountedRef,
}: UseQueuedFollowUpsParams): UseQueuedFollowUpsResult {
  const [queuedFollowUpsByChat, setQueuedFollowUpsByChat] =
    useState<QueuedItemsByChat<QueuedFollowUp>>(initial);

  // The ref is kept current inside `replace` (updated *before* setState),
  // so a render-time `ref.current = state` line would be redundant — and
  // would trigger react-hooks/refs. Every state mutation routes through
  // `replace`, so external callers that read the ref immediately after a
  // mutator still see the latest queue.
  const queuedFollowUpsRef = useRef<QueuedItemsByChat<QueuedFollowUp>>(initial);

  const persist = useCallback(
    (chatId: string, queuedFollowUps: QueuedFollowUp[]) => {
      updateConversations((prev) => {
        const conversation = prev[chatId];
        if (!conversation) return prev;
        dirtyConversationIdsRef.current.add(chatId);
        return {
          ...prev,
          [chatId]: setConversationQueuedFollowUps(conversation, queuedFollowUps),
        };
      });
    },
    [updateConversations, dirtyConversationIdsRef],
  );

  const replace = useCallback(
    (next: QueuedItemsByChat<QueuedFollowUp>, options?: { persist?: boolean }) => {
      const previous = queuedFollowUpsRef.current;
      queuedFollowUpsRef.current = next;
      if (isMountedRef.current) {
        setQueuedFollowUpsByChat(next);
      }
      if (!options?.persist) return;

      const changedChatIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
      changedChatIds.forEach((chatId) => {
        if (previous[chatId] === next[chatId]) return;
        persist(chatId, next[chatId] || []);
      });
    },
    [persist, isMountedRef],
  );

  const enqueue = useCallback(
    (chatId: string, followUp: QueuedFollowUp) => {
      replace(appendQueuedItem(queuedFollowUpsRef.current, chatId, followUp), {
        persist: true,
      });
    },
    [replace],
  );

  const dequeue = useCallback(
    (chatId: string): QueuedFollowUp | null => {
      const { next, item } = shiftQueuedItem(queuedFollowUpsRef.current, chatId);
      if (!item) return null;
      replace(next, { persist: true });
      return item;
    },
    [replace],
  );

  const clear = useCallback(
    (chatId: string) => {
      replace(clearQueuedItems(queuedFollowUpsRef.current, chatId), {
        persist: true,
      });
    },
    [replace],
  );

  const hydrate = useCallback(
    (convs: Record<string, Conversation>) => {
      replace(buildQueuedFollowUpsByChat(convs));
    },
    [replace],
  );

  return {
    queuedFollowUpsByChat,
    queuedFollowUpsRef,
    enqueue,
    dequeue,
    clear,
    hydrate,
  };
}
