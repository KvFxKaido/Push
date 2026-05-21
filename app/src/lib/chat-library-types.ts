/**
 * Chat library — user-managed bundles of attachments.
 *
 * v2a structure (this file): a two-tier model — `Library` collections
 * own `LibraryItem` files. A "library" in the UX (matching Le Chat's
 * naming) is one collection; an attached library stages every one of
 * its items into the chat composer as a normal attachment.
 *
 * Storage shape is forward-compatible with v2b's planned
 * `linkedLibraryIds: string[]` on chat metadata — libraries already
 * carry durable UUIDs, and items carry their owning `libraryId`.
 * Library `instructions` are stored here but in v2a they don't get
 * any special injection treatment; they only reach the model as a
 * normal attached text blob when a library is attached.
 *
 * KV layout (CHAT_LIBRARY binding):
 *   `lib:<library_id>`               → Library JSON       (metadata = LibraryMeta)
 *   `item:<library_id>:<item_id>`    → LibraryItem JSON   (metadata = LibraryItemMeta)
 *   `_meta:v1-migrated`              → "done" marker       (set after one-shot v1 migration)
 *
 * v1's legacy `library:<item_id>` keys are migrated into a Default
 * library on the first v2a touch and then deleted; see
 * `worker-chat-library.ts` for the migration body.
 */

import type { AttachmentData } from '@/types';

// ---------------------------------------------------------------------------
// Library (collection)
// ---------------------------------------------------------------------------

export interface Library {
  id: string;
  name: string;
  /**
   * Optional sticky text the user attaches to the library. In v2a this
   * is included as a normal text attachment when the library is
   * attached to a chat (so it reaches the model the same way as any
   * other file). v2b will lift this into per-turn injection.
   */
  instructions?: string;
  /**
   * Cached count of items in the library. Maintained on item
   * create/delete so `collections/list` can render the badge without
   * an N+1 scan. Re-derived during v1 migration and on cascade
   * delete; not relied on for correctness anywhere downstream.
   */
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * KV metadata stored alongside the Library record so `collections/list`
 * returns enough to render rows without a second read. Bounded so the
 * 1024-byte KV metadata cap can't be busted by a long `instructions`
 * field — only a `hasInstructions` flag goes here; the full text lives
 * in the value.
 */
export interface LibraryMeta {
  id: string;
  name: string;
  hasInstructions: boolean;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}

export function libraryMetaFromLibrary(library: Library): LibraryMeta {
  return {
    id: library.id,
    name: library.name,
    hasInstructions: typeof library.instructions === 'string' && library.instructions.length > 0,
    itemCount: library.itemCount,
    createdAt: library.createdAt,
    updatedAt: library.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// LibraryItem
// ---------------------------------------------------------------------------

export interface LibraryItem extends AttachmentData {
  /** Owning Library id (UUID). v2a items always belong to exactly one library. */
  libraryId: string;
  /** Optional user-set short label, e.g. "PZ Timeline v3.1". Filename is always shown alongside. */
  label?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryItemMeta {
  id: string;
  libraryId: string;
  filename: string;
  label?: string;
  type: AttachmentData['type'];
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export function libraryItemMetaFromItem(item: LibraryItem): LibraryItemMeta {
  return {
    id: item.id,
    libraryId: item.libraryId,
    filename: item.filename,
    label: item.label,
    type: item.type,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// KV key helpers
// ---------------------------------------------------------------------------

/** v2a prefix for Library collection records. */
export const LIBRARY_KV_PREFIX = 'lib:';

/** v2a prefix for LibraryItem records. Followed by `<library_id>:<item_id>`. */
export const LIBRARY_ITEM_KV_PREFIX = 'item:';

/** v1 (pre-v2a) item prefix. Read-only — used only by the one-shot migration. */
export const V1_LIBRARY_ITEM_KV_PREFIX = 'library:';

/** Marker key set after v1→v2a migration completes (or runs and finds nothing). */
export const V1_MIGRATION_MARKER_KEY = '_meta:v1-migrated';

export function libraryKvKey(libraryId: string): string {
  return `${LIBRARY_KV_PREFIX}${libraryId}`;
}

export function libraryItemKvKey(libraryId: string, itemId: string): string {
  return `${LIBRARY_ITEM_KV_PREFIX}${libraryId}:${itemId}`;
}

/** Prefix for `KV.list` to walk just the items inside one library. */
export function libraryItemsPrefix(libraryId: string): string {
  return `${LIBRARY_ITEM_KV_PREFIX}${libraryId}:`;
}
