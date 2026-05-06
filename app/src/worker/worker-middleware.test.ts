import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BODY_SIZE_BYTES,
  buildVertexPreambleAuth,
  createJsonProxyHandler,
  createStreamProxyHandler,
  getAllowedOrigins,
  getClientIp,
  getExperimentalUpstreamUrl,
  hasVertexNativeCredentials,
  normalizeOrigin,
  passthroughAuth,
  readBodyText,
  runPreamble,
  standardAuth,
  validateOrigin,
  wlog,
  type Env,
  type JsonProxyConfig,
} from './worker-middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    // Always-success rate limiter (per-test overrides can swap this).
    RATE_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    } as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
    ...overrides,
  };
}

function makeRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// normalizeOrigin
// ---------------------------------------------------------------------------

describe('normalizeOrigin', () => {
  it('returns null for null, empty, or the literal string "null"', () => {
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('null')).toBeNull();
  });

  it('strips path, query, and fragment from a URL', () => {
    expect(normalizeOrigin('https://push.example.test/app?foo=1#frag')).toBe(
      'https://push.example.test',
    );
  });

  it('preserves non-default ports', () => {
    expect(normalizeOrigin('http://localhost:8787/anything')).toBe('http://localhost:8787');
  });

  it('returns null when the URL cannot be parsed', () => {
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('//missing-protocol')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAllowedOrigins
// ---------------------------------------------------------------------------

describe('getAllowedOrigins', () => {
  const requestUrl = new URL('https://push.example.test/api/foo');

  it('always includes the request origin even if ALLOWED_ORIGINS is unset', () => {
    const allowed = getAllowedOrigins(requestUrl, makeEnv());
    expect(allowed.has('https://push.example.test')).toBe(true);
  });

  it('adds comma-separated origins from ALLOWED_ORIGINS', () => {
    const allowed = getAllowedOrigins(
      requestUrl,
      makeEnv({ ALLOWED_ORIGINS: 'https://a.test, https://b.test:9000' }),
    );
    expect(allowed.has('https://a.test')).toBe(true);
    expect(allowed.has('https://b.test:9000')).toBe(true);
  });

  it('skips unparseable entries in ALLOWED_ORIGINS', () => {
    const allowed = getAllowedOrigins(
      requestUrl,
      makeEnv({ ALLOWED_ORIGINS: 'not-a-url, https://ok.test' }),
    );
    expect(allowed.has('https://ok.test')).toBe(true);
    expect(Array.from(allowed).every((o) => o.startsWith('http'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateOrigin
// ---------------------------------------------------------------------------

describe('validateOrigin', () => {
  const requestUrl = new URL('https://push.example.test/api/chat');

  it('accepts a request whose Origin matches the request URL origin', () => {
    const request = makeRequest(requestUrl.toString(), {
      headers: { Origin: 'https://push.example.test' },
    });
    expect(validateOrigin(request, requestUrl, makeEnv())).toEqual({ ok: true });
  });

  it('accepts a request whose Origin matches an ALLOWED_ORIGINS entry', () => {
    const request = makeRequest(requestUrl.toString(), {
      headers: { Origin: 'https://trusted.test' },
    });
    const env = makeEnv({ ALLOWED_ORIGINS: 'https://trusted.test' });
    expect(validateOrigin(request, requestUrl, env)).toEqual({ ok: true });
  });

  it('falls back to Referer when Origin is missing', () => {
    const request = makeRequest(requestUrl.toString(), {
      headers: { Referer: 'https://push.example.test/some/page' },
    });
    expect(validateOrigin(request, requestUrl, makeEnv())).toEqual({ ok: true });
  });

  it('rejects a request with no Origin or Referer', () => {
    const request = makeRequest(requestUrl.toString());
    expect(validateOrigin(request, requestUrl, makeEnv())).toEqual({
      ok: false,
      error: 'Missing or invalid Origin/Referer',
    });
  });

  it('rejects a request whose Origin is not allowed', () => {
    const request = makeRequest(requestUrl.toString(), {
      headers: { Origin: 'https://evil.test' },
    });
    expect(validateOrigin(request, requestUrl, makeEnv())).toEqual({
      ok: false,
      error: 'Origin not allowed',
    });
  });

  it('rejects an Origin header of the literal "null"', () => {
    const request = makeRequest(requestUrl.toString(), {
      headers: { Origin: 'null' },
    });
    expect(validateOrigin(request, requestUrl, makeEnv())).toEqual({
      ok: false,
      error: 'Missing or invalid Origin/Referer',
    });
  });
});

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP', () => {
    const request = makeRequest('https://x.test/', {
      headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9' },
    });
    expect(getClientIp(request)).toBe('1.2.3.4');
  });

  it('falls back to the first entry of X-Forwarded-For', () => {
    const request = makeRequest('https://x.test/', {
      headers: { 'X-Forwarded-For': '5.6.7.8, 10.0.0.1' },
    });
    expect(getClientIp(request)).toBe('5.6.7.8');
  });

  it('trims whitespace inside X-Forwarded-For', () => {
    const request = makeRequest('https://x.test/', {
      headers: { 'X-Forwarded-For': '   5.6.7.8  , 10.0.0.1' },
    });
    expect(getClientIp(request)).toBe('5.6.7.8');
  });

  it('returns "unknown" when no identifying headers are present', () => {
    const request = makeRequest('https://x.test/');
    expect(getClientIp(request)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// wlog
// ---------------------------------------------------------------------------

describe('wlog', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('writes info logs as JSON on console.log', () => {
    wlog('info', 'some_event', { requestId: 'req_x' });
    expect(logSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe('info');
    expect(entry.event).toBe('some_event');
    expect(entry.requestId).toBe('req_x');
    expect(typeof entry.ts).toBe('string');
  });

  it('writes error logs on console.error', () => {
    wlog('error', 'boom');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readBodyText
// ---------------------------------------------------------------------------

describe('readBodyText', () => {
  it('reads a small body successfully', async () => {
    const request = makeRequest('https://x.test/', {
      method: 'POST',
      body: 'hello world',
    });
    const result = await readBodyText(request, 1024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('hello world');
  });

  it('rejects when Content-Length exceeds the limit', async () => {
    const request = makeRequest('https://x.test/', {
      method: 'POST',
      headers: { 'Content-Length': '100' },
      body: 'x',
    });
    const result = await readBodyText(request, 10);
    expect(result).toEqual({ ok: false, status: 413, error: 'Request body too large' });
  });

  it('rejects when the streamed body exceeds the limit', async () => {
    const big = 'y'.repeat(100);
    const request = makeRequest('https://x.test/', {
      method: 'POST',
      body: big,
    });
    const result = await readBodyText(request, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it('rejects an empty body', async () => {
    const request = makeRequest('https://x.test/', {
      method: 'POST',
      body: '',
    });
    const result = await readBodyText(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects a GET request with no body', async () => {
    const request = makeRequest('https://x.test/');
    const result = await readBodyText(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe('Missing request body');
    }
  });

  it('exposes MAX_BODY_SIZE_BYTES as a sensible default (>= 1 MiB)', () => {
    expect(MAX_BODY_SIZE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Auth builders
// ---------------------------------------------------------------------------

describe('standardAuth', () => {
  it('uses the server-side key when present', async () => {
    const env = makeEnv({ OLLAMA_API_KEY: 'sk-server' });
    const request = makeRequest('https://x.test/', {
      headers: { Authorization: 'Bearer client-token' },
    });
    expect(await standardAuth('OLLAMA_API_KEY')(env, request)).toBe('Bearer sk-server');
  });

  it('falls through to the client Authorization header when no server key', async () => {
    const env = makeEnv();
    const request = makeRequest('https://x.test/', {
      headers: { Authorization: 'Bearer client-token' },
    });
    expect(await standardAuth('OLLAMA_API_KEY')(env, request)).toBe('Bearer client-token');
  });

  it('returns null when neither a server key nor a client header is set', async () => {
    expect(
      await standardAuth('OLLAMA_API_KEY')(makeEnv(), makeRequest('https://x.test/')),
    ).toBeNull();
  });
});

describe('passthroughAuth', () => {
  it('returns the client Authorization header untouched', () => {
    const request = makeRequest('https://x.test/', {
      headers: { Authorization: 'Bearer client-token' },
    });
    expect(passthroughAuth(makeEnv(), request)).toBe('Bearer client-token');
  });

  it('returns null when no Authorization header is present', () => {
    expect(passthroughAuth(makeEnv(), makeRequest('https://x.test/'))).toBeNull();
  });
});

describe('hasVertexNativeCredentials / buildVertexPreambleAuth', () => {
  it('reports true when the Vertex service-account header is present', () => {
    const request = makeRequest('https://x.test/', {
      headers: { 'X-Push-Vertex-Service-Account': 'opaque-value' },
    });
    expect(hasVertexNativeCredentials(request)).toBe(true);
    expect(buildVertexPreambleAuth(makeEnv(), request)).toBe('VertexNative');
  });

  it('falls back to the Authorization header when no native credentials', () => {
    const request = makeRequest('https://x.test/', {
      headers: { Authorization: 'Bearer x' },
    });
    expect(hasVertexNativeCredentials(request)).toBe(false);
    expect(buildVertexPreambleAuth(makeEnv(), request)).toBe('Bearer x');
  });
});

// ---------------------------------------------------------------------------
// getExperimentalUpstreamUrl
// ---------------------------------------------------------------------------

describe('getExperimentalUpstreamUrl', () => {
  it('returns 400 when the upstream base URL is missing', async () => {
    const request = makeRequest('https://x.test/');
    const result = getExperimentalUpstreamUrl(request, 'azure', '/models');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/azure base URL is invalid/);
    }
  });

  it('returns 400 for a malformed base URL', async () => {
    const request = makeRequest('https://x.test/', {
      headers: { 'X-Push-Upstream-Base': 'not a url' },
    });
    const result = getExperimentalUpstreamUrl(request, 'azure', '/chat/completions');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('appends the suffix to a normalized base URL', () => {
    const request = makeRequest('https://x.test/', {
      headers: {
        'X-Push-Upstream-Base': 'https://my-resource.openai.azure.com/openai/v1',
      },
    });
    const result = getExperimentalUpstreamUrl(request, 'azure', '/chat/completions');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.endsWith('/openai/v1/chat/completions')).toBe(true);
      expect(result.url.startsWith('https://my-resource.openai.azure.com')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runPreamble — integrated guard
// ---------------------------------------------------------------------------

describe('runPreamble', () => {
  const requestUrl = 'https://push.example.test/api/chat';

  function makeChatRequest(body: string | null, headers: Record<string, string> = {}): Request {
    const init: RequestInit = {
      method: body === null ? 'GET' : 'POST',
      headers: {
        Origin: 'https://push.example.test',
        ...headers,
      },
    };
    if (body !== null) init.body = body;
    return makeRequest(requestUrl, init);
  }

  it('returns a 403 when the origin is not allowed', async () => {
    const request = makeChatRequest('{}', { Origin: 'https://evil.test' });
    const response = await runPreamble(request, makeEnv(), {
      buildAuth: standardAuth('OLLAMA_API_KEY'),
    });
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) expect(response.status).toBe(403);
  });

  it('returns a 429 with Retry-After when the rate limiter rejects', async () => {
    const request = makeChatRequest('{}');
    const env = makeEnv({
      RATE_LIMITER: {
        limit: vi.fn(async () => ({ success: false })),
      } as unknown as Env['RATE_LIMITER'],
    });
    const response = await runPreamble(request, env, {
      buildAuth: standardAuth('OLLAMA_API_KEY'),
    });
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
    }
  });

  it('returns 401 when buildAuth yields null and keyMissingError is provided', async () => {
    const request = makeChatRequest('{}');
    const response = await runPreamble(request, makeEnv(), {
      buildAuth: () => null,
      keyMissingError: 'no key',
    });
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('no key');
    }
  });

  it('succeeds and returns auth/body/requestId when everything is in order', async () => {
    const request = makeChatRequest('{"hello":"world"}');
    const env = makeEnv({ OLLAMA_API_KEY: 'sk-server' });
    const result = await runPreamble(request, env, {
      buildAuth: standardAuth('OLLAMA_API_KEY'),
    });
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.authHeader).toBe('Bearer sk-server');
      expect(result.bodyText).toBe('{"hello":"world"}');
      expect(typeof result.requestId).toBe('string');
      expect(result.requestId.length).toBeGreaterThan(0);
      expect(result.spanCtx).toBeDefined();
    }
  });

  it('skips body reading when needsBody is false', async () => {
    const request = makeChatRequest(null);
    const result = await runPreamble(request, makeEnv({ OLLAMA_API_KEY: 'sk' }), {
      buildAuth: standardAuth('OLLAMA_API_KEY'),
      needsBody: false,
    });
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.bodyText).toBe('');
    }
  });

  it('propagates an incoming X-Push-Request-Id when it matches the safe pattern', async () => {
    const request = makeChatRequest('{}', { 'X-Push-Request-Id': 'req_abcdef12345' });
    const result = await runPreamble(request, makeEnv({ OLLAMA_API_KEY: 'k' }), {
      buildAuth: standardAuth('OLLAMA_API_KEY'),
    });
    if (!(result instanceof Response)) {
      expect(result.requestId).toBe('req_abcdef12345');
    }
  });

  it('rate-limits by client IP (CF-Connecting-IP is used as the key)', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const env = makeEnv({
      RATE_LIMITER: { limit } as unknown as Env['RATE_LIMITER'],
      OLLAMA_API_KEY: 'k',
    });
    const request = makeChatRequest('{}', { 'CF-Connecting-IP': '203.0.113.7' });
    await runPreamble(request, env, { buildAuth: standardAuth('OLLAMA_API_KEY') });
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
  });
});

// ---------------------------------------------------------------------------
// createStreamProxyHandler — factory used by most chat adapters
// ---------------------------------------------------------------------------

function makeChatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
}

function makeChatRequestPOST(
  body: string = makeChatBody(),
  headers: Record<string, string> = {},
): Request {
  return new Request('https://push.example.test/api/chat', {
    method: 'POST',
    headers: {
      Origin: 'https://push.example.test',
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });
}

function silenceWlog(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('createStreamProxyHandler', () => {
  const baseConfig = {
    name: 'Test Provider',
    logTag: 'api/test/chat',
    upstreamUrl: 'https://upstream.test/v1/chat/completions',
    timeoutMs: 30_000,
    maxOutputTokens: 4096,
    buildAuth: standardAuth('OLLAMA_API_KEY'),
    keyMissingError: 'missing key',
    timeoutError: 'timed out',
  };

  beforeEach(() => {
    silenceWlog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the preamble response short-circuit (403/401/429) without calling upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const handler = createStreamProxyHandler(baseConfig);
    // No Origin → 403
    const request = new Request('https://push.example.test/api/chat', {
      method: 'POST',
      body: makeChatBody(),
    });
    const response = await handler(request, makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed chat body with the validation error code', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const handler = createStreamProxyHandler(baseConfig);
    const request = makeChatRequestPOST('{"not":"valid-chat"}');
    const response = await handler(request, makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards the normalized body and auth header to the upstream URL', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('data: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    const handler = createStreamProxyHandler(baseConfig);
    await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk-server' }));

    expect(captured?.url).toBe(baseConfig.upstreamUrl);
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-server');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['X-Push-Request-Id']).toBeDefined();
  });

  it('streams the upstream SSE body through with text/event-stream headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('data: {"hello":"world"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    const handler = createStreamProxyHandler(baseConfig);
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(response.headers.get('Cache-Control')).toMatch(/no-cache/);
    expect(response.headers.get('X-Push-Trace-Id')).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get('X-Push-Span-Id')).toMatch(/^[0-9a-f]{16}$/);
    expect(await response.text()).toContain('data: {"hello":"world"}');
  });

  it('resolves upstreamUrl from a function when it is not a static string', async () => {
    let captured: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        captured = url;
        return new Response('', { status: 200 });
      }),
    );
    const handler = createStreamProxyHandler({
      ...baseConfig,
      upstreamUrl: (request) => `https://computed.test/${new URL(request.url).pathname.slice(1)}`,
    });
    await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(captured).toBe('https://computed.test/api/chat');
  });

  it('adds extraFetchHeaders when provided as an object or a function of request', async () => {
    let staticHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        staticHeaders = init.headers as Record<string, string>;
        return new Response('', { status: 200 });
      }),
    );
    const staticHandler = createStreamProxyHandler({
      ...baseConfig,
      extraFetchHeaders: { 'X-Static': 'yes' },
    });
    await staticHandler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(staticHeaders['X-Static']).toBe('yes');

    let dynamicHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        dynamicHeaders = init.headers as Record<string, string>;
        return new Response('', { status: 200 });
      }),
    );
    const dynamicHandler = createStreamProxyHandler({
      ...baseConfig,
      extraFetchHeaders: (request) => ({ 'X-Origin': new URL(request.url).origin }),
    });
    await dynamicHandler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(dynamicHeaders['X-Origin']).toBe('https://push.example.test');
  });

  it('returns the upstream status code with a clean JSON error on 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('internal explosion', { status: 503 })),
    );
    const handler = createStreamProxyHandler(baseConfig);
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/Test Provider API error 503/);
    expect(body.error).toContain('internal explosion');
  });

  it('strips HTML error pages and reports an HTTP-status message instead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body>403</body></html>', { status: 403 })),
    );
    const handler = createStreamProxyHandler(baseConfig);
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/HTTP 403/);
    expect(body.error).not.toContain('<html>');
  });

  it('routes upstream errors through formatUpstreamError when provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"raw":"x"}', { status: 429 })),
    );
    const handler = createStreamProxyHandler({
      ...baseConfig,
      formatUpstreamError: (status, body) =>
        ({
          error: `custom-${status}`,
          code: 'RATE_LIMITED',
          raw: body.slice(0, 5),
        }) as unknown as { error: string; code?: string },
    });
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('custom-429');
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('returns 504 with the timeoutError when fetch aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    const handler = createStreamProxyHandler(baseConfig);
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe('timed out');
  });

  it('returns 502 on a non-timeout network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    const handler = createStreamProxyHandler(baseConfig);
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('connection refused');
  });

  it('preserves the upstream Content-Type when preserveUpstreamHeaders is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/custom+json' },
        });
      }),
    );
    const handler = createStreamProxyHandler({ ...baseConfig, preserveUpstreamHeaders: true });
    const response = await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.headers.get('Content-Type')).toBe('application/custom+json');
  });
});

