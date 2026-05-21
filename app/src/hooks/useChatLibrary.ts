/**
 * React hook backing the chat library picker.
 *
 * v2a manages two tiers: a flat list of Library *collections* (the
 * top-level view in the picker) and a lazily-fetched *detail* for the
 * currently-opened library (item metadata only — content is fetched
 * separately during Attach Library so the panel never holds MB-sized
 * blobs in memory until they're needed).
 *
 * The hook is intentionally not a context — there's only one panel
 * consumer per app instance today.
 */

import { useCallback, useRef, useState } from 'react';
import type { AttachmentData } from '@/types';
import type { Library, LibraryItem, LibraryItemMeta, LibraryMeta } from '@/lib/chat-library-types';
import {
  collectionsCreate,
  collectionsDelete,
  collectionsGet,
  collectionsList,
  collectionsUpdate,
  itemsCreate,
  itemsDelete,
  itemsUpdate,
} from '@/lib/chat-library-client';

export interface CollectionDetailState {
  collection: Library;
  items: LibraryItemMeta[];
}

export interface UseChatLibraryResult {
  collections: LibraryMeta[];
  isLoading: boolean;
  hasFetched: boolean;
  error: string | null;
  refresh: () => Promise<void>;

  /** Detail state for the currently-opened library (metadata-only items). */
  openCollectionId: string | null;
  openCollection: CollectionDetailState | null;
  isDetailLoading: boolean;
  openCollectionRef: (id: string | null) => Promise<void>;

  createCollection: (name: string, instructions?: string) => Promise<Library | null>;
  renameCollection: (id: string, name: string) => Promise<boolean>;
  setInstructions: (id: string, instructions: string | null) => Promise<boolean>;
  deleteCollection: (id: string) => Promise<boolean>;

  saveItem: (
    libraryId: string,
    attachment: AttachmentData,
    label?: string,
  ) => Promise<LibraryItem | null>;
  renameItem: (libraryId: string, id: string, label: string | null) => Promise<boolean>;
  deleteItem: (libraryId: string, id: string) => Promise<boolean>;

  /**
   * Fetch the full LibraryItem array (with content) for an Attach
   * Library action. Kept separate from the metadata-only detail
   * state so memory and bandwidth aren't paid until the user
   * actually attaches.
   */
  fetchForAttach: (libraryId: string) => Promise<LibraryItem[]>;
}

