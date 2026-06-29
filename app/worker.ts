/**
 * Cloudflare Worker — serves the Vite app + streaming proxy to AI providers.
 *
 * Static assets in ./dist are served directly by the [assets] layer.
 * Only unmatched requests (like /api/ollama/chat) reach this Worker.
 *
 * Handler implementations live in:
 *   src/worker/worker-middleware.ts  — shared preamble, proxy factories, auth
 *   src/worker/worker-providers.ts  — all provider handlers (Ollama, OpenRouter, etc.)
 *   src/worker/worker-infra.ts      — sandbox proxy, health check, GitHub App
 */

import type { ExecutionContext, ScheduledEvent } from '@cloudflare/workers-types';
import type { Env } from './src/worker/worker-middleware';
import {
  applySecurityHeaders,
  corsHeadersFor,
  requireSessionForGatedApi,
} from './src/worker/worker-middleware';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from './src/lib/request-id';

import {
  handleOllamaSearch,
  handleGoogleSearch,
  handleZenGoChat,
  handleZenGoModels,
  handleTavilySearch,
  handleFreeSearch,
  WORKER_PROVIDER_API_ROUTES,
} from './src/worker/worker-providers';

import {
  handleSandbox,
  handleHealthCheck,
  handleGitHubAppOAuth,
  handleGitHubAppToken,
  handleRepoCoverage,
  handleGitHubAppLogout,
} from './src/worker/worker-infra';
import { handleCloudflareSandbox } from './src/worker/worker-cf-sandbox';
import { handleGitHubTools } from './src/worker/worker-github-tools';
import { handleGitHubWebhook } from './src/worker/github-webhook';
import { sanitizeUrlForLogging } from './src/worker/worker-log-utils';
import { summarizeSnapshotIndex, reapOrphanedSnapshots } from './src/worker/snapshot-index';
import { SNAPSHOT_KEY_PREFIX } from './src/worker/worker-cf-sandbox';
import { handleAdminSnapshots } from './src/worker/admin-routes';
import { handleJobsRoute, matchJobsRoute } from './src/worker/worker-coder-job';
import { handlePrReviewRoute, matchPrReviewRoute } from './src/worker/worker-pr-review';
import { handleSettingsRoute, matchSettingsRoute } from './src/worker/worker-settings';
import { handleRelayRequest, matchRelayRoute } from './src/worker/relay-routes';
import { handleRunHostRoute, matchRunHostRoute } from './src/worker/run-host-routes';
import { handleStats } from './src/worker/worker-stats';
import {
  handleArtifactsCreate,
  handleArtifactsDelete,
  handleArtifactsGet,
  handleArtifactsList,
} from './src/worker/worker-artifacts';
import { handleMemoryEmbed } from './src/worker/worker-memory-embed';
import { handleProviderEngineCapabilities } from './src/worker/worker-provider-capabilities';
import {
  handleCollectionsCreate,
  handleCollectionsDelete,
  handleCollectionsGet,
  handleCollectionsList,
  handleCollectionsUpdate,
  handleItemsCreate,
  handleItemsDelete,
  handleItemsUpdate,
} from './src/worker/worker-chat-library';

// Re-export the Sandbox Durable Object class so wrangler can bind to it.
// The Cloudflare Sandbox SDK ships the DO implementation; we only need to
// expose the class symbol from the Worker entry. Subclass here later if we
// need outbound handlers (outboundByHost) or custom lifecycle hooks.
export { Sandbox } from '@cloudflare/sandbox';

// Background-jobs DO — Phase 1 of Background Coder Tasks.
export { CoderJob } from './src/worker/coder-job-do';

// PR review DO — autonomous webhook-triggered advisory reviews. Bound as
// `PrReviewJob` in wrangler.jsonc; the receiver lives in github-webhook.ts.
export { PrReviewJob } from './src/worker/pr-review-job-do';

// Remote Sessions relay DO — Phase 2.b scaffold. Bound as `RELAY_SESSIONS`
// in wrangler.jsonc; routes live in `relay-routes.ts`.
export { RelaySessionDO } from './src/worker/relay-do';

