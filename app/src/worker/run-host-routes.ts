/**
 * HTTP route handlers for `/api/runhost/*` — Durable Runs (Adopt-on-Silence)
 * track. Forwards to the `RunHost` Durable Object bound as `env.RUN_HOST`.
 *
 * Two surfaces:
 *
 *   **Phase 2 substrate (durable) — `/api/runhost/run/*`:** the heartbeat
 *   ledger + checkpoint persistence + adoption decision. The DO instance is
 *   derived from the run's durable scope (`repoFullName + branch + chatId`)
 *   via `runHostInstanceId`, so a reopening client reaches the same instance
 *   to attach (Phase 3) without a server-minted handle.
 *     POST /api/runhost/run/register   — open/refresh a run for a scope.
 *     PUT  /api/runhost/run/checkpoint  — persist the latest RunCheckpointV1.
 *     POST /api/runhost/run/heartbeat   — keepalive (no checkpoint).
 *     POST /api/runhost/run/release     — pull-back-local / teardown.
 *     GET  /api/runhost/run/status      — lifecycle snapshot.
 *
 *   **Phase 3 attach/viewer — also under `/api/runhost/run/*`:**
 *     GET  /api/runhost/run/attach     — snapshot hydration + cursor-follow
 *                                        (`?sinceSavedAt=` echoes the last
 *                                        seen checkpoint cursor).
 *     POST /api/runhost/run/stop       — end the run server-side (keeps the
 *                                        checkpoint for final hydration).
 *     POST /api/runhost/run/approval   — approve/deny the gate a supervised
 *                                        adopted run paused on; relaunches
 *                                        the loop with the decision.
 *
 *   **Phase 0 spike (throwaway) — `/api/runhost/spike/*`:** latency
 *   instruments pinned to a single shared instance ("latency-spike").
 *     GET  /api/runhost/spike/page        — HTML measurement harness.
 *     POST /api/runhost/spike/relay       — DO-relayed SSE provider stream.
 *     POST /api/runhost/spike/server-turn — DO-internal turn, timing JSON.
 *     GET  /api/runhost/spike/ws          — DO-relayed WebSocket stream.
 *
 * All paths sit behind the universal GitHub-identity session gate (cookie
 * rides on same-origin navigation, fetch, and WS upgrade alike — no
 * exemption needed). Per-route gates mirror /api/jobs/*: NOT_CONFIGURED when
 * the binding is absent, origin validation, per-IP rate limit.
 */

import { type RunHostScope, isCompleteScope, runHostInstanceId } from '@push/lib/run-host-adoption';
import { getClientIp, validateOrigin, type Env } from './worker-middleware';
import { SPIKE_PAGE_HTML, SPIKE_PAGE_JS } from './run-host-spike-page';

const ROUTE_PREFIX = '/api/runhost/';

export type SpikeRouteAction = 'page' | 'page.js' | 'relay' | 'server-turn' | 'ws';
export type RunRouteAction =
  | 'run.register'
  | 'run.checkpoint'
  | 'run.heartbeat'
  | 'run.release'
  | 'run.status'
  | 'run.attach'
  | 'run.stop'
  | 'run.approval';
export type RunHostAction = SpikeRouteAction | RunRouteAction;

function isRunAction(action: RunHostAction): action is RunRouteAction {
  return action.startsWith('run.');
}

export function matchRunHostRoute(pathname: string, method: string): RunHostAction | null {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const rest = pathname.slice(ROUTE_PREFIX.length).replace(/\/$/, '');
  // Phase 2 substrate — the durable run ledger.
  if (rest === 'run/register' && method === 'POST') return 'run.register';
  if (rest === 'run/checkpoint' && method === 'PUT') return 'run.checkpoint';
  if (rest === 'run/heartbeat' && method === 'POST') return 'run.heartbeat';
  if (rest === 'run/release' && method === 'POST') return 'run.release';
  if (rest === 'run/status' && method === 'GET') return 'run.status';
  // Phase 3 attach/viewer — snapshot hydration + pending-gate controls.
  if (rest === 'run/attach' && method === 'GET') return 'run.attach';
  if (rest === 'run/stop' && method === 'POST') return 'run.stop';
  if (rest === 'run/approval' && method === 'POST') return 'run.approval';
  // Phase 0 spike — latency instruments.
  if (rest === 'spike/page' && method === 'GET') return 'page';
  // Separate same-origin script file so the strict global CSP
  // (script-src 'self') applies to the page unchanged.
  if (rest === 'spike/page.js' && method === 'GET') return 'page.js';
  if (rest === 'spike/relay' && method === 'POST') return 'relay';
  if (rest === 'spike/server-turn' && method === 'POST') return 'server-turn';
  if (rest === 'spike/ws' && method === 'GET') return 'ws';
  return null;
}

