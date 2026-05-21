/**
 * Client wrapper for `/api/library/*` (v2a). Plain `fetch` — the
 * global `installDeploymentAuthFetch` shim attaches the deployment
 * token header to /api/* requests automatically.
 */

import type { AttachmentData } from '@/types';
import { resolveApiUrl } from './api-url';
import type { Library, LibraryItem, LibraryItemMeta, LibraryMeta } from './chat-library-types';

export interface LibraryApiSuccess<T> {
  ok: true;
  data: T;
}
export interface LibraryApiFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
}
export type LibraryApiResult<T> = LibraryApiSuccess<T> | LibraryApiFailure;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function post<T>(
  path: string,
  body: unknown,
  extract: (json: JsonRecord) => T,
): Promise<LibraryApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : String(err),
      status: 0,
    };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response — surface a generic shape so callers don't crash.
  }

  const jsonRec = isRecord(json) ? json : null;
  if (!res.ok || !jsonRec || jsonRec.ok !== true) {
    return {
      ok: false,
      code: typeof jsonRec?.code === 'string' ? jsonRec.code : 'REQUEST_FAILED',
      message:
        typeof jsonRec?.message === 'string' ? jsonRec.message : `Request failed (${res.status})`,
      status: res.status,
    };
  }
  return { ok: true, data: extract(jsonRec) };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function collectionsList(): Promise<LibraryApiResult<LibraryMeta[]>> {
  return post('/api/library/collections/list', {}, (j) =>
    Array.isArray(j.collections) ? (j.collections as LibraryMeta[]) : [],
  );
}

export function collectionsCreate(
  name: string,
  instructions?: string,
): Promise<LibraryApiResult<{ collection: Library; meta: LibraryMeta }>> {
  return post('/api/library/collections/create', { name, instructions }, (j) => ({
    collection: j.collection as Library,
    meta: j.meta as LibraryMeta,
  }));
}

export interface CollectionDetail {
  collection: Library;
  /** When `includeContent` was false, items are metadata-only. */
  items: LibraryItemMeta[] | LibraryItem[];
}

export function collectionsGet(
  id: string,
  options?: { includeContent?: boolean },
): Promise<LibraryApiResult<CollectionDetail>> {
  return post(
    '/api/library/collections/get',
    { id, includeContent: options?.includeContent === true },
    (j) => ({
      collection: j.collection as Library,
      items: (j.items as LibraryItemMeta[] | LibraryItem[]) ?? [],
    }),
  );
}

export function collectionsUpdate(
  id: string,
  patch: { name?: string; instructions?: string | null },
): Promise<LibraryApiResult<{ collection: Library; meta: LibraryMeta }>> {
  return post('/api/library/collections/update', { id, ...patch }, (j) => ({
    collection: j.collection as Library,
    meta: j.meta as LibraryMeta,
  }));
}

export function collectionsDelete(id: string): Promise<LibraryApiResult<{ deletedItems: number }>> {
  return post('/api/library/collections/delete', { id }, (j) => ({
    deletedItems: typeof j.deletedItems === 'number' ? j.deletedItems : 0,
  }));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function itemsCreate(
  libraryId: string,
  attachment: AttachmentData,
  label?: string,
): Promise<LibraryApiResult<{ item: LibraryItem; meta: LibraryItemMeta; collection: Library }>> {
  return post('/api/library/items/create', { libraryId, attachment, label }, (j) => ({
    item: j.item as LibraryItem,
    meta: j.meta as LibraryItemMeta,
    collection: j.collection as Library,
  }));
}

export function itemsUpdate(
  libraryId: string,
  id: string,
  label: string | null,
): Promise<LibraryApiResult<{ item: LibraryItem; meta: LibraryItemMeta }>> {
  return post('/api/library/items/update', { libraryId, id, label }, (j) => ({
    item: j.item as LibraryItem,
    meta: j.meta as LibraryItemMeta,
  }));
}

export function itemsDelete(libraryId: string, id: string): Promise<LibraryApiResult<true>> {
  return post('/api/library/items/delete', { libraryId, id }, () => true);
}
