/**
 * HTTP route handlers for `/api/runhost/spike/*` — Phase 0 of the Durable
 * Runs (Adopt-on-Silence) track. Forwards to the `RunHost` Durable Object
 * bound as `env.RUN_HOST`.
 *
 * Routes:
 *   GET  /api/runhost/spike/page        — self-contained HTML measurement
 *                                         harness (run it from the phone).
 *   POST /api/runhost/spike/relay       — DO-relayed SSE provider stream.
 *   POST /api/runhost/spike/server-turn — DO-internal turn, timing JSON.
 *   GET  /api/runhost/spike/ws          — DO-relayed WebSocket stream.
 *
 * All paths sit behind the universal GitHub-identity session gate (cookie
 * rides on same-origin navigation, fetch, and WS upgrade alike — no
 * exemption needed). Per-route gates mirror /api/jobs/*: NOT_CONFIGURED
 * when the binding is absent, origin validation, per-IP rate limit.
 *
 * `?instance=<name>` re-rolls the DO instance (and therefore its colo
 * placement) so measurement sets aren't pinned to wherever the first
 * trial landed. Default instance: "latency-spike".
 *
 * Throwaway scope: this file (and the spike endpoints in run-host-do.ts)
 * get deleted when Phase 2 lands the real RunHost surface; numbers are
 * recorded in docs/decisions/Durable Runs — Adopt-on-Silence.md.
 */

import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import { SPIKE_PAGE_HTML, SPIKE_PAGE_JS } from './run-host-spike-page';

const SPIKE_PREFIX = '/api/runhost/spike/';

export type SpikeRouteAction = 'page' | 'page.js' | 'relay' | 'server-turn' | 'ws';

export function matchRunHostRoute(pathname: string, method: string): SpikeRouteAction | null {
  if (!pathname.startsWith(SPIKE_PREFIX)) return null;
  const rest = pathname.slice(SPIKE_PREFIX.length).replace(/\/$/, '');
  if (rest === 'page' && method === 'GET') return 'page';
  // Separate same-origin script file so the strict global CSP
  // (script-src 'self') applies to the page unchanged.
  if (rest === 'page.js' && method === 'GET') return 'page.js';
  if (rest === 'relay' && method === 'POST') return 'relay';
  if (rest === 'server-turn' && method === 'POST') return 'server-turn';
  if (rest === 'ws' && method === 'GET') return 'ws';
  return null;
}

export async function handleRunHostRoute(
  request: Request,
  env: Env,
  action: SpikeRouteAction,
): Promise<Response> {
  if (action === 'page') {
    return new Response(SPIKE_PAGE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (action === 'page.js') {
    return new Response(SPIKE_PAGE_JS, {
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (!env.RUN_HOST) {
    return json({ error: 'NOT_CONFIGURED', message: 'RUN_HOST DO binding is not present.' }, 503);
  }

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

  const instance = requestUrl.searchParams.get('instance') || 'latency-spike';
  const id = env.RUN_HOST.idFromName(instance);
  const stub = env.RUN_HOST.get(id);

  // Server-derived deployment origin for the DO's internal provider
  // dispatch — set unconditionally so a client-supplied value can never
  // win (same never-trust-client stance as /api/jobs/ start). Travels as
  // a query param because query params survive Request reconstruction
  // across the namespace.fetch boundary cleanly (relay-routes precedent),
  // and the WS upgrade must be forwarded as a reconstruction of the
  // original request to keep the Upgrade semantics intact.
  const targetUrl = new URL(`https://do/spike/${action}`);
  targetUrl.searchParams.set('spikeOrigin', requestUrl.origin);
  const forwarded = new Request(targetUrl.toString(), request);

  // Cast at the single DO boundary — CF Workers types vs DOM types, same
  // pattern as worker-coder-job.ts.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    forwarded,
  )) as Response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
