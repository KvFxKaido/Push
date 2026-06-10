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

  it('matches the Phase 2 run-ledger routes with their methods', () => {
    expect(matchRunHostRoute('/api/runhost/run/register', 'POST')).toBe('run.register');
    expect(matchRunHostRoute('/api/runhost/run/checkpoint', 'PUT')).toBe('run.checkpoint');
    expect(matchRunHostRoute('/api/runhost/run/heartbeat', 'POST')).toBe('run.heartbeat');
    expect(matchRunHostRoute('/api/runhost/run/release', 'POST')).toBe('run.release');
    expect(matchRunHostRoute('/api/runhost/run/status', 'GET')).toBe('run.status');
  });

  it('rejects wrong methods and unknown paths', () => {
    expect(matchRunHostRoute('/api/runhost/spike/relay', 'GET')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/spike/page', 'POST')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/spike/unknown', 'GET')).toBeNull();
    // checkpoint is PUT-only; register is POST-only.
    expect(matchRunHostRoute('/api/runhost/run/checkpoint', 'POST')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/run/register', 'GET')).toBeNull();
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

  it('counts reasoning_content deltas as tokens (reasoning models)', async () => {
    // glm-5.1 (a reasoning variant) can spend the whole token budget on
    // reasoning_content — the 2026-06-10 phone run measured TTFT=null on
    // every arm because only `content` was counted.
    const reasoningBody = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking "}}]}',
      '',
      'data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    mocks.resolveProviderHandler.mockReturnValue(async () => sseResponse(reasoningBody));
    const res = await makeHost().fetch(spikeRequest('/spike/server-turn', VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.contentChars).toBe('thinking hard'.length);
    expect(typeof body.serverFirstTokenMs).toBe('number');
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

// ---------------------------------------------------------------------------
// Phase 2 substrate — run ledger + silence alarm
// ---------------------------------------------------------------------------

/** In-memory mock of the DO storage surface the run ledger uses. */
function makeStorage() {
  const map = new Map<string, unknown>();
  const s = {
    map,
    alarmAt: null as number | null,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, val: unknown): Promise<void> {
      map.set(key, val);
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async setAlarm(ts: number): Promise<void> {
      s.alarmAt = ts;
    },
    async deleteAlarm(): Promise<void> {
      s.alarmAt = null;
    },
  };
  return s;
}

type Storage = ReturnType<typeof makeStorage>;

function makeLedgerHost(storage: Storage): RunHost {
  return new RunHost(
    { storage } as unknown as ConstructorParameters<typeof RunHost>[0],
    {} as unknown as Env,
  );
}

const SCOPE = { repoFullName: 'KvFxKaido/Push', branch: 'main', chatId: 'chat-1' };

function makeCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    chatId: SCOPE.chatId,
    repoFullName: SCOPE.repoFullName,
    branch: SCOPE.branch,
    runId: 'run-1',
    round: 4,
    phase: 'executing_tools',
    savedAt: 1781000000000,
    reason: 'turn',
    messages: [
      { role: 'system', content: 'You are Push.' },
      { role: 'user', content: 'Fix the bug in foo.ts' },
    ],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'Fix the bug in foo.ts',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
    ...overrides,
  };
}

function ledgerRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://do${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function register(host: RunHost, body: Record<string, unknown> = {}): Promise<Response> {
  return host.fetch(
    ledgerRequest('/run/register', 'POST', {
      runId: 'run-1',
      scope: SCOPE,
      mode: 'supervised',
      round: 0,
      ...body,
    }),
  );
}

describe('run ledger: register', () => {
  it('opens a watched run and arms the silence alarm', async () => {
    const storage = makeStorage();
    const res = await register(makeLedgerHost(storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.state).toBe('watched');
    expect(typeof body.heartbeatIntervalMs).toBe('number');
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('watched');
    expect(record.hasCheckpoint).toBe(false);
    expect(storage.alarmAt).not.toBeNull();
  });

  it('rejects an incomplete scope or unknown approval mode', async () => {
    const host = makeLedgerHost(makeStorage());
    expect((await register(host, { scope: { repoFullName: 'o/r' } })).status).toBe(400);
    expect((await register(host, { mode: 'yolo' })).status).toBe(400);
  });

  it('supersedes a different run on the same scope and drops its checkpoint', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));
    expect(storage.map.has('run:checkpoint')).toBe(true);
    await register(host, { runId: 'run-2' });
    expect(storage.map.has('run:checkpoint')).toBe(false);
    expect((storage.map.get('run:record') as Record<string, unknown>).runId).toBe('run-2');
  });

  it('preserves the prior round on a same-run re-register that omits it', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));
    expect((storage.map.get('run:record') as Record<string, unknown>).round).toBe(4);
    // Reconnect without echoing the round — it must not regress to 0.
    await register(host, { round: undefined });
    expect((storage.map.get('run:record') as Record<string, unknown>).round).toBe(4);
  });
});