// RunHost DO — Durable Runs (Adopt-on-Silence). Bound as `RUN_HOST` in
// wrangler.jsonc; Phase 0 hosts the latency-spike endpoints only (routes in
// `run-host-routes.ts`).
export { RunHost } from './src/worker/run-host-do';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
    try {
      const requestWithId = withRequestIdOnRequest(request, requestId);
      const url = new URL(requestWithId.url);

      // CORS preflight for any /api/* route. The actual route registry is
      // method-keyed (GET/POST), so OPTIONS requests would otherwise fall
      // through to the SPA fallback (which doesn't handle them and 500s).
      if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        const headers = corsHeadersFor(requestWithId, env);
        return withRequestIdOnResponse(
          headers
            ? new Response(null, { status: 204, headers })
            : new Response(null, { status: 403 }),
          requestId,
          requestWithId,
          env,
        );
      }

      // GitHub-identity session gate — the universal /api/* auth (auth rework
      // step 3; the X-Push-Deployment-Token gate it replaced is retired). Returns
      // a 401 Response when ENFORCE is on and the request lacks a valid
      // allowlisted session on a gated path; null otherwise.
      const sessionAuthResponse = await requireSessionForGatedApi(requestWithId, env, url);
      if (sessionAuthResponse) {
        return withRequestIdOnResponse(sessionAuthResponse, requestId, requestWithId, env);
      }

      const exactRoute = matchExactApiRoute(url.pathname, request.method);
      if (exactRoute) {
        return withRequestIdOnResponse(
          await exactRoute.handler(requestWithId, env, ctx),
          requestId,
          requestWithId,
          env,
        );
      }

      // API route: sandbox proxy. PUSH_SANDBOX_PROVIDER (via wrangler vars)
      // selects the /api/sandbox/* backend. Cloudflare Sandbox SDK is the
      // default; Modal remains available by setting PUSH_SANDBOX_PROVIDER=modal.
      // Browser/Worker callers have no process.env, so the toggle has to live
      // server-side for the selector to actually select anything.
      if (url.pathname.startsWith('/api/sandbox/') && request.method === 'POST') {
        const route = url.pathname.replace('/api/sandbox/', '');
        const useCf = (env.PUSH_SANDBOX_PROVIDER ?? 'cloudflare').toLowerCase() === 'cloudflare';
        const handler = useCf ? handleCloudflareSandbox : handleSandbox;
        return withRequestIdOnResponse(
          await handler(requestWithId, env, url, route, ctx),
          requestId,
          requestWithId,
          env,
        );
      }

      // Background-jobs DO routes — Phase 1 of Background Coder Tasks.
      const jobsMatch = matchJobsRoute(url.pathname, request.method);
      if (jobsMatch) {
        return withRequestIdOnResponse(
          await handleJobsRoute(requestWithId, env, jobsMatch),
          requestId,
          requestWithId,
          env,
        );
      }

      // PR review history + manual re-run — forward to the PrReviewJob DO.
      const prReviewAction = matchPrReviewRoute(url.pathname, request.method);
      if (prReviewAction) {
        return withRequestIdOnResponse(
          await handlePrReviewRoute(requestWithId, env, prReviewAction, ctx),
          requestId,
          requestWithId,
          env,
        );
      }

      // Unified web settings — one identity-keyed KV doc behind the session
      // gate. See docs/decisions §11 (Settings unify behind GitHub identity).
      const settingsAction = matchSettingsRoute(url.pathname, request.method);
      if (settingsAction) {
        return withRequestIdOnResponse(
          await handleSettingsRoute(requestWithId, env, settingsAction),
          requestId,
          requestWithId,
          env,
        );
      }

      // Durable Runs — RunHost DO endpoints: the Phase 2 run ledger
      // (/api/runhost/run/*) and the Phase 0 latency spike (/api/runhost/spike/*).
      const runHostAction = matchRunHostRoute(url.pathname, request.method);
      if (runHostAction) {
        return withRequestIdOnResponse(
          await handleRunHostRoute(requestWithId, env, runHostAction),
          requestId,
          requestWithId,
          env,
        );
      }

      // Remote Sessions relay — Phase 2.b scaffold. Gated by
      // PUSH_RELAY_ENABLED=1; otherwise the route returns 503 NOT_ENABLED.
      const relayMatch = matchRelayRoute(url.pathname, request.method);
      if (relayMatch) {
        return withRequestIdOnResponse(
          await handleRelayRequest(requestWithId, env, relayMatch),
          requestId,
          requestWithId,
          env,
        );
      }

      // Explicit-path alternative — forces Cloudflare regardless of the var.
      // Useful for side-by-side A/B testing and debugging without a redeploy.
      if (url.pathname.startsWith('/api/sandbox-cf/') && request.method === 'POST') {
        const route = url.pathname.replace('/api/sandbox-cf/', '');
        return withRequestIdOnResponse(
          await handleCloudflareSandbox(requestWithId, env, url, route, ctx),
          requestId,
          requestWithId,
          env,
        );
      }

      // SPA fallback: serve index.html for non-file paths
      // (actual static files like .js/.css are already served by the [assets] layer)
      return withRequestIdOnResponse(
        await env.ASSETS.fetch(new Request(new URL('/index.html', requestWithId.url))),
        requestId,
        requestWithId,
        env,
      );
    } catch (err) {
      // Wrap so the 500 carries CORS headers — without them a route-handler
      // crash surfaces to the browser as an opaque CORS error instead of the
      // structured 500 + request_id, swallowing diagnostics on mobile.
      return withRequestIdOnResponse(
        handleUncaughtFetchError(err, request, requestId),
        requestId,
        request,
        env,
      );
    }
  },

  /**
   * Daily cron — walk the snapshot index and emit metrics, then reap orphaned
   * R2 snapshot objects.
   *
   * Triggered by the `triggers.crons` schedule in wrangler.jsonc. KV's TTL
   * auto-evicts index entries after 7 days, but R2 objects don't expire on
   * their own — so this also reaps any `cf-snapshots/*` object no longer
   * referenced by a live index entry (e.g. a TTL-expired entry, or an
   * anonymous snapshot), which is the R2-backed counterpart to KV's TTL.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.SNAPSHOT_INDEX) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'snapshot_index_cron_skipped',
          reason: 'no_binding',
          cron: event.cron,
        }),
      );
      return;
    }
    ctx.waitUntil(
      (async () => {
        try {
          const metrics = await summarizeSnapshotIndex(env.SNAPSHOT_INDEX!);
          console.log(
            JSON.stringify({
              level: 'info',
              event: 'snapshot_index_cron',
              cron: event.cron,
              ...metrics,
            }),
          );
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'snapshot_index_cron_error',
              cron: event.cron,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }

        // Reap orphaned R2 snapshot objects (no-op when the R2 binding is
        // absent, e.g. a Modal-only deployment). Independent of the metrics
        // pass — a failure in one shouldn't suppress the other.
        if (env.SNAPSHOTS) {
          try {
            const reaped = await reapOrphanedSnapshots(
              env.SNAPSHOT_INDEX!,
              env.SNAPSHOTS,
              SNAPSHOT_KEY_PREFIX,
            );
            console.log(
              JSON.stringify({
                level: 'info',
                event: 'snapshot_reap_cron',
                cron: event.cron,
                ...reaped,
              }),
            );
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'snapshot_reap_cron_error',
                cron: event.cron,
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      })(),
    );
  },
};

// ---------------------------------------------------------------------------
// Top-level error handler
// ---------------------------------------------------------------------------

/**
 * Last-resort handler for anything that escapes a route handler. Logs a
 * structured line so the OTLP collector / wrangler tail can pick it up, then
 * returns a 500 carrying the request ID so the client can correlate.
 */
