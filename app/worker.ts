/**
 * Cloudflare Worker — serves the Vite app + streaming proxy to AI providers.
 *
 * Static assets in ./dist are served directly by the [assets] layer.
 * Only unmatched requests (like /api/ollama/chat) reach this Worker.
 */

import { SANDBOX_ROUTES, resolveModalSandboxBase } from './src/lib/sandbox-routes';

interface Env {
  OLLAMA_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  ZAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  ZEN_API_KEY?: string;
  MODAL_SANDBOX_BASE_URL?: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  ALLOWED_ORIGINS?: string;
  ASSETS: Fetcher;
  RATE_LIMITER: RateLimit;
  // GitHub App credentials
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_ALLOWED_INSTALLATION_IDS?: string;
  // GitHub App OAuth (for auto-connect flow)
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
}

const MAX_BODY_SIZE_BYTES = 512 * 1024; // 512KB default
const RESTORE_MAX_BODY_SIZE_BYTES = 12 * 1024 * 1024; // 12MB for snapshot restore payloads

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API route: health check endpoint
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return handleHealthCheck(env);
    }

    // API route: GitHub App token exchange
    if (url.pathname === '/api/github/app-token' && request.method === 'POST') {
      return handleGitHubAppToken(request, env);
    }

    // API route: GitHub App OAuth auto-connect (code → user token → find installation → installation token)
    if (url.pathname === '/api/github/app-oauth' && request.method === 'POST') {
      return handleGitHubAppOAuth(request, env);
    }

    // API route: streaming proxy to Ollama Cloud (SSE, OpenAI-compatible)
    if (url.pathname === '/api/ollama/chat' && request.method === 'POST') {
      return handleOllamaChat(request, env);
    }

    // API route: model catalog proxy to Ollama Cloud
    if (url.pathname === '/api/ollama/models' && request.method === 'GET') {
      return handleOllamaModels(request, env);
    }

    // API route: streaming proxy to Mistral Vibe (SSE, OpenAI-compatible)
    if (url.pathname === '/api/mistral/chat' && request.method === 'POST') {
      return handleMistralChat(request, env);
    }

    // API route: model catalog proxy to Mistral
    if (url.pathname === '/api/mistral/models' && request.method === 'GET') {
      return handleMistralModels(request, env);
    }

    // API route: streaming proxy to OpenRouter (SSE, OpenAI-compatible)
    if (url.pathname === '/api/openrouter/chat' && request.method === 'POST') {
      return handleOpenRouterChat(request, env);
    }

    // API route: model catalog proxy to OpenRouter
    if (url.pathname === '/api/openrouter/models' && request.method === 'GET') {
      return handleOpenRouterModels(request, env);
    }

    // API route: streaming proxy to MiniMax (SSE, OpenAI-compatible)
    if (url.pathname === '/api/minimax/chat' && request.method === 'POST') {
      return handleMinimaxChat(request, env);
    }

    // API route: model catalog proxy to MiniMax
    if (url.pathname === '/api/minimax/models' && request.method === 'GET') {
      return handleMinimaxModels(request, env);
    }

    // API route: streaming proxy to Z.AI (SSE, OpenAI-compatible)
    if (url.pathname === '/api/zai/chat' && request.method === 'POST') {
      return handleZaiChat(request, env);
    }

    // API route: model catalog proxy to Z.AI
    if (url.pathname === '/api/zai/models' && request.method === 'GET') {
      return handleZaiModels(request, env);
    }

    // API route: streaming proxy to Google Gemini OpenAI-compatible endpoint
    if (url.pathname === '/api/google/chat' && request.method === 'POST') {
      return handleGoogleChat(request, env);
    }

    // API route: model catalog proxy to Google Gemini OpenAI-compatible endpoint
    if (url.pathname === '/api/google/models' && request.method === 'GET') {
      return handleGoogleModels(request, env);
    }

    // API route: streaming proxy to OpenCode Zen (SSE, OpenAI-compatible)
    if (url.pathname === '/api/zen/chat' && request.method === 'POST') {
      return handleZenChat(request, env);
    }

    // API route: model catalog proxy to OpenCode Zen
    if (url.pathname === '/api/zen/models' && request.method === 'GET') {
      return handleZenModels(request, env);
    }

    // API route: Ollama web search proxy
    if (url.pathname === '/api/ollama/search' && request.method === 'POST') {
      return handleOllamaSearch(request, env);
    }

    // API route: Mistral agent creation proxy
    if (url.pathname === '/api/mistral/agents' && request.method === 'POST') {
      return handleMistralAgentCreate(request, env);
    }

    // API route: Mistral agent completions streaming proxy
    if (url.pathname === '/api/mistral/agents/chat' && request.method === 'POST') {
      return handleMistralAgentChat(request, env);
    }

    // API route: Tavily web search proxy (optional premium upgrade)
    if (url.pathname === '/api/search/tavily' && request.method === 'POST') {
      return handleTavilySearch(request, env);
    }

    // API route: free web search (DuckDuckGo HTML scraping — no API key needed)
    if (url.pathname === '/api/search' && request.method === 'POST') {
      return handleFreeSearch(request, env);
    }

    // API route: sandbox proxy to Modal
    if (url.pathname.startsWith('/api/sandbox/') && request.method === 'POST') {
      const route = url.pathname.replace('/api/sandbox/', '');
      return handleSandbox(request, env, url, route);
    }

    // SPA fallback: serve index.html for non-file paths
    // (actual static files like .js/.css are already served by the [assets] layer)
    return env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
  },
};

