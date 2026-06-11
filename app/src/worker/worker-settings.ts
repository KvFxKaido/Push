/**
 * HTTP routes for the unified web settings document.
 *
 *   GET    /api/settings           — read the signed-in user's settings doc
 *   PUT    /api/settings  { values } — shallow-merge changed keys (LWW per key)
 *   GET    /api/settings/provider-keys — presence metadata (last4/updatedAt) only
 *   PUT    /api/settings/provider-keys { provider, key } — store one key
 *   DELETE /api/settings/provider-keys { provider } — remove one key
 *
 * Identity-keyed (`settings:<githubUserId>`) and session-gated like every other
 * `/api/*` route. Origin validation + rate limiting mirror the jobs/pr-review
 * routers so neither path bypasses CSRF / abuse protection. See
 * settings-config.ts for the document model and conflict policy, and
 * user-secrets.ts for the provider-key store (encrypted at rest; values are
 * write-only — no read endpoint returns key material).
 */

import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import { readSettingsDoc, resolveSettingsUserId, writeSettingsMerge } from './settings-config';
import {
  MAX_PROVIDER_KEY_CHARS,
  deleteUserProviderKey,
  listUserProviderKeyMeta,
  putUserProviderKey,
} from './user-secrets';

const SETTINGS_PATH = '/api/settings';
const PROVIDER_KEYS_PATH = '/api/settings/provider-keys';

export type SettingsRouteAction = 'get' | 'put' | 'keys-list' | 'keys-put' | 'keys-delete';

export function matchSettingsRoute(pathname: string, method: string): SettingsRouteAction | null {
  if (pathname === PROVIDER_KEYS_PATH) {
    if (method === 'GET') return 'keys-list';
    if (method === 'PUT') return 'keys-put';
    if (method === 'DELETE') return 'keys-delete';
    return null;
  }
  if (pathname !== SETTINGS_PATH) return null;
  if (method === 'GET') return 'get';
  if (method === 'PUT') return 'put';
  return null;
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleSettingsRoute(
  request: Request,
  env: Env,
  action: SettingsRouteAction,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return json({ error: originCheck.error }, 403);
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '60' },
    });
  }

  const identity = await resolveSettingsUserId(request, env);

  if (action === 'get') {
    const doc = await readSettingsDoc(env, identity.userId);
    log('info', 'settings_get', { userId: identity.userId, source: identity.source });
    return json(doc);
  }
  if (action === 'keys-list') {
    const providers = await listUserProviderKeyMeta(env, identity.userId);
    return json({ providers }, 200);
  }
  if (action === 'keys-put' || action === 'keys-delete') {
    return handleProviderKeyWrite(request, env, identity.userId, action);
  }

  return handlePut(request, env, identity.userId, identity.source);
}

/**
 * PUT/DELETE one provider key. The key value appears only in the PUT body —
 * never in responses, never in logs (user-secrets.ts logs last4 at most).
 */
async function handleProviderKeyWrite(
  request: Request,
  env: Env,
  userId: string,
  action: 'keys-put' | 'keys-delete',
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_BODY', message: 'Body must be JSON.' }, 400);
  }
  const { provider, key } = (body ?? {}) as { provider?: unknown; key?: unknown };
  if (typeof provider !== 'string' || provider.length === 0) {
    return json({ error: 'INVALID_REQUEST', message: 'provider is required.' }, 400);
  }

  if (action === 'keys-delete') {
    const result = await deleteUserProviderKey(env, userId, provider);
    if (!result.ok) return providerKeyWriteError(result.reason);
    return json({ ok: true });
  }

  if (typeof key !== 'string' || key.trim().length === 0) {
    return json({ error: 'INVALID_REQUEST', message: 'key must be a non-empty string.' }, 400);
  }
  const result = await putUserProviderKey(env, userId, provider, key.trim());
  if (!result.ok) return providerKeyWriteError(result.reason);
  return json({ ok: true });
}

function providerKeyWriteError(
  reason: 'no_kv' | 'not_configured' | 'invalid_provider' | 'too_large',
): Response {
  switch (reason) {
    case 'invalid_provider':
      return json({ error: 'INVALID_REQUEST', message: 'Unknown provider.' }, 400);
    case 'too_large':
      return json(
        {
          error: 'PAYLOAD_TOO_LARGE',
          message: `Key exceeds ${MAX_PROVIDER_KEY_CHARS} characters.`,
        },
        413,
      );
    case 'not_configured':
      return json(
        {
          error: 'NOT_CONFIGURED',
          message:
            'Server-side key storage requires PUSH_SESSION_SECRET on the Worker (encryption at rest).',
        },
        503,
      );
    case 'no_kv':
      return json(
        { error: 'NOT_CONFIGURED', message: 'Settings store (SNAPSHOT_INDEX KV) is not bound.' },
        503,
      );
  }
}

async function handlePut(
  request: Request,
  env: Env,
  userId: string,
  source: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'INVALID_BODY', message: 'PUT body must be JSON.' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'INVALID_REQUEST', message: 'PUT body must be an object.' }, 400);
  }
  const { values } = body as { values?: unknown };
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return json(
      { error: 'INVALID_REQUEST', message: 'values must be an object of settings to merge.' },
      400,
    );
  }

  const result = await writeSettingsMerge(env, userId, values as Record<string, unknown>);
  if (!result.ok) {
    if (result.reason === 'too_large') {
      return json(
        { error: 'PAYLOAD_TOO_LARGE', message: 'Settings document exceeds the size limit.' },
        413,
      );
    }
    return json(
      { error: 'NOT_CONFIGURED', message: 'Settings store (SNAPSHOT_INDEX KV) is not bound.' },
      503,
    );
  }

  log('info', 'settings_put', {
    userId,
    source,
    keys: Object.keys(values as Record<string, unknown>).length,
  });
  return json(result.doc);
}
