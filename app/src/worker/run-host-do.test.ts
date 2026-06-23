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
  provisionAdoption: vi.fn(),
  runAdoptedLoop: vi.fn(),
}));

vi.mock('./coder-job-stream-adapter', () => ({
  resolveProviderHandler: mocks.resolveProviderHandler,
}));

vi.mock('./run-host-adoption-runner', () => ({
  provisionAdoption: mocks.provisionAdoption,
  runAdoptedLoop: mocks.runAdoptedLoop,
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
  mocks.provisionAdoption.mockReset();
  mocks.provisionAdoption.mockResolvedValue({
    ok: true,
    origin: 'https://push.test',
    sandboxId: 'sb-1',
    ownerToken: 'owner-token',
  });
  mocks.runAdoptedLoop.mockReset();
  // Default: a loop that runs "forever" (tests abort or re-mock it).
  mocks.runAdoptedLoop.mockReturnValue(new Promise<void>(() => {}));
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

  it('matches the Phase 3 attach/viewer routes with their methods', () => {
    expect(matchRunHostRoute('/api/runhost/run/attach', 'GET')).toBe('run.attach');
    expect(matchRunHostRoute('/api/runhost/run/stop', 'POST')).toBe('run.stop');
    expect(matchRunHostRoute('/api/runhost/run/approval', 'POST')).toBe('run.approval');
    expect(matchRunHostRoute('/api/runhost/run/attach', 'POST')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/run/stop', 'GET')).toBeNull();
    expect(matchRunHostRoute('/api/runhost/run/approval', 'GET')).toBeNull();
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
    {
      storage,
      waitUntil: (p: Promise<unknown>) => {
        void p.catch(() => {});
      },
      // The ledger tests don't attach `/run/watch` sockets; an empty list is
      // the no-watchers short-circuit `broadcastWatchers` takes in production.
      getWebSockets: () => [],
    } as unknown as ConstructorParameters<typeof RunHost>[0],
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

function seedWatchedLapsedRun(storage: Storage, overrides: Record<string, unknown> = {}): void {
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
    origin: 'https://push.test',
    ...overrides,
  });
  storage.map.set('run:checkpoint', makeCheckpoint());
}

describe('run ledger: silence alarm', () => {
  it('adopts a lapsed, mid-flight run: state adopted, watchdog armed, loop launched', async () => {
    const storage = makeStorage();
    seedWatchedLapsedRun(storage);
    storage.alarmAt = 123;
    await makeLedgerHost(storage).alarm();
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('adopted');
    expect(typeof record.adoptionId).toBe('string');
    expect(typeof record.adoptedAt).toBe('number');
    // Watchdog armed so an eviction is recoverable.
    expect(storage.alarmAt).not.toBeNull();
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
    const args = mocks.runAdoptedLoop.mock.calls[0][0] as Record<string, unknown>;
    expect(args.ownerToken).toBe('owner-token');
    expect(args.origin).toBe('https://push.test');
    expect(args.sandboxId).toBe('sb-1');
  });

  it('parks adoptable LOUDLY (alarm cleared, no loop) when provisioning is blocked', async () => {
    const storage = makeStorage();
    seedWatchedLapsedRun(storage);
    mocks.provisionAdoption.mockResolvedValue({ ok: false, reason: 'no_sandbox_credentials' });
    storage.alarmAt = 123;
    await makeLedgerHost(storage).alarm();
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('adoptable');
    expect(storage.alarmAt).toBeNull();
    expect(mocks.runAdoptedLoop).not.toHaveBeenCalled();
  });

  it('a register landing during provisioning preempts the adoption (no hijack)', async () => {
    const storage = makeStorage();
    seedWatchedLapsedRun(storage);
    // Simulate a reclaim interleaving at the provisioning await: by the time
    // the KV read resolves, a live client re-registered and the record is
    // `watched` again with the silence alarm armed.
    mocks.provisionAdoption.mockImplementation(async () => {
      const record = storage.map.get('run:record') as Record<string, unknown>;
      storage.map.set('run:record', { ...record, state: 'watched' });
      storage.alarmAt = Date.now() + 45_000;
      return { ok: true, origin: 'https://push.test', sandboxId: 'sb-1', ownerToken: 'tok' };
    });
    await makeLedgerHost(storage).alarm();
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('watched');
    expect(record.adoptionId).toBeUndefined();
    expect(mocks.runAdoptedLoop).not.toHaveBeenCalled();
    // The racing register's silence alarm survives — preemption touches nothing.
    expect(storage.alarmAt).not.toBeNull();
  });

  it('parks adoptable when no checkpoint exists to adopt from', async () => {
    const storage = makeStorage();
    seedWatchedLapsedRun(storage);
    storage.map.delete('run:checkpoint');
    // hasCheckpoint must be true to reach adoption at all — simulate a record
    // whose checkpoint vanished (storage divergence) to prove the fail-closed
    // park rather than a crash.
    await makeLedgerHost(storage).alarm();
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('adoptable');
    expect(storage.alarmAt).toBeNull();
    expect(mocks.runAdoptedLoop).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Phase 2 loop — adopted lifecycle (reclaim, watchdog, orphan relaunch)
// ---------------------------------------------------------------------------

/** Drive a host through silence-adoption so the in-memory loop handle is
 * live, and return the abort controller the DO handed the runner. */
async function adoptRun(host: RunHost, storage: Storage): Promise<AbortController> {
  seedWatchedLapsedRun(storage);
  await host.alarm();
  expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  const args = mocks.runAdoptedLoop.mock.calls[0][0] as { abort: AbortController };
  return args.abort;
}

describe('run ledger: adopted lifecycle', () => {
  it('register reclaims an adopted run: loop aborted, state watched, response says so', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    const abort = await adoptRun(host, storage);
    expect(abort.signal.aborted).toBe(false);

    const res = await register(host);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reclaimedFromAdopted).toBe(true);
    expect(body.hostRound).toBe(4);
    expect(abort.signal.aborted).toBe(true);
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('watched');
    expect(record.adoptionId).toBeUndefined();
  });

  it('rejects a client checkpoint while adopted (409 RUN_NOT_WATCHED)', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    const res = await host.fetch(
      ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('RUN_NOT_WATCHED');
    expect(body.state).toBe('adopted');
  });

  it('rejects a client checkpoint while adoptable — no torn read under the adoption launcher', async () => {
    // A late client checkpoint landing while startAdoption is mid-await
    // would otherwise be accepted and then silently overwritten by the
    // loop's first persisted round (adoption launches from the checkpoint it
    // read BEFORE this write). The 409 routes the client into the
    // re-register reclaim path instead.
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    seedWatchedLapsedRun(storage, { state: 'adoptable' });
    const before = storage.map.get('run:checkpoint');
    const res = await host.fetch(
      ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint({ round: 9 }) }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('RUN_NOT_WATCHED');
    expect(body.state).toBe('adoptable');
    // The stored adoption source is untouched.
    expect(storage.map.get('run:checkpoint')).toBe(before);
    expect((storage.map.get('run:record') as Record<string, unknown>).round).toBe(4);
  });

  it('heartbeat on an adopted run reports the state so the client can reclaim', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    const res = await host.fetch(ledgerRequest('/run/heartbeat', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).state).toBe('adopted');
  });

  it('release of an adopted run aborts the loop and tears down', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    const abort = await adoptRun(host, storage);
    const res = await host.fetch(ledgerRequest('/run/release', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(200);
    expect(abort.signal.aborted).toBe(true);
    expect(storage.map.has('run:record')).toBe(false);
  });

  it('watchdog re-arms while the loop is alive in this isolate', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    storage.alarmAt = null;
    await host.alarm();
    expect(storage.alarmAt).not.toBeNull();
    // No relaunch — still the original loop.
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  });

  it('watchdog relaunches an orphaned loop after a DO eviction (new isolate)', async () => {
    const storage = makeStorage();
    const first = makeLedgerHost(storage);
    await adoptRun(first, storage);
    const beforeId = (storage.map.get('run:record') as Record<string, unknown>).adoptionId;

    // A fresh host over the same storage = the post-eviction isolate: the
    // record survives, the in-memory loop handle does not.
    const second = makeLedgerHost(storage);
    await second.alarm();
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('adopted');
    expect(record.adoptionRelaunches).toBe(1);
    expect(record.adoptionId).not.toBe(beforeId);
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(2);
  });

  it('watchdog expires an orphaned run once the relaunch cap is exhausted', async () => {
    const storage = makeStorage();
    const first = makeLedgerHost(storage);
    await adoptRun(first, storage);
    const record = storage.map.get('run:record') as Record<string, unknown>;
    record.adoptionRelaunches = 2; // RUN_HOST_MAX_ADOPTION_RELAUNCHES
    storage.map.set('run:record', record);

    const second = makeLedgerHost(storage);
    await second.alarm();
    const after = storage.map.get('run:record') as Record<string, unknown>;
    expect(after.state).toBe('ended');
    expect(after.midFlight).toBe(false);
    expect(storage.alarmAt).toBeNull();
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  });

  it('watchdog never relaunches a run paused at a supervised approval gate', async () => {
    const storage = makeStorage();
    const first = makeLedgerHost(storage);
    await adoptRun(first, storage);
    const record = storage.map.get('run:record') as Record<string, unknown>;
    record.pausedForApproval = { approvalId: 'adopt-sandbox_push-r5', kind: 'remote_side_effect' };
    storage.map.set('run:record', record);

    const second = makeLedgerHost(storage);
    await second.alarm();
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('adopted');
    expect(storage.alarmAt).toBeNull();
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  });

  it('a paused run is reclaimable: register clears the pause and goes watched', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    const record = storage.map.get('run:record') as Record<string, unknown>;
    record.pausedForApproval = { approvalId: 'a-1', kind: 'remote_side_effect' };
    storage.map.set('run:record', record);

    const res = await register(host);
    expect(res.status).toBe(200);
    const after = storage.map.get('run:record') as Record<string, unknown>;
    expect(after.state).toBe('watched');
    expect(after.pausedForApproval).toBeUndefined();
  });

  it('status exposes the adoption observability fields', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    const res = await host.fetch(ledgerRequest('/run/status', 'GET'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe('adopted');
    expect(typeof body.adoptedAt).toBe('number');
  });

  it('register persists the route-stamped hostOrigin on the record', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    const res = await host.fetch(
      new Request('https://do/run/register?hostOrigin=https%3A%2F%2Fpush.example', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1', scope: SCOPE, mode: 'supervised', round: 0 }),
      }),
    );
    expect(res.status).toBe(200);
    expect((storage.map.get('run:record') as Record<string, unknown>).origin).toBe(
      'https://push.example',
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — attach/viewer snapshot + pending-gate controls
// ---------------------------------------------------------------------------

/** Drive a host into the supervised-paused state a returning viewer sees. */
async function pauseAdoptedRun(
  host: RunHost,
  storage: Storage,
  pause: Record<string, unknown> = {
    approvalId: 'adopt-sandbox_push-r5',
    kind: 'remote_side_effect',
    tool: 'sandbox_push',
    argsFingerprint: 'cbf29ce484222325',
  },
): Promise<AbortController> {
  const abort = await adoptRun(host, storage);
  const record = storage.map.get('run:record') as Record<string, unknown>;
  record.pausedForApproval = pause;
  storage.map.set('run:record', record);
  return abort;
}

describe('run ledger: attach (Phase 3)', () => {
  it('attach for an unknown scope is 404', async () => {
    const res = await makeLedgerHost(makeStorage()).fetch(ledgerRequest('/run/attach', 'GET'));
    expect(res.status).toBe(404);
  });

  it('first attach returns the full snapshot including the stored checkpoint', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));
    const res = await host.fetch(ledgerRequest('/run/attach', 'GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('run-1');
    expect(body.state).toBe('watched');
    expect(body.round).toBe(4);
    expect(body.checkpointSavedAt).toBe(1781000000000);
    expect((body.checkpoint as Record<string, unknown>).round).toBe(4);
  });

  it('a current cursor skips the checkpoint body; a stale one gets it', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));
    const current = await host.fetch(
      ledgerRequest('/run/attach?sinceSavedAt=1781000000000', 'GET'),
    );
    const currentBody = (await current.json()) as Record<string, unknown>;
    expect(currentBody.checkpoint).toBeUndefined();
    expect(currentBody.checkpointSavedAt).toBe(1781000000000);
    const stale = await host.fetch(ledgerRequest('/run/attach?sinceSavedAt=1780999999999', 'GET'));
    expect(((await stale.json()) as Record<string, unknown>).checkpoint).toBeDefined();
  });

  it('attach is read-only: no heartbeat bump, no alarm change, no state change', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    const before = storage.map.get('run:record') as Record<string, unknown>;
    const beforeBeat = before.lastHeartbeatAt;
    const beforeAlarm = storage.alarmAt;
    const res = await host.fetch(ledgerRequest('/run/attach', 'GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe('adopted');
    const after = storage.map.get('run:record') as Record<string, unknown>;
    expect(after.lastHeartbeatAt).toBe(beforeBeat);
    expect(after.state).toBe('adopted');
    expect(storage.alarmAt).toBe(beforeAlarm);
  });

  it('attach surfaces the pending gate of a paused run', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await pauseAdoptedRun(host, storage);
    const res = await host.fetch(ledgerRequest('/run/attach', 'GET'));
    const body = (await res.json()) as Record<string, unknown>;
    const paused = body.pausedForApproval as Record<string, unknown>;
    expect(paused.approvalId).toBe('adopt-sandbox_push-r5');
    expect(paused.tool).toBe('sandbox_push');
  });
});

describe('run ledger: stop (Phase 3)', () => {
  it('stops an adopted run: loop aborted, ended, alarm cleared, checkpoint KEPT', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    const abort = await adoptRun(host, storage);
    const res = await host.fetch(ledgerRequest('/run/stop', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.stopped).toBe(true);
    expect(body.fromState).toBe('adopted');
    expect(abort.signal.aborted).toBe(true);
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('ended');
    expect(record.midFlight).toBe(false);
    expect(storage.alarmAt).toBeNull();
    // The final transcript stays hydratable until release.
    expect(storage.map.has('run:checkpoint')).toBe(true);
  });

  it('stop is idempotent on a terminal run', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage);
    await host.fetch(ledgerRequest('/run/stop', 'POST', { runId: 'run-1' }));
    const res = await host.fetch(ledgerRequest('/run/stop', 'POST', { runId: 'run-1' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).stopped).toBe(false);
  });

  it('stop without a record is a no-op; missing/stale runId refuses (400/409)', async () => {
    const noRecord = await makeLedgerHost(makeStorage()).fetch(
      ledgerRequest('/run/stop', 'POST', { runId: 'run-1' }),
    );
    expect(noRecord.status).toBe(200);
    expect(((await noRecord.json()) as Record<string, unknown>).stopped).toBe(false);

    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    const missing = await host.fetch(ledgerRequest('/run/stop', 'POST', {}));
    expect(missing.status).toBe(400);
    const stale = await host.fetch(ledgerRequest('/run/stop', 'POST', { runId: 'run-0' }));
    expect(stale.status).toBe(409);
    expect((storage.map.get('run:record') as Record<string, unknown>).state).toBe('watched');
  });
});

describe('run ledger: approval (Phase 3)', () => {
  it('approve relaunches the loop with a one-shot grant and clears the pause', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await pauseAdoptedRun(host, storage);
    const res = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        runId: 'run-1',
        approvalId: 'adopt-sandbox_push-r5',
        decision: 'approve',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.decision).toBe('approve');
    expect(body.state).toBe('adopted');

    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(2);
    const args = mocks.runAdoptedLoop.mock.calls[1][0] as {
      resolvedApproval: Record<string, unknown>;
    };
    expect(args.resolvedApproval.decision).toBe('approve');
    expect(args.resolvedApproval.tool).toBe('sandbox_push');
    expect(args.resolvedApproval.approvalId).toBe('adopt-sandbox_push-r5');
    // The grant is bound to the arguments the user approved.
    expect(args.resolvedApproval.argsFingerprint).toBe('cbf29ce484222325');

    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.state).toBe('adopted');
    expect(record.pausedForApproval).toBeNull();
    // Consumed by the launch — a crash-relaunch re-pauses, not re-grants.
    expect(record.resolvedApproval).toBeNull();
    expect(storage.alarmAt).not.toBeNull();
  });

  it('deny relaunches with the denial; tool recovered from the approvalId when unset', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    // Pre-`tool`-field pause record (older loop version).
    await pauseAdoptedRun(host, storage, {
      approvalId: 'adopt-sandbox_exec-r7',
      kind: 'destructive_sandbox',
    });
    const res = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        runId: 'run-1',
        approvalId: 'adopt-sandbox_exec-r7',
        decision: 'deny',
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(2);
    const args = mocks.runAdoptedLoop.mock.calls[1][0] as {
      resolvedApproval: Record<string, unknown>;
    };
    expect(args.resolvedApproval.decision).toBe('deny');
    expect(args.resolvedApproval.tool).toBe('sandbox_exec');
    // Pre-fingerprint pause record → no fingerprint to bind (legacy path).
    expect(args.resolvedApproval.argsFingerprint).toBeUndefined();
  });

  it('rejects a decision when nothing is paused (409 NO_PENDING_APPROVAL)', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await adoptRun(host, storage); // adopted but NOT paused
    const res = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        runId: 'run-1',
        approvalId: 'adopt-sandbox_push-r5',
        decision: 'approve',
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('NO_PENDING_APPROVAL');
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale approvalId (409 APPROVAL_MISMATCH) — the gate moved on', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await pauseAdoptedRun(host, storage);
    const res = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        runId: 'run-1',
        approvalId: 'adopt-other_tool-r2',
        decision: 'approve',
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('APPROVAL_MISMATCH');
    expect(body.pendingApprovalId).toBe('adopt-sandbox_push-r5');
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed decisions and unbound runIds (400/409)', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await pauseAdoptedRun(host, storage);
    const badDecision = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        runId: 'run-1',
        approvalId: 'adopt-sandbox_push-r5',
        decision: 'maybe',
      }),
    );
    expect(badDecision.status).toBe(400);
    const missingRun = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        approvalId: 'adopt-sandbox_push-r5',
        decision: 'approve',
      }),
    );
    expect(missingRun.status).toBe(400);
    const staleRun = await host.fetch(
      ledgerRequest('/run/approval', 'POST', {
        runId: 'run-9',
        approvalId: 'adopt-sandbox_push-r5',
        decision: 'approve',
      }),
    );
    expect(staleRun.status).toBe(409);
    expect(mocks.runAdoptedLoop).toHaveBeenCalledTimes(1);
  });
});