function normalizeOrigin(value: string | null): string | null {
  if (!value || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins(requestUrl: URL, env: Env): Set<string> {
  const allowed = new Set<string>([requestUrl.origin]);
  const raw = env.ALLOWED_ORIGINS;
  if (raw) {
    for (const entry of raw.split(',')) {
      const normalized = normalizeOrigin(entry.trim());
      if (normalized) {
        allowed.add(normalized);
      }
    }
  }
  return allowed;
}

function validateOrigin(request: Request, requestUrl: URL, env: Env): { ok: boolean; error?: string } {
  const origin = normalizeOrigin(request.headers.get('Origin'));
  const refererOrigin = normalizeOrigin(request.headers.get('Referer'));
  const candidates = [origin, refererOrigin].filter(Boolean) as string[];

  if (candidates.length === 0) {
    return { ok: false, error: 'Missing or invalid Origin/Referer' };
  }

  const allowedOrigins = getAllowedOrigins(requestUrl, env);
  const allowed = candidates.some((candidate) => allowedOrigins.has(candidate));
  if (!allowed) {
    return { ok: false, error: 'Origin not allowed' };
  }

  return { ok: true };
}

function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

function wlog(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, event, ts: new Date().toISOString(), ...data });
  if (level === 'error') {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

async function readBodyText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, status: 413, error: 'Request body too large' };
    }
  }

  if (!request.body) {
    return { ok: false, status: 400, error: 'Missing request body' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      return { ok: false, status: 413, error: 'Request body too large' };
    }
    chunks.push(value);
  }

  if (received === 0) {
    return { ok: false, status: 400, error: 'Empty request body' };
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder().decode(merged) };
}

// ---------------------------------------------------------------------------
// Shared handler preamble — origin check, rate limit, auth, optional body
// ---------------------------------------------------------------------------

type AuthBuilder = (env: Env, request: Request) => Promise<string | null> | (string | null);

interface PreambleOk {
  authHeader: string;
  bodyText: string;
}

async function runPreamble(
  request: Request,
  env: Env,
  opts: {
    buildAuth: AuthBuilder;
    keyMissingError?: string;
    needsBody?: boolean;
    maxBodyBytes?: number;
  },
): Promise<Response | PreambleOk> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', { ip: getClientIp(request), path: new URL(request.url).pathname });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const authHeader = await opts.buildAuth(env, request);
  if (!authHeader && opts.keyMissingError) {
    return Response.json({ error: opts.keyMissingError }, { status: 401 });
  }

  let bodyText = '';
  if (opts.needsBody !== false) {
    const bodyResult = await readBodyText(request, opts.maxBodyBytes ?? MAX_BODY_SIZE_BYTES);
    if (!bodyResult.ok) {
      return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
    }
    bodyText = bodyResult.text;
  }

  return { authHeader: authHeader ?? '', bodyText };
}

function standardAuth(envKey: keyof Env): AuthBuilder {
  return (env, request) => {
    const serverKey = env[envKey] as string | undefined;
    const clientAuth = request.headers.get('Authorization');
    return serverKey ? `Bearer ${serverKey}` : clientAuth;
  };
}

// ---------------------------------------------------------------------------
// Stream proxy factory — for SSE chat endpoints
// ---------------------------------------------------------------------------

interface StreamProxyConfig {
  name: string;
  logTag: string;
  upstreamUrl: string | ((request: Request) => string);
  timeoutMs: number;
  buildAuth: AuthBuilder;
  keyMissingError: string;
  timeoutError: string;
  extraFetchHeaders?: Record<string, string> | ((request: Request) => Record<string, string>);
  preserveUpstreamHeaders?: boolean;
}

function createStreamProxyHandler(
  config: StreamProxyConfig,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const preamble = await runPreamble(request, env, {
      buildAuth: config.buildAuth,
      keyMissingError: config.keyMissingError,
      needsBody: true,
    });
    if (preamble instanceof Response) return preamble;
    const { authHeader, bodyText } = preamble;

    wlog('info', 'request', { route: config.logTag, bytes: bodyText.length });

    const upstreamUrl = typeof config.upstreamUrl === 'function'
      ? config.upstreamUrl(request)
      : config.upstreamUrl;

    const extraHeaders = typeof config.extraFetchHeaders === 'function'
      ? config.extraFetchHeaders(request)
      : (config.extraFetchHeaders ?? {});

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
      let upstream: Response;

      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            ...extraHeaders,
          },
          body: bodyText,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      wlog('info', 'upstream_ok', { route: config.logTag, status: upstream.status });

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        wlog('error', 'upstream_error', { route: config.logTag, status: upstream.status, body: errBody.slice(0, 500) });
        // Strip HTML error pages (e.g. Cloudflare 403/503 pages) — return a clean message
        const isHtml = /<\s*html[\s>]/i.test(errBody) || /<\s*!doctype/i.test(errBody);
        const errDetail = isHtml
          ? `HTTP ${upstream.status} (the server returned an HTML error page instead of JSON)`
          : errBody.slice(0, 200);
        return Response.json(
          { error: `${config.name} API error ${upstream.status}: ${errDetail}` },
          { status: upstream.status },
        );
      }

      if (config.preserveUpstreamHeaders) {
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      // Standard SSE streaming
      if (upstream.body) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // Non-streaming fallback
      const data: unknown = await upstream.json();
      return Response.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const status = isTimeout ? 504 : 502;
      const error = isTimeout ? config.timeoutError : message;
      wlog('error', 'unhandled', { route: config.logTag, message, timeout: isTimeout });
      return Response.json({ error }, { status });
    }
  };
}