function handleUncaughtFetchError(err: unknown, request: Request, requestId: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // Single-line JSON keeps this parseable by structured log sinks.
  console.error(
    JSON.stringify({
      level: 'error',
      source: 'worker.fetch',
      request_id: requestId,
      url: sanitizeUrlForLogging(request.url),
      method: request.method,
      error: message,
      ...(stack ? { stack } : {}),
    }),
  );
  return new Response(
    JSON.stringify({
      error: 'Internal Server Error',
      request_id: requestId,
    }),
    {
      status: 500,
      headers: {
        'content-type': 'application/json',
        [REQUEST_ID_HEADER]: requestId,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Request ID helpers
// ---------------------------------------------------------------------------

function withRequestIdOnRequest(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Request(request, { headers });
}

function withRequestIdOnResponse(
  response: Response,
  requestId: string,
  request?: Request,
  env?: Env,
): Response {
  // WebSocket upgrade responses (101) carry Cloudflare's non-standard
  // `webSocket` init prop on the underlying response. Rewrapping via
  // `new Response(body, { status, headers })` drops that prop and
  // breaks the upgrade silently. There is also no client-visible
  // request-id surface on a WS upgrade — the headers we'd add don't
  // reach the JS WebSocket client. Pass through unmodified.
  if (response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  if (request && env) {
    const cors = corsHeadersFor(request, env);
    if (cors) {
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
    }
  }
  applySecurityHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------

type ExactApiRoute = {
  path: string;
  method: 'GET' | 'POST';
  // `ctx` is threaded so a handler can defer best-effort work past its response
  // via `ctx.waitUntil` (the webhook reaction ack); handlers that don't need it
  // simply ignore the extra arg.
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
};

const EXACT_API_ROUTES: ExactApiRoute[] = [
  { path: '/api/_stats', method: 'GET', handler: handleStats },
  {
    path: '/api/health',
    method: 'GET',
    handler: (request, env) => handleHealthCheck(env, request),
  },
  {
    path: '/api/auth-probe',
    method: 'GET',
    handler: () =>
      Promise.resolve(Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })),
  },
  { path: '/api/github/app-token', method: 'POST', handler: handleGitHubAppToken },
  { path: '/api/github/repo-coverage', method: 'POST', handler: handleRepoCoverage },
  { path: '/api/github/app-oauth', method: 'POST', handler: handleGitHubAppOAuth },
  { path: '/api/github/app-logout', method: 'POST', handler: handleGitHubAppLogout },
  { path: '/api/github/tools', method: 'POST', handler: handleGitHubTools },
  // GitHub App webhook — autonomous PR-review trigger. Authenticated by HMAC
  // signature (not the deployment token — see isDeploymentTokenExemptPath), so
  // it does no origin check and forwards to the PrReviewJob DO.
  { path: '/api/github/webhook', method: 'POST', handler: handleGitHubWebhook },
  // Artifacts — all POST so scope + args ride in the JSON body. See
  // app/src/worker/worker-artifacts.ts for the request/response shape.
  { path: '/api/artifacts/create', method: 'POST', handler: handleArtifactsCreate },
  { path: '/api/artifacts/list', method: 'POST', handler: handleArtifactsList },
  { path: '/api/artifacts/get', method: 'POST', handler: handleArtifactsGet },
  { path: '/api/artifacts/delete', method: 'POST', handler: handleArtifactsDelete },
  // Semantic memory embeddings — turns text into BGE vectors via env.AI for
  // context-memory retrieval. See app/src/worker/worker-memory-embed.ts.
  { path: '/api/memory/embed', method: 'POST', handler: handleMemoryEmbed },
  // Chat library — user-managed bundles (v2a). Collections + items live
  // under separate route tiers; see worker-chat-library.ts.
  { path: '/api/library/collections/create', method: 'POST', handler: handleCollectionsCreate },
  { path: '/api/library/collections/list', method: 'POST', handler: handleCollectionsList },
  { path: '/api/library/collections/get', method: 'POST', handler: handleCollectionsGet },
  { path: '/api/library/collections/update', method: 'POST', handler: handleCollectionsUpdate },
  { path: '/api/library/collections/delete', method: 'POST', handler: handleCollectionsDelete },
  { path: '/api/library/items/create', method: 'POST', handler: handleItemsCreate },
  { path: '/api/library/items/update', method: 'POST', handler: handleItemsUpdate },
  { path: '/api/library/items/delete', method: 'POST', handler: handleItemsDelete },
  // Per-provider "can the durable engine dispatch this server-side?" booleans.
  // The client folds this into engine-routing eligibility so turns on
  // Settings-key-only providers stay on the foreground loop instead of
  // 401-ing in the CoderJob DO. See worker-provider-capabilities.ts.
  {
    path: '/api/providers/engine-capabilities',
    method: 'GET',
    handler: handleProviderEngineCapabilities,
  },
  ...WORKER_PROVIDER_API_ROUTES,
  { path: '/api/zen/go/chat', method: 'POST', handler: handleZenGoChat },
  { path: '/api/zen/go/models', method: 'GET', handler: handleZenGoModels },
  { path: '/api/ollama/search', method: 'POST', handler: handleOllamaSearch },
  { path: '/api/google/search', method: 'POST', handler: handleGoogleSearch },
  { path: '/api/search/tavily', method: 'POST', handler: handleTavilySearch },
  { path: '/api/search', method: 'POST', handler: handleFreeSearch },
  { path: '/api/admin/snapshots', method: 'GET', handler: handleAdminSnapshots },
];

function matchExactApiRoute(pathname: string, method: string): ExactApiRoute | null {
  return (
    EXACT_API_ROUTES.find((route) => route.path === pathname && route.method === method) ?? null
  );
}
