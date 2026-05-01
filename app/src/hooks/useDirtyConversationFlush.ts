import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { Conversation } from '@/types';
import {
  saveConversation as saveConversationToDB,
  deleteConversation as deleteConversationFromDB,
} from '@/lib/conversation-store';

export interface UseDirtyConversationFlushParams {
  conversationsLoaded: boolean;
  conversationsRef: React.MutableRefObject<Record<string, Conversation>>;
  dirtyConversationIdsRef: React.MutableRefObject<Set<string>>;
  deletedConversationIdsRef: React.MutableRefObject<Set<string>>;
}

export interface UseDirtyConversationFlushResult {
  /**
   * Drain the dirty + deleted ID sets to IndexedDB. Exposed so callers can
   * force a flush before navigation/teardown without waiting for the next
   * periodic tick. The hook drives this on a 3s interval and on
   * visibilitychange→hidden internally.
   */
  flushDirty: () => Promise<void>;
}

const FLUSH_INTERVAL_MS = 3000;
const MAX_RETRIES = 3;

/**
 * Owns the persist-on-tick contract for conversations marked dirty or
 * deleted by the rest of the chat hook tree. Inputs are the ref-shaped
 * dirty/deleted ID sets and the conversationsRef snapshot — every other
 * hook in this tree mutates those sets, and this hook is the only place
 * that drains them to IndexedDB.
 *
 * Failure handling: each ID gets up to `MAX_RETRIES` attempts before the
 * update is dropped. Failures re-add the ID to the *current* set (after
 * the snapshot), so a concurrent dirty-marking won't be lost.
 */
export function useDirtyConversationFlush({
  conversationsLoaded,
  conversationsRef,
  dirtyConversationIdsRef,
  deletedConversationIdsRef,
}: UseDirtyConversationFlushParams): UseDirtyConversationFlushResult {
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
  }, [conversationsLoaded, conversationsRef, dirtyConversationIdsRef, deletedConversationIdsRef]);

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

  return { flushDirty };
}
