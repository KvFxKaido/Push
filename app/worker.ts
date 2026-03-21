/**
 * Cloudflare Worker — serves the Vite app + streaming proxy to AI providers.
 *
 * Static assets in ./dist are served directly by the [assets] layer.
 * Only unmatched requests (like /api/ollama/chat) reach this Worker.
 */

import { SANDBOX_ROUTES, resolveModalSandboxBase } from './src/lib/sandbox-routes';
import {
  normalizeExperimentalBaseUrl,
  type ExperimentalProviderType,
} from './src/lib/experimental-providers';
import {
  formatExperimentalProviderHttpError,
  formatVertexProviderHttpError,
} from './src/lib/provider-error-utils';
import {
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
} from './src/lib/openai-anthropic-bridge';
import {
  buildVertexAnthropicEndpoint,
  buildVertexOpenApiBaseUrl,
  decodeVertexServiceAccountHeader,
  getVertexModelTransport,
  normalizeVertexRegion,
  VERTEX_MODEL_OPTIONS,
} from './src/lib/vertex-provider';
import {
  validateAndNormalizeChatRequest,
} from './src/lib/chat-request-guardrails';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from './src/lib/request-id';
import { getZenGoTransport, ZEN_GO_MODELS } from './src/lib/zen-go';

interface Env {
  OLLAMA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ZEN_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  BLACKBOX_API_KEY?: string;
  KILOCODE_API_KEY?: string;
  OPENADAPTER_API_KEY?: string;
  MODAL_SANDBOX_BASE_URL?: string;
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

const MAX_BODY_SIZE_BYTES = 5 * 1024 * 1024; // 5MB default (bumped from 1MB — models need headroom for large file writes)
const RESTORE_MAX_BODY_SIZE_BYTES = 12 * 1024 * 1024; // 12MB for snapshot restore payloads
const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

interface CachedGoogleAccessToken {
  token: string;
  expiresAt: number;
}

const googleAccessTokenCache = new Map<string, CachedGoogleAccessToken>();

function base64UrlEncodeString(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeBytes(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function createGoogleJwtAssertion(serviceAccount: {
  clientEmail: string;
  privateKey: string;
}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncodeString(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: GOOGLE_OAUTH_SCOPE,
    aud: GOOGLE_TOKEN_ENDPOINT,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.privateKey),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

async function getGoogleAccessToken(serviceAccount: {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}): Promise<string> {
  const cacheKey = `${serviceAccount.projectId}:${serviceAccount.clientEmail}`;
  const cached = googleAccessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const assertion = await createGoogleJwtAssertion(serviceAccount);
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Google OAuth token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new Error('Google OAuth token exchange returned no access token');
  }

  googleAccessTokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(0, (payload.expires_in ?? 3600) - 120) * 1000,
  });
  return payload.access_token;
}

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
  requestId: string;
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
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', {
      requestId,
      ip: getClientIp(request),
      path: new URL(request.url).pathname,
    });
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
    if ('error' in bodyResult) {
      return Response.json(
        { error: bodyResult.error },
        { status: bodyResult.status },
      );
    }
    bodyText = bodyResult.text;
  }

  return { authHeader: authHeader ?? '', bodyText, requestId };
}

function standardAuth(envKey: keyof Env): AuthBuilder {
  return (env, request) => {
    const serverKey = env[envKey] as string | undefined;
    const clientAuth = request.headers.get('Authorization');
    return serverKey ? `Bearer ${serverKey}` : clientAuth;
  };
}

function passthroughAuth(_env: Env, request: Request): string | null {
  return request.headers.get('Authorization');
}

function hasVertexNativeCredentials(request: Request): boolean {
  return Boolean(request.headers.get('X-Push-Vertex-Service-Account'));
}

function buildVertexPreambleAuth(_env: Env, request: Request): string | null {
  if (hasVertexNativeCredentials(request)) {
    return 'VertexNative';
  }
  return request.headers.get('Authorization');
}

interface VertexNativeConfig {
  serviceAccount: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  };
  region: string;
}

