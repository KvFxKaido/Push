/**
 * Worker handlers for `/api/library/*` (v2a — user-managed bundles).
 *
 * Two resources:
 *   - Library (collection)  — `lib:<id>` keys
 *   - LibraryItem           — `item:<library_id>:<item_id>` keys
 *
 * Routes (all POST so payloads ride in JSON body):
 *   POST /api/library/collections/create   body: { name, instructions? }
 *   POST /api/library/collections/list     body: {}
 *   POST /api/library/collections/get      body: { id, includeContent?: boolean }
 *   POST /api/library/collections/update   body: { id, name?, instructions? }
 *   POST /api/library/collections/delete   body: { id }  (cascades to items)
 *   POST /api/library/items/create         body: { libraryId, attachment, label? }
 *   POST /api/library/items/update         body: { libraryId, id, label? }
 *   POST /api/library/items/delete         body: { libraryId, id }
 *
 * Every handler that touches data runs `migrateV1IfNeeded` first — a
 * one-shot lazy migration that scans the old `library:<item_id>` keys
 * (v1) into a "Default" collection. Idempotent via a marker key.
 *
 * Auth model — matches the rest of /api/* in this worker: no per-user
 * authn today. The deployment-token gate is applied upstream in
 * worker.ts.
 *
 * Fail-closed: when `env.CHAT_LIBRARY` isn't bound, every route returns
 * NOT_CONFIGURED 503.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { AttachmentData } from '@/types';
import {
  LIBRARY_KV_PREFIX,
  V1_LIBRARY_ITEM_KV_PREFIX,
  V1_MIGRATION_MARKER_KEY,
  libraryItemKvKey,
  libraryItemMetaFromItem,
  libraryItemsPrefix,
  libraryKvKey,
  libraryMetaFromLibrary,
  type Library,
  type LibraryItem,
  type LibraryItemMeta,
  type LibraryMeta,
} from '@/lib/chat-library-types';
import { readBodyText } from './worker-middleware';

interface LibraryEnv {
  CHAT_LIBRARY?: KVNamespace;
}

/** 2MB ceiling on a single item's `content` field. */
const MAX_LIBRARY_ITEM_CONTENT_BYTES = 2 * 1024 * 1024;

/** 3MB outer body cap enforced before JSON.parse. */
const MAX_LIBRARY_BODY_BYTES = 3 * 1024 * 1024;

/** 200-char ceiling on user-set labels (items) and library names. */
const MAX_LIBRARY_LABEL_CHARS = 200;

/** 2000-char ceiling on per-library `instructions`. */
const MAX_LIBRARY_INSTRUCTIONS_CHARS = 2000;

/**
 * Deterministic UUID for the "Default" library produced by the v1→v2a
 * migration. Using a fixed id (rather than `crypto.randomUUID()`) means
 * concurrent first requests after a v1 deploy converge on the same
 * record instead of each minting a separate Default — KV `put` of the
 * same key with the same shape is idempotent, and items written under
 * `item:<DEFAULT>:<old_id>` collide harmlessly. The chance of a
 * user-created library colliding with this UUID is zero (crypto random
 * bytes won't produce these exact bits).
 */
const DEFAULT_LIBRARY_ID = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

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

type ReadJsonResult = { ok: true; body: unknown } | { ok: false; response: Response };

