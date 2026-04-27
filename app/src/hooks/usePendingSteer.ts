import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import type { AttachmentData, QueuedFollowUpOptions } from '@/types';
import {
  appendQueuedItem,
  clearQueuedItems,
  shiftQueuedItem,
  type QueuedItemsByChat,
} from './chat-queue';

export interface PendingSteerRequest {
  text: string;
  attachments?: AttachmentData[];
  options?: QueuedFollowUpOptions;
  requestedAt: number;
}

export type PendingSteersByChat = QueuedItemsByChat<PendingSteerRequest>;

export interface UsePendingSteerParams {
  isMountedRef: React.MutableRefObject<boolean>;
}

export interface UsePendingSteerResult {
  pendingSteersByChat: PendingSteersByChat;
  pendingSteersByChatRef: React.MutableRefObject<PendingSteersByChat>;
  enqueuePendingSteer: (chatId: string, steer: PendingSteerRequest) => void;
  dequeuePendingSteer: (chatId: string) => PendingSteerRequest | null;
  clearPendingSteer: (chatId: string) => boolean;
}

// Per-chat FIFO queue of pending steer requests. Replaces the prior
// single-slot "latest wins" shape so two steers typed in quick
// succession both land at consecutive drain boundaries instead of
// silently dropping the first one. Drain semantics are head-only
// ("one-at-a-time"): each steer-drain boundary in `useChat.ts`
// dequeues exactly one entry and restarts the loop with it.
//
// `replacePendingSteers` is deliberately private: every public mutator
// routes through it, preserving the "ref updated before setState"
// contract so callbacks reading the ref immediately after a mutator
// see the latest queue.
export function usePendingSteer({ isMountedRef }: UsePendingSteerParams): UsePendingSteerResult {
  const [pendingSteersByChat, setPendingSteersByChat] = useState<PendingSteersByChat>({});
  const pendingSteersByChatRef = useRef<PendingSteersByChat>({});

  const replacePendingSteers = useCallback(
    (next: PendingSteersByChat) => {
      pendingSteersByChatRef.current = next;
      if (isMountedRef.current) {
        setPendingSteersByChat(next);
      }
    },
    [isMountedRef],
  );

  const enqueuePendingSteer = useCallback(
    (chatId: string, steer: PendingSteerRequest) => {
      replacePendingSteers(appendQueuedItem(pendingSteersByChatRef.current, chatId, steer));
    },
    [replacePendingSteers],
  );

  const dequeuePendingSteer = useCallback(
    (chatId: string): PendingSteerRequest | null => {
      const { next, item } = shiftQueuedItem(pendingSteersByChatRef.current, chatId);
      if (!item) return null;
      replacePendingSteers(next);
      return item;
    },
    [replacePendingSteers],
  );

  const clearPendingSteer = useCallback(
    (chatId: string): boolean => {
      const current = pendingSteersByChatRef.current[chatId];
      if (!current || current.length === 0) return false;
      replacePendingSteers(clearQueuedItems(pendingSteersByChatRef.current, chatId));
      return true;
    },
    [replacePendingSteers],
  );

  return {
    pendingSteersByChat,
    pendingSteersByChatRef,
    enqueuePendingSteer,
    dequeuePendingSteer,
    clearPendingSteer,
  };
}
