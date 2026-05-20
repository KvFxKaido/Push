/**
 * React hook backing the chat library picker. Owns the in-memory list
 * cache, list/fetch/update/delete actions, and loading + error state.
 *
 * The hook is intentionally not a context — there's only one panel
 * consumer per app instance today, so a hook-scoped cache is enough.
 * If a "save current attachment to library" affordance is added to
 * the staged-attachment chip later, lift the cache into a provider then.
 */

import { useCallback, useRef, useState } from 'react';
import type { AttachmentData } from '@/types';
import type { LibraryItem, LibraryItemMeta } from '@/lib/chat-library-types';
import {
  libraryCreate,
  libraryDelete,
  libraryGet,
  libraryList,
  libraryUpdate,
} from '@/lib/chat-library-client';

export interface UseChatLibraryResult {
  items: LibraryItemMeta[];
  isLoading: boolean;
  error: string | null;
  /** Tracks whether at least one successful list call has happened. Callers
   *  can use this to fetch lazily from an event handler — e.g. when the
   *  picker popover opens — without forcing the fetch through an effect. */
  hasFetched: boolean;
  /** Fetch (or refetch) the list. Safe to call from event handlers. */
  refresh: () => Promise<void>;
  /** Persist an already-processed attachment to the library. */
  save: (attachment: AttachmentData, label?: string) => Promise<LibraryItem | null>;
  /** Fetch the full content for an item (used when attaching to a chat). */
  fetchOne: (id: string) => Promise<LibraryItem | null>;
  /** Rename (or clear) the label on an item. */
  rename: (id: string, label: string | null) => Promise<boolean>;
  /** Hard-delete an item. Optimistically removes from the list. */
  remove: (id: string) => Promise<boolean>;
}

export function useChatLibrary(): UseChatLibraryResult {
  const [items, setItems] = useState<LibraryItemMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const inflightRef = useRef(false);

  const refresh = useCallback(async () => {
    // Coalesce concurrent refreshes (e.g. popover opened twice rapidly).
    if (inflightRef.current) return;
    inflightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const res = await libraryList();
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setItems(res.data);
      setHasFetched(true);
    } finally {
      setIsLoading(false);
      inflightRef.current = false;
    }
  }, []);

  const save = useCallback(
    async (attachment: AttachmentData, label?: string): Promise<LibraryItem | null> => {
      setError(null);
      const res = await libraryCreate(attachment, label);
      if (!res.ok) {
        setError(res.message);
        return null;
      }
      // Prepend — list is sorted most-recent-first server-side.
      setItems((prev) => [res.data.meta, ...prev]);
      return res.data.item;
    },
    [],
  );

  const fetchOne = useCallback(async (id: string): Promise<LibraryItem | null> => {
    setError(null);
    const res = await libraryGet(id);
    if (!res.ok) {
      setError(res.message);
      return null;
    }
    return res.data;
  }, []);

  const rename = useCallback(async (id: string, label: string | null): Promise<boolean> => {
    setError(null);
    const res = await libraryUpdate(id, label);
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    setItems((prev) => prev.map((m) => (m.id === id ? res.data.meta : m)));
    return true;
  }, []);

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setError(null);
      const prev = items;
      // Optimistic remove — restore on failure.
      setItems((current) => current.filter((m) => m.id !== id));
      const res = await libraryDelete(id);
      if (!res.ok) {
        setItems(prev);
        setError(res.message);
        return false;
      }
      return true;
    },
    [items],
  );

  return { items, isLoading, error, hasFetched, refresh, save, fetchOne, rename, remove };
}