// ---------------------------------------------------------------------------
// createJsonProxyHandler — factory used by model-list/search endpoints
// ---------------------------------------------------------------------------

describe('createJsonProxyHandler', () => {
  const baseConfig = {
    name: 'Test Provider',
    logTag: 'api/test/models',
    upstreamUrl: 'https://upstream.test/v1/models',
    timeoutMs: 10_000,
    buildAuth: standardAuth('OLLAMA_API_KEY'),
    keyMissingError: 'missing key',
    timeoutError: 'timed out',
  };

  beforeEach(() => {
    silenceWlog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeGetRequest(): Request {
    return new Request('https://push.example.test/api/models', {
      method: 'GET',
      headers: { Origin: 'https://push.example.test' },
    });
  }

  it('supports GET without requiring a body', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('{"data":[]}', { status: 200 });
      }),
    );
    const handler = createJsonProxyHandler({ ...baseConfig, method: 'GET' });
    const response = await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(200);
    expect(captured?.url).toBe(baseConfig.upstreamUrl);
    expect(captured?.init.method).toBe('GET');
    expect(captured?.init.body).toBeUndefined();
  });

  it('defaults to POST with a body when method is omitted', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return new Response('{}', { status: 200 });
      }),
    );
    const handler = createJsonProxyHandler(baseConfig);
    await handler(makeChatRequestPOST(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(capturedInit?.method).toBe('POST');
    expect(typeof capturedInit?.body).toBe('string');
  });

  it('returns a structured upstream-error JSON on non-ok upstream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream broke', { status: 502 })),
    );
    const handler = createJsonProxyHandler({ ...baseConfig, method: 'GET' });
    const response = await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toMatch(/Test Provider error 502/);
  });

  it('uses formatUpstreamError when provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"raw":"x"}', { status: 429 })),
    );
    const handler = createJsonProxyHandler({
      ...baseConfig,
      method: 'GET',
      formatUpstreamError: (status) => ({ error: `custom-${status}` }),
    });
    const response = await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('custom-429');
  });

  it('attaches X-Push-Request-Id and X-Push-Trace-Id on a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"models":[]}', { status: 200 })),
    );
    const handler = createJsonProxyHandler({ ...baseConfig, method: 'GET' });
    const response = await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Push-Request-Id')).toBeDefined();
    expect(response.headers.get('X-Push-Trace-Id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns 504 with timeoutError when fetch aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    const handler = createJsonProxyHandler({ ...baseConfig, method: 'GET' });
    const response = await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe('timed out');
  });

  it('returns 500 on a non-timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('dns failure');
      }),
    );
    const handler = createJsonProxyHandler({ ...baseConfig, method: 'GET' });
    const response = await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('dns failure');
  });

  it('short-circuits with 401 when the auth key is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const handler = createJsonProxyHandler({ ...baseConfig, method: 'GET' });
    const response = await handler(makeGetRequest(), makeEnv());
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds extraFetchHeaders to the upstream request', async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        return new Response('{}', { status: 200 });
      }),
    );
    const handler = createJsonProxyHandler({
      ...baseConfig,
      method: 'GET',
      extraFetchHeaders: { 'X-Extra': 'yes' },
    });
    await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));
    expect(capturedHeaders['X-Extra']).toBe('yes');
  });

  // ---------------------------------------------------------------------------
  // createJsonProxyHandler — AI Gateway routing
  // ---------------------------------------------------------------------------

  describe('createJsonProxyHandler — AI Gateway routing', () => {
    const jsonBaseConfig: JsonProxyConfig = {
      name: 'Test JSON Provider',
      logTag: 'api/test/models',
      upstreamUrl: 'https://upstream.test/v1/models',
      method: 'GET',
      timeoutMs: 30_000,
      buildAuth: standardAuth('OLLAMA_API_KEY'),
      keyMissingError: 'missing key',
      timeoutError: 'timed out',
      gateway: { provider: 'openrouter', pathSuffix: '/models' },
    };

    function makeGetRequest(): Request {
      return new Request('https://push.example.test/api/models', {
        method: 'GET',
        headers: { Origin: 'https://push.example.test' },
      });
    }

    beforeEach(() => {
      silenceWlog();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('uses direct URL when gateway env vars are unset', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedHeaders = init.headers as Record<string, string>;
          return new Response('{}', { status: 200 });
        }),
      );
      const handler = createJsonProxyHandler({ ...jsonBaseConfig });
      await handler(makeGetRequest(), makeEnv({ OLLAMA_API_KEY: 'sk' }));

      expect(capturedUrl).toBe('https://upstream.test/v1/models');
      expect(capturedHeaders['cf-aig-authorization']).toBeUndefined();
    });

    it('rewrites URL to gateway when account+slug are set', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedHeaders = init.headers as Record<string, string>;
          return new Response('{}', { status: 200 });
        }),
      );
      const handler = createJsonProxyHandler({ ...jsonBaseConfig });
      await handler(
        makeGetRequest(),
        makeEnv({
          OLLAMA_API_KEY: 'sk',
          CF_AI_GATEWAY_ACCOUNT_ID: 'test-account',
          CF_AI_GATEWAY_SLUG: 'test-gateway',
        }),
      );

      expect(capturedUrl).toBe(
        'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/openrouter/models',
      );
      expect(capturedHeaders.Authorization).toBe('Bearer sk');
      expect(capturedHeaders['cf-aig-authorization']).toBeUndefined();
    });

    it('attaches gateway auth header when token is set', async () => {
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedHeaders = init.headers as Record<string, string>;
          return new Response('{}', { status: 200 });
        }),
      );
      const handler = createJsonProxyHandler({ ...jsonBaseConfig });
      await handler(
        makeGetRequest(),
        makeEnv({
          OLLAMA_API_KEY: 'sk',
          CF_AI_GATEWAY_ACCOUNT_ID: 'test-account',
          CF_AI_GATEWAY_SLUG: 'test-gateway',
          CF_AI_GATEWAY_TOKEN: 'test-token',
        }),
      );

      expect(capturedHeaders['cf-aig-authorization']).toBe('Bearer test-token');
    });

    it('orphan token does not leak when gateway URL is null', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedHeaders = init.headers as Record<string, string>;
          return new Response('{}', { status: 200 });
        }),
      );
      const handler = createJsonProxyHandler({ ...jsonBaseConfig });
      await handler(
        makeGetRequest(),
        makeEnv({
          OLLAMA_API_KEY: 'sk',
          CF_AI_GATEWAY_TOKEN: 'orphan-token',
        }),
      );

      expect(capturedUrl).toBe('https://upstream.test/v1/models');
      expect(capturedHeaders['cf-aig-authorization']).toBeUndefined();
    });
  });
});
