/**
 * Chat library — persistent user-scoped file store.
 *
 * v1 stores already-processed attachments (the same shape produced by
 * `file-processing.ts` and consumed by `chat-prepare-send.ts`) so the
 * server is a pure passthrough — no resize, no truncate. Auth-scoping is
 * deferred (matches the rest of /api/*, see worker-artifacts.ts header)
 * so KV keys are flat `library:<id>` today; when per-user identity lands
 * the key can take a user namespace additively.
 */

import type { AttachmentData } from '@/types';

export interface LibraryItem extends AttachmentData {
  /** Optional user-set short label, e.g. "PZ Timeline v3.1". Filename is always shown alongside. */
  label?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * KV metadata index — what list() returns without fetching the (potentially
 * large) base64 content. Stored as the `metadata` argument on KV.put.
 */
export interface LibraryItemMeta {
  id: string;
  filename: string;
  label?: string;
  type: AttachmentData['type'];
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export function metaFromItem(item: LibraryItem): LibraryItemMeta {
  return {
    id: item.id,
    filename: item.filename,
    label: item.label,
    type: item.type,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export const LIBRARY_KV_PREFIX = 'library:';

export function libraryKvKey(id: string): string {
  return `${LIBRARY_KV_PREFIX}${id}`;
}
