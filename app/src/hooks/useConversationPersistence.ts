import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import {
  saveConversation as saveConversationToDB,
  deleteConversation as deleteConversationFromDB,
} from '@/lib/conversation-store';
import type { Conversation } from '@/types';

export interface UseConversationPersistenceParams {
  conversationsLoaded: boolean;
  conversationsRef: React.MutableRefObject<Record<string, Conversation>>;
}

export interface UseConversationPersistenceResult {
  dirtyConversationIdsRef: React.MutableRefObject<Set<string>>;
  deletedConversationIdsRef: React.MutableRefObject<Set<string>>;
  flushDirty: () => Promise<void>;
}

const FLUSH_INTERVAL_MS = 3000;
const MAX_RETRIES = 3;

// Owns the dirty/deleted ID sets and the periodic + visibilitychange
// flush lifecycle. Failed saves/deletes get re-queued up to MAX_RETRIES;
// after that the change is dropped with a warn — better to drop a single
// stale update than starve every later edit behind an infinite retry.
export function useConversationPersistence({
  conversationsLoaded,
  conversationsRef,
}: UseConversationPersistenceParams): UseConversationPersistenceResult {
  const dirtyConversationIdsRef = useRef(new Set<string>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const saveRetryCountsRef = useRef<Map<string, number>>(new Map());

  const flushDirty = useCallback(async () => {
    if (!conversationsLoaded) return;
    const dirty = dirtyConversationIdsRef.current;
    const deleted = deletedConversationIdsRef.current;
    if (dirty.size === 0 && deleted.size === 0) return;

    const dirtyIds = [...dirty];
    const deletedIds = [...deleted];
    dirty.clear();
    deleted.clear();

    const currentConvs = conversationsRef.current;
    for (const id of dirtyIds) {
      const conv = currentConvs[id];
      if (!conv) continue;
      try {
        await saveConversationToDB(conv);
        saveRetryCountsRef.current.delete(id);
      } catch (err) {
        const count = saveRetryCountsRef.current.get(id) || 0;
        if (count < MAX_RETRIES) {
          saveRetryCountsRef.current.set(id, count + 1);
          dirty.add(id);
        } else {
          console.warn(
            `Failed to save conversation ${id} after ${MAX_RETRIES} retries. Dropping update.`,
            err,
          );
          saveRetryCountsRef.current.delete(id);
        }
      }
    }
    for (const id of deletedIds) {
      try {
        await deleteConversationFromDB(id);
        saveRetryCountsRef.current.delete(id);
      } catch (err) {
        const count = saveRetryCountsRef.current.get(id) || 0;
        if (count < MAX_RETRIES) {
          saveRetryCountsRef.current.set(id, count + 1);
          deleted.add(id);
        } else {
          console.warn(
            `Failed to delete conversation ${id} after ${MAX_RETRIES} retries. Dropping deletion.`,
            err,
          );
          saveRetryCountsRef.current.delete(id);
        }
      }
    }
  }, [conversationsLoaded, conversationsRef]);

  useEffect(() => {
    const interval = setInterval(flushDirty, FLUSH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [flushDirty]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushDirty();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [flushDirty]);

  return {
    dirtyConversationIdsRef,
    deletedConversationIdsRef,
    flushDirty,
  };
}