// ---------------------------------------------------------------------------
// JSON proxy factory — for model lists, search, agent creation
// ---------------------------------------------------------------------------

interface JsonProxyConfig {
  name: string;
  logTag: string;
  upstreamUrl: string;
  method?: 'GET' | 'POST';
  timeoutMs: number;
  buildAuth: AuthBuilder;
  keyMissingError: string;
  timeoutError: string;
  needsBody?: boolean;
  extraFetchHeaders?: Record<string, string>;
}

function createJsonProxyHandler(
  config: JsonProxyConfig,
): (request: Request, env: Env) => Promise<Response> {
  const method = config.method ?? 'POST';
  const needsBody = config.needsBody ?? (method === 'POST');

  return async (request, env) => {
    const preamble = await runPreamble(request, env, {
      buildAuth: config.buildAuth,
      keyMissingError: config.keyMissingError,
      needsBody,
    });
    if (preamble instanceof Response) return preamble;
    const { authHeader, bodyText } = preamble;

    wlog('info', 'request', { route: config.logTag, ...(needsBody ? { bytes: bodyText.length } : {}) });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
      let upstream: Response;

      try {
        const fetchInit: RequestInit = {
          method,
          headers: {
            'Authorization': authHeader,
            ...(needsBody ? { 'Content-Type': 'application/json' } : {}),
            ...(config.extraFetchHeaders ?? {}),
          },
          signal: controller.signal,
        };
        if (needsBody) fetchInit.body = bodyText;
        upstream = await fetch(config.upstreamUrl, fetchInit);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        wlog('error', 'upstream_error', { route: config.logTag, status: upstream.status, body: errBody.slice(0, 500) });
        return Response.json(
          { error: `${config.name} error ${upstream.status}: ${errBody.slice(0, 200)}` },
          { status: upstream.status },
        );
      }

      const data: unknown = await upstream.json();
      return Response.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const status = isTimeout ? 504 : 500;
      const error = isTimeout ? config.timeoutError : message;
      wlog('error', 'unhandled', { route: config.logTag, message, timeout: isTimeout });
      return Response.json({ error }, { status });
    }
  };
}

async function handleSandbox(request: Request, env: Env, requestUrl: URL, route: string): Promise<Response> {
  const modalFunction = SANDBOX_ROUTES[route];
  if (!modalFunction) {
    return Response.json({ error: `Unknown sandbox route: ${route}` }, { status: 404 });
  }

  const baseUrl = env.MODAL_SANDBOX_BASE_URL;
  if (!baseUrl) {
    return Response.json({
      error: 'Sandbox not configured',
      code: 'MODAL_NOT_CONFIGURED',
      details: 'MODAL_SANDBOX_BASE_URL secret is not set. Run: npx wrangler secret put MODAL_SANDBOX_BASE_URL',
    }, { status: 503 });
  }

  const resolvedBase = resolveModalSandboxBase(baseUrl);
  if (!resolvedBase.ok) {
    return Response.json({
      error: 'Sandbox misconfigured',
      code: resolvedBase.code,
      details: resolvedBase.details,
    }, { status: 503 });
  }

  // Validate origin
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  // Rate limit
  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', { ip: getClientIp(request), path: `api/sandbox/${route}` });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  // Read and forward body
  const maxBodyBytes = route === 'restore' ? RESTORE_MAX_BODY_SIZE_BYTES : MAX_BODY_SIZE_BYTES;
  const bodyResult = await readBodyText(request, maxBodyBytes);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  // Route-specific payload enrichment without changing client contracts.
  let forwardBodyText = bodyResult.text;
  if (
    route === 'read'
    || route === 'write'
    || route === 'list'
    || route === 'delete'
    || route === 'restore'
    || route === 'browser-screenshot'
    || route === 'browser-extract'
  ) {
    try {
      const payload = JSON.parse(bodyResult.text) as Record<string, unknown>;

      if (route === 'read') payload.action = 'read';
      if (route === 'write') payload.action = 'write';
      if (route === 'list') payload.action = 'list';
      if (route === 'delete') payload.action = 'delete';
      if (route === 'restore') payload.action = 'hydrate';

      if (route === 'browser-screenshot' || route === 'browser-extract') {
        payload.browserbase_api_key = env.BROWSERBASE_API_KEY || '';
        payload.browserbase_project_id = env.BROWSERBASE_PROJECT_ID || '';
      }

      forwardBodyText = JSON.stringify(payload);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // Forward to Modal web endpoint
  // Modal web endpoints follow pattern: {base}-{function_name}.modal.run
  const modalUrl = `${resolvedBase.base}-${modalFunction}.modal.run`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    let upstream: Response;

    try {
      upstream = await fetch(modalUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: forwardBodyText,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'modal_error', { route, status: upstream.status, body: errBody.slice(0, 500) });

      // Provide actionable error messages based on status code
      let code = 'MODAL_ERROR';
      let details = errBody.slice(0, 200);
      const lowerBody = errBody.toLowerCase();

      if (upstream.status === 404) {
        code = 'MODAL_NOT_FOUND';
        details = `Modal endpoint not found. The app may not be deployed. Run: cd sandbox && modal deploy app.py`;
      } else if (upstream.status === 401 || upstream.status === 403) {
        code = 'MODAL_AUTH_FAILED';
        details = 'Modal authentication failed. Check that your Modal tokens are valid and the app is deployed under the correct account.';
      } else if (upstream.status === 500) {
        // Parse 500 error bodies for known patterns to give more specific codes
        if (lowerBody.includes('not found') || lowerBody.includes('does not exist') || lowerBody.includes('no such')) {
          code = 'MODAL_NOT_FOUND';
          details = 'Sandbox not found or expired. The container may have been terminated.';
        } else if (lowerBody.includes('terminated') || lowerBody.includes('closed')) {
          code = 'MODAL_NOT_FOUND';
          details = 'Sandbox has been terminated. Start a new sandbox session.';
        } else if (lowerBody.includes('timeout') || lowerBody.includes('timed out')) {
          code = 'MODAL_TIMEOUT';
          details = 'Modal operation timed out internally.';
        } else {
          details = errBody.slice(0, 200) || 'Internal Server Error';
        }
      } else if (upstream.status === 502 || upstream.status === 503) {
        code = 'MODAL_UNAVAILABLE';
        details = 'Modal is temporarily unavailable. The container may be cold-starting. Try again in a few seconds.';
      } else if (upstream.status === 504) {
        code = 'MODAL_TIMEOUT';
        details = 'Modal request timed out. The operation took too long to complete.';
      }

      return Response.json(
        { error: `Sandbox error (${upstream.status})`, code, details },
        { status: upstream.status },
      );
    }

    const data: unknown = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'sandbox_error', { route, message, timeout: isTimeout });

    if (isTimeout) {
      return Response.json({
        error: 'Sandbox request timed out',
        code: 'MODAL_TIMEOUT',
        details: 'The sandbox took longer than 60 seconds to respond. Try a simpler operation or check Modal dashboard for issues.',
      }, { status: 504 });
    }

    // Check for common network errors
    const isNetworkError = message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('network');
    if (isNetworkError) {
      return Response.json({
        error: 'Cannot reach Modal',
        code: 'MODAL_NETWORK_ERROR',
        details: `Network error connecting to Modal. Check that the MODAL_SANDBOX_BASE_URL is correct and Modal is not experiencing outages. (${message})`,
      }, { status: 502 });
    }

    return Response.json({
      error: 'Sandbox error',
      code: 'MODAL_UNKNOWN_ERROR',
      details: message,
    }, { status: 500 });
  }
}

