/**
 * HTTP route handlers for `/api/relay/v1/*` — the Remote Sessions relay
 * surface (Phase 2.b scaffold).
 *
 * Routes:
 *   GET /api/relay/v1/session/:sessionId/connect — WebSocket upgrade.
 *     The route resolves a DO instance via
 *     `env.RELAY_SESSIONS.idFromName(sessionId)` so two clients hitting
 *     the same sessionId share one DO instance.
 *
 * Fails closed with 503 (NOT_CONFIGURED) when `env.RELAY_SESSIONS` is
 * not bound, mirroring the `/api/jobs/*` and `/api/sandbox-cf/*`
 * patterns. The whole route family is additionally gated by
 * `PUSH_RELAY_ENABLED === '1'`: until 2.c (auth) and 2.d (buffer) land,
 * the endpoint accepts WS connections but does nothing useful, so we
 * keep it dark by default in deployed envs.
 *
 * Auth lands in 2.c. Until then any caller can open a connection with
 * any sessionId. This is intentional and called out in `RelaySessionDO`
 * — 2.c will add the auth envelope at the WS-upgrade layer.
 */

import { getClientIp, validateOrigin, type Env } from './worker-middleware';

const RELAY_PREFIX = '/api/relay/v1/';

export interface RelayRouteMatch {
  action: 'connect';
  sessionId: string;
}

/** Parse a pathname beginning with `/api/relay/v1/`. Returns null for
 * non-match. */
export function matchRelayRoute(pathname: string, method: string): RelayRouteMatch | null {
  if (!pathname.startsWith(RELAY_PREFIX)) return null;
  const rest = pathname.slice(RELAY_PREFIX.length);
  const segments = rest.split('/').filter(Boolean);
  if (
    segments.length === 3 &&
    segments[0] === 'session' &&
    segments[2] === 'connect' &&
    method === 'GET'
  ) {
    return { action: 'connect', sessionId: segments[1] };
  }
  return null;
}

export async function handleRelayRequest(
  request: Request,
  env: Env,
  match: RelayRouteMatch,
): Promise<Response> {
  if (env.PUSH_RELAY_ENABLED !== '1') {
    return jsonError(
      'NOT_ENABLED',
      'Relay endpoint is disabled. Set PUSH_RELAY_ENABLED=1 to enable.',
      503,
    );
  }

  if (!env.RELAY_SESSIONS) {
    return jsonError(
      'NOT_CONFIGURED',
      'RELAY_SESSIONS Durable Object binding is not present in this environment.',
      503,
    );
  }

  // Origin + rate limiting mirror the /api/jobs/* pattern so the relay
  // endpoint isn't a softer CSRF / abuse surface than the rest of /api/*.
  // Browser PWA clients carry Origin; pushd's outbound dial in 2.e will
  // NOT carry a browser Origin header, so this gate must be reworked
  // alongside the 2.c auth model — most likely "auth token presence
  // bypasses the Origin check, since pushd isn't a CSRF target."
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return jsonError('ORIGIN_REJECTED', originCheck.error ?? 'Origin not allowed', 403);
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    return new Response(
      JSON.stringify({ error: 'RATE_LIMITED', message: 'Rate limit exceeded. Try again later.' }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '60' },
      },
    );
  }

  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return jsonError('UPGRADE_REQUIRED', 'Expected WebSocket upgrade.', 426);
  }

  const id = env.RELAY_SESSIONS.idFromName(match.sessionId);
  const stub = env.RELAY_SESSIONS.get(id);
  // CF Workers types diverge from DOM types (e.g. Headers.getSetCookie);
  // cast at this single boundary so the handler signature stays as the
  // app-wide `Response` / `Request` (DOM). Mirrors the pattern in
  // `worker-coder-job.ts`.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    request,
  )) as Response;
}

function jsonError(error: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
