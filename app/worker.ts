/**
 * Cloudflare Worker — serves the Vite app + streaming proxy to Kimi For Coding.
 *
 * Static assets in ./dist are served directly by the [assets] layer.
 * Only unmatched requests (like /api/kimi/chat) reach this Worker.
 */

interface Env {
  MOONSHOT_API_KEY?: string;
  MODAL_SANDBOX_BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  ASSETS: Fetcher;
}

const MAX_BODY_SIZE_BYTES = 512 * 1024; // 512KB — supports file uploads via sandbox write
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();

// Sandbox endpoint name mapping: /api/sandbox/{route} → Modal function name
const SANDBOX_ROUTES: Record<string, string> = {
  create: 'create',
  exec: 'exec-command',
  read: 'read-file',
  write: 'write-file',
  diff: 'get-diff',
  cleanup: 'cleanup',
  list: 'list-dir',
  delete: 'delete-file',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API route: health check endpoint
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return handleHealthCheck(env);
    }

    // API route: streaming proxy to Kimi For Coding (SSE)
    if (url.pathname === '/api/kimi/chat' && request.method === 'POST') {
      return handleKimiChat(request, env);
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

function cleanupRateLimitStore(now: number) {
  if (rateLimitStore.size < 1000) return;
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(ip);
    }
  }
}

function checkRateLimit(ip: string, now: number): { allowed: boolean; retryAfter: number } {
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
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

  // Validate URL format to catch common configuration mistakes
  if (!baseUrl.startsWith('https://') || !baseUrl.includes('--')) {
    return Response.json({
      error: 'Sandbox misconfigured',
      code: 'MODAL_URL_INVALID',
      details: `MODAL_SANDBOX_BASE_URL must be https://<username>--push-sandbox (got: ${baseUrl.slice(0, 50)}...)`,
    }, { status: 503 });
  }

  if (baseUrl.endsWith('/')) {
    return Response.json({
      error: 'Sandbox misconfigured',
      code: 'MODAL_URL_TRAILING_SLASH',
      details: 'MODAL_SANDBOX_BASE_URL must not have a trailing slash. Remove the trailing / and redeploy.',
    }, { status: 503 });
  }

  // Validate origin
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  // Rate limit
  const now = Date.now();
  cleanupRateLimitStore(now);
  const rateLimit = checkRateLimit(getClientIp(request), now);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } },
    );
  }

  // Read and forward body
  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  // Forward to Modal web endpoint
  // Modal web endpoints follow pattern: {base}-{function_name}.modal.run
  const modalUrl = `${baseUrl}-${modalFunction}.modal.run`;

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
        body: bodyResult.text,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      console.error(`[api/sandbox/${route}] Modal ${upstream.status}: ${errBody.slice(0, 500)}`);

      // Provide actionable error messages based on status code
      let code = 'MODAL_ERROR';
      let details = errBody.slice(0, 200);

      if (upstream.status === 404) {
        code = 'MODAL_NOT_FOUND';
        details = `Modal endpoint not found. The app may not be deployed. Run: cd sandbox && modal deploy app.py`;
      } else if (upstream.status === 401 || upstream.status === 403) {
        code = 'MODAL_AUTH_FAILED';
        details = 'Modal authentication failed. Check that your Modal tokens are valid and the app is deployed under the correct account.';
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
    console.error(`[api/sandbox/${route}] Error: ${message}`);

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
    kimi: { status: 'ok' | 'unconfigured'; configured: boolean };
    sandbox: { status: 'ok' | 'unconfigured' | 'misconfigured'; configured: boolean; error?: string };
  };
  version: string;
}

async function handleHealthCheck(env: Env): Promise<Response> {
  const kimiConfigured = Boolean(env.MOONSHOT_API_KEY);
  const sandboxUrl = env.MODAL_SANDBOX_BASE_URL;

  let sandboxStatus: 'ok' | 'unconfigured' | 'misconfigured' = 'unconfigured';
  let sandboxError: string | undefined;

  if (sandboxUrl) {
    if (!sandboxUrl.startsWith('https://') || !sandboxUrl.includes('--')) {
      sandboxStatus = 'misconfigured';
      sandboxError = 'MODAL_SANDBOX_BASE_URL format is invalid';
    } else if (sandboxUrl.endsWith('/')) {
      sandboxStatus = 'misconfigured';
      sandboxError = 'MODAL_SANDBOX_BASE_URL has trailing slash';
    } else {
      sandboxStatus = 'ok';
    }
  }

  const overallStatus: 'healthy' | 'degraded' | 'unhealthy' =
    kimiConfigured && sandboxStatus === 'ok' ? 'healthy' :
    kimiConfigured || sandboxStatus === 'ok' ? 'degraded' : 'unhealthy';

  const health: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      worker: { status: 'ok' },
      kimi: { status: kimiConfigured ? 'ok' : 'unconfigured', configured: kimiConfigured },
      sandbox: { status: sandboxStatus, configured: Boolean(sandboxUrl), error: sandboxError },
    },
    version: '1.0.0',
  };

  return Response.json(health, {
    status: overallStatus === 'unhealthy' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function handleKimiChat(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const now = Date.now();
  cleanupRateLimitStore(now);
  const rateLimit = checkRateLimit(getClientIp(request), now);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } },
    );
  }

  // Prefer server-side secret; fall back to client-provided Authorization header
  const serverKey = env.MOONSHOT_API_KEY;
  const clientAuth = request.headers.get('Authorization');
  const authHeader = serverKey ? `Bearer ${serverKey}` : clientAuth;

  if (!authHeader) {
    return Response.json(
      { error: 'Kimi API key not configured. Add it in Settings or set MOONSHOT_API_KEY on the Worker.' },
      { status: 401 },
    );
  }

  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  console.log(`[api/kimi/chat] Forwarding request (${bodyResult.text.length} bytes)`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min for long responses
    let upstream: Response;

    try {
      upstream = await fetch('https://api.kimi.com/coding/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'User-Agent': 'claude-code/1.0.0',
        },
        body: bodyResult.text,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log(`[api/kimi/chat] Upstream responded: ${upstream.status}`);

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      console.error(`[api/kimi/chat] Upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
      return Response.json(
        { error: `Kimi API error ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status },
      );
    }

    // SSE streaming: pipe upstream body straight through
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
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? 'Kimi request timed out after 120 seconds' : message;
    console.error(`[api/kimi/chat] Unhandled: ${message}`);
    return Response.json({ error }, { status });
  }
}
