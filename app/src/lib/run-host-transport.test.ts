import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_HOST_HEARTBEAT_INTERVAL_MS } from '@push/lib/run-host-adoption';
import type { RunCheckpointV1 } from '@push/lib/run-checkpoint';
import {
  __resetRunHostTransportForTests,
  publishRunCheckpointToHost,
  releaseRunFromHost,
} from './run-host-transport';

// ---------------------------------------------------------------------------
// Fetch harness — records calls, replays scripted responses in order (a
// default 200 once the script runs out).
// ---------------------------------------------------------------------------

interface RecordedCall {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

let calls: RecordedCall[] = [];
let scripted: Array<Response | Error> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      const next = scripted.shift();
      if (next instanceof Error) throw next;
      return next ?? jsonResponse({ ok: true });
    }),
  );
}

/** Drain the transport's per-run promise queue. `Response.json()` costs a
 * handful of microtask hops per scripted response, so be generous. */
async function flush(): Promise<void> {
  for (let i = 0; i < 64; i++) await Promise.resolve();
}

function makeCheckpoint(overrides: Partial<RunCheckpointV1> = {}): RunCheckpointV1 {
  return {
    v: 1,
    chatId: 'chat-1',
    repoFullName: 'owner/repo',
    branch: 'main',
    runId: 'run-1',
    round: 3,
    phase: 'executing_tools',
    savedAt: 1781000000000,
    reason: 'turn',
    messages: [{ role: 'user', content: 'fix it' }],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'fix it',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
    ...overrides,
  } as RunCheckpointV1;
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  scripted = [];
  installFetch();
  __resetRunHostTransportForTests();
});

