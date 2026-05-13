/**
 * HTTP route handlers for `/api/relay/v1/*` — the Remote Sessions relay
 * surface.
 *
 * Routes:
 *   GET /api/relay/v1/session/:sessionId/connect — WebSocket upgrade.
 *     The route resolves a DO instance via
 *     `env.RELAY_SESSIONS.idFromName(sessionId)` so two clients hitting
 *     the same sessionId share one DO instance.
 *
 * Auth (Phase 2.c): bearer travels in `Sec-WebSocket-Protocol`, matching
 * the Phase 1 device-pairing pattern (browser `WebSocket` can't set
 * arbitrary upgrade headers). The header is parsed as:
 *
 *   Sec-WebSocket-Protocol: push.relay.v1, bearer.<token>
 *
 * The token's prefix determines the connection role:
 *
 *   `pushd_relay_*`  → pushd outbound dial. The token after the prefix
 *                       is compared constant-time against
 *                       `env.PUSH_RELAY_TOKEN` (Worker secret).
 *   `pushd_da_*`     → phone attach (Phase 3 slice 2 token shape). The
 *                       relay does NOT cryptographically verify these —
 *                       pushd holds the token store and rejects bogus
 *                       tokens at the protocol layer in later phases.
 *                       The relay enforces format only (prefix + length).
 *
 * Per-route gates (same order as /api/jobs/*):
 *   1. PUSH_RELAY_ENABLED === '1'   → otherwise 503 NOT_ENABLED
 *   2. env.RELAY_SESSIONS bound     → otherwise 503 NOT_CONFIGURED
 *   3. validateOrigin               → otherwise 403 ORIGIN_REJECTED
 *      (NOTE: pushd's outbound dial in 2.e won't carry a browser
 *      Origin header. This gate will need a carve-out then — likely
 *      "valid pushd bearer bypasses Origin check since pushd is not a
 *      CSRF target.")
 *   4. RATE_LIMITER                 → otherwise 429
 *   5. Upgrade: websocket           → otherwise 426
 *   6. Bearer parsing + validation  → otherwise 401
 *   7. Forward to DO with role appended to URL (?role=pushd|phone) so
 *      the DO knows which side of the pair this connection is.
 *
 * The DO does the rest (role tracking + forwarding).
 */

import { getClientIp, timingSafeEqual, validateOrigin, type Env } from './worker-middleware';

const RELAY_PREFIX = '/api/relay/v1/';
const RELAY_SUBPROTOCOL = 'push.relay.v1';
const BEARER_PROTOCOL_PREFIX = 'bearer.';
const PUSHD_BEARER_PREFIX = 'pushd_relay_';
const PHONE_BEARER_PREFIX = 'pushd_da_';
// Phase 3 slice 2 attach tokens are `pushd_da_` + 32 hex chars; allow a
// little slack for future token-shape evolution but reject obvious
// garbage (e.g. empty token, header-stuffing). Same idea for relay
// tokens.
const MIN_TOKEN_BODY_LEN = 16;
const MAX_TOKEN_BODY_LEN = 256;

export type RelayConnectionRole = 'pushd' | 'phone';

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

  const authResult = authenticateBearer(request, env);
  if (authResult.error) {
    return jsonError(authResult.error.code, authResult.error.message, 401);
  }

  const id = env.RELAY_SESSIONS.idFromName(match.sessionId);
  const stub = env.RELAY_SESSIONS.get(id);

  // Forward the role to the DO via a query param. The DO uses this to
  // tag the connection in its role map (no other way to pass auth
  // context across the namespace.fetch boundary cleanly — headers are
  // mutable but query params survive Request reconstruction).
  const targetUrl = new URL(request.url);
  targetUrl.searchParams.set('role', authResult.role);
  const forwarded = new Request(targetUrl.toString(), request);

  // CF Workers types diverge from DOM types (e.g. Headers.getSetCookie);
  // cast at this single boundary so the handler signature stays as the
  // app-wide `Response` / `Request` (DOM). Mirrors the pattern in
  // `worker-coder-job.ts`.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    forwarded,
  )) as Response;
}

interface AuthResult {
  role: RelayConnectionRole;
  error?: never;
}
interface AuthError {
  role?: never;
  error: { code: string; message: string };
}

function authenticateBearer(request: Request, env: Env): AuthResult | AuthError {
  const header = request.headers.get('Sec-WebSocket-Protocol');
  const parsed = parseBearerSubprotocol(header);
  if (!parsed) {
    return {
      error: {
        code: 'BEARER_MISSING',
        message: 'Sec-WebSocket-Protocol must include push.relay.v1 and bearer.<token>.',
      },
    };
  }

  const { bearer } = parsed;

  if (bearer.startsWith(PUSHD_BEARER_PREFIX)) {
    const expected = env.PUSH_RELAY_TOKEN ?? '';
    if (expected.length === 0) {
      return {
        error: {
          code: 'RELAY_TOKEN_NOT_CONFIGURED',
          message: 'Relay endpoint received a pushd bearer but PUSH_RELAY_TOKEN secret is not set.',
        },
      };
    }
    // Compare the full bearer (prefix + body) so an attacker can't
    // distinguish prefix-match vs body-match via timing.
    if (!timingSafeEqual(bearer, expected)) {
      return {
        error: { code: 'BEARER_REJECTED', message: 'Invalid relay bearer.' },
      };
    }
    return { role: 'pushd' };
  }

  if (bearer.startsWith(PHONE_BEARER_PREFIX)) {
    const body = bearer.slice(PHONE_BEARER_PREFIX.length);
    if (body.length < MIN_TOKEN_BODY_LEN || body.length > MAX_TOKEN_BODY_LEN) {
      return {
        error: { code: 'BEARER_REJECTED', message: 'Attach token format invalid.' },
      };
    }
    // No crypto verification at the relay — pushd's token store is the
    // source of truth, and pushd rejects unknown attach tokens at the
    // protocol layer (envelope inspection). The relay enforces shape
    // only so malformed garbage doesn't tie up a DO instance.
    return { role: 'phone' };
  }

  return {
    error: { code: 'BEARER_REJECTED', message: 'Unrecognized bearer prefix.' },
  };
}

interface ParsedSubprotocol {
  protocol: string;
  bearer: string;
}

function parseBearerSubprotocol(headerValue: string | null): ParsedSubprotocol | null {
  if (!headerValue) return null;
  const entries = headerValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let protocol: string | null = null;
  let bearer: string | null = null;
  for (const entry of entries) {
    if (entry === RELAY_SUBPROTOCOL) {
      protocol = entry;
    } else if (entry.startsWith(BEARER_PROTOCOL_PREFIX)) {
      bearer = entry.slice(BEARER_PROTOCOL_PREFIX.length);
    }
  }
  if (!protocol || !bearer) return null;
  if (bearer.length === 0 || bearer.length > MAX_TOKEN_BODY_LEN + 32) return null;
  return { protocol, bearer };
}

function jsonError(error: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
