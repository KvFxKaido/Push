import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import type { AttachmentData, QueuedFollowUpOptions } from '@/types';

export interface PendingSteerRequest {
  text: string;
  attachments?: AttachmentData[];
  options?: QueuedFollowUpOptions;
  requestedAt: number;
}

export type PendingSteersByChat = Record<string, PendingSteerRequest>;

export interface UsePendingSteerParams {
  isMountedRef: React.MutableRefObject<boolean>;
}

export interface UsePendingSteerResult {
  pendingSteersByChat: PendingSteersByChat;
  pendingSteersByChatRef: React.MutableRefObject<PendingSteersByChat>;
  setPendingSteer: (chatId: string, steer: PendingSteerRequest) => void;
  consumePendingSteer: (chatId: string) => PendingSteerRequest | null;
  clearPendingSteer: (chatId: string) => boolean;
}

// Single-slot per-chat pending-steer state. Unlike the FIFO shape of
// useQueuedFollowUps, this is Record<string, PendingSteerRequest> --
// one steer per chat, "latest wins" on set, and consume *deletes* the
// slot rather than shifting. The cardinality difference is why these
// two per-chat maps stay in separate hooks despite their superficially
// similar shape (audit Open Question #2 resolved in Phase 4).
//
// `replacePendingSteers` is deliberately private: every public mutator
// routes through it, preserving the "ref updated before setState" contract
// that Phases 1-3 also protect by not exposing their internal replacers.
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

  const setPendingSteer = useCallback(
    (chatId: string, steer: PendingSteerRequest) => {
      replacePendingSteers({
        ...pendingSteersByChatRef.current,
        [chatId]: steer,
      });
    },
    [replacePendingSteers],
  );

  const consumePendingSteer = useCallback(
    (chatId: string): PendingSteerRequest | null => {
      const current = pendingSteersByChatRef.current[chatId];
      if (!current) return null;
      const next = { ...pendingSteersByChatRef.current };
      delete next[chatId];
      replacePendingSteers(next);
      return current;
    },
    [replacePendingSteers],
  );

  const clearPendingSteer = useCallback(
    (chatId: string): boolean => {
      if (!pendingSteersByChatRef.current[chatId]) return false;
      const next = { ...pendingSteersByChatRef.current };
      delete next[chatId];
      replacePendingSteers(next);
      return true;
    },
    [replacePendingSteers],
  );

  return {
    pendingSteersByChat,
    pendingSteersByChatRef,
    setPendingSteer,
    consumePendingSteer,
    clearPendingSteer,
  };
}
