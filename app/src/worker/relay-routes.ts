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
 *   `pushd_relay_*`  → pushd outbound dial. The FULL prefixed bearer
 *                       (e.g. `pushd_relay_<random-hex>`) is compared
 *                       constant-time against `env.PUSH_RELAY_TOKEN`.
 *                       Operator stores the prefixed form so the
 *                       prefix is a structural check too — an
 *                       unprefixed value can't accidentally match.
 *   `pushd_da_*`     → phone attach (Phase 3 slice 2 token shape).
 *                       Format-only check at the route. The actual
 *                       session-attach gate runs in the DO: pushd
 *                       emits `relay_phone_allow` envelopes (2.d.1)
 *                       naming which attach tokens may join the
 *                       session, and the DO only forwards pushd →
 *                       phones whose bearer is in that allowlist.
 *
 * Per-route gates (same order as /api/jobs/*):
 *   1. PUSH_RELAY_ENABLED === '1'   → otherwise 503 NOT_ENABLED
 *   2. env.RELAY_SESSIONS bound     → otherwise 503 NOT_CONFIGURED
 *   3. validateOrigin               → otherwise 403 ORIGIN_REJECTED
 *      Phase 2.e carve-out: a pre-parse of the bearer subprotocol
 *      runs FIRST. If the bearer starts with `pushd_relay_`, the
 *      origin gate is skipped — pushd's outbound dial is a Node
 *      WebSocket, not a browser, and carries no `Origin` header.
 *      The carve-out is bearer-prefix-scoped (not "any auth bypasses
 *      origin"): phone bearers (`pushd_da_*`) still enforce the
 *      origin check, because they ARE browser-originated and a CSRF
 *      target. Without this discrimination the carve-out would
 *      widen the CSRF surface for everyone.
 *   4. RATE_LIMITER                 → otherwise 429
 *   5. Upgrade: websocket           → otherwise 426
 *   6. Bearer parsing + validation  → otherwise 401
 *   7. Forward to DO with role appended to URL (?role=pushd|phone) so
 *      the DO knows which side of the pair this connection is.
 *
 * The DO does the rest (role tracking + forwarding).
 */

import type { RelayConnectionRole } from './relay-do';
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

  // Phase 2.e: pre-parse the bearer so we can decide whether to run
  // the origin gate. The origin check exists to block browser CSRF;
  // a Node-side outbound WS (pushd) is not a CSRF vector and doesn't
  // carry an Origin header in the first place. Skip the gate ONLY
  // when the bearer is in the `pushd_relay_*` family — phone bearers
  // (browser-originated) still go through the gate.
  //
  // This is bearer-prefix-scoped, not auth-presence-scoped: a phone
  // bearer must still pass origin (the phone IS a browser). The
  // distinction matters because a misshapen carve-out ("any valid
  // auth bypasses origin") would silently widen the CSRF surface
  // for phone clients too.
  const preParsedBearer = parseBearerSubprotocol(request.headers.get('Sec-WebSocket-Protocol'));
  const isPushdBearer = preParsedBearer?.bearer.startsWith(PUSHD_BEARER_PREFIX) ?? false;

  const requestUrl = new URL(request.url);
  if (!isPushdBearer) {
    const originCheck = validateOrigin(request, requestUrl, env);
    if (!originCheck.ok) {
      return jsonError('ORIGIN_REJECTED', originCheck.error ?? 'Origin not allowed', 403);
    }
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
    // Trim trailing whitespace/newlines — `echo ... | wrangler secret
    // put PUSH_RELAY_TOKEN` is a common operator pattern and leaves
    // a trailing `\n` that would otherwise cause silent
    // BEARER_REJECTED (matches PUSH_DEPLOYMENT_TOKEN's trimSecret
    // path in worker-middleware.ts).
    const expected = (env.PUSH_RELAY_TOKEN ?? '').trim();
    if (expected.length === 0) {
      return {
        error: {
          code: 'RELAY_TOKEN_NOT_CONFIGURED',
          message: 'Relay endpoint received a pushd bearer but PUSH_RELAY_TOKEN secret is not set.',
        },
      };
    }
    // Compare the FULL prefixed bearer against the stored secret. The
    // operator stores `pushd_relay_<random>` so the prefix is a
    // structural check: any unprefixed value can't accidentally match.
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
    // Format-only check at the route layer. The DO enforces the
    // actual session-attach gate via pushd-controlled allowlist
    // (2.d.1): pushd emits `relay_phone_allow` envelopes naming
    // which attach tokens may join the session; the DO only
    // forwards pushd → phones whose bearer is in that allowlist.
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

/**
 * Re-extract the phone bearer from a forwarded request's
 * `Sec-WebSocket-Protocol` header. Returns the full token
 * including the `pushd_da_` prefix (only the `bearer.` subprotocol
 * tag is stripped — the `pushd_da_` part stays, so the returned
 * value can be compared directly against allowlist entries in
 * `relay_phone_allow` envelopes). Returns null if the header is
 * absent, the protocol doesn't match, the bearer entry is missing,
 * or the bearer isn't shaped like a phone token.
 *
 * Used by the DO to store the bearer alongside the connection so
 * the allowlist match in `handleMessage` has the identity to
 * compare against. The route handler already validated the bearer
 * at upgrade time; this re-parse exists because the alternative —
 * passing the bearer via a query param on the forwarded request —
 * would leak phone tokens into URL logs.
 */
export function extractPhoneBearer(headerValue: string | null): string | null {
  const parsed = parseBearerSubprotocol(headerValue);
  if (!parsed) return null;
  if (!parsed.bearer.startsWith(PHONE_BEARER_PREFIX)) return null;
  return parsed.bearer;
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