describe('run ledger: checkpoint', () => {
  it('persists a valid checkpoint and reflects it in status', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const res = await host.fetch(
      ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.round).toBe(4);
    expect(typeof body.bytes).toBe('number');

    const statusRes = await host.fetch(ledgerRequest('/run/status', 'GET'));
    const status = (await statusRes.json()) as Record<string, unknown>;
    expect(status.hasCheckpoint).toBe(true);
    expect(status.round).toBe(4);
    expect(status.midFlight).toBe(true);
  });

  it('rejects a checkpoint before the run is registered (409)', async () => {
    const res = await makeLedgerHost(makeStorage()).fetch(
      ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('NOT_REGISTERED');
  });

  it('rejects an invalid checkpoint (400) — credential blocklist runs here', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const leaky = makeCheckpoint({ apiKey: 'sk-leaked' });
    const res = await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: leaky }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('INVALID_CHECKPOINT');
  });

  it('rejects a checkpoint whose runId does not match the run (409)', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const res = await host.fetch(
      ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint({ runId: 'other' }) }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('RUN_MISMATCH');
  });

  it('rejects a hosted checkpoint with no runId (400) — cannot bind to a run', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const res = await host.fetch(
      ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint({ runId: undefined }) }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('MISSING_RUN_ID');
    expect(storage.map.has('run:checkpoint')).toBe(false);
  });

  it('rejects an oversize checkpoint loudly (413) rather than failing the put', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const huge = makeCheckpoint({
      messages: [{ role: 'user', content: 'x'.repeat(140 * 1024) }],
    });
    storage.alarmAt = null;
    const res = await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: huge }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('CHECKPOINT_TOO_LARGE');
    // The put was rejected — no checkpoint persisted.
    expect(storage.map.has('run:checkpoint')).toBe(false);
    // …but the provably-alive client's beat still counts: the clock is bumped
    // and the silence alarm re-armed, so it doesn't lapse into adoptable.
    expect(storage.alarmAt).not.toBeNull();
    expect((storage.map.get('run:record') as Record<string, unknown>).hasCheckpoint).toBe(false);
  });

  it('marks an aborted checkpoint not-mid-flight', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(
      ledgerRequest('/run/checkpoint', 'PUT', {
        checkpoint: makeCheckpoint({ userAborted: true }),
      }),
    );
    expect((storage.map.get('run:record') as Record<string, unknown>).midFlight).toBe(false);
  });
});