describe('run ledger: ownerUserId stamp', () => {
  it('persists the route-stamped ownerUser on register and keeps it across re-register', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    const res = await host.fetch(
      ledgerRequest('/run/register?ownerUser=107059169', 'POST', {
        runId: 'run-1',
        scope: SCOPE,
        mode: 'supervised',
        round: 0,
      }),
    );
    expect(res.status).toBe(200);
    let record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.ownerUserId).toBe('107059169');

    // A re-register without the stamp (defensive: route always stamps, but a
    // missing param must not erase the persisted identity).
    await register(host);
    record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.ownerUserId).toBe('107059169');
  });

  it('persists the stamp from a checkpoint write', async () => {
    const storage = makeStorage();
    const host = makeLedgerHost(storage);
    await register(host);
    await host.fetch(
      ledgerRequest('/run/checkpoint?ownerUser=anon', 'PUT', { checkpoint: makeCheckpoint() }),
    );
    const record = storage.map.get('run:record') as Record<string, unknown>;
    expect(record.ownerUserId).toBe('anon');
  });
});

// ---------------------------------------------------------------------------
// Phase 3 refinement — `/run/watch` WS push (broadcastWatchers)
// ---------------------------------------------------------------------------

/** Minimal stand-in for a hibernation WebSocket: records sends, round-trips
 * the cursor attachment, and notes a close. */
