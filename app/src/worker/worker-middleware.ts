/**
 * Shared middleware, factories, and utilities for the Cloudflare Worker.
 *
 * Extracted from worker.ts so that individual provider handlers can import
 * only what they need without pulling in the entire monolith.
 */

import type {
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
  RateLimit,
} from '@cloudflare/workers-types';
import {
  normalizeExperimentalBaseUrl,
  type ExperimentalProviderType,
} from '../lib/experimental-providers';
import { decodeVertexServiceAccountHeader, normalizeVertexRegion } from '../lib/vertex-provider';
import { validateAndNormalizeChatRequest } from '../lib/chat-request-guardrails';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from '../lib/request-id';
import {
  createSpanContext,
  buildTraceparent,
  createChildContext,
  type WorkerSpanContext,
} from './worker-tracing';

// ---------------------------------------------------------------------------
// Env interface
// ---------------------------------------------------------------------------

export interface Env {
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
  // Snapshot index — see docs/decisions/Modal Sandbox Snapshots Design.md §6.
  // Optional because local dev or test envs may not bind the namespace; callers
  // must degrade gracefully when it's absent.
  SNAPSHOT_INDEX?: KVNamespace;
  // Gate for /api/admin/* routes. When unset the admin endpoints 404.
  ADMIN_TOKEN?: string;
  // GitHub App credentials
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_ALLOWED_INSTALLATION_IDS?: string;
  // GitHub App OAuth (for auto-connect flow)
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  // Cloudflare Sandbox SDK Durable Object binding. Optional because local dev
  // or test envs may not bind it; the cloudflare-sandbox-provider must 503
  // gracefully when it's absent so the Modal fallback path stays safe.
  Sandbox?: DurableObjectNamespace;
  // CoderJob Durable Object binding — background Coder delegations (Phase 1
  // background-tasks). Optional so local/test envs without the v2 migration
  // can still boot; /api/jobs/* fails closed with NOT_CONFIGURED when
  // missing so we don't half-accept background jobs that can't run.
  CoderJob?: DurableObjectNamespace;
  // Sibling-provider selector. Values: "modal" | "cloudflare". Unset or
  // anything else defaults to "modal" during coexistence.
  PUSH_SANDBOX_PROVIDER?: string;
  // Owner-token store for the Cloudflare sandbox path. Optional so the
  // Worker still boots for non-CF paths (Modal fallback, admin routes,
  // etc.) without a KV binding — but /api/sandbox-cf/* routes fail closed
  // (NOT_CONFIGURED 503) on every route including create when the binding
  // is missing. No silent auth bypass; no half-auth'd sandboxes.
  SANDBOX_TOKENS?: KVNamespace;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_BODY_SIZE_BYTES = 5 * 1024 * 1024; // 5MB default (bumped from 1MB — models need headroom for large file writes)
export const RESTORE_MAX_BODY_SIZE_BYTES = 12 * 1024 * 1024; // 12MB for snapshot restore payloads
export const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------------------
// Google JWT / token utilities
// ---------------------------------------------------------------------------

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

export async function createGoogleJwtAssertion(serviceAccount: {
  clientEmail: string;
  privateKey: string;
}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncodeString(
    JSON.stringify({
      iss: serviceAccount.clientEmail,
      scope: GOOGLE_OAUTH_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    }),
  );
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

export async function getGoogleAccessToken(serviceAccount: {
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
    throw new Error(
      `Google OAuth token exchange failed (${response.status}): ${detail.slice(0, 200)}`,
    );
  }

  const payload = (await response.json()) as {
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

// ---------------------------------------------------------------------------
// Origin validation
// ---------------------------------------------------------------------------

export function normalizeOrigin(value: string | null): string | null {
  if (!value || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function getAllowedOrigins(requestUrl: URL, env: Env): Set<string> {
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

export function validateOrigin(
  request: Request,
  requestUrl: URL,
  env: Env,
): { ok: boolean; error?: string } {
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

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

export function wlog(
  level: 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>,
): void {
  const entry = JSON.stringify({ level, event, ts: new Date().toISOString(), ...data });
  if (level === 'error') {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

export async function readBodyText(
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

export type AuthBuilder = (env: Env, request: Request) => Promise<string | null> | (string | null);

export interface PreambleOk {
  authHeader: string;
  bodyText: string;
  requestId: string;
  spanCtx: WorkerSpanContext;
}

export async function runPreamble(
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
  const spanCtx = createSpanContext(request, requestId);
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
      return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
    }
    bodyText = bodyResult.text;
  }

  return { authHeader: authHeader ?? '', bodyText, requestId, spanCtx };
}

// ---------------------------------------------------------------------------
// Auth builders
// ---------------------------------------------------------------------------

export function standardAuth(envKey: keyof Env): AuthBuilder {
  return (env, request) => {
    const serverKey = env[envKey] as string | undefined;
    const clientAuth = request.headers.get('Authorization');
    return serverKey ? `Bearer ${serverKey}` : clientAuth;
  };
}

export function passthroughAuth(_env: Env, request: Request): string | null {
  return request.headers.get('Authorization');
}

export function hasVertexNativeCredentials(request: Request): boolean {
  return Boolean(request.headers.get('X-Push-Vertex-Service-Account'));
}

export function buildVertexPreambleAuth(_env: Env, request: Request): string | null {
  if (hasVertexNativeCredentials(request)) {
    return 'VertexNative';
  }
  return request.headers.get('Authorization');
}

// ---------------------------------------------------------------------------
// Vertex native config
// ---------------------------------------------------------------------------

export interface VertexNativeConfig {
  serviceAccount: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  };
  region: string;
}

export function getVertexNativeConfig(
  request: Request,
): { ok: true; config: VertexNativeConfig } | { ok: false; response: Response } {
  const decoded = decodeVertexServiceAccountHeader(
    request.headers.get('X-Push-Vertex-Service-Account'),
  );
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

// ---------------------------------------------------------------------------
// Experimental upstream URL helper
// ---------------------------------------------------------------------------

export function getExperimentalUpstreamUrl(
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

export interface StreamProxyConfig {
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

export function createStreamProxyHandler(
  config: StreamProxyConfig,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    const preamble = await runPreamble(request, env, {
      buildAuth: config.buildAuth,
      keyMissingError: config.keyMissingError,
      needsBody: true,
    });
    if (preamble instanceof Response) return preamble;
    const { authHeader, bodyText, requestId, spanCtx } = preamble;

    const normalizedRequest = validateAndNormalizeChatRequest(bodyText, {
      routeLabel: config.name,
      maxOutputTokens: config.maxOutputTokens,
    });
    if (!normalizedRequest.ok) {
      return Response.json(
        { error: normalizedRequest.error },
        { status: normalizedRequest.status },
      );
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

    const upstreamUrl =
      typeof config.upstreamUrl === 'function' ? config.upstreamUrl(request) : config.upstreamUrl;

    const extraHeaders =
      typeof config.extraFetchHeaders === 'function'
        ? config.extraFetchHeaders(request)
        : (config.extraFetchHeaders ?? {});

    // Trace context headers for response correlation
    const traceResponseHeaders: Record<string, string> = {
      'X-Push-Trace-Id': spanCtx.traceId,
      'X-Push-Span-Id': spanCtx.spanId,
    };

    // Create child context for upstream propagation
    const upstreamCtx = createChildContext(spanCtx);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
      let upstream: Response;

      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
            [REQUEST_ID_HEADER]: requestId,
            traceparent: buildTraceparent(upstreamCtx),
            ...extraHeaders,
          },
          body: normalizedRequest.value.bodyText,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      wlog('info', 'upstream_ok', {
        requestId,
        route: config.logTag,
        status: upstream.status,
        trace_id: spanCtx.traceId,
      });

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
            'Content-Type':
              upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            [REQUEST_ID_HEADER]: requestId,
            'X-Accel-Buffering': 'no',
            ...traceResponseHeaders,
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
            Connection: 'keep-alive',
            [REQUEST_ID_HEADER]: requestId,
            ...traceResponseHeaders,
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

export interface JsonProxyConfig {
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

export function createJsonProxyHandler(
  config: JsonProxyConfig,
): (request: Request, env: Env) => Promise<Response> {
  const method = config.method ?? 'POST';
  const needsBody = config.needsBody ?? method === 'POST';

  return async (request, env) => {
    const preamble = await runPreamble(request, env, {
      buildAuth: config.buildAuth,
      keyMissingError: config.keyMissingError,
      needsBody,
    });
    if (preamble instanceof Response) return preamble;
    const { authHeader, bodyText, requestId, spanCtx } = preamble;

    // Trace context headers for response correlation
    const traceResponseHeaders: Record<string, string> = {
      'X-Push-Trace-Id': spanCtx.traceId,
      'X-Push-Span-Id': spanCtx.spanId,
    };

    // Create child context for upstream propagation
    const upstreamCtx = createChildContext(spanCtx);

    wlog('info', 'request', {
      requestId,
      route: config.logTag,
      trace_id: spanCtx.traceId,
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
            Authorization: authHeader,
            [REQUEST_ID_HEADER]: requestId,
            traceparent: buildTraceparent(upstreamCtx),
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
          trace_id: spanCtx.traceId,
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
        headers: { [REQUEST_ID_HEADER]: requestId, ...traceResponseHeaders },
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
