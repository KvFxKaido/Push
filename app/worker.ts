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
  requireDeploymentTokenForApi,
} from './src/worker/worker-middleware';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from './src/lib/request-id';

import {
  handleCloudflareChat,
  handleCloudflareModels,
  handleOllamaChat,
  handleOllamaModels,
  handleOllamaSearch,
  handleOpenRouterChat,
  handleOpenRouterModels,
  handleZenChat,
  handleZenModels,
  handleZenGoChat,
  handleZenGoModels,
  handleKiloCodeChat,
  handleKiloCodeModels,
  handleOpenAdapterChat,
  handleOpenAdapterModels,
  handleNvidiaChat,
  handleNvidiaModels,
  handleBlackboxChat,
  handleBlackboxModels,
  handleAzureChat,
  handleAzureModels,
  handleBedrockChat,
  handleBedrockModels,
  handleVertexChat,
  handleVertexModels,
  handleAnthropicChat,
  handleTavilySearch,
  handleFreeSearch,
} from './src/worker/worker-providers';

import {
  handleSandbox,
  handleHealthCheck,
  handleGitHubAppOAuth,
  handleGitHubAppToken,
  handleGitHubAppLogout,
} from './src/worker/worker-infra';
import { handleCloudflareSandbox } from './src/worker/worker-cf-sandbox';
import { handleGitHubTools } from './src/worker/worker-github-tools';
import { sanitizeUrlForLogging } from './src/worker/worker-log-utils';
import { summarizeSnapshotIndex } from './src/worker/snapshot-index';
import { handleAdminSnapshots } from './src/worker/admin-routes';
import { handleJobsRoute, matchJobsRoute } from './src/worker/worker-coder-job';
import { handleRelayRequest, matchRelayRoute } from './src/worker/relay-routes';
import { handleStats } from './src/worker/worker-stats';
import {
  handleArtifactsCreate,
  handleArtifactsDelete,
  handleArtifactsGet,
  handleArtifactsList,
} from './src/worker/worker-artifacts';

// Re-export the Sandbox Durable Object class so wrangler can bind to it.
// The Cloudflare Sandbox SDK ships the DO implementation; we only need to
// expose the class symbol from the Worker entry. Subclass here later if we
// need outbound handlers (outboundByHost) or custom lifecycle hooks.
export { Sandbox } from '@cloudflare/sandbox';

// Background-jobs DO — Phase 1 of Background Coder Tasks.
export { CoderJob } from './src/worker/coder-job-do';

// Remote Sessions relay DO — Phase 2.b scaffold. Bound as `RELAY_SESSIONS`
// in wrangler.jsonc; routes live in `relay-routes.ts`.
export { RelaySessionDO } from './src/worker/relay-do';

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

      const deploymentAuthResponse = requireDeploymentTokenForApi(requestWithId, env, url);
      if (deploymentAuthResponse) {
        return withRequestIdOnResponse(deploymentAuthResponse, requestId, requestWithId, env);
      }

      const exactRoute = matchExactApiRoute(url.pathname, request.method);
      if (exactRoute) {
        return withRequestIdOnResponse(
          await exactRoute.handler(requestWithId, env),
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
   * Daily cron — walk the snapshot index and emit metrics.
   *
   * Triggered by the `triggers.crons` schedule in wrangler.jsonc. KV's TTL
   * already evicts entries older than 7 days; this handler just observes
   * what's left so we can tune per-user caps once user identity lands in
   * the index keys (Modal Sandbox Snapshots Design §6).
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
  handler: (request: Request, env: Env) => Promise<Response>;
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
  { path: '/api/github/app-oauth', method: 'POST', handler: handleGitHubAppOAuth },
  { path: '/api/github/app-logout', method: 'POST', handler: handleGitHubAppLogout },
  { path: '/api/github/tools', method: 'POST', handler: handleGitHubTools },
  // Artifacts — all POST so scope + args ride in the JSON body. See
  // app/src/worker/worker-artifacts.ts for the request/response shape.
  { path: '/api/artifacts/create', method: 'POST', handler: handleArtifactsCreate },
  { path: '/api/artifacts/list', method: 'POST', handler: handleArtifactsList },
  { path: '/api/artifacts/get', method: 'POST', handler: handleArtifactsGet },
  { path: '/api/artifacts/delete', method: 'POST', handler: handleArtifactsDelete },
  { path: '/api/ollama/chat', method: 'POST', handler: handleOllamaChat },
  { path: '/api/ollama/models', method: 'GET', handler: handleOllamaModels },
  { path: '/api/openrouter/chat', method: 'POST', handler: handleOpenRouterChat },
  { path: '/api/openrouter/models', method: 'GET', handler: handleOpenRouterModels },
  { path: '/api/cloudflare/chat', method: 'POST', handler: handleCloudflareChat },
  { path: '/api/cloudflare/models', method: 'GET', handler: handleCloudflareModels },
  { path: '/api/zen/chat', method: 'POST', handler: handleZenChat },
  { path: '/api/zen/models', method: 'GET', handler: handleZenModels },
  { path: '/api/zen/go/chat', method: 'POST', handler: handleZenGoChat },
  { path: '/api/zen/go/models', method: 'GET', handler: handleZenGoModels },
  { path: '/api/nvidia/chat', method: 'POST', handler: handleNvidiaChat },
  { path: '/api/nvidia/models', method: 'GET', handler: handleNvidiaModels },
  { path: '/api/blackbox/chat', method: 'POST', handler: handleBlackboxChat },
  { path: '/api/blackbox/models', method: 'GET', handler: handleBlackboxModels },
  { path: '/api/kilocode/chat', method: 'POST', handler: handleKiloCodeChat },
  { path: '/api/kilocode/models', method: 'GET', handler: handleKiloCodeModels },
  { path: '/api/openadapter/chat', method: 'POST', handler: handleOpenAdapterChat },
  { path: '/api/openadapter/models', method: 'GET', handler: handleOpenAdapterModels },
  { path: '/api/azure/chat', method: 'POST', handler: handleAzureChat },
  { path: '/api/azure/models', method: 'GET', handler: handleAzureModels },
  { path: '/api/bedrock/chat', method: 'POST', handler: handleBedrockChat },
  { path: '/api/bedrock/models', method: 'GET', handler: handleBedrockModels },
  { path: '/api/vertex/chat', method: 'POST', handler: handleVertexChat },
  { path: '/api/vertex/models', method: 'GET', handler: handleVertexModels },
  { path: '/api/anthropic/chat', method: 'POST', handler: handleAnthropicChat },
  { path: '/api/ollama/search', method: 'POST', handler: handleOllamaSearch },
  { path: '/api/search/tavily', method: 'POST', handler: handleTavilySearch },
  { path: '/api/search', method: 'POST', handler: handleFreeSearch },
  { path: '/api/admin/snapshots', method: 'GET', handler: handleAdminSnapshots },
];

function matchExactApiRoute(pathname: string, method: string): ExactApiRoute | null {
  return (
    EXACT_API_ROUTES.find((route) => route.path === pathname && route.method === method) ?? null
  );
}
