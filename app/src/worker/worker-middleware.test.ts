import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BODY_SIZE_BYTES,
  buildVertexPreambleAuth,
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