export async function handleRunHostRoute(
  request: Request,
  env: Env,
  action: RunHostAction,
): Promise<Response> {
  // The spike page + its script are static and binding-independent.
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

  return isRunAction(action)
    ? handleRunAction(request, env, requestUrl, action)
    : handleSpikeAction(request, env, requestUrl, action);
}

/**
 * Phase 2 run endpoints. The DO instance is derived server-side from the
 * run's durable scope — never client-trusted as a raw instance name, so a
 * malformed or hostile client can't address an arbitrary DO. The scope is
 * read from the body (top-level for register/heartbeat/release, embedded in
 * the checkpoint for checkpoint) or query params (status).
 */
async function handleRunAction(
  request: Request,
  env: Env,
  requestUrl: URL,
  action: RunRouteAction,
): Promise<Response> {
  let forwardBody: string | undefined;
  let scope: RunHostScope | null;

  if (action === 'run.status' || action === 'run.attach') {
    scope = scopeFromQuery(requestUrl);
  } else {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'INVALID_BODY', message: 'request body must be JSON' }, 400);
    }
    forwardBody = JSON.stringify(raw);
    scope = scopeFromBody(action, raw);
  }

  if (!scope) {
    return json(
      {
        error: 'INVALID_SCOPE',
        message: 'a complete repoFullName/branch/chatId scope is required',
      },
      400,
    );
  }

  const id = env.RUN_HOST!.idFromName(runHostInstanceId(scope));
  const stub = env.RUN_HOST!.get(id);
  const doPath = `/run/${action.slice('run.'.length)}`;
  // Server-derived deployment origin, stamped unconditionally (a
  // client-supplied value can never win — the spikeOrigin stance). The DO
  // persists it on the record so adoption-time provisioning can build
  // internal provider/sandbox Requests after the client is gone.
  const targetUrl = new URL(`https://do${doPath}`);
  targetUrl.searchParams.set('hostOrigin', requestUrl.origin);
  if (action === 'run.attach') {
    // The attach cursor rides the query; everything else about the request
    // is server-derived (scope → instance, origin stamp).
    const since = requestUrl.searchParams.get('sinceSavedAt');
    if (since !== null) targetUrl.searchParams.set('sinceSavedAt', since);
  }
  const forwarded = new Request(targetUrl.toString(), {
    method: request.method,
    headers: { 'content-type': 'application/json' },
    body: forwardBody,
  });
  // Cast at the single DO boundary — CF Workers types vs DOM types, same
  // pattern as worker-coder-job.ts.
  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    forwarded,
  )) as Response;
}

/** Phase 0 spike endpoints — fixed instance, DO-internal provider dispatch. */
async function handleSpikeAction(
  request: Request,
  env: Env,
  requestUrl: URL,
  action: SpikeRouteAction,
): Promise<Response> {
  // `?instance=<name>` re-rolls the DO instance (and therefore its colo
  // placement) so measurement sets aren't pinned to wherever the first trial
  // landed. Default instance: "latency-spike".
  const instance = requestUrl.searchParams.get('instance') || 'latency-spike';
  const id = env.RUN_HOST!.idFromName(instance);
  const stub = env.RUN_HOST!.get(id);

  // Server-derived deployment origin for the DO's internal provider dispatch
  // — set unconditionally so a client-supplied value can never win (same
  // never-trust-client stance as /api/jobs/ start). Travels as a query param
  // because query params survive Request reconstruction across the
  // namespace.fetch boundary cleanly (relay-routes precedent), and the WS
  // upgrade must be forwarded as a reconstruction of the original request to
  // keep the Upgrade semantics intact.
  const targetUrl = new URL(`https://do/spike/${action}`);
  targetUrl.searchParams.set('spikeOrigin', requestUrl.origin);
  const forwarded = new Request(targetUrl.toString(), request);

  return (await (stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
    forwarded,
  )) as Response;
}

/** Extract the routing scope for a run write. register/heartbeat/release
 * carry `scope` at the top level; checkpoint embeds it in the checkpoint. */
function scopeFromBody(action: RunRouteAction, raw: unknown): RunHostScope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const candidate = action === 'run.checkpoint' ? scopeFromCheckpoint(body.checkpoint) : body.scope;
  return isCompleteScope(candidate) ? candidate : null;
}

function scopeFromCheckpoint(checkpoint: unknown): unknown {
  if (typeof checkpoint !== 'object' || checkpoint === null) return null;
  const cp = checkpoint as Record<string, unknown>;
  return { repoFullName: cp.repoFullName, branch: cp.branch, chatId: cp.chatId };
}

function scopeFromQuery(url: URL): RunHostScope | null {
  const candidate = {
    repoFullName: url.searchParams.get('repoFullName') ?? '',
    branch: url.searchParams.get('branch') ?? '',
    chatId: url.searchParams.get('chatId') ?? '',
  };
  return isCompleteScope(candidate) ? candidate : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