function getVertexNativeConfig(request: Request): { ok: true; config: VertexNativeConfig } | { ok: false; response: Response } {
  const decoded = decodeVertexServiceAccountHeader(request.headers.get('X-Push-Vertex-Service-Account'));
  if (!decoded.ok) {
    return {
      ok: false,
      response: Response.json({ error: decoded.error }, { status: 400 }),
    };
  }

  const region = normalizeVertexRegion(request.headers.get('X-Push-Vertex-Region'));
  if (!region.ok) {
    return {
      ok: false,
      response: Response.json({ error: region.error }, { status: 400 }),
    };
  }

  return {
    ok: true,
    config: {
      serviceAccount: decoded.parsed,
      region: region.normalized,
    },
  };
}

function getExperimentalUpstreamUrl(
  request: Request,
  provider: ExperimentalProviderType,
  suffix: '/chat/completions' | '/models',
): { ok: true; url: string } | { ok: false; response: Response } {
  const rawBase = request.headers.get('X-Push-Upstream-Base');
  const normalized = normalizeExperimentalBaseUrl(provider, rawBase);
  if ('error' in normalized) {
    return {
      ok: false,
      response: Response.json(
        { error: `${provider} base URL is invalid: ${normalized.error}` },
        { status: 400 },
      ),
    };
  }

  return { ok: true, url: `${normalized.normalized}${suffix}` };
}

// ---------------------------------------------------------------------------
// Stream proxy factory — for SSE chat endpoints
// ---------------------------------------------------------------------------

interface StreamProxyConfig {
  name: string;
  logTag: string;
  upstreamUrl: string | ((request: Request) => string);
  timeoutMs: number;
  maxOutputTokens: number;
  buildAuth: AuthBuilder;
  keyMissingError: string;
  timeoutError: string;
  extraFetchHeaders?: Record<string, string> | ((request: Request) => Record<string, string>);
  preserveUpstreamHeaders?: boolean;
  formatUpstreamError?: (status: number, bodyText: string) => { error: string; code?: string };
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
    const { authHeader, bodyText, requestId } = preamble;