export function useChatLibrary(): UseChatLibraryResult {
  const [collections, setCollections] = useState<LibraryMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshInflightRef = useRef(false);

  const [openCollectionId, setOpenCollectionId] = useState<string | null>(null);
  const [openCollection, setOpenCollection] = useState<CollectionDetailState | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  // -------------------------------------------------------------------------
  // Collection list
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (refreshInflightRef.current) return;
    refreshInflightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const res = await collectionsList();
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setCollections(res.data);
      setHasFetched(true);
    } finally {
      setIsLoading(false);
      refreshInflightRef.current = false;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Collection detail
  // -------------------------------------------------------------------------

  const openCollectionRef = useCallback(async (id: string | null) => {
    setOpenCollectionId(id);
    if (id === null) {
      setOpenCollection(null);
      return;
    }
    setIsDetailLoading(true);
    setError(null);
    try {
      const res = await collectionsGet(id);
      if (!res.ok) {
        setError(res.message);
        setOpenCollection(null);
        return;
      }
      // Server may return items with or without content depending on
      // includeContent; default call is metadata-only.
      const itemsMeta = (res.data.items as LibraryItemMeta[]).filter(
        (i): i is LibraryItemMeta => typeof (i as LibraryItemMeta).libraryId === 'string',
      );
      setOpenCollection({ collection: res.data.collection, items: itemsMeta });
    } finally {
      setIsDetailLoading(false);
    }
  }, []);

  const refreshOpenDetail = useCallback(async () => {
    if (!openCollectionId) return;
    const res = await collectionsGet(openCollectionId);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const itemsMeta = (res.data.items as LibraryItemMeta[]).filter(
      (i): i is LibraryItemMeta => typeof (i as LibraryItemMeta).libraryId === 'string',
    );
    setOpenCollection({ collection: res.data.collection, items: itemsMeta });
  }, [openCollectionId]);

  // -------------------------------------------------------------------------
  // Collection mutations
  // -------------------------------------------------------------------------

  const createCollection = useCallback(
    async (name: string, instructions?: string): Promise<Library | null> => {
      setError(null);
      const res = await collectionsCreate(name, instructions);
      if (!res.ok) {
        setError(res.message);
        return null;
      }
      setCollections((prev) => [res.data.meta, ...prev]);
      return res.data.collection;
    },
    [],
  );

  const renameCollection = useCallback(async (id: string, name: string): Promise<boolean> => {
    setError(null);
    const res = await collectionsUpdate(id, { name });
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    setCollections((prev) => prev.map((c) => (c.id === id ? res.data.meta : c)));
    setOpenCollection((prev) =>
      prev && prev.collection.id === id ? { ...prev, collection: res.data.collection } : prev,
    );
    return true;
  }, []);

  const setInstructions = useCallback(
    async (id: string, instructions: string | null): Promise<boolean> => {
      setError(null);
      const res = await collectionsUpdate(id, { instructions });
      if (!res.ok) {
        setError(res.message);
        return false;
      }
      setCollections((prev) => prev.map((c) => (c.id === id ? res.data.meta : c)));
      setOpenCollection((prev) =>
        prev && prev.collection.id === id ? { ...prev, collection: res.data.collection } : prev,
      );
      return true;
    },
    [],
  );

  const deleteCollection = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    // Optimistic remove from the list — capture the row inside the
    // setter so concurrent mutations can't roll back to a stale snapshot.
    let removed: LibraryMeta | undefined;
    setCollections((current) => {
      removed = current.find((c) => c.id === id);
      return current.filter((c) => c.id !== id);
    });
    const res = await collectionsDelete(id);
    if (!res.ok) {
      const restored = removed;
      if (restored) {
        setCollections((current) => {
          if (current.some((c) => c.id === id)) return current;
          const next = [...current, restored];
          next.sort((a, b) => b.updatedAt - a.updatedAt);
          return next;
        });
      }
      setError(res.message);
      return false;
    }
    // If we deleted the currently-open collection, clear detail state too.
    setOpenCollection((prev) => (prev && prev.collection.id === id ? null : prev));
    setOpenCollectionId((prev) => (prev === id ? null : prev));
    return true;
  }, []);

  // -------------------------------------------------------------------------
  // Item mutations
  // -------------------------------------------------------------------------

  const saveItem = useCallback(
    async (
      libraryId: string,
      attachment: AttachmentData,
      label?: string,
    ): Promise<LibraryItem | null> => {
      setError(null);
      const res = await itemsCreate(libraryId, attachment, label);
      if (!res.ok) {
        setError(res.message);
        return null;
      }
      // Reflect the updated collection meta in the list + detail.
      const updatedMeta: LibraryMeta = {
        id: res.data.collection.id,
        name: res.data.collection.name,
        hasInstructions:
          typeof res.data.collection.instructions === 'string' &&
          res.data.collection.instructions.length > 0,
        itemCount: res.data.collection.itemCount,
        createdAt: res.data.collection.createdAt,
        updatedAt: res.data.collection.updatedAt,
      };
      setCollections((prev) => prev.map((c) => (c.id === libraryId ? updatedMeta : c)));
      setOpenCollection((prev) =>
        prev && prev.collection.id === libraryId
          ? {
              collection: res.data.collection,
              items: [res.data.meta, ...prev.items],
            }
          : prev,
      );
      return res.data.item;
    },
    [],
  );

  const renameItem = useCallback(
    async (libraryId: string, id: string, label: string | null): Promise<boolean> => {
      setError(null);
      const res = await itemsUpdate(libraryId, id, label);
      if (!res.ok) {
        setError(res.message);
        return false;
      }
      setOpenCollection((prev) =>
        prev && prev.collection.id === libraryId
          ? {
              ...prev,
              items: prev.items.map((m) => (m.id === id ? res.data.meta : m)),
            }
          : prev,
      );
      return true;
    },
    [],
  );

  const deleteItem = useCallback(
    async (libraryId: string, id: string): Promise<boolean> => {
      setError(null);
      // Optimistic remove from the open detail; restore on failure.
      let removed: LibraryItemMeta | undefined;
      setOpenCollection((prev) => {
        if (!prev || prev.collection.id !== libraryId) return prev;
        removed = prev.items.find((m) => m.id === id);
        return {
          collection: {
            ...prev.collection,
            itemCount: Math.max(0, prev.collection.itemCount - 1),
          },
          items: prev.items.filter((m) => m.id !== id),
        };
      });
      const res = await itemsDelete(libraryId, id);
      if (!res.ok) {
        const restored = removed;
        if (restored) {
          setOpenCollection((prev) => {
            if (!prev || prev.collection.id !== libraryId) return prev;
            if (prev.items.some((m) => m.id === id)) return prev;
            return {
              collection: { ...prev.collection, itemCount: prev.collection.itemCount + 1 },
              items: [...prev.items, restored].sort((a, b) => b.createdAt - a.createdAt),
            };
          });
        }
        setError(res.message);
        return false;
      }
      // Mirror the decrement in the collection list. We do this after
      // success because the optimistic detail update is per-detail, not
      // per-list.
      await refreshOpenDetail();
      setCollections((prev) =>
        prev.map((c) =>
          c.id === libraryId
            ? { ...c, itemCount: Math.max(0, c.itemCount - 1), updatedAt: Date.now() }
            : c,
        ),
      );
      return true;
    },
    [refreshOpenDetail],
  );

  // -------------------------------------------------------------------------
  // Attach Library — full content fetch
  // -------------------------------------------------------------------------

  const fetchForAttach = useCallback(async (libraryId: string): Promise<LibraryItem[]> => {
    setError(null);
    const res = await collectionsGet(libraryId, { includeContent: true });
    if (!res.ok) {
      setError(res.message);
      return [];
    }
    // includeContent=true guarantees items carry `content`; cast to
    // LibraryItem[] without re-checking each row.
    return res.data.items as LibraryItem[];
  }, []);

  return {
    collections,
    isLoading,
    hasFetched,
    error,
    refresh,
    openCollectionId,
    openCollection,
    isDetailLoading,
    openCollectionRef,
    createCollection,
    renameCollection,
    setInstructions,
    deleteCollection,
    saveItem,
    renameItem,
    deleteItem,
    fetchForAttach,
  };
}