describe('run ledger: heartbeat + release', () => {
  it('heartbeat bumps the clock and re-arms the alarm', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const before = (storage.map.get('run:record') as Record<string, unknown>)
      .lastHeartbeatAt as number;
    storage.alarmAt = null;
    await new Promise((r) => setTimeout(r, 2));
    const res = await host.fetch(ledgerRequest('/run/heartbeat', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(200);
    const after = (storage.map.get('run:record') as Record<string, unknown>)
      .lastHeartbeatAt as number;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(storage.alarmAt).not.toBeNull();
  });

  it('heartbeat for an unregistered run is 409', async () => {
    const res = await makeLedgerHost(makeStorage()).fetch(
      ledgerRequest('/run/heartbeat', 'POST', { runId: 'run-1' }),
    );
    expect(res.status).toBe(409);
  });

  it('heartbeat without a runId is 400 — cannot bind to the run', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const res = await host.fetch(ledgerRequest('/run/heartbeat', 'POST', {}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('MISSING_RUN_ID');
  });

  it('heartbeat on an adoptable run records liveness but does not resurrect it', async () => {
    const storage = makeStorage();
    storage.map.set('run:record', {
      v: 1,
      runId: 'run-1',
      scope: SCOPE,
      mode: 'supervised',
      state: 'adoptable',
      registeredAt: 1,
      lastHeartbeatAt: 1,
      hasCheckpoint: true,
      midFlight: true,
      round: 4,
    });
    storage.alarmAt = null;
    const res = await makeLedgerHost(storage).fetch(
      ledgerRequest('/run/heartbeat', 'POST', { runId: 'run-1' }),
    );
    expect(res.status).toBe(200);
    // The client learns it must re-register (pull-back-local) to take it back.
    expect(((await res.json()) as Record<string, unknown>).state).toBe('adoptable');
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('adoptable');
    // No re-arm — the one-way `adoptable` contract.
    expect(storage.alarmAt).toBeNull();
  });

  it('release tears down the record, checkpoint, and alarm', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));
    const res = await host.fetch(ledgerRequest('/run/release', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).released).toBe(true);
    expect(storage.map.has('run:record')).toBe(false);
    expect(storage.map.has('run:checkpoint')).toBe(false);
    expect(storage.alarmAt).toBeNull();
  });

  it('release of an unknown run is an idempotent no-op (200)', async () => {
    const res = await makeLedgerHost(makeStorage()).fetch(
      ledgerRequest('/run/release', 'POST', { runId: 'run-1' }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).released).toBe(false);
  });

  it('refuses to tear down a live run on a release with no runId (400)', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));
    const res = await host.fetch(ledgerRequest('/run/release', 'POST', {}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('MISSING_RUN_ID');
    // The live run survives — nothing deleted.
    expect(storage.map.has('run:record')).toBe(true);
    expect(storage.map.has('run:checkpoint')).toBe(true);
  });

  it('refuses to tear down a superseding run on a stale release (409)', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await register(host, { runId: 'run-2' }); // run-2 supersedes run-1 on this scope
    const res = await host.fetch(ledgerRequest('/run/release', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(409);
    expect(storage.map.has('run:record')).toBe(true);
    expect((storage.map.get('run:record') as Record<string, unknown>).runId).toBe('run-2');
  });

  it('status for an unknown run is 404', async () => {
    const res = await makeLedgerHost(makeStorage()).fetch(ledgerRequest('/run/status', 'GET'));
    expect(res.status).toBe(404);
  });
});

describe('run ledger: silence alarm', () => {
  it('transitions a lapsed, mid-flight run to adoptable and clears the alarm', async () => {
    const storage = makeStorage();
    // Seed a watched run whose last heartbeat is well past the threshold.
    storage.map.set('run:record', {
      v: 1,
      runId: 'run-1',
      scope: SCOPE,
      mode: 'supervised',
      state: 'watched',
      registeredAt: 1,
      lastHeartbeatAt: Date.now() - 10 * 60_000,
      hasCheckpoint: true,
      midFlight: true,
      round: 4,
    });
    storage.alarmAt = 123;
    await makeLedgerHost(storage).alarm();
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('adoptable');
    // Parked — the alarm is cleared (the server-side loop is the next PR).
    expect(storage.alarmAt).toBeNull();
  });

  it('re-arms a run still within the silence window', async () => {
    const storage = makeStorage();
    const now = Date.now();
    storage.map.set('run:record', {
      v: 1,
      runId: 'run-1',
      scope: SCOPE,
      mode: 'supervised',
      state: 'watched',
      registeredAt: 1,
      lastHeartbeatAt: now,
      hasCheckpoint: true,
      midFlight: true,
      round: 4,
    });
    await makeLedgerHost(storage).alarm();
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('watched');
    expect(storage.alarmAt).toBeGreaterThan(now);
  });

  it('is a no-op when no record is present', async () => {
    const storage = makeStorage();
    await makeLedgerHost(storage).alarm();
    expect(storage.alarmAt).toBeNull();
  });
});
