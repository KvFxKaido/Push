/**
 * Client wrapper for `/api/library/*`. Plain `fetch` — the global
 * `installDeploymentAuthFetch` shim (see `deployment-auth.ts`) attaches
 * the deployment token header to /api/* requests automatically.
 */

import type { AttachmentData } from '@/types';
import { resolveApiUrl } from './api-url';
import type { LibraryItem, LibraryItemMeta } from './chat-library-types';

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

export function libraryList(): Promise<LibraryApiResult<LibraryItemMeta[]>> {
  return post('/api/library/list', {}, (j) =>
    Array.isArray(j.items) ? (j.items as LibraryItemMeta[]) : [],
  );
}

export function libraryCreate(
  attachment: AttachmentData,
  label?: string,
): Promise<LibraryApiResult<{ item: LibraryItem; meta: LibraryItemMeta }>> {
  return post('/api/library/create', { attachment, label }, (j) => ({
    item: j.item as LibraryItem,
    meta: j.meta as LibraryItemMeta,
  }));
}

export function libraryGet(id: string): Promise<LibraryApiResult<LibraryItem>> {
  return post('/api/library/get', { id }, (j) => j.item as LibraryItem);
}

export function libraryUpdate(
  id: string,
  label: string | null,
): Promise<LibraryApiResult<{ item: LibraryItem; meta: LibraryItemMeta }>> {
  return post('/api/library/update', { id, label }, (j) => ({
    item: j.item as LibraryItem,
    meta: j.meta as LibraryItemMeta,
  }));
}

export function libraryDelete(id: string): Promise<LibraryApiResult<true>> {
  return post('/api/library/delete', { id }, () => true);
}
