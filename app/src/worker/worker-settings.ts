/**
 * HTTP routes for the unified web settings document.
 *
 *   GET  /api/settings           — read the signed-in user's settings doc
 *   PUT  /api/settings  { values } — shallow-merge changed keys (LWW per key)
 *
 * Identity-keyed (`settings:<githubUserId>`) and session-gated like every other
 * `/api/*` route. Origin validation + rate limiting mirror the jobs/pr-review
 * routers so neither path bypasses CSRF / abuse protection. See
 * settings-config.ts for the document model and conflict policy.
 */

import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import { readSettingsDoc, resolveSettingsUserId, writeSettingsMerge } from './settings-config';

const SETTINGS_PATH = '/api/settings';

export type SettingsRouteAction = 'get' | 'put';

export function matchSettingsRoute(pathname: string, method: string): SettingsRouteAction | null {
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

  return handlePut(request, env, identity.userId, identity.source);
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