// --- Health check endpoint ---

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    worker: { status: 'ok' };
    ollama: { status: 'ok' | 'unconfigured'; configured: boolean };
    mistral: { status: 'ok' | 'unconfigured'; configured: boolean };
    openrouter: { status: 'ok' | 'unconfigured'; configured: boolean };
    minimax: { status: 'ok' | 'unconfigured'; configured: boolean };
    zai: { status: 'ok' | 'unconfigured'; configured: boolean };
    google: { status: 'ok' | 'unconfigured'; configured: boolean };
    zen: { status: 'ok' | 'unconfigured'; configured: boolean };
    sandbox: { status: 'ok' | 'unconfigured' | 'misconfigured'; configured: boolean; error?: string };
    github_app: { status: 'ok' | 'unconfigured'; configured: boolean };
    github_app_oauth: { status: 'ok' | 'unconfigured'; configured: boolean };
  };
  version: string;
}

async function handleHealthCheck(env: Env): Promise<Response> {
  const ollamaConfigured = Boolean(env.OLLAMA_API_KEY);
  const mistralConfigured = Boolean(env.MISTRAL_API_KEY);
  const openRouterConfigured = Boolean(env.OPENROUTER_API_KEY);
  const minimaxConfigured = Boolean(env.MINIMAX_API_KEY);
  const zaiConfigured = Boolean(env.ZAI_API_KEY);
  const googleConfigured = Boolean(env.GOOGLE_API_KEY);
  const zenConfigured = Boolean(env.ZEN_API_KEY);
  const sandboxUrl = env.MODAL_SANDBOX_BASE_URL;

  let sandboxStatus: 'ok' | 'unconfigured' | 'misconfigured' = 'unconfigured';
  let sandboxError: string | undefined;

  if (sandboxUrl) {
    const resolvedBase = resolveModalSandboxBase(sandboxUrl);
    if (resolvedBase.ok) {
      sandboxStatus = 'ok';
    } else {
      sandboxStatus = 'misconfigured';
      sandboxError = resolvedBase.details;
    }
  }

  const hasAnyLlm = ollamaConfigured || mistralConfigured || openRouterConfigured || minimaxConfigured || zaiConfigured || googleConfigured || zenConfigured;
  const overallStatus: 'healthy' | 'degraded' | 'unhealthy' =
    hasAnyLlm && sandboxStatus === 'ok' ? 'healthy' :
    hasAnyLlm || sandboxStatus === 'ok' ? 'degraded' : 'unhealthy';

  const health: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      worker: { status: 'ok' },
      ollama: { status: ollamaConfigured ? 'ok' : 'unconfigured', configured: ollamaConfigured },
      mistral: { status: mistralConfigured ? 'ok' : 'unconfigured', configured: mistralConfigured },
      openrouter: { status: openRouterConfigured ? 'ok' : 'unconfigured', configured: openRouterConfigured },
      minimax: { status: minimaxConfigured ? 'ok' : 'unconfigured', configured: minimaxConfigured },
      zai: { status: zaiConfigured ? 'ok' : 'unconfigured', configured: zaiConfigured },
      google: { status: googleConfigured ? 'ok' : 'unconfigured', configured: googleConfigured },
      zen: { status: zenConfigured ? 'ok' : 'unconfigured', configured: zenConfigured },
      sandbox: { status: sandboxStatus, configured: Boolean(sandboxUrl), error: sandboxError },
      github_app: { status: env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? 'ok' : 'unconfigured', configured: Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) },
      github_app_oauth: { status: env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET ? 'ok' : 'unconfigured', configured: Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET) },
    },
    version: '1.0.0',
  };

  return Response.json(health, {
    status: overallStatus === 'unhealthy' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// --- Ollama Cloud ---

const handleOllamaModels = createJsonProxyHandler({
  name: 'Ollama Cloud API', logTag: 'api/ollama/models',
  upstreamUrl: 'https://ollama.com/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError: 'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama Cloud model list timed out after 30 seconds',
});

const handleOllamaChat = createStreamProxyHandler({
  name: 'Ollama Cloud API', logTag: 'api/ollama/chat',
  upstreamUrl: 'https://ollama.com/v1/chat/completions',
  timeoutMs: 180_000,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError: 'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama Cloud request timed out after 180 seconds',
});

// --- Mistral ---

const handleMistralModels = createJsonProxyHandler({
  name: 'Mistral API', logTag: 'api/mistral/models',
  upstreamUrl: 'https://api.mistral.ai/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('MISTRAL_API_KEY'),
  keyMissingError: 'Mistral API key not configured. Add it in Settings or set MISTRAL_API_KEY on the Worker.',
  timeoutError: 'Mistral model list timed out after 30 seconds',
});

const handleMistralChat = createStreamProxyHandler({
  name: 'Mistral API', logTag: 'api/mistral/chat',
  upstreamUrl: 'https://api.mistral.ai/v1/chat/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('MISTRAL_API_KEY'),
  keyMissingError: 'Mistral API key not configured. Add it in Settings or set MISTRAL_API_KEY on the Worker.',
  timeoutError: 'Mistral request timed out after 120 seconds',
});

// --- OpenRouter ---

const handleOpenRouterChat = createStreamProxyHandler({
  name: 'OpenRouter API', logTag: 'api/openrouter/chat',
  upstreamUrl: 'https://openrouter.ai/api/v1/chat/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('OPENROUTER_API_KEY'),
  keyMissingError: 'OpenRouter API key not configured. Add it in Settings or set OPENROUTER_API_KEY on the Worker.',
  timeoutError: 'OpenRouter request timed out after 120 seconds',
  extraFetchHeaders: (request) => ({
    'HTTP-Referer': new URL(request.url).origin,
    'X-Title': 'Push',
  }),
});

const handleOpenRouterModels = createJsonProxyHandler({
  name: 'OpenRouter API', logTag: 'api/openrouter/models',
  upstreamUrl: 'https://openrouter.ai/api/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OPENROUTER_API_KEY'),
  keyMissingError: 'OpenRouter API key not configured. Add it in Settings or set OPENROUTER_API_KEY on the Worker.',
  timeoutError: 'OpenRouter model list timed out after 30 seconds',
});

// --- MiniMax (OpenAI-compatible endpoint) ---

const handleMinimaxChat = createStreamProxyHandler({
  name: 'MiniMax API', logTag: 'api/minimax/chat',
  upstreamUrl: 'https://api.minimax.io/v1/chat/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('MINIMAX_API_KEY'),
  keyMissingError: 'MiniMax API key not configured. Add it in Settings or set MINIMAX_API_KEY on the Worker.',
  timeoutError: 'MiniMax request timed out after 120 seconds',
});

const handleMinimaxModels = createJsonProxyHandler({
  name: 'MiniMax API', logTag: 'api/minimax/models',
  upstreamUrl: 'https://api.minimax.io/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('MINIMAX_API_KEY'),
  keyMissingError: 'MiniMax API key not configured. Add it in Settings or set MINIMAX_API_KEY on the Worker.',
  timeoutError: 'MiniMax model list timed out after 30 seconds',
});

// --- Z.AI (OpenAI-compatible coding endpoint) ---

const handleZaiChat = createStreamProxyHandler({
  name: 'Z.AI API', logTag: 'api/zai/chat',
  upstreamUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('ZAI_API_KEY'),
  keyMissingError: 'Z.AI API key not configured. Add it in Settings or set ZAI_API_KEY on the Worker.',
  timeoutError: 'Z.AI request timed out after 120 seconds',
});

const handleZaiModels = createJsonProxyHandler({
  name: 'Z.AI API', logTag: 'api/zai/models',
  upstreamUrl: 'https://api.z.ai/api/coding/paas/v4/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('ZAI_API_KEY'),
  keyMissingError: 'Z.AI API key not configured. Add it in Settings or set ZAI_API_KEY on the Worker.',
  timeoutError: 'Z.AI model list timed out after 30 seconds',
});

// --- Google Gemini (OpenAI-compatible endpoint) ---

const handleGoogleChat = createStreamProxyHandler({
  name: 'Google Gemini API', logTag: 'api/google/chat',
  upstreamUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('GOOGLE_API_KEY'),
  keyMissingError: 'Google API key not configured. Add it in Settings or set GOOGLE_API_KEY on the Worker.',
  timeoutError: 'Google request timed out after 120 seconds',
});

const handleGoogleModels = createJsonProxyHandler({
  name: 'Google Gemini API', logTag: 'api/google/models',
  upstreamUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('GOOGLE_API_KEY'),
  keyMissingError: 'Google API key not configured. Add it in Settings or set GOOGLE_API_KEY on the Worker.',
  timeoutError: 'Google model list timed out after 30 seconds',
});

// --- OpenCode Zen (OpenAI-compatible endpoint) ---

const handleZenChat = createStreamProxyHandler({
  name: 'OpenCode Zen API', logTag: 'api/zen/chat',
  upstreamUrl: 'https://opencode.ai/zen/v1/chat/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('ZEN_API_KEY'),
  keyMissingError: 'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
  timeoutError: 'OpenCode Zen request timed out after 120 seconds',
});

const handleZenModels = createJsonProxyHandler({
  name: 'OpenCode Zen API', logTag: 'api/zen/models',
  upstreamUrl: 'https://opencode.ai/zen/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('ZEN_API_KEY'),
  keyMissingError: 'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
  timeoutError: 'OpenCode Zen model list timed out after 30 seconds',
});

// --- Ollama Web Search proxy ---

const handleOllamaSearch = createJsonProxyHandler({
  name: 'Ollama search', logTag: 'api/ollama/search',
  upstreamUrl: 'https://ollama.com/api/web_search',
  method: 'POST',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError: 'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama search timed out after 30 seconds',
});

// --- Mistral Agents API proxies ---

const handleMistralAgentCreate = createJsonProxyHandler({
  name: 'Mistral Agents API', logTag: 'api/mistral/agents',
  upstreamUrl: 'https://api.mistral.ai/v1/agents',
  method: 'POST',
  timeoutMs: 30_000,
  buildAuth: standardAuth('MISTRAL_API_KEY'),
  keyMissingError: 'Mistral API key not configured. Add it in Settings or set MISTRAL_API_KEY on the Worker.',
  timeoutError: 'Mistral agent creation timed out after 30 seconds',
});

const handleMistralAgentChat = createStreamProxyHandler({
  name: 'Mistral Agents API', logTag: 'api/mistral/agents/chat',
  upstreamUrl: 'https://api.mistral.ai/v1/agents/completions',
  timeoutMs: 120_000,
  buildAuth: standardAuth('MISTRAL_API_KEY'),
  keyMissingError: 'Mistral API key not configured. Add it in Settings or set MISTRAL_API_KEY on the Worker.',
  timeoutError: 'Mistral agent chat timed out after 120 seconds',
});

// --- Tavily web search proxy (optional premium upgrade) ---

async function handleTavilySearch(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: (_env, req) => {
      const auth = req.headers.get('Authorization');
      return auth; // Tavily key comes from client only
    },
    keyMissingError: 'Missing Tavily API key in Authorization header',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader, bodyText } = preamble;

  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!apiKey) {
    return Response.json({ error: 'Missing Tavily API key in Authorization header' }, { status: 401 });
  }

  let query: string;
  try {
    const parsed = JSON.parse(bodyText) as { query?: string };
    if (!parsed.query || typeof parsed.query !== 'string') {
      return Response.json({ error: 'Missing "query" field' }, { status: 400 });
    }
    query = parsed.query.trim();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  wlog('info', 'search', { provider: 'tavily', query });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    let upstream: Response;

    try {
      upstream = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', { route: 'api/search/tavily', status: upstream.status, body: errBody.slice(0, 200) });
      return Response.json(
        { error: `Tavily returned ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status },
      );
    }

    // Tavily returns { results: [{ title, url, content, score, ... }] }
    // Normalize to our WebSearchResult shape: { title, url, content }
    const data = (await upstream.json()) as {
      results?: { title: string; url: string; content: string; score?: number }[];
    };
    const results = (data.results || []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));

    wlog('info', 'search_results', { provider: 'tavily', query, count: results.length });
    return Response.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? 'Tavily search timed out after 30 seconds' : message;
    wlog('error', 'search_error', { provider: 'tavily', message, timeout: isTimeout });
    return Response.json({ error }, { status });
  }
}

// --- Free web search (DuckDuckGo HTML scraping) ---

/**
 * Parse DuckDuckGo HTML lite search results into structured JSON.
 * The lite page (html.duckduckgo.com/html/) has a simple, stable structure
 * designed for low-bandwidth clients. We extract titles, URLs, and snippets.
 */
function parseDuckDuckGoHTML(html: string): { title: string; url: string; content: string }[] {
  const results: { title: string; url: string; content: string }[] = [];

  // Match result blocks: <a class="result__a" href="URL">TITLE</a>
  // followed by <a class="result__snippet" ...>SNIPPET</a>
  const resultBlockRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  // Collect all result links
  const links: { url: string; title: string }[] = [];
  let match;
  while ((match = resultBlockRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const rawTitle = match[2].replace(/<[^>]*>/g, '').trim();
    if (rawUrl && rawTitle && rawUrl.startsWith('http')) {
      links.push({ url: decodeURIComponent(rawUrl), title: rawTitle });
    }
  }

  // Collect all snippets
  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
  }

  // Pair them up
  for (let i = 0; i < links.length && i < 5; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      content: snippets[i] || '',
    });
  }

  return results;
}

async function handleFreeSearch(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: () => null, // No auth needed for DuckDuckGo
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { bodyText } = preamble;

  let query: string;
  try {
    const parsed = JSON.parse(bodyText) as { query?: string };
    if (!parsed.query || typeof parsed.query !== 'string') {
      return Response.json({ error: 'Missing "query" field' }, { status: 400 });
    }
    query = parsed.query.trim();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  wlog('info', 'search', { provider: 'ddg', query });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    let upstream: Response;

    try {
      upstream = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          method: 'GET',
          headers: { 'User-Agent': 'Push/1.0 (AI Coding Assistant)' },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      return Response.json(
        { error: `DuckDuckGo returned ${upstream.status}` },
        { status: upstream.status },
      );
    }

    const html = await upstream.text();
    const results = parseDuckDuckGoHTML(html);

    wlog('info', 'search_results', { provider: 'ddg', query, count: results.length });
    return Response.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? 'Search timed out after 15 seconds' : message;
    wlog('error', 'search_error', { provider: 'ddg', message, timeout: isTimeout });
    return Response.json({ error }, { status });
  }
}

// --- GitHub App OAuth auto-connect ---

async function handleGitHubAppOAuth(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    return Response.json({ error: 'GitHub App OAuth not configured' }, { status: 500 });
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: 'GitHub App not configured (needed for installation token)' }, { status: 500 });
  }

  const bodyResult = await readBodyText(request, 4096);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let payload: { code?: string };
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const code = payload.code;
  if (!code || typeof code !== 'string') {
    return Response.json({ error: 'Missing code' }, { status: 400 });
  }

  try {
    // Step 1: Exchange OAuth code for user access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => '');
      wlog('error', 'github_oauth_error', { step: 'token_exchange', status: tokenRes.status, body: errBody.slice(0, 300) });
      return Response.json({ error: `GitHub OAuth token exchange failed (${tokenRes.status})` }, { status: 502 });
    }

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };
    if (tokenData.error || !tokenData.access_token) {
      wlog('error', 'github_oauth_error', { step: 'token_parse', error: tokenData.error, description: tokenData.error_description });
      return Response.json({
        error: tokenData.error_description || tokenData.error || 'OAuth token exchange failed',
      }, { status: 400 });
    }

    const userToken = tokenData.access_token;
    let oauthUser: { login: string; avatar_url: string } | null = null;
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Push-App/1.0.0',
        },
      });
      if (userRes.ok) {
        const userData = await userRes.json() as { login?: unknown; avatar_url?: unknown };
        if (typeof userData.login === 'string' && userData.login.trim()) {
          oauthUser = {
            login: userData.login,
            avatar_url: typeof userData.avatar_url === 'string' ? userData.avatar_url : '',
          };
        }
      }
    } catch {
      // Identity enrichment is best-effort and should not block auth.
    }

    // Step 2: Find user's installations for this app
    const installRes = await fetch('https://api.github.com/user/installations', {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    });

    if (!installRes.ok) {
      const errBody = await installRes.text().catch(() => '');
      wlog('error', 'github_oauth_error', { step: 'installations', status: installRes.status, body: errBody.slice(0, 300) });
      return Response.json({ error: `Failed to fetch installations (${installRes.status})` }, { status: 502 });
    }

    const installData = await installRes.json() as {
      total_count: number;
      installations: Array<{
        id: number;
        app_id: number;
        app_slug: string;
        account?: { login?: unknown; avatar_url?: unknown };
      }>;
    };

    // Find installation matching our app
    const appId = Number(env.GITHUB_APP_ID);
    const installation = installData.installations.find((inst) => inst.app_id === appId);

    if (!installation) {
      return Response.json({
        error: 'No installation found',
        details: 'You have not installed the Push Auth GitHub App. Please install it first, then try connecting again.',
        install_url: `https://github.com/apps/push-auth/installations/new`,
      }, { status: 404 });
    }

    const installationId = String(installation.id);
    const installationAccount =
      installation.account && typeof installation.account.login === 'string'
        ? {
            login: installation.account.login,
            avatar_url:
              typeof installation.account.avatar_url === 'string'
                ? installation.account.avatar_url
                : '',
          }
        : null;

    // Step 3: Check allowlist (if configured)
    const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
      return Response.json({ error: 'installation_id is not allowed' }, { status: 403 });
    }

    // Step 4: Exchange for installation token (reuses existing JWT flow)
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const instTokenData = await exchangeForInstallationToken(jwt, installationId);

    const botCommitIdentity = await fetchGitHubAppBotCommitIdentity(installation.app_slug);

    return Response.json({
      token: instTokenData.token,
      expires_at: instTokenData.expires_at,
      installation_id: installationId,
      user: oauthUser || installationAccount,
      commit_identity: botCommitIdentity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    wlog('error', 'github_oauth_error', { step: 'unknown', message });
    return Response.json({ error: `GitHub App OAuth failed: ${message}` }, { status: 500 });
  }
}