    const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
      routeLabel: config.name,
      maxOutputTokens: config.maxOutputTokens,
    });
    if (!normalizedRequest.ok) {
      return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
    }
    if (normalizedRequest.value.adjustments.length > 0) {
      wlog('warn', 'chat_request_adjusted', {
        requestId,
        route: config.logTag,
        adjustments: normalizedRequest.value.adjustments,
      });
    }

    wlog('info', 'request', {
      requestId,
      route: config.logTag,
      bytes: normalizedRequest.value.bodyText.length,
      model: normalizedRequest.value.parsed.model,
    });

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
            [REQUEST_ID_HEADER]: requestId,
            ...extraHeaders,
          },
          body: normalizedRequest.value.bodyText,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      wlog('info', 'upstream_ok', { requestId, route: config.logTag, status: upstream.status });

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        wlog('error', 'upstream_error', {
          requestId,
          route: config.logTag,
          status: upstream.status,
          body: errBody.slice(0, 500),
        });
        if (config.formatUpstreamError) {
          const formatted = config.formatUpstreamError(upstream.status, errBody);
          return Response.json(formatted, { status: upstream.status });
        }
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
            [REQUEST_ID_HEADER]: requestId,
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
            [REQUEST_ID_HEADER]: requestId,
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
      wlog('error', 'unhandled', { requestId, route: config.logTag, message, timeout: isTimeout });
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
  formatUpstreamError?: (status: number, bodyText: string) => { error: string; code?: string };
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
    const { authHeader, bodyText, requestId } = preamble;

    wlog('info', 'request', {
      requestId,
      route: config.logTag,
      ...(needsBody ? { bytes: bodyText.length } : {}),
    });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
      let upstream: Response;

      try {
        const fetchInit: RequestInit = {
          method,
          headers: {
            'Authorization': authHeader,
            [REQUEST_ID_HEADER]: requestId,
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
        wlog('error', 'upstream_error', {
          requestId,
          route: config.logTag,
          status: upstream.status,
          body: errBody.slice(0, 500),
        });
        if (config.formatUpstreamError) {
          const formatted = config.formatUpstreamError(upstream.status, errBody);
          return Response.json(formatted, { status: upstream.status });
        }
        return Response.json(
          { error: `${config.name} error ${upstream.status}: ${errBody.slice(0, 200)}` },
          { status: upstream.status },
        );
      }

      const data: unknown = await upstream.json();
      return Response.json(data, {
        headers: { [REQUEST_ID_HEADER]: requestId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const status = isTimeout ? 504 : 500;
      const error = isTimeout ? config.timeoutError : message;
      wlog('error', 'unhandled', { requestId, route: config.logTag, message, timeout: isTimeout });
      return Response.json({ error }, { status });
    }
  };
}

async function handleSandbox(request: Request, env: Env, requestUrl: URL, route: string): Promise<Response> {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'sandbox');
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
  if ('code' in resolvedBase) {
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
    wlog('warn', 'rate_limited', {
      requestId,
      ip: getClientIp(request),
      path: `api/sandbox/${route}`,
    });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  // Read and forward body
  const maxBodyBytes = (route === 'restore' || route === 'batch-write') ? RESTORE_MAX_BODY_SIZE_BYTES : MAX_BODY_SIZE_BYTES;
  const bodyResult = await readBodyText(request, maxBodyBytes);
  if ('error' in bodyResult) {
    return Response.json(
      { error: bodyResult.error },
      { status: bodyResult.status },
    );
  }

  // Route-specific payload enrichment without changing client contracts.
  let forwardBodyText = bodyResult.text;
  if (
    route === 'read'
    || route === 'write'
    || route === 'batch-write'
    || route === 'list'
    || route === 'delete'
    || route === 'restore'
  ) {
    try {
      const payload = JSON.parse(bodyResult.text) as Record<string, unknown>;

      if (route === 'read') payload.action = 'read';
      if (route === 'write') payload.action = 'write';
      if (route === 'batch-write') payload.action = 'batch_write';
      if (route === 'list') payload.action = 'list';
      if (route === 'delete') payload.action = 'delete';
      if (route === 'restore') payload.action = 'hydrate';

      forwardBodyText = JSON.stringify(payload);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // Forward to Modal web endpoint
  // Modal web endpoints follow pattern: {base}-{function_name}.modal.run
  const modalUrl = `${resolvedBase.base}-${modalFunction}.modal.run`;

  // exec can run arbitrary shell commands (npm install, test suites, builds) that
  // legitimately take 2+ minutes. Modal's exec_command waits up to 110s internally,
  // so give it 120s here to receive that response. All other routes stay at 60s.
  const routeTimeoutMs = route === 'exec' ? 120_000 : 60_000;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), routeTimeoutMs);

    try {
      const upstream = await fetch(modalUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
        },
        body: forwardBodyText,
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        wlog('error', 'modal_error', {
          requestId,
          route,
          status: upstream.status,
          body: errBody.slice(0, 500),
        });

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
          if (lowerBody.includes('not found') || lowerBody.includes('does not exist') || lowerBody.includes('no such') || lowerBody.includes('expired')) {
            code = 'MODAL_NOT_FOUND';
            details = 'Sandbox not found or expired. The container may have been terminated.';
          } else if (lowerBody.includes('terminated') || lowerBody.includes('closed') || lowerBody.includes('no longer running')) {
            code = 'MODAL_NOT_FOUND';
            details = 'Sandbox has been terminated. Start a new sandbox session.';
          } else if (lowerBody.includes('timeout') || lowerBody.includes('timed out')) {
            code = 'MODAL_TIMEOUT';
            details = 'Modal operation timed out internally.';
          } else if (lowerBody.includes('unauthorized') || lowerBody.includes('forbidden')) {
            code = 'MODAL_AUTH_FAILED';
            details = 'Sandbox access was denied. The session token may be invalid.';
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
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'sandbox_error', { requestId, route, message, timeout: isTimeout });

    if (isTimeout) {
      return Response.json({
        error: 'Sandbox request timed out',
        code: 'MODAL_TIMEOUT',
        details: `The sandbox took longer than ${routeTimeoutMs / 1000} seconds to respond. Try a simpler operation or check Modal dashboard for issues.`,
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
    openrouter: { status: 'ok' | 'unconfigured'; configured: boolean };
    zen: { status: 'ok' | 'unconfigured'; configured: boolean };
    nvidia: { status: 'ok' | 'unconfigured'; configured: boolean };
    blackbox: { status: 'ok' | 'unconfigured'; configured: boolean };
    openadapter: { status: 'ok' | 'unconfigured'; configured: boolean };
    sandbox: { status: 'ok' | 'unconfigured' | 'misconfigured'; configured: boolean; error?: string };
    github_app: { status: 'ok' | 'unconfigured'; configured: boolean };
    github_app_oauth: { status: 'ok' | 'unconfigured'; configured: boolean };
  };
  version: string;
}

async function handleHealthCheck(env: Env): Promise<Response> {
  const ollamaConfigured = Boolean(env.OLLAMA_API_KEY);
  const openRouterConfigured = Boolean(env.OPENROUTER_API_KEY);
  const zenConfigured = Boolean(env.ZEN_API_KEY);
  const nvidiaConfigured = Boolean(env.NVIDIA_API_KEY);
  const blackboxConfigured = Boolean(env.BLACKBOX_API_KEY);
  const kiloCodeConfigured = Boolean(env.KILOCODE_API_KEY);
  const openAdapterConfigured = Boolean(env.OPENADAPTER_API_KEY);
  const sandboxUrl = env.MODAL_SANDBOX_BASE_URL;

  let sandboxStatus: 'ok' | 'unconfigured' | 'misconfigured' = 'unconfigured';
  let sandboxError: string | undefined;

  if (sandboxUrl) {
    const resolvedBase = resolveModalSandboxBase(sandboxUrl);
    if (!('code' in resolvedBase)) {
      sandboxStatus = 'ok';
    } else {
      sandboxStatus = 'misconfigured';
      sandboxError = resolvedBase.details;
  }
  }

  const hasAnyLlm = ollamaConfigured || openRouterConfigured || zenConfigured || nvidiaConfigured || blackboxConfigured || kiloCodeConfigured || openAdapterConfigured;
  const overallStatus: 'healthy' | 'degraded' | 'unhealthy' =
    hasAnyLlm && sandboxStatus === 'ok' ? 'healthy' :
    hasAnyLlm || sandboxStatus === 'ok' ? 'degraded' : 'unhealthy';

  const health: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      worker: { status: 'ok' },
      ollama: { status: ollamaConfigured ? 'ok' : 'unconfigured', configured: ollamaConfigured },
      openrouter: { status: openRouterConfigured ? 'ok' : 'unconfigured', configured: openRouterConfigured },
      zen: { status: zenConfigured ? 'ok' : 'unconfigured', configured: zenConfigured },
      nvidia: { status: nvidiaConfigured ? 'ok' : 'unconfigured', configured: nvidiaConfigured },
      blackbox: { status: blackboxConfigured ? 'ok' : 'unconfigured', configured: blackboxConfigured },
      kilocode: { status: kiloCodeConfigured ? 'ok' : 'unconfigured', configured: kiloCodeConfigured },
      openadapter: { status: openAdapterConfigured ? 'ok' : 'unconfigured', configured: openAdapterConfigured },
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
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('OLLAMA_API_KEY'),
  keyMissingError: 'Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker.',
  timeoutError: 'Ollama Cloud request timed out after 180 seconds',
});

// --- Mistral ---

// --- OpenRouter ---

const handleOpenRouterChat = createStreamProxyHandler({
  name: 'OpenRouter API', logTag: 'api/openrouter/chat',
  upstreamUrl: 'https://openrouter.ai/api/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 12_288,
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

// --- OpenCode Zen (OpenAI-compatible endpoint) ---

const handleZenChat = createStreamProxyHandler({
  name: 'OpenCode Zen API', logTag: 'api/zen/chat',
  upstreamUrl: 'https://opencode.ai/zen/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 12_288,
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

// --- Kilo Code (OpenAI-compatible gateway) ---

const handleKiloCodeChat = createStreamProxyHandler({
  name: 'Kilo Code API', logTag: 'api/kilocode/chat',
  upstreamUrl: 'https://api.kilo.ai/api/gateway/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('KILOCODE_API_KEY'),
  keyMissingError: 'Kilo Code API key not configured. Add it in Settings or set KILOCODE_API_KEY on the Worker.',
  timeoutError: 'Kilo Code request timed out after 120 seconds',
});

const handleKiloCodeModels = createJsonProxyHandler({
  name: 'Kilo Code API', logTag: 'api/kilocode/models',
  upstreamUrl: 'https://api.kilo.ai/api/gateway/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('KILOCODE_API_KEY'),
  keyMissingError: 'Kilo Code API key not configured. Add it in Settings or set KILOCODE_API_KEY on the Worker.',
  timeoutError: 'Kilo Code model list timed out after 30 seconds',
});

const handleOpenAdapterChat = createStreamProxyHandler({
  name: 'OpenAdapter API', logTag: 'api/openadapter/chat',
  upstreamUrl: 'https://api.openadapter.in/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('OPENADAPTER_API_KEY'),
  keyMissingError: 'OpenAdapter API key not configured. Add it in Settings or set OPENADAPTER_API_KEY on the Worker.',
  timeoutError: 'OpenAdapter request timed out after 120 seconds',
});

const handleOpenAdapterModels = createJsonProxyHandler({
  name: 'OpenAdapter API', logTag: 'api/openadapter/models',
  upstreamUrl: 'https://api.openadapter.in/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('OPENADAPTER_API_KEY'),
  keyMissingError: 'OpenAdapter API key not configured. Add it in Settings or set OPENADAPTER_API_KEY on the Worker.',
  timeoutError: 'OpenAdapter model list timed out after 30 seconds',
});

// --- OpenCode Zen Go tier (mixed OpenAI + Anthropic transports) ---

function getZenGoAuthHeaders(authHeader: string, requestId: string, transport: 'openai' | 'anthropic'): Record<string, string> {
  if (transport === 'anthropic') {
    const bearerPrefix = 'Bearer ';
    const bearerToken = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length).trim() : '';
    return {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'anthropic-version': '2023-06-01',
      ...(bearerToken ? { 'x-api-key': bearerToken } : {}),
      [REQUEST_ID_HEADER]: requestId,
    };
  }

  return {
    'Content-Type': 'application/json',
    'Authorization': authHeader,
    [REQUEST_ID_HEADER]: requestId,
  };
}

async function handleZenGoChat(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: standardAuth('ZEN_API_KEY'),
    keyMissingError: 'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { authHeader, bodyText, requestId } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'OpenCode Zen Go',
    maxOutputTokens: 12_288,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/zen/go/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }

  const parsedRequest = normalizedRequest.value.parsed;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';
  const transport = getZenGoTransport(model);
  const upstreamUrl = transport === 'anthropic'
    ? 'https://opencode.ai/zen/go/v1/messages'
    : 'https://opencode.ai/zen/go/v1/chat/completions';
  const upstreamBody = transport === 'anthropic'
    ? JSON.stringify(buildAnthropicMessagesRequest(parsedRequest))
    : normalizedRequest.value.bodyText;

  wlog('info', 'request', {
    requestId,
    route: 'api/zen/go/chat',
    transport,
    model,
    bytes: upstreamBody.length,
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: getZenGoAuthHeaders(authHeader, requestId, transport),
        body: upstreamBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    wlog('info', 'upstream_ok', {
      requestId,
      route: 'api/zen/go/chat',
      transport,
      status: upstream.status,
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        requestId,
        route: 'api/zen/go/chat',
        transport,
        status: upstream.status,
        body: errBody.slice(0, 500),
      });

      const isHtml = /<\s*html[\s>]/i.test(errBody) || /<\s*!doctype/i.test(errBody);
      const errDetail = isHtml
        ? `HTTP ${upstream.status} (the server returned an HTML error page instead of JSON)`
        : errBody.slice(0, 200);
      return Response.json(
        { error: `OpenCode Zen Go API error ${upstream.status}: ${errDetail}` },
        { status: upstream.status },
      );
    }

    if (transport === 'anthropic') {
      return new Response(createAnthropicTranslatedStream(upstream, model), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          [REQUEST_ID_HEADER]: requestId,
        },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/zen/go/chat',
      transport,
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'OpenCode Zen Go request timed out after 120 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

async function handleZenGoModels(request: Request, env: Env): Promise<Response> {
  const preamble = await runPreamble(request, env, {
    buildAuth: standardAuth('ZEN_API_KEY'),
    keyMissingError: 'OpenCode Zen API key not configured. Add it in Settings or set ZEN_API_KEY on the Worker.',
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;

  return Response.json({
    object: 'list',
    data: ZEN_GO_MODELS.map((id) => ({
      id,
      object: 'model',
      transport: getZenGoTransport(id),
    })),
  });
}

// --- Nvidia NIM (OpenAI-compatible endpoint) ---

const handleNvidiaChat = createStreamProxyHandler({
  name: 'Nvidia NIM API', logTag: 'api/nvidia/chat',
  upstreamUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('NVIDIA_API_KEY'),
  keyMissingError: 'Nvidia NIM API key not configured. Add it in Settings or set NVIDIA_API_KEY on the Worker.',
  timeoutError: 'Nvidia NIM request timed out after 120 seconds',
});

const handleNvidiaModels = createJsonProxyHandler({
  name: 'Nvidia NIM API', logTag: 'api/nvidia/models',
  upstreamUrl: 'https://integrate.api.nvidia.com/v1/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('NVIDIA_API_KEY'),
  keyMissingError: 'Nvidia NIM API key not configured. Add it in Settings or set NVIDIA_API_KEY on the Worker.',
  timeoutError: 'Nvidia NIM model list timed out after 30 seconds',
});

// --- Blackbox AI ---

const handleBlackboxChat = createStreamProxyHandler({
  name: 'Blackbox AI API', logTag: 'api/blackbox/chat',
  upstreamUrl: 'https://api.blackbox.ai/chat/completions',
  timeoutMs: 120_000,
  maxOutputTokens: 8_192,
  buildAuth: standardAuth('BLACKBOX_API_KEY'),
  keyMissingError: 'Blackbox AI API key not configured. Add it in Settings or set BLACKBOX_API_KEY on the Worker.',
  timeoutError: 'Blackbox AI request timed out after 120 seconds',
});

const handleBlackboxModels = createJsonProxyHandler({
  name: 'Blackbox AI API', logTag: 'api/blackbox/models',
  upstreamUrl: 'https://api.blackbox.ai/models',
  method: 'GET',
  timeoutMs: 30_000,
  buildAuth: standardAuth('BLACKBOX_API_KEY'),
  keyMissingError: 'Blackbox AI API key not configured. Add it in Settings or set BLACKBOX_API_KEY on the Worker.',
  timeoutError: 'Blackbox AI model list timed out after 30 seconds',
});

// --- Experimental private connectors (OpenAI-compatible upstreams) ---

function createExperimentalStreamProxyHandler(
  provider: ExperimentalProviderType,
  name: string,
  logTag: string,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const upstream = getExperimentalUpstreamUrl(request, provider, '/chat/completions');
    if ('response' in upstream) return upstream.response;

    return createStreamProxyHandler({
      name,
      logTag,
      upstreamUrl: upstream.url,
      timeoutMs: 180_000,
      maxOutputTokens: 12_288,
      buildAuth: passthroughAuth,
      keyMissingError: `${name} API key not configured. Add it in Advanced AI settings.`,
      timeoutError: `${name} request timed out after 180 seconds`,
      formatUpstreamError: (status, bodyText) => ({
        error: formatExperimentalProviderHttpError(name, status, bodyText),
        code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
      }),
    })(request, env);
  };
}

function createExperimentalModelsHandler(
  provider: ExperimentalProviderType,
  name: string,
  logTag: string,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const upstream = getExperimentalUpstreamUrl(request, provider, '/models');
    if ('response' in upstream) return upstream.response;

    return createJsonProxyHandler({
      name,
      logTag,
      upstreamUrl: upstream.url,
      method: 'GET',
      timeoutMs: 30_000,
      buildAuth: passthroughAuth,
      keyMissingError: `${name} API key not configured. Add it in Advanced AI settings.`,
      timeoutError: `${name} model list timed out after 30 seconds`,
      needsBody: false,
      formatUpstreamError: (status, bodyText) => ({
        error: formatExperimentalProviderHttpError(name, status, bodyText),
        code: status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
      }),
    })(request, env);
  };
}

const handleAzureChat = createExperimentalStreamProxyHandler('azure', 'Azure OpenAI', 'api/azure/chat');
const handleAzureModels = createExperimentalModelsHandler('azure', 'Azure OpenAI', 'api/azure/models');
const handleBedrockChat = createExperimentalStreamProxyHandler('bedrock', 'AWS Bedrock', 'api/bedrock/chat');
const handleBedrockModels = createExperimentalModelsHandler('bedrock', 'AWS Bedrock', 'api/bedrock/models');
const handleLegacyVertexChat = createExperimentalStreamProxyHandler('vertex', 'Google Vertex', 'api/vertex/chat');
const handleLegacyVertexModels = createExperimentalModelsHandler('vertex', 'Google Vertex', 'api/vertex/models');

async function handleVertexChat(request: Request, env: Env): Promise<Response> {
  if (!hasVertexNativeCredentials(request)) {
    return handleLegacyVertexChat(request, env);
  }

  const preamble = await runPreamble(request, env, {
    buildAuth: buildVertexPreambleAuth,
    keyMissingError: 'Google Vertex service account not configured. Add it in Advanced AI settings.',
    needsBody: true,
  });
  if (preamble instanceof Response) return preamble;
  const { bodyText, requestId } = preamble;

  const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
    routeLabel: 'Google Vertex',
    maxOutputTokens: 12_288,
  });
  if (!normalizedRequest.ok) {
    return Response.json({ error: normalizedRequest.error }, { status: normalizedRequest.status });
  }
  if (normalizedRequest.value.adjustments.length > 0) {
    wlog('warn', 'chat_request_adjusted', {
      requestId,
      route: 'api/vertex/chat',
      adjustments: normalizedRequest.value.adjustments,
    });
  }
  const parsedRequest = normalizedRequest.value.parsed;
  const model = typeof parsedRequest.model === 'string' ? parsedRequest.model.trim() : '';

  const nativeConfig = getVertexNativeConfig(request);
  if (!nativeConfig.ok) return nativeConfig.response;

  const transport = getVertexModelTransport(model);
  const upstreamUrl = transport === 'anthropic'
    ? buildVertexAnthropicEndpoint(
      nativeConfig.config.serviceAccount.projectId,
      nativeConfig.config.region,
      model,
    )
    : `${buildVertexOpenApiBaseUrl(nativeConfig.config.serviceAccount.projectId, nativeConfig.config.region)}/chat/completions`;
  const upstreamBody = transport === 'anthropic'
    ? JSON.stringify(buildAnthropicMessagesRequest(parsedRequest, { anthropicVersion: 'vertex-2023-10-16' }))
    : normalizedRequest.value.bodyText;

  wlog('info', 'request', {
    requestId,
    route: 'api/vertex/chat',
    mode: 'native',
    transport,
    model,
    region: nativeConfig.config.region,
  });

  try {
    const accessToken = await getGoogleAccessToken(nativeConfig.config.serviceAccount);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    let upstream: Response;

    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
        },
        body: upstreamBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      wlog('error', 'upstream_error', {
        requestId,
        route: 'api/vertex/chat',
        mode: 'native',
        transport,
        status: upstream.status,
        body: errBody.slice(0, 500),
      });
      return Response.json(
        {
          error: formatVertexProviderHttpError(upstream.status, errBody, transport),
          code: upstream.status === 429 ? 'UPSTREAM_QUOTA_OR_RATE_LIMIT' : undefined,
        },
        { status: upstream.status },
      );
    }

    if (transport === 'anthropic') {
      return new Response(createAnthropicTranslatedStream(upstream, model), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          [REQUEST_ID_HEADER]: requestId,
        },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        [REQUEST_ID_HEADER]: requestId,
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'unhandled', {
      requestId,
      route: 'api/vertex/chat',
      mode: 'native',
      transport,
      message,
      timeout: isTimeout,
    });
    return Response.json(
      { error: isTimeout ? 'Google Vertex request timed out after 180 seconds' : message },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

async function handleVertexModels(request: Request, env: Env): Promise<Response> {
  if (!hasVertexNativeCredentials(request)) {
    return handleLegacyVertexModels(request, env);
  }

  const preamble = await runPreamble(request, env, {
    buildAuth: buildVertexPreambleAuth,
    needsBody: false,
  });
  if (preamble instanceof Response) return preamble;

  return Response.json({
    object: 'list',
    data: VERTEX_MODEL_OPTIONS.map((model) => ({
      id: model.id,
      name: model.label,
      transport: model.transport,
      family: model.family,
    })),
  });
}

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
  if ('error' in bodyResult) {
    return Response.json(
      { error: bodyResult.error },
      { status: bodyResult.status },
    );
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
  if ('error' in bodyResult) {
    return Response.json(
      { error: bodyResult.error },
      { status: bodyResult.status },
    );
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

type ExactApiRoute = {
  path: string;
  method: 'GET' | 'POST';
  handler: (request: Request, env: Env) => Promise<Response>;
};

const EXACT_API_ROUTES: ExactApiRoute[] = [
  { path: '/api/health', method: 'GET', handler: (_request, env) => handleHealthCheck(env) },
  { path: '/api/github/app-token', method: 'POST', handler: handleGitHubAppToken },
  { path: '/api/github/app-oauth', method: 'POST', handler: handleGitHubAppOAuth },
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