function makeFakeWatcher(initial: { sinceSavedAt: number | null } = { sinceSavedAt: null }) {
  let attachment: { sinceSavedAt: number | null } = initial;
  const sent: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  return {
    sent,
    get attachment() {
      return attachment;
    },
    get closed() {
      return closed;
    },
    send: (data: string) => sent.push(data),
    serializeAttachment: (value: { sinceSavedAt: number | null }) => {
      attachment = value;
    },
    deserializeAttachment: () => attachment,
    close: (code: number, reason: string) => {
      closed = { code, reason };
    },
  };
}

type FakeWatcher = ReturnType<typeof makeFakeWatcher>;

function makeWatchedHost(storage: Storage, sockets: FakeWatcher[]): RunHost {
  return new RunHost(
    {
      storage,
      waitUntil: (p: Promise<unknown>) => {
        void p.catch(() => {});
      },
      getWebSockets: () => sockets,
    } as unknown as ConstructorParameters<typeof RunHost>[0],
    {} as unknown as Env,
  );
}

function lastSnapshotFrame(socket: FakeWatcher) {
  const raw = socket.sent.at(-1);
  expect(raw).toBeDefined();
  return JSON.parse(raw as string) as { t: string; snapshot?: Record<string, unknown> };
}

describe('run watch: broadcastWatchers', () => {
  it('pushes a fresh snapshot to watchers when a checkpoint persists', async () => {
    const storage = makeStorage();
    const watcher = makeFakeWatcher();
    const host = makeWatchedHost(storage, [watcher]);
    await register(host);
    watcher.sent.length = 0; // ignore any register-path noise

    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));

    const frame = lastSnapshotFrame(watcher);
    expect(frame.t).toBe('snapshot');
    // First broadcast: the watcher's cursor was null, so the body ships and
    // the per-socket cursor advances to the checkpoint's savedAt.
    expect(frame.snapshot?.round).toBe(4);
    expect(frame.snapshot?.checkpoint).toBeDefined();
    expect(frame.snapshot?.checkpointSavedAt).toBe(1781000000000);
    expect(watcher.attachment.sinceSavedAt).toBe(1781000000000);
  });

  it('omits the checkpoint body once the watcher cursor is caught up', async () => {
    const storage = makeStorage();
    // Watcher already at the checkpoint's savedAt — a re-broadcast must ship
    // the lifecycle frame without re-downloading the unchanged transcript.
    const watcher = makeFakeWatcher({ sinceSavedAt: 1781000000000 });
    const host = makeWatchedHost(storage, [watcher]);
    await register(host);
    await host.fetch(ledgerRequest('/run/checkpoint', 'PUT', { checkpoint: makeCheckpoint() }));

    const frame = lastSnapshotFrame(watcher);
    expect(frame.t).toBe('snapshot');
    expect(frame.snapshot?.checkpoint).toBeUndefined();
    expect(frame.snapshot?.checkpointSavedAt).toBe(1781000000000);
  });

  it('closes watcher sockets when the run is released', async () => {
    const storage = makeStorage();
    const watcher = makeFakeWatcher();
    const host = makeWatchedHost(storage, [watcher]);
    await register(host);
    await host.fetch(ledgerRequest('/run/release', 'POST', { runId: 'run-1', scope: SCOPE }));
    expect(watcher.closed?.code).toBe(1000);
    expect(watcher.closed?.reason).toBe('released');
  });
});