// --- GitHub App token exchange ---

async function handleGitHubAppToken(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: 'GitHub App not configured' }, { status: 500 });
  }

  const bodyResult = await readBodyText(request, 4096);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let payload: { installation_id?: string };
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const installationId = payload.installation_id;
  if (!installationId || typeof installationId !== 'string') {
    return Response.json({ error: 'Missing installation_id' }, { status: 400 });
  }

  // Validate installation_id is a positive integer
  if (!/^\d+$/.test(installationId)) {
    return Response.json({ error: 'Invalid installation_id format' }, { status: 400 });
  }

  // Prevent overly long IDs (DoS protection)
  if (installationId.length > 20) {
    return Response.json({ error: 'installation_id too long' }, { status: 400 });
  }

  const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
    return Response.json({ error: 'installation_id is not allowed' }, { status: 403 });
  }

  try {
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const tokenData = await exchangeForInstallationToken(jwt, installationId);
    const installationMeta = await fetchInstallationMetadata(jwt, installationId);
    const botCommitIdentity = await fetchGitHubAppBotCommitIdentity(installationMeta.app_slug);
    return Response.json({
      ...tokenData,
      user: installationMeta.account,
      commit_identity: botCommitIdentity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    wlog('error', 'github_token_error', { message });
    return Response.json({ error: `GitHub App authentication failed: ${message}` }, { status: 500 });
  }
}

async function generateGitHubAppJWT(appId: string, privateKeyPEM: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encodeBase64Url = (data: string | Uint8Array): string => {
    let base64: string;
    if (typeof data === 'string') {
      base64 = btoa(data);
    } else {
      const bytes = Array.from(data, (b) => String.fromCharCode(b)).join('');
      base64 = btoa(bytes);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Normalize PEM: dotenv may store literal \n or truncate multiline values.
  // Also handle both PKCS#1 (BEGIN RSA PRIVATE KEY) and PKCS#8 (BEGIN PRIVATE KEY).
  // The production Cloudflare runtime accepts PKCS#1 via importKey('pkcs8'),
  // but the local workerd dev runtime does not — so we wrap PKCS#1 in PKCS#8.
  const normalizedPEM = privateKeyPEM.replace(/\\n/g, '\n');
  const isPkcs1 = normalizedPEM.includes('BEGIN RSA PRIVATE KEY');
  const pemHeader = isPkcs1 ? '-----BEGIN RSA PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY-----';
  const pemFooter = isPkcs1 ? '-----END RSA PRIVATE KEY-----' : '-----END PRIVATE KEY-----';
  const pemContents = normalizedPEM
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\s/g, '');

  if (!pemContents || pemContents.length < 100) {
    throw new Error(
      `Private key appears empty or truncated (${pemContents.length} base64 chars). ` +
      'If using .dev.vars, wrap the PEM value in double quotes for multiline support.'
    );
  }

  const derBytes = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const pkcs8Bytes = isPkcs1 ? wrapPkcs1InPkcs8(derBytes) : derBytes;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Wrap a PKCS#1 RSA private key in a PKCS#8 ASN.1 envelope */
function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // PKCS#8 structure:
  //   SEQUENCE {
  //     INTEGER 0 (version),
  //     SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL },
  //     OCTET STRING { <PKCS#1 DER bytes> }
  //   }
  function asn1Length(len: number): Uint8Array {
    if (len < 0x80) return new Uint8Array([len]);
    if (len < 0x100) return new Uint8Array([0x81, len]);
    return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetTag = new Uint8Array([0x04]);
  const octetLen = asn1Length(pkcs1Der.length);

  const innerLen = version.length + rsaOid.length + octetTag.length + octetLen.length + pkcs1Der.length;
  const seqTag = new Uint8Array([0x30]);
  const seqLen = asn1Length(innerLen);

  const result = new Uint8Array(seqTag.length + seqLen.length + innerLen);
  let off = 0;
  for (const part of [seqTag, seqLen, version, rsaOid, octetTag, octetLen, pkcs1Der]) {
    result.set(part, off);
    off += part.length;
  }
  return result;
}

async function exchangeForInstallationToken(
  jwt: string,
  installationId: string
): Promise<{ token: string; expires_at: string }> {
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API ${response.status}: ${error}`);
  }

  return await response.json() as { token: string; expires_at: string };
}

async function fetchInstallationMetadata(
  jwt: string,
  installationId: string
): Promise<{ account: { login: string; avatar_url: string } | null; app_slug: string | null }> {
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    }
  );
  if (!response.ok) {
    return { account: null, app_slug: null };
  }

  const data = await response.json() as {
    app_slug?: unknown;
    account?: { login?: unknown; avatar_url?: unknown };
  };
  const account = data.account && typeof data.account.login === 'string'
    ? {
        login: data.account.login,
        avatar_url: typeof data.account.avatar_url === 'string' ? data.account.avatar_url : '',
      }
    : null;
  const appSlug = typeof data.app_slug === 'string' && data.app_slug.trim() ? data.app_slug : null;
  return { account, app_slug: appSlug };
}

async function fetchGitHubAppBotCommitIdentity(
  appSlug: string | null | undefined,
): Promise<{ name: string; email: string; login: string; avatar_url: string } | null> {
  if (!appSlug || !appSlug.trim()) return null;
  const botLogin = `${appSlug}[bot]`;
  try {
    const response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(botLogin)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Push-App/1.0.0',
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json() as { id?: unknown; login?: unknown; avatar_url?: unknown };
    if (typeof data.id !== 'number' || !Number.isFinite(data.id)) return null;
    const login = typeof data.login === 'string' && data.login.trim() ? data.login : botLogin;
    return {
      name: login,
      email: `${data.id}+${login}@users.noreply.github.com`,
      login,
      avatar_url: typeof data.avatar_url === 'string' ? data.avatar_url : '',
    };
  } catch {
    return null;
  }
}
