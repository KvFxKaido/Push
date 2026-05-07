/**
 * Worker handlers for `/api/artifacts/*`.
 *
 * Persists model-emitted artifacts to the `ARTIFACTS` KV namespace.
 * Routes:
 *   POST /api/artifacts/create  body: { args, scope, author? }
 *   POST /api/artifacts/list    body: { scope, kind?, limit? }
 *   POST /api/artifacts/get     body: { scope, id }
 *   POST /api/artifacts/delete  body: { scope, id }
 *
 * `args` is the model-supplied `CreateArtifactArgs` shape; the handler
 * runs `validateCreateArtifactArgs` and returns a structured 400 with
 * the same code/field/message envelope the CLI uses on validation
 * failures so the model can recover with a fixed payload.
 *
 * Auth model — matches the rest of /api/* in this worker: no per-user
 * authn today (Push doesn't have multi-user auth in production yet).
 * Origin/CORS is enforced upstream in `worker.ts`. When per-user auth
 * lands, scope-key inclusion of a user-id namespace is the path
 * forward — `ArtifactScope` is already structured to admit it
 * additively.
 *
 * Fail-closed: when `env.ARTIFACTS` isn't bound (operator hasn't
 * created the KV namespace yet), every route returns NOT_CONFIGURED
 * 503 — same shape as the `/api/sandbox-cf/*` paths use today when
 * `SANDBOX_TOKENS` is missing.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import {
  buildArtifactRecord,
  summarizeArtifact,
  validateCreateArtifactArgs,
} from '@push/lib/artifacts/handler';
import type { ArtifactAuthor, ArtifactRecord, ArtifactScope } from '@push/lib/artifacts/types';
import { isArtifactKind } from '@push/lib/artifacts/types';
import type { AgentRole } from '@push/lib/runtime-contract';
import type { ListArtifactsQuery } from '@push/lib/artifacts/store';

import { InvalidArtifactIdError, WebKvArtifactStore } from './artifact-store-kv';

interface ArtifactsEnv {
  ARTIFACTS?: KVNamespace;
}

const KNOWN_AGENT_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'orchestrator',
  'explorer',
  'coder',
  'reviewer',
  'auditor',
]);

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
        'ARTIFACTS KV binding is not configured. Run `wrangler kv:namespace create ARTIFACTS` and add the returned id to wrangler.jsonc.',
    },
    503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScope(raw: unknown): ArtifactScope | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.repoFullName !== 'string' || raw.repoFullName.length === 0) return null;
  // `branch` is required as the discriminator between "in a repo" and
  // "outside a repo" — null is valid (mirrors WorkspaceIdentity), but
  // omitted/non-string is not.
  if (raw.branch !== null && typeof raw.branch !== 'string') return null;
  if (raw.chatId !== undefined && raw.chatId !== null && typeof raw.chatId !== 'string') {
    return null;
  }
  return {
    repoFullName: raw.repoFullName,
    branch: typeof raw.branch === 'string' ? raw.branch : null,
    chatId: typeof raw.chatId === 'string' ? raw.chatId : undefined,
  };
}

function parseAuthor(raw: unknown): ArtifactAuthor | null {
  if (!isRecord(raw)) return null;
  if (raw.surface !== 'web' && raw.surface !== 'cli') return null;
  if (typeof raw.role !== 'string' || !KNOWN_AGENT_ROLES.has(raw.role as AgentRole)) {
    return null;
  }
  if (typeof raw.createdAt !== 'number') return null;
  return {
    surface: raw.surface,
    role: raw.role as AgentRole,
    messageId: typeof raw.messageId === 'string' ? raw.messageId : undefined,
    runId: typeof raw.runId === 'string' ? raw.runId : undefined,
    createdAt: raw.createdAt,
  };
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// /api/artifacts/create
// ---------------------------------------------------------------------------

export async function handleArtifactsCreate(
  request: Request,
  env: ArtifactsEnv,
): Promise<Response> {
  if (!env.ARTIFACTS) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return jsonResponse(
      {
        ok: false,
        code: 'INVALID_SCOPE',
        message: 'scope must be { repoFullName: string, branch: string|null, chatId?: string }.',
      },
      400,
    );
  }

  const validation = validateCreateArtifactArgs(body.args);
  if (!validation.ok) {
    return jsonResponse(
      {
        ok: false,
        code: validation.code,
        field: validation.field,
        message: validation.message,
      },
      400,
    );
  }

  // Author is optional in the request — synthesize a default if the
  // client doesn't supply one. Web orchestrator typically passes
  // `{ surface: 'web', role: 'orchestrator', messageId, createdAt }`.
  const author: ArtifactAuthor = parseAuthor(body.author) ?? {
    surface: 'web',
    role: 'orchestrator',
    createdAt: Date.now(),
  };

  let record: ArtifactRecord;
  try {
    record = buildArtifactRecord(validation.args, { scope, author });
    const store = new WebKvArtifactStore(env.ARTIFACTS);
    await store.put(record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      {
        ok: false,
        code: 'ARTIFACT_PERSIST_FAILED',
        message,
      },
      500,
    );
  }

  return jsonResponse({
    ok: true,
    record,
    summary: summarizeArtifact(record),
  });
}

// ---------------------------------------------------------------------------
// /api/artifacts/list
// ---------------------------------------------------------------------------

export async function handleArtifactsList(request: Request, env: ArtifactsEnv): Promise<Response> {
  if (!env.ARTIFACTS) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  const scope = parseScope(body.scope);
  if (!scope) {
    return jsonResponse({ ok: false, code: 'INVALID_SCOPE', message: 'Invalid scope.' }, 400);
  }

  const kind = body.kind;
  // `kind` filter accepts a single value or an array; sanity-check.
  let kindFilter: ListArtifactsQuery['kind'];
  if (kind === undefined) {
    kindFilter = undefined;
  } else if (typeof kind === 'string' && isArtifactKind(kind)) {
    kindFilter = kind;
  } else if (
    Array.isArray(kind) &&
    kind.every((k: unknown) => typeof k === 'string' && isArtifactKind(k))
  ) {
    kindFilter = kind as ArtifactRecord['kind'][];
  } else {
    return jsonResponse(
      { ok: false, code: 'INVALID_KIND', message: 'kind must be an ArtifactKind or array.' },
      400,
    );
  }

  const limit =
    typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit >= 0
      ? body.limit
      : undefined;

  const store = new WebKvArtifactStore(env.ARTIFACTS);
  const records = await store.list({ scope, kind: kindFilter, limit });
  return jsonResponse({ ok: true, records });
}

// ---------------------------------------------------------------------------
// /api/artifacts/get
// ---------------------------------------------------------------------------

export async function handleArtifactsGet(request: Request, env: ArtifactsEnv): Promise<Response> {
  if (!env.ARTIFACTS) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  const scope = parseScope(body.scope);
  if (!scope) {
    return jsonResponse({ ok: false, code: 'INVALID_SCOPE', message: 'Invalid scope.' }, 400);
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }

  const store = new WebKvArtifactStore(env.ARTIFACTS);
  try {
    const record = await store.get(scope, body.id);
    return jsonResponse({ ok: true, record });
  } catch (err) {
    // Distinguish client-side validation errors (bad id shape) from
    // server-side failures (KV outage, corrupt record JSON). Earlier
    // revs collapsed both to 400 INVALID_ID, masking real outages.
    if (err instanceof InvalidArtifactIdError) {
      return jsonResponse({ ok: false, code: 'INVALID_ID', message: err.message }, 400);
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, code: 'INTERNAL_ERROR', message }, 500);
  }
}

// ---------------------------------------------------------------------------
// /api/artifacts/delete
// ---------------------------------------------------------------------------

export async function handleArtifactsDelete(
  request: Request,
  env: ArtifactsEnv,
): Promise<Response> {
  if (!env.ARTIFACTS) return notConfiguredResponse();

  const body = await readJsonBody(request);
  if (!isRecord(body)) {
    return jsonResponse(
      { ok: false, code: 'BAD_REQUEST', message: 'Request body must be a JSON object.' },
      400,
    );
  }
  const scope = parseScope(body.scope);
  if (!scope) {
    return jsonResponse({ ok: false, code: 'INVALID_SCOPE', message: 'Invalid scope.' }, 400);
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ ok: false, code: 'INVALID_ID', message: 'id is required.' }, 400);
  }

  const store = new WebKvArtifactStore(env.ARTIFACTS);
  try {
    await store.delete(scope, body.id);
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof InvalidArtifactIdError) {
      return jsonResponse({ ok: false, code: 'INVALID_ID', message: err.message }, 400);
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, code: 'INTERNAL_ERROR', message }, 500);
  }
}
