/**
 * Cloudflare Worker — serves the Vite app + streaming proxy to Ollama Cloud.
 *
 * Static assets in ./dist are served directly by the [assets] layer.
 * Only unmatched requests (like /api/chat) reach this Worker.
 */

interface Env {
  OLLAMA_CLOUD_API_KEY: string;
  ALLOWED_ORIGINS?: string;
  ASSETS: Fetcher;
}

const MAX_BODY_SIZE_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API route: streaming proxy to Ollama Cloud
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
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

type ChatPayload = {
  model: string;
  messages: unknown[];
  stream?: boolean;
  options?: Record<string, unknown>;
  format?: string;
  keep_alive?: string | number;
};

function sanitizeChatPayload(input: any): { ok: true; payload: ChatPayload } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid JSON body' };
  }

  const model = input.model;
  const messages = input.messages;

  if (typeof model !== 'string' || !model.trim()) {
    return { ok: false, error: 'Missing or invalid model' };
  }

  if (!Array.isArray(messages)) {
    return { ok: false, error: 'Missing or invalid messages array' };
  }

  if (messages.length > 100) {
    return { ok: false, error: 'Too many messages (max 100)' };
  }

  const payload: ChatPayload = { model, messages };

  if (typeof input.stream === 'boolean') {
    payload.stream = input.stream;
  }

  if (typeof input.format === 'string') {
    payload.format = input.format;
  }

  if (typeof input.keep_alive === 'string' || typeof input.keep_alive === 'number') {
    payload.keep_alive = input.keep_alive;
  }

  if (input.options && typeof input.options === 'object' && !Array.isArray(input.options)) {
    payload.options = input.options as Record<string, unknown>;
  }

  return { ok: true, payload };
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

async function handleChat(request: Request, env: Env): Promise<Response> {
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

  const apiKey = env.OLLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'API key not configured. Add OLLAMA_CLOUD_API_KEY in Cloudflare settings.' },
      { status: 500 },
    );
  }

  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sanitized = sanitizeChatPayload(parsed);
  if (!sanitized.ok) {
    return Response.json({ error: sanitized.error }, { status: 400 });
  }

  const payload = sanitized.payload;
  console.log(
    `[api/chat] model=${payload.model}, messages=${payload.messages.length}, stream=${payload.stream === true}`,
  );

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    let upstream: Response;

    try {
      upstream = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Diff/1.0',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log(`[api/chat] Upstream responded: ${upstream.status}`);

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      console.error(`[api/chat] Upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
      return Response.json(
        { error: `Ollama API error ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status },
      );
    }

    // Streaming: pipe upstream ndjson straight through
    if (payload.stream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Non-streaming: return as-is
    const data: unknown = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? 'Upstream request timed out after 60 seconds' : message;
    console.error(`[api/chat] Unhandled: ${message}`);
    return Response.json({ error }, { status });
  }
}