async function readJsonBody(request: Request): Promise<ReadJsonResult> {
  const bodyResult = await readBodyText(request, MAX_LIBRARY_BODY_BYTES);
  if (!bodyResult.ok) {
    const code = bodyResult.status === 413 ? 'BODY_TOO_LARGE' : 'BAD_REQUEST';
    return {
      ok: false,
      response: jsonResponse({ ok: false, code, message: bodyResult.error }, bodyResult.status),
    };
  }
  try {
    return { ok: true, body: JSON.parse(bodyResult.text) };
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, code: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
        400,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Attachment parsing (shared by item routes)
// ---------------------------------------------------------------------------

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
// KV pagination helper
// ---------------------------------------------------------------------------

async function listAllKeys<TMeta = unknown>(
  kv: KVNamespace,
  prefix: string,
): Promise<Array<{ name: string; metadata: TMeta | undefined }>> {
  const out: Array<{ name: string; metadata: TMeta | undefined }> = [];
  let cursor: string | undefined;
  while (true) {
    const result = await kv.list<TMeta>({ prefix, cursor });
    for (const key of result.keys) {
      out.push({ name: key.name, metadata: key.metadata });
    }
    if (result.list_complete) break;
    cursor = result.cursor;
    if (!cursor) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One-shot v1 → v2a migration
// ---------------------------------------------------------------------------

/**
 * Walk the legacy `library:<item_id>` keys, fold them into a fresh
 * "Default" collection, and delete the originals. No-op after first
 * run (marker key). Cheap to call from every handler.
 */
async function migrateV1IfNeeded(kv: KVNamespace): Promise<void> {
  const marker = await kv.get(V1_MIGRATION_MARKER_KEY);
  if (marker === 'done') return;

  const v1Keys = await listAllKeys(kv, V1_LIBRARY_ITEM_KV_PREFIX);

  if (v1Keys.length === 0) {
    await kv.put(V1_MIGRATION_MARKER_KEY, 'done');
    return;
  }

  const defaultId = DEFAULT_LIBRARY_ID;
  const now = Date.now();

  // Upsert the Default library record BEFORE moving any items. If the
  // worker crashes mid-migration with items already moved, the next
  // run can still see them under `lib:DEFAULT` instead of leaving
  // orphan `item:DEFAULT:*` entries with no owning collection. Idempotent
  // — same key, deterministic shape, so concurrent racers converge.
  const existingDefault = await getLibrary(kv, defaultId);
  if (!existingDefault) {
    const seedLib: Library = {
      id: defaultId,
      name: 'Default',
      itemCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await putLibrary(kv, seedLib);
  }

  const validTypes = new Set<LibraryItem['type']>(['image', 'code', 'document']);

  for (const oldKey of v1Keys) {
    const oldValue = await kv.get(oldKey.name);
    if (!oldValue) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(oldValue);
    } catch {
      // Malformed JSON. Leave for the final sweep; we'll delete it
      // alongside other corrupted stragglers below.
      continue;
    }
    // Validate the v1 shape end-to-end before persisting as v2. A
    // missing/unexpected `type` would have produced an invalid
    // LibraryItem under the previous force-cast.
    if (
      !isRecord(parsed) ||
      typeof parsed.filename !== 'string' ||
      parsed.filename.length === 0 ||
      typeof parsed.content !== 'string' ||
      typeof parsed.type !== 'string' ||
      !validTypes.has(parsed.type as LibraryItem['type'])
    ) {
      continue;
    }
    const oldItemId = oldKey.name.slice(V1_LIBRARY_ITEM_KV_PREFIX.length);
    const itemId = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : oldItemId;
    const newItem: LibraryItem = {
      id: itemId,
      libraryId: defaultId,
      type: parsed.type as LibraryItem['type'],
      filename: parsed.filename,
      mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : 'application/octet-stream',
      sizeBytes: typeof parsed.sizeBytes === 'number' ? parsed.sizeBytes : 0,
      content: parsed.content,
      thumbnail: typeof parsed.thumbnail === 'string' ? parsed.thumbnail : undefined,
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : now,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
    };
    await kv.put(libraryItemKvKey(defaultId, itemId), JSON.stringify(newItem), {
      metadata: libraryItemMetaFromItem(newItem),
    });
    await kv.delete(oldKey.name);
  }

  // Final sweep: any v1 keys still present after the loop are malformed
  // (failed JSON parse or shape validation). Delete them so they don't
  // block the marker forever and force every future request to re-walk
  // them. These records were already corrupted — dropping them is the
  // least-bad option for a single-user store; preserving them would
  // require either an explicit quarantine prefix or admin intervention.
  const stragglers = await listAllKeys(kv, V1_LIBRARY_ITEM_KV_PREFIX);
  await Promise.all(stragglers.map((s) => kv.delete(s.name)));

  // Now reconcile the Default library record: itemCount derived from
  // actual storage (interleave-safe), createdAt inherited if a prior
  // run already wrote one.
  const actualItems = await listAllKeys(kv, libraryItemsPrefix(defaultId));
  const existingFinal = await getLibrary(kv, defaultId);
  const defaultLib: Library = {
    id: defaultId,
    name: existingFinal?.name ?? 'Default',
    itemCount: actualItems.length,
    createdAt: existingFinal?.createdAt ?? now,
    updatedAt: now,
  };
  await kv.put(libraryKvKey(defaultId), JSON.stringify(defaultLib), {
    metadata: libraryMetaFromLibrary(defaultLib),
  });
  await kv.put(V1_MIGRATION_MARKER_KEY, 'done');
}

// ---------------------------------------------------------------------------
// Library record helpers
// ---------------------------------------------------------------------------

async function getLibrary(kv: KVNamespace, id: string): Promise<Library | null> {
  const raw = await kv.get(libraryKvKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Library;
  } catch {
    return null;
  }
}

async function putLibrary(kv: KVNamespace, library: Library): Promise<void> {
  await kv.put(libraryKvKey(library.id), JSON.stringify(library), {
    metadata: libraryMetaFromLibrary(library),
  });
}

// ---------------------------------------------------------------------------
// /api/library/collections/create
// ---------------------------------------------------------------------------

export async function handleCollectionsCreate(
  request: Request,
  env: LibraryEnv,
): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_NAME', message: 'name is required.' }, 400);
  }
  // Cap applies to the trimmed name (what we actually persist) so a
  // user typing leading/trailing whitespace can't be falsely rejected.
  if (body.name.trim().length > MAX_LIBRARY_LABEL_CHARS) {
    return jsonResponse(
      {
        ok: false,
        code: 'NAME_TOO_LONG',
        message: `name exceeds ${MAX_LIBRARY_LABEL_CHARS} character ceiling.`,
      },
      400,
    );
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    return jsonResponse(
      {
        ok: false,
        code: 'INVALID_INSTRUCTIONS',
        message: 'instructions must be a string when provided.',
      },
      400,
    );
  }
  if (
    typeof body.instructions === 'string' &&
    body.instructions.length > MAX_LIBRARY_INSTRUCTIONS_CHARS
  ) {
    return jsonResponse(
      {
        ok: false,
        code: 'INSTRUCTIONS_TOO_LONG',
        message: `instructions exceed ${MAX_LIBRARY_INSTRUCTIONS_CHARS} character ceiling.`,
      },
      400,
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const library: Library = {
    id,
    name: body.name.trim(),
    instructions:
      typeof body.instructions === 'string' && body.instructions.length > 0
        ? body.instructions
        : undefined,
    itemCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await putLibrary(env.CHAT_LIBRARY, library);
  return jsonResponse({ ok: true, collection: library, meta: libraryMetaFromLibrary(library) });
}

// ---------------------------------------------------------------------------
// /api/library/collections/list
// ---------------------------------------------------------------------------

export async function handleCollectionsList(_request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const keys = await listAllKeys<LibraryMeta>(env.CHAT_LIBRARY, LIBRARY_KV_PREFIX);
  const collections: LibraryMeta[] = [];
  for (const key of keys) {
    if (key.metadata) collections.push(key.metadata);
  }
  // Most-recently-updated first — matches user expectation when
  // jumping back into the bundle they were last working with.
  collections.sort((a, b) => b.updatedAt - a.updatedAt);
  return jsonResponse({ ok: true, collections });
}

// ---------------------------------------------------------------------------
// /api/library/collections/get
// ---------------------------------------------------------------------------

export async function handleCollectionsGet(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }
  const includeContent = body.includeContent === true;

  const library = await getLibrary(env.CHAT_LIBRARY, body.id);
  if (!library) {
    return jsonResponse({ ok: false, code: 'NOT_FOUND', message: 'Library not found.' }, 404);
  }

  const keys = await listAllKeys<LibraryItemMeta>(env.CHAT_LIBRARY, libraryItemsPrefix(library.id));

  // Self-heal `itemCount` from actual storage. The cached count on the
  // Library record is maintained by item create/delete with non-atomic
  // read-modify-write, so concurrent mutations can drift it. Detail
  // open is the cheap moment to reconcile — we're already paying for
  // the prefix list here. Persist back so collections/list rows pick
  // up the corrected badge on next refresh.
  let collectionForResponse = library;
  if (library.itemCount !== keys.length) {
    const reconciled: Library = {
      ...library,
      itemCount: keys.length,
      updatedAt: Date.now(),
    };
    await putLibrary(env.CHAT_LIBRARY, reconciled);
    collectionForResponse = reconciled;
  }

  if (!includeContent) {
    const itemMetas: LibraryItemMeta[] = [];
    for (const key of keys) {
      if (key.metadata) itemMetas.push(key.metadata);
    }
    itemMetas.sort((a, b) => b.createdAt - a.createdAt);
    return jsonResponse({ ok: true, collection: collectionForResponse, items: itemMetas });
  }

  // Full content path — used by Attach Library. KV has no bulk-get,
  // but each `get` is an independent round-trip so Promise.all kills
  // the N×latency tax on libraries with many items.
  const kv = env.CHAT_LIBRARY;
  const fetched = await Promise.all(
    keys.map(async (key) => {
      const raw = await kv.get(key.name);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as LibraryItem;
      } catch {
        return null;
      }
    }),
  );
  const items: LibraryItem[] = fetched.filter((i): i is LibraryItem => i !== null);
  items.sort((a, b) => b.createdAt - a.createdAt);
  return jsonResponse({ ok: true, collection: collectionForResponse, items });
}

// ---------------------------------------------------------------------------
// /api/library/collections/update
// ---------------------------------------------------------------------------

export async function handleCollectionsUpdate(
  request: Request,
  env: LibraryEnv,
): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return jsonResponse(
        { ok: false, code: 'INVALID_NAME', message: 'name must be a non-empty string.' },
        400,
      );
    }
    if (body.name.trim().length > MAX_LIBRARY_LABEL_CHARS) {
      return jsonResponse(
        {
          ok: false,
          code: 'NAME_TOO_LONG',
          message: `name exceeds ${MAX_LIBRARY_LABEL_CHARS} character ceiling.`,
        },
        400,
      );
    }
  }
  if (
    body.instructions !== undefined &&
    body.instructions !== null &&
    typeof body.instructions !== 'string'
  ) {
    return jsonResponse(
      {
        ok: false,
        code: 'INVALID_INSTRUCTIONS',
        message: 'instructions must be a string, null (to clear), or omitted.',
      },
      400,
    );
  }
  if (
    typeof body.instructions === 'string' &&
    body.instructions.length > MAX_LIBRARY_INSTRUCTIONS_CHARS
  ) {
    return jsonResponse(
      {
        ok: false,
        code: 'INSTRUCTIONS_TOO_LONG',
        message: `instructions exceed ${MAX_LIBRARY_INSTRUCTIONS_CHARS} character ceiling.`,
      },
      400,
    );
  }

  const existing = await getLibrary(env.CHAT_LIBRARY, body.id);
  if (!existing) {
    return jsonResponse({ ok: false, code: 'NOT_FOUND', message: 'Library not found.' }, 404);
  }

  let nextInstructions: string | undefined = existing.instructions;
  if (body.instructions === null) {
    nextInstructions = undefined;
  } else if (typeof body.instructions === 'string') {
    const trimmed = body.instructions;
    nextInstructions = trimmed.length > 0 ? trimmed : undefined;
  }

  const updated: Library = {
    ...existing,
    name: typeof body.name === 'string' ? body.name.trim() : existing.name,
    instructions: nextInstructions,
    updatedAt: Date.now(),
  };
  await putLibrary(env.CHAT_LIBRARY, updated);
  return jsonResponse({ ok: true, collection: updated, meta: libraryMetaFromLibrary(updated) });
}

