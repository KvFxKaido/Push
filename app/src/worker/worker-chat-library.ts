/**
 * Worker handlers for `/api/library/*`.
 *
 * Persists chat-mode attachments to the `CHAT_LIBRARY` KV namespace so a
 * file uploaded once can be re-attached to any future chat without
 * re-uploading. Storage is a thin passthrough — the client posts the
 * already-processed `AttachmentData` blob (image base64 or text content
 * already resized/truncated by `file-processing.ts`) and the server
 * just persists.
 *
 * Routes (all POST so payloads ride in JSON body):
 *   POST /api/library/create   body: { attachment, label? }
 *   POST /api/library/list     body: {}
 *   POST /api/library/get      body: { id }
 *   POST /api/library/update   body: { id, label? }
 *   POST /api/library/delete   body: { id }
 *
 * Auth model — matches the rest of /api/* in this worker: no per-user
 * authn today. The deployment-token gate is applied upstream in
 * worker.ts. When per-user auth lands the KV key can take a user-id
 * namespace additively (the LibraryItem shape doesn't change).
 *
 * Fail-closed: when `env.CHAT_LIBRARY` isn't bound, every route returns
 * NOT_CONFIGURED 503 — same shape as `/api/artifacts/*` and
 * `/api/sandbox-cf/*` use when their bindings are missing.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { AttachmentData } from '@/types';
import {
  libraryKvKey,
  LIBRARY_KV_PREFIX,
  metaFromItem,
  type LibraryItem,
  type LibraryItemMeta,
} from '@/lib/chat-library-types';

interface LibraryEnv {
  CHAT_LIBRARY?: KVNamespace;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notConfiguredResponse(): Response {
  return jsonResponse(
    {
      ok: false,
      code: 'NOT_CONFIGURED',
      message:
        'CHAT_LIBRARY KV binding is not configured. Run `wrangler kv:namespace create CHAT_LIBRARY` and add the returned id to wrangler.jsonc.',
    },
    503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseAttachment(raw: unknown): AttachmentData | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.filename !== 'string' || raw.filename.length === 0) return null;
  if (raw.type !== 'image' && raw.type !== 'code' && raw.type !== 'document') return null;
  if (typeof raw.mimeType !== 'string') return null;
  if (typeof raw.sizeBytes !== 'number' || !Number.isFinite(raw.sizeBytes) || raw.sizeBytes < 0) {
    return null;
  }
  if (typeof raw.content !== 'string') return null;
  if (raw.thumbnail !== undefined && typeof raw.thumbnail !== 'string') return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    type: raw.type,
    filename: raw.filename,
    mimeType: raw.mimeType,
    sizeBytes: raw.sizeBytes,
    content: raw.content,
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined,
  };
}

// ---------------------------------------------------------------------------
// /api/library/create
// ---------------------------------------------------------------------------

export async function handleLibraryCreate(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }

  const attachment = parseAttachment(body.attachment);
  if (!attachment) {
    return jsonResponse(
      {
        ok: false,
        code: 'INVALID_ATTACHMENT',
        message:
          'attachment must be { type: "image"|"code"|"document", filename, mimeType, sizeBytes, content }.',
      },
      400,
    );
  }

  if (body.label !== undefined && typeof body.label !== 'string') {
    return jsonResponse(
      { ok: false, code: 'INVALID_LABEL', message: 'label must be a string when provided.' },
      400,
    );
  }
  const label = typeof body.label === 'string' ? body.label.trim() : undefined;

  const id = crypto.randomUUID();
  const now = Date.now();
  const item: LibraryItem = {
    ...attachment,
    id,
    label: label || undefined,
    createdAt: now,
    updatedAt: now,
  };

  await env.CHAT_LIBRARY.put(libraryKvKey(id), JSON.stringify(item), {
    metadata: metaFromItem(item),
  });

  return jsonResponse({ ok: true, item, meta: metaFromItem(item) });
}

// ---------------------------------------------------------------------------
// /api/library/list
// ---------------------------------------------------------------------------

export async function handleLibraryList(_request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();

  // KV.list returns up to 1000 keys per call; for a single-operator
  // library this is well within the cap. If a multi-user model ever
  // lands we'll need to paginate per user.
  const result = await env.CHAT_LIBRARY.list<LibraryItemMeta>({ prefix: LIBRARY_KV_PREFIX });
  const items: LibraryItemMeta[] = [];
  for (const key of result.keys) {
    if (key.metadata) items.push(key.metadata);
  }
  // Most-recently-created first — matches user expectation when picking
  // from a growing list.
  items.sort((a, b) => b.createdAt - a.createdAt);
  return jsonResponse({ ok: true, items });
}

// ---------------------------------------------------------------------------
// /api/library/get
// ---------------------------------------------------------------------------

export async function handleLibraryGet(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }

  const raw = await env.CHAT_LIBRARY.get(libraryKvKey(body.id));
  if (!raw) {
    return jsonResponse({ ok: false, code: 'NOT_FOUND', message: 'Library item not found.' }, 404);
  }
  try {
    const item = JSON.parse(raw) as LibraryItem;
    return jsonResponse({ ok: true, item });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { ok: false, code: 'CORRUPT_RECORD', message: `Failed to parse stored item: ${message}` },
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// /api/library/update
// ---------------------------------------------------------------------------

export async function handleLibraryUpdate(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }
  // v1 only allows label edits. Filename and content are immutable —
  // delete and re-upload to "replace" a file.
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') {
    return jsonResponse(
      {
        ok: false,
        code: 'INVALID_LABEL',
        message: 'label must be a string, null (to clear), or omitted.',
      },
      400,
    );
  }

  const key = libraryKvKey(body.id);
  const raw = await env.CHAT_LIBRARY.get(key);
  if (!raw) {
    return jsonResponse({ ok: false, code: 'NOT_FOUND', message: 'Library item not found.' }, 404);
  }
  let existing: LibraryItem;
  try {
    existing = JSON.parse(raw) as LibraryItem;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { ok: false, code: 'CORRUPT_RECORD', message: `Failed to parse stored item: ${message}` },
      500,
    );
  }

  let nextLabel: string | undefined = existing.label;
  if (body.label === null) {
    nextLabel = undefined;
  } else if (typeof body.label === 'string') {
    const trimmed = body.label.trim();
    nextLabel = trimmed.length > 0 ? trimmed : undefined;
  }

  const item: LibraryItem = {
    ...existing,
    label: nextLabel,
    updatedAt: Date.now(),
  };
  await env.CHAT_LIBRARY.put(key, JSON.stringify(item), {
    metadata: metaFromItem(item),
  });
  return jsonResponse({ ok: true, item, meta: metaFromItem(item) });
}

// ---------------------------------------------------------------------------
// /api/library/delete
// ---------------------------------------------------------------------------

export async function handleLibraryDelete(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }

  await env.CHAT_LIBRARY.delete(libraryKvKey(body.id));
  return jsonResponse({ ok: true });
}