afterEach(() => {
  __resetRunHostTransportForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Register + checkpoint
// ---------------------------------------------------------------------------

describe('publishRunCheckpointToHost', () => {
  it('registers on the first publish, then PUTs the checkpoint', async () => {
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();

    expect(calls.map((c) => [c.path, c.method])).toEqual([
      ['/api/runhost/run/register', 'POST'],
      ['/api/runhost/run/checkpoint', 'PUT'],
    ]);
    expect(calls[0].body).toMatchObject({
      runId: 'run-1',
      scope: { repoFullName: 'owner/repo', branch: 'main', chatId: 'chat-1' },
      mode: 'supervised',
      round: 3,
    });
    expect(calls[1].body).toMatchObject({ checkpoint: { runId: 'run-1', round: 3 } });
  });

  it('skips the register on subsequent publishes', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    await flush();
    publishRunCheckpointToHost(makeCheckpoint({ round: 2 }));
    await flush();

    const paths = calls.map((c) => c.path);
    expect(paths.filter((p) => p.endsWith('/register'))).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith('/checkpoint'))).toHaveLength(2);
  });

  it('serializes a rapid pair of publishes behind one register', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    publishRunCheckpointToHost(makeCheckpoint({ round: 2 }));
    await flush();

    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/register',
      '/api/runhost/run/checkpoint',
      '/api/runhost/run/checkpoint',
    ]);
  });

  it('skips (without fetching) when the checkpoint has no runId', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ runId: undefined }));
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('skips (without fetching) on an incomplete scope', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ branch: '' }));
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('retries the register on the next publish after a failed register', async () => {
    scripted = [new Error('network down')];
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    await flush();
    // Register failed → no checkpoint PUT was attempted.
    expect(calls.map((c) => c.path)).toEqual(['/api/runhost/run/register']);

    publishRunCheckpointToHost(makeCheckpoint({ round: 2 }));
    await flush();
    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/register',
      '/api/runhost/run/register',
      '/api/runhost/run/checkpoint',
    ]);
  });

  it('re-registers after a checkpoint 409 (host lost or superseded the run)', async () => {
    scripted = [
      jsonResponse({ ok: true }), // register
      jsonResponse({ error: 'NOT_REGISTERED' }, 409), // checkpoint
    ];
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    await flush();
    publishRunCheckpointToHost(makeCheckpoint({ round: 2 }));
    await flush();

    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/register',
      '/api/runhost/run/checkpoint',
      '/api/runhost/run/register',
      '/api/runhost/run/checkpoint',
    ]);
  });

  it('survives a 413 oversize rejection without unregistering', async () => {
    scripted = [
      jsonResponse({ ok: true }), // register
      jsonResponse({ error: 'CHECKPOINT_TOO_LARGE', bytes: 200_000 }, 413),
    ];
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    await flush();
    publishRunCheckpointToHost(makeCheckpoint({ round: 2 }));
    await flush();

    // No second register — the host kept the run (and counted the liveness).
    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/register',
      '/api/runhost/run/checkpoint',
      '/api/runhost/run/checkpoint',
    ]);
  });

  it('never throws when fetch rejects', async () => {
    scripted = [new Error('boom')];
    expect(() => publishRunCheckpointToHost(makeCheckpoint())).not.toThrow();
    await flush();
  });

  it('disables the transport for the session on a 503 NOT_CONFIGURED register', async () => {
    scripted = [jsonResponse({ error: 'NOT_CONFIGURED' }, 503)];
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    await flush();
    publishRunCheckpointToHost(makeCheckpoint({ round: 2 }));
    await flush();

    expect(calls.map((c) => c.path)).toEqual(['/api/runhost/run/register']);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------

describe('heartbeat loop', () => {
  it('beats at the server-provided cadence with runId + scope', async () => {
    scripted = [jsonResponse({ ok: true, heartbeatIntervalMs: 10_000 })];
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();
    calls = [];

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/heartbeat',
      '/api/runhost/run/heartbeat',
    ]);
    expect(calls[0].body).toMatchObject({
      runId: 'run-1',
      scope: { repoFullName: 'owner/repo', branch: 'main', chatId: 'chat-1' },
    });
  });

  it('falls back to the shared cadence constant when register omits it', async () => {
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();
    calls = [];

    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS);
    expect(calls.map((c) => c.path)).toEqual(['/api/runhost/run/heartbeat']);
  });

  it('keeps beating through transient network failures', async () => {
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();
    calls = [];

    scripted = [new Error('offline')];
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS);

    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/heartbeat',
      '/api/runhost/run/heartbeat',
    ]);
  });

  it('re-registers (pull-back-local) when a beat reports state adoptable', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ round: 5 }));
    await flush();
    calls = [];

    scripted = [jsonResponse({ ok: true, state: 'adoptable' })];
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS);
    await flush();

    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/heartbeat',
      '/api/runhost/run/register',
    ]);
    // The reclaim replays the latest published round, not 0.
    expect(calls[1].body).toMatchObject({ runId: 'run-1', round: 5 });
  });

  it('re-registers (reclaim) when a beat reports state adopted — register stops the server loop', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ round: 7 }));
    await flush();
    calls = [];

    scripted = [jsonResponse({ ok: true, state: 'adopted' })];
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS);
    await flush();

    expect(calls.map((c) => c.path)).toEqual([
      '/api/runhost/run/heartbeat',
      '/api/runhost/run/register',
    ]);
    expect(calls[1].body).toMatchObject({ runId: 'run-1', round: 7 });
  });

  it('stops the loop on a 409 (run released or superseded on the host)', async () => {
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();
    calls = [];

    scripted = [jsonResponse({ error: 'RUN_MISMATCH' }, 409)];
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS * 3);

    expect(calls.map((c) => c.path)).toEqual(['/api/runhost/run/heartbeat']);
  });
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

describe('releaseRunFromHost', () => {
  it('POSTs the release and stops the heartbeat', async () => {
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();
    calls = [];

    releaseRunFromHost('run-1');
    await flush();
    await vi.advanceTimersByTimeAsync(RUN_HOST_HEARTBEAT_INTERVAL_MS * 3);

    expect(calls.map((c) => c.path)).toEqual(['/api/runhost/run/release']);
    expect(calls[0].body).toMatchObject({
      runId: 'run-1',
      scope: { repoFullName: 'owner/repo', branch: 'main', chatId: 'chat-1' },
    });
  });

  it('is an idempotent no-op for an unknown or never-published run', async () => {
    releaseRunFromHost('run-1');
    releaseRunFromHost(null);
    releaseRunFromHost(undefined);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('does not release a run whose register never succeeded', async () => {
    scripted = [new Error('network down')];
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();
    calls = [];

    releaseRunFromHost('run-1');
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('drops queued publishes once released', async () => {
    publishRunCheckpointToHost(makeCheckpoint({ round: 1 }));
    releaseRunFromHost('run-1');
    await flush();

    // The queued first publish saw the handle disappear and bailed; only the
    // register (already in flight before release) may have landed — never a
    // checkpoint PUT for a released run.
    expect(calls.map((c) => c.path)).not.toContain('/api/runhost/run/checkpoint');
  });

  it('never throws when the release POST fails', async () => {
    publishRunCheckpointToHost(makeCheckpoint());
    await flush();

    scripted = [new Error('gone')];
    expect(() => releaseRunFromHost('run-1')).not.toThrow();
    await flush();
  });
});