// ---------------------------------------------------------------------------
// /api/library/collections/delete  (cascades to items)
// ---------------------------------------------------------------------------

export async function handleCollectionsDelete(
  request: Request,
  env: LibraryEnv,
): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }

  const kv = env.CHAT_LIBRARY;

  // Cascade — walk every `item:<id>:*` and delete, then drop the
  // collection record itself. Order matters: if the collection record
  // disappears first and the cascade is interrupted, orphan items
  // can't be found via the namespaced list. Items first means partial
  // failure leaves the library findable for a retry.
  const itemKeys = await listAllKeys(kv, libraryItemsPrefix(body.id));
  await Promise.all(itemKeys.map((key) => kv.delete(key.name)));
  await kv.delete(libraryKvKey(body.id));
  return jsonResponse({ ok: true, deletedItems: itemKeys.length });
}

// ---------------------------------------------------------------------------
// /api/library/items/create
// ---------------------------------------------------------------------------

export async function handleItemsCreate(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.libraryId !== 'string' || body.libraryId.length === 0) {
    return jsonResponse(
      { ok: false, code: 'INVALID_LIBRARY_ID', message: 'libraryId is required.' },
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
  if (attachment.content.length > MAX_LIBRARY_ITEM_CONTENT_BYTES) {
    return jsonResponse(
      {
        ok: false,
        code: 'CONTENT_TOO_LARGE',
        message: `content exceeds ${MAX_LIBRARY_ITEM_CONTENT_BYTES} byte ceiling.`,
      },
      413,
    );
  }
  if (body.label !== undefined && typeof body.label !== 'string') {
    return jsonResponse(
      { ok: false, code: 'INVALID_LABEL', message: 'label must be a string when provided.' },
      400,
    );
  }
  if (typeof body.label === 'string' && body.label.trim().length > MAX_LIBRARY_LABEL_CHARS) {
    return jsonResponse(
      {
        ok: false,
        code: 'LABEL_TOO_LONG',
        message: `label exceeds ${MAX_LIBRARY_LABEL_CHARS} character ceiling.`,
      },
      400,
    );
  }

  const library = await getLibrary(env.CHAT_LIBRARY, body.libraryId);
  if (!library) {
    return jsonResponse(
      { ok: false, code: 'LIBRARY_NOT_FOUND', message: 'Owning library not found.' },
      404,
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const label = typeof body.label === 'string' ? body.label.trim() : undefined;
  const item: LibraryItem = {
    ...attachment,
    id,
    libraryId: library.id,
    label: label && label.length > 0 ? label : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await env.CHAT_LIBRARY.put(libraryItemKvKey(library.id, id), JSON.stringify(item), {
    metadata: libraryItemMetaFromItem(item),
  });

  // Bump itemCount + updatedAt on the owning library.
  const updatedLib: Library = {
    ...library,
    itemCount: library.itemCount + 1,
    updatedAt: now,
  };
  await putLibrary(env.CHAT_LIBRARY, updatedLib);

  return jsonResponse({
    ok: true,
    item,
    meta: libraryItemMetaFromItem(item),
    collection: updatedLib,
  });
}

// ---------------------------------------------------------------------------
// /api/library/items/update  (label rename only)
// ---------------------------------------------------------------------------

export async function handleItemsUpdate(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.libraryId !== 'string' || body.libraryId.length === 0) {
    return jsonResponse(
      { ok: false, code: 'INVALID_LIBRARY_ID', message: 'libraryId is required.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }
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
  if (typeof body.label === 'string' && body.label.trim().length > MAX_LIBRARY_LABEL_CHARS) {
    return jsonResponse(
      {
        ok: false,
        code: 'LABEL_TOO_LONG',
        message: `label exceeds ${MAX_LIBRARY_LABEL_CHARS} character ceiling.`,
      },
      400,
    );
  }

  const key = libraryItemKvKey(body.libraryId, body.id);
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

  const now = Date.now();
  const item: LibraryItem = {
    ...existing,
    label: nextLabel,
    updatedAt: now,
  };
  await env.CHAT_LIBRARY.put(key, JSON.stringify(item), {
    metadata: libraryItemMetaFromItem(item),
  });

  // Bump the owning library's updatedAt so item renames reorder the
  // collections list. Without this the library would be sorted by
  // its last create/delete only — surprising for "recently touched".
  const library = await getLibrary(env.CHAT_LIBRARY, body.libraryId);
  if (library) {
    await putLibrary(env.CHAT_LIBRARY, { ...library, updatedAt: now });
  }

  return jsonResponse({ ok: true, item, meta: libraryItemMetaFromItem(item) });
}

// ---------------------------------------------------------------------------
// /api/library/items/delete
// ---------------------------------------------------------------------------

export async function handleItemsDelete(request: Request, env: LibraryEnv): Promise<Response> {
  if (!env.CHAT_LIBRARY) return notConfiguredResponse();
  await migrateV1IfNeeded(env.CHAT_LIBRARY);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  if (typeof body.libraryId !== 'string' || body.libraryId.length === 0) {
    return jsonResponse(
      { ok: false, code: 'INVALID_LIBRARY_ID', message: 'libraryId is required.' },
      400,
    );
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }

  const key = libraryItemKvKey(body.libraryId, body.id);
  const existed = await env.CHAT_LIBRARY.get(key);
  await env.CHAT_LIBRARY.delete(key);

  // Decrement itemCount only if the item actually existed. This makes
  // the *sequential* double-delete case idempotent (second call sees
  // nothing, skips the decrement) but does NOT protect against
  // genuinely concurrent deletes of the same id — two callers can
  // both observe `existed` before either KV.delete returns and both
  // decrement. itemCount is best-effort under concurrent mutations;
  // `collections/get` reconciles from the actual item list on next
  // detail open, so the drift is bounded and self-healing.
  if (existed) {
    const library = await getLibrary(env.CHAT_LIBRARY, body.libraryId);
    if (library) {
      const next: Library = {
        ...library,
        itemCount: Math.max(0, library.itemCount - 1),
        updatedAt: Date.now(),
      };
      await putLibrary(env.CHAT_LIBRARY, next);
    }
  }

  return jsonResponse({ ok: true });
}
