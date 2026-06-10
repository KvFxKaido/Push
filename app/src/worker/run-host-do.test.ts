/**
 * RunHost DO — Phase 0 latency-spike endpoints.
 *
 * The provider handler is mocked at the coder-job-stream-adapter seam (the
 * real resolver is proven by the CoderJob path); these tests cover the
 * spike-local logic: request parsing, SSE delta scanning, timing-mark
 * injection, and the error surfaces.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveProviderHandler: vi.fn(),
}));

vi.mock('./coder-job-stream-adapter', () => ({
  resolveProviderHandler: mocks.resolveProviderHandler,
}));

import { RunHost } from './run-host-do';
import { matchRunHostRoute } from './run-host-routes';
import type { Env } from './worker-middleware';

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hello "}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"world"}}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function sseResponse(body = SSE_BODY): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeHost(): RunHost {
  return new RunHost(
    {} as unknown as ConstructorParameters<typeof RunHost>[0],
    {} as unknown as Env,
  );
}

function spikeRequest(path: string, body: unknown): Request {
  return new Request(`https://do${path}?spikeOrigin=${encodeURIComponent('https://push.test')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { provider: 'zen', model: 'glm-5.1', prompt: 'ping' };

beforeEach(() => {
  mocks.resolveProviderHandler.mockReset();
  mocks.resolveProviderHandler.mockReturnValue(async () => sseResponse());
});

describe('matchRunHostRoute', () => {
  it('matches the spike routes with their methods', () => {
    expect(matchRunHostRoute('/api/runhost/spike/page', 'GET')).toBe('page');
    expect(matchRunHostRoute('/api/runhost/spike/page.js', 'GET')).toBe('page.js');
    expect(matchRunHostRoute('/api/runhost/spike/relay', 'POST')).toBe('relay');
    expect(matchRunHostRoute('/api/runhost/spike/server-turn', 'POST')).toBe('server-turn');
    expect(matchRunHostRoute('/api/runhost/spike/ws', 'GET')).toBe('ws');
  });

  it('rejects wrong methods and unknown paths', () => {
    expect(matchRunHostRoute('/api/runhost/spike/relay', 'GET')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/spike/page', 'POST')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/spike/unknown', 'GET')).toBeNull();
    expect(matchRunHostRoute('/api/jobs/start', 'POST')).toBeNull();
  });
});

describe('POST /spike/server-turn', () => {
  it('consumes the provider stream and returns timing JSON', async () => {
    const res = await makeHost().fetch(spikeRequest('/spike/server-turn', VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.contentChars).toBe('hello world'.length);
    expect(typeof body.serverFirstByteMs).toBe('number');
    expect(typeof body.serverFirstTokenMs).toBe('number');
    expect(typeof body.serverTotalMs).toBe('number');
  });

  it('maps an upstream failure to PROVIDER_ERROR 502 with bounded detail', async () => {
    mocks.resolveProviderHandler.mockReturnValue(
      async () => new Response('upstream auth failed', { status: 401 }),
    );
    const res = await makeHost().fetch(spikeRequest('/spike/server-turn', VALID_BODY));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('PROVIDER_ERROR');
    expect(body.status).toBe(401);
    expect(body.detail).toContain('upstream auth failed');
  });

  it('rejects a body without provider/model', async () => {
    const res = await makeHost().fetch(spikeRequest('/spike/server-turn', { model: 'x' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported provider', async () => {
    mocks.resolveProviderHandler.mockReturnValue(null);
    const res = await makeHost().fetch(spikeRequest('/spike/server-turn', VALID_BODY));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('UNSUPPORTED_PROVIDER');
  });

  it('fails with MISSING_ORIGIN when the route did not stamp spikeOrigin', async () => {
    const req = new Request('https://do/spike/server-turn', {
      method: 'POST',
      body: JSON.stringify(VALID_BODY),
    });
    const res = await makeHost().fetch(req);
    expect(res.status).toBe(500);
  });
});

describe('POST /spike/relay', () => {
  it('passes the SSE body through with injected timing marks', async () => {
    const res = await makeHost().fetch(spikeRequest('/spike/relay', VALID_BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toMatch(/: spike do_dispatch=\d+/);
    expect(text).toMatch(/: spike upstream_first_byte_ms=\d+/);
    // Original SSE events survive unmodified.
    expect(text).toContain('data: {"choices":[{"delta":{"content":"hello "}}]}');
    expect(text).toContain('data: [DONE]');
  });

  it('builds the provider request against the stamped origin', async () => {
    let seenUrl: string | null = null;
    mocks.resolveProviderHandler.mockReturnValue(async (req: Request) => {
      seenUrl = req.url;
      return sseResponse();
    });
    await makeHost().fetch(spikeRequest('/spike/relay', VALID_BODY));
    expect(seenUrl).toBe('https://push.test/api/zen/chat');
  });

  it('routes zenGo through the Go endpoint', async () => {
    let seenUrl: string | null = null;
    mocks.resolveProviderHandler.mockReturnValue(async (req: Request) => {
      seenUrl = req.url;
      return sseResponse();
    });
    await makeHost().fetch(spikeRequest('/spike/relay', { ...VALID_BODY, zenGo: true }));
    expect(seenUrl).toBe('https://push.test/api/zen/go/chat');
  });
});

describe('unknown DO paths', () => {
  it('404s', async () => {
    const res = await makeHost().fetch(new Request('https://do/nope', { method: 'GET' }));
    expect(res.status).toBe(404);
  });
});
