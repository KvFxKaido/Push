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

import type { Env } from './src/worker/worker-middleware';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from './src/lib/request-id';

import {
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
  handleTavilySearch,
  handleFreeSearch,
} from './src/worker/worker-providers';

import {
  handleSandbox,
  handleHealthCheck,
  handleGitHubAppOAuth,
  handleGitHubAppToken,
} from './src/worker/worker-infra';
import { handleGitHubTools } from './src/worker/worker-github-tools';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
    const requestWithId = withRequestIdOnRequest(request, requestId);
    const url = new URL(requestWithId.url);
    const exactRoute = matchExactApiRoute(url.pathname, request.method);
    if (exactRoute) {
      return withRequestIdOnResponse(await exactRoute.handler(requestWithId, env), requestId);
    }

    // API route: sandbox proxy to Modal
    if (url.pathname.startsWith('/api/sandbox/') && request.method === 'POST') {
      const route = url.pathname.replace('/api/sandbox/', '');
      return withRequestIdOnResponse(await handleSandbox(requestWithId, env, url, route), requestId);
    }

    // SPA fallback: serve index.html for non-file paths
    // (actual static files like .js/.css are already served by the [assets] layer)
    return withRequestIdOnResponse(
      await env.ASSETS.fetch(new Request(new URL('/index.html', requestWithId.url))),
      requestId,
    );
  },
};

// ---------------------------------------------------------------------------
// Request ID helpers
// ---------------------------------------------------------------------------

function withRequestIdOnRequest(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Request(request, { headers });
}

function withRequestIdOnResponse(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
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
  { path: '/api/health', method: 'GET', handler: (_request, env) => handleHealthCheck(env) },
  { path: '/api/github/app-token', method: 'POST', handler: handleGitHubAppToken },
  { path: '/api/github/app-oauth', method: 'POST', handler: handleGitHubAppOAuth },
  { path: '/api/github/tools', method: 'POST', handler: handleGitHubTools },
  { path: '/api/ollama/chat', method: 'POST', handler: handleOllamaChat },
  { path: '/api/ollama/models', method: 'GET', handler: handleOllamaModels },
  { path: '/api/openrouter/chat', method: 'POST', handler: handleOpenRouterChat },
  { path: '/api/openrouter/models', method: 'GET', handler: handleOpenRouterModels },
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
  { path: '/api/ollama/search', method: 'POST', handler: handleOllamaSearch },
  { path: '/api/search/tavily', method: 'POST', handler: handleTavilySearch },
  { path: '/api/search', method: 'POST', handler: handleFreeSearch },
];

function matchExactApiRoute(pathname: string, method: string): ExactApiRoute | null {
  return EXACT_API_ROUTES.find((route) => route.path === pathname && route.method === method) ?? null;
}
