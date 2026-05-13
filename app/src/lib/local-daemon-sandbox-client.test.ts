/**
 * local-daemon-sandbox-client.test.ts — End-to-end coverage for the
 * transient-binding client wrappers (PR 3c.1). Stands up a real
 * `ws` server that mimics pushd's `sandbox_exec` / `daemon_identify`
 * shape so the wrapper's full path is exercised: WS upgrade →
 * subprotocol auth → request → response → handle close.
 *
 * The Node 20 WebSocket polyfill at the top is the same pattern used
 * in `local-daemon-binding.test.ts`. CI's app job pins Node 20, which
 * lacks `globalThis.WebSocket`; the adapter calls `new WebSocket(...)`
 * because that's the browser API it runs against in production.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { PROTOCOL_VERSION } from '@push/lib/protocol-schema';
import {
  LocalDaemonUnreachableError,
  execLocalDaemon,
  getDiffLocalDaemon,
  identifyLocalDaemon,
  isLiveDaemonBinding,
  isRelayBinding,
  listDirLocalDaemon,
  readFileLocalDaemon,
  runWithBinding,
  writeFileLocalDaemon,
  type LiveDaemonBinding,
} from './local-daemon-sandbox-client';
import type { RequestOptions, SessionResponse } from './local-daemon-binding';
import type { LocalPcBinding, RelayBinding } from '@/types';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as unknown as { WebSocket: typeof WsClient }).WebSocket = WsClient;
}

const VALID_TOKEN = 'pushd_test_client_token_xxxxxxxxxxxxxxxxxxxxxx';
const SUBPROTOCOL_SELECTOR = 'pushd.v1';

interface StubServer {
  port: number;
  close: () => Promise<void>;
  /** Override the next response payload (per request type) for failure-path tests. */
  setResponseOverride: (
    type: string,
    override: { ok: boolean; payload?: unknown; error?: unknown },
  ) => void;
}

async function startStubServer(): Promise<StubServer> {
  const overrides = new Map<string, { ok: boolean; payload?: unknown; error?: unknown }>();
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false,
    verifyClient: (info, cb) => {
      const subproto = info.req.headers['sec-websocket-protocol'];
      if (typeof subproto !== 'string') return cb(false, 401, 'missing protocol');
      const protocols = subproto.split(',').map((p) => p.trim());
      const bearer = protocols.find((p) => p.startsWith('bearer.'));
      if (!bearer) return cb(false, 401, 'malformed bearer');
      const token = bearer.slice('bearer.'.length);
      if (token !== VALID_TOKEN) return cb(false, 401, 'bad token');
      cb(true);
    },
  });

  const clients = new Set<WsServerSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => {
      const raw = data.toString('utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed);
        if (parsed.kind !== 'request') continue;
        const override = overrides.get(parsed.type);
        if (override) {
          ws.send(
            `${JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              requestId: parsed.requestId,
              type: parsed.type,
              sessionId: null,
              ok: override.ok,
              payload: override.payload ?? {},
              error: override.error ?? null,
            })}\n`,
          );
          continue;
        }
        if (parsed.type === 'sandbox_exec') {
          const command = parsed.payload?.command ?? '';
          ws.send(
            `${JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              requestId: parsed.requestId,
              type: 'sandbox_exec',
              sessionId: null,
              ok: true,
              payload: {
                stdout: `ran: ${command}\n`,
                stderr: '',
                exitCode: 0,
                durationMs: 1,
                truncated: false,
              },
              error: null,
            })}\n`,
          );
        }
        if (parsed.type === 'daemon_identify') {
          ws.send(
            `${JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              requestId: parsed.requestId,
              type: 'daemon_identify',
              sessionId: null,
              ok: true,
              payload: {
                tokenId: 'pdt_stub_id',
                boundOrigin: 'http://localhost:5173',
                daemonVersion: '0.3.0',
                protocolVersion: PROTOCOL_VERSION,
              },
              error: null,
            })}\n`,
          );
        }
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.close();
        wss.close(() => resolve());
      }),
    setResponseOverride: (type, override) => overrides.set(type, override),
  };
}

let server: StubServer;
let binding: LocalPcBinding;

beforeEach(async () => {
  server = await startStubServer();
  binding = {
    port: server.port,
    token: VALID_TOKEN,
    boundOrigin: 'http://localhost:5173',
  };
});

afterEach(async () => {
  await server.close();
});

describe('execLocalDaemon', () => {
  it("round-trips a command and returns the daemon's payload", async () => {
    const result = await execLocalDaemon(binding, 'echo hi');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo hi');
    expect(result.truncated).toBe(false);
    expect(typeof result.durationMs).toBe('number');
  });

  it('threads cwd and timeoutMs into the request payload', async () => {
    // The stub server's setResponseOverride is observation-only; for
    // payload capture we stand up a fresh server that records every
    // incoming payload before replying.
    await server.close();
    const captured: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false,
      verifyClient: (info, cb) => {
        const subproto = info.req.headers['sec-websocket-protocol'];
        if (typeof subproto !== 'string') return cb(false, 401, 'missing protocol');
        cb(true);
      },
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8').trim());
        captured.push(parsed.payload);
        ws.send(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: parsed.requestId,
            type: parsed.type,
            sessionId: null,
            ok: true,
            payload: { stdout: '', stderr: '', exitCode: 0, durationMs: 0, truncated: false },
            error: null,
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    await execLocalDaemon(
      { port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
      'ls -la',
      { cwd: '/tmp/foo', timeoutMs: 5_000 },
    );
    expect(captured[0]).toMatchObject({ command: 'ls -la', cwd: '/tmp/foo', timeoutMs: 5_000 });
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('omits cwd and timeoutMs from the payload when not provided', async () => {
    await server.close();
    const captured: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (p) => (p.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8').trim());
        captured.push(parsed.payload);
        ws.send(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: parsed.requestId,
            type: parsed.type,
            sessionId: null,
            ok: true,
            payload: { stdout: '', stderr: '', exitCode: 0, durationMs: 0, truncated: false },
            error: null,
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    await execLocalDaemon(
      { port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
      'pwd',
    );
    // Phase 1.f: every sandbox_exec payload now carries a runId so
    // the daemon can register the child in its activeRuns map for
    // mid-run cancellation. cwd/timeoutMs are still omitted when
    // unset; the runId is the only new always-on field.
    expect(captured[0]).toMatchObject({ command: 'pwd' });
    expect(typeof (captured[0] as { runId?: unknown }).runId).toBe('string');
    expect(captured[0]).not.toHaveProperty('cwd');
    expect(captured[0]).not.toHaveProperty('timeoutMs');
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('throws LocalDaemonUnreachableError when the daemon rejects the bearer', async () => {
    const wrongTokenBinding: LocalPcBinding = {
      port: server.port,
      token: 'pushd_wrong_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      boundOrigin: 'http://localhost:5173',
    };
    await expect(execLocalDaemon(wrongTokenBinding, 'echo nope')).rejects.toBeInstanceOf(
      LocalDaemonUnreachableError,
    );
  });

  it('throws LocalDaemonUnreachableError when no daemon is listening', async () => {
    await server.close();
    await expect(execLocalDaemon(binding, 'echo nope')).rejects.toBeInstanceOf(
      LocalDaemonUnreachableError,
    );
  });
});

describe('readFileLocalDaemon', () => {
  it('round-trips a read response payload', async () => {
    server.setResponseOverride('sandbox_read_file', {
      ok: true,
      payload: { content: 'file body', truncated: false, totalLines: 1 },
    });
    const res = await readFileLocalDaemon(binding, 'src/app.ts');
    expect(res.content).toBe('file body');
    expect(res.truncated).toBe(false);
    expect(res.totalLines).toBe(1);
  });

  it('threads startLine and endLine into the request payload', async () => {
    await server.close();
    const captured: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (p) => (p.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8').trim());
        captured.push(parsed.payload);
        ws.send(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: parsed.requestId,
            type: parsed.type,
            sessionId: null,
            ok: true,
            payload: { content: '', truncated: false },
            error: null,
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    await readFileLocalDaemon(
      { port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
      'lines.txt',
      { startLine: 5, endLine: 10 },
    );
    expect(captured[0]).toEqual({ path: 'lines.txt', startLine: 5, endLine: 10 });
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('propagates a payload-level error (missing file, etc.)', async () => {
    server.setResponseOverride('sandbox_read_file', {
      ok: true,
      payload: { content: '', truncated: false, error: 'ENOENT: …', code: 'ENOENT' },
    });
    const res = await readFileLocalDaemon(binding, 'nope.txt');
    expect(res.error).toMatch(/ENOENT/);
    expect(res.code).toBe('ENOENT');
  });
});

describe('writeFileLocalDaemon', () => {
  it('round-trips a successful write response', async () => {
    server.setResponseOverride('sandbox_write_file', {
      ok: true,
      payload: { ok: true, bytesWritten: 42 },
    });
    const res = await writeFileLocalDaemon(binding, 'out.txt', 'hello');
    expect(res.ok).toBe(true);
    expect(res.bytesWritten).toBe(42);
  });

  it('forwards path and content in the request payload', async () => {
    await server.close();
    const captured: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (p) => (p.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8').trim());
        captured.push(parsed.payload);
        ws.send(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: parsed.requestId,
            type: parsed.type,
            sessionId: null,
            ok: true,
            payload: { ok: true, bytesWritten: 0 },
            error: null,
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    await writeFileLocalDaemon(
      { port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
      'a/b/c.txt',
      'payload',
    );
    expect(captured[0]).toEqual({ path: 'a/b/c.txt', content: 'payload' });
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('propagates a write-failure response', async () => {
    server.setResponseOverride('sandbox_write_file', {
      ok: true,
      payload: { ok: false, error: 'EACCES: permission denied' },
    });
    const res = await writeFileLocalDaemon(binding, '/etc/passwd', 'rooted');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/EACCES/);
  });
});

describe('listDirLocalDaemon', () => {
  it('returns directory entries', async () => {
    server.setResponseOverride('sandbox_list_dir', {
      ok: true,
      payload: {
        entries: [
          { name: 'a.txt', type: 'file', size: 10 },
          { name: 'sub', type: 'directory' },
        ],
        truncated: false,
      },
    });
    const res = await listDirLocalDaemon(binding, 'src');
    expect(res.entries.length).toBe(2);
    expect(res.entries[0]).toMatchObject({ name: 'a.txt', type: 'file', size: 10 });
    expect(res.entries[1]).toMatchObject({ name: 'sub', type: 'directory' });
  });

  it('omits path from the payload when listing the cwd', async () => {
    await server.close();
    const captured: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (p) => (p.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8').trim());
        captured.push(parsed.payload);
        ws.send(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: parsed.requestId,
            type: parsed.type,
            sessionId: null,
            ok: true,
            payload: { entries: [], truncated: false },
            error: null,
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    await listDirLocalDaemon({ port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' });
    expect(captured[0]).toEqual({});
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

describe('getDiffLocalDaemon', () => {
  it('returns diff and git-status text', async () => {
    server.setResponseOverride('sandbox_diff', {
      ok: true,
      payload: {
        diff: 'diff --git a/x b/x\n+added line\n',
        truncated: false,
        gitStatus: ' M src/foo.ts\n',
      },
    });
    const res = await getDiffLocalDaemon(binding);
    expect(res.diff).toContain('+added line');
    expect(res.gitStatus).toContain('src/foo.ts');
    expect(res.truncated).toBe(false);
  });

  it('propagates a soft error when git fails (non-repo cwd)', async () => {
    server.setResponseOverride('sandbox_diff', {
      ok: true,
      payload: { diff: '', truncated: false, error: 'not a git repository' },
    });
    const res = await getDiffLocalDaemon(binding);
    expect(res.diff).toBe('');
    expect(res.error).toMatch(/not a git repository/);
  });
});

describe('identifyLocalDaemon', () => {
  it('returns the daemon identity payload', async () => {
    const id = await identifyLocalDaemon(binding);
    expect(id.tokenId).toBe('pdt_stub_id');
    expect(id.boundOrigin).toBe('http://localhost:5173');
    expect(id.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof id.daemonVersion).toBe('string');
  });

  it('rejects on auth failure with LocalDaemonUnreachableError', async () => {
    const wrongBinding: LocalPcBinding = {
      port: server.port,
      token: 'pushd_wrong_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      boundOrigin: 'http://localhost:5173',
    };
    await expect(identifyLocalDaemon(wrongBinding)).rejects.toBeInstanceOf(
      LocalDaemonUnreachableError,
    );
  });
});

describe('execLocalDaemon (Phase 1.f abortSignal)', () => {
  // The base stub server in this file always responds immediately to
  // sandbox_exec; testing the cancel path needs a server that holds
  // the response until the client sends cancel_run, so each case
  // stands up its own dedicated WSS.

  async function startCancelObservingServer(): Promise<{
    port: number;
    captured: { type: string; payload: Record<string, unknown> }[];
    close: () => Promise<void>;
  }> {
    const captured: { type: string; payload: Record<string, unknown> }[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false,
      verifyClient: (info, cb) => {
        const subproto = info.req.headers['sec-websocket-protocol'];
        if (typeof subproto !== 'string') return cb(false, 401, 'missing protocol');
        cb(true);
      },
    });
    wss.on('connection', (ws) => {
      // Holds the pending sandbox_exec response until the cancel
      // envelope arrives, then replies to BOTH with the daemon's
      // canonical "cancelled" shape for exec and an accepted shape
      // for cancel_run.
      let pendingExec: { requestId: string } | null = null;
      ws.on('message', (data) => {
        for (const line of data.toString('utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parsed = JSON.parse(trimmed);
          if (parsed.kind !== 'request') continue;
          captured.push({ type: parsed.type, payload: parsed.payload });
          if (parsed.type === 'sandbox_exec') {
            pendingExec = { requestId: parsed.requestId };
            // Do not reply yet — wait for cancel_run.
            continue;
          }
          if (parsed.type === 'cancel_run' && pendingExec) {
            ws.send(
              `${JSON.stringify({
                v: PROTOCOL_VERSION,
                kind: 'response',
                requestId: parsed.requestId,
                type: 'cancel_run',
                sessionId: null,
                ok: true,
                payload: { accepted: true, runId: parsed.payload.runId },
                error: null,
              })}\n`,
            );
            ws.send(
              `${JSON.stringify({
                v: PROTOCOL_VERSION,
                kind: 'response',
                requestId: pendingExec.requestId,
                type: 'sandbox_exec',
                sessionId: null,
                ok: true,
                payload: {
                  stdout: '',
                  stderr: '',
                  exitCode: 124,
                  durationMs: 1,
                  truncated: false,
                  cancelled: true,
                },
                error: null,
              })}\n`,
            );
            pendingExec = null;
          }
        }
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    return {
      port,
      captured,
      close: () => new Promise<void>((r) => wss.close(() => r())),
    };
  }

  it('includes a runId in every sandbox_exec payload', async () => {
    // Even without an abortSignal the client mints a runId so the
    // daemon can register the child uniformly. (Registration is cheap;
    // the daemon clears the entry in its `finally`.) Use the default
    // immediate-response server to verify the payload shape.
    const captured: { type: string; payload: Record<string, unknown> }[] = [];
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (p) => (p.has(SUBPROTOCOL_SELECTOR) ? SUBPROTOCOL_SELECTOR : false),
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8').trim());
        captured.push({ type: parsed.type, payload: parsed.payload });
        ws.send(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: parsed.requestId,
            type: parsed.type,
            sessionId: null,
            ok: true,
            payload: { stdout: '', stderr: '', exitCode: 0, durationMs: 0, truncated: false },
            error: null,
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    try {
      await execLocalDaemon(
        { port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
        'echo hi',
      );
      const execEnv = captured.find((c) => c.type === 'sandbox_exec');
      expect(execEnv).toBeDefined();
      expect(typeof execEnv?.payload.runId).toBe('string');
      expect((execEnv?.payload.runId as string).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it('dispatches cancel_run with the matching runId when the abort signal fires', async () => {
    const cs = await startCancelObservingServer();
    try {
      const controller = new AbortController();
      const explicitRunId = 'run_test_abort_fires';
      const promise = execLocalDaemon(
        { port: cs.port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
        'sleep 30',
        { abortSignal: controller.signal, runId: explicitRunId },
      );
      // Give the server a tick to see the exec, then abort.
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      await expect(promise).rejects.toThrow(/aborted/i);
      // The outer promise rejects synchronously with AbortError, but
      // the cancel_run frame is still in flight on the WS at that
      // point. Give the loopback a tick to surface it on the server.
      await new Promise((r) => setTimeout(r, 50));
      const execEnv = cs.captured.find((c) => c.type === 'sandbox_exec');
      const cancelEnv = cs.captured.find((c) => c.type === 'cancel_run');
      expect(execEnv?.payload.runId).toBe(explicitRunId);
      expect(cancelEnv).toBeDefined();
      expect(cancelEnv?.payload.runId).toBe(explicitRunId);
    } finally {
      await cs.close();
    }
  });

  it('rejects with AbortError when the signal fires before the WS opens', async () => {
    // Pre-open abort path (#517 review): if the signal fires while
    // the WS is still in `connecting`, the wrapper must close the
    // connect attempt and reject with AbortError. Previously this
    // surfaced as LocalDaemonUnreachableError because the abort
    // listener was only wired after `open`.
    //
    // Use a wrong port so the connect attempt actually has time to
    // sit in `connecting` — a normal stub would race the abort.
    const controller = new AbortController();
    const promise = execLocalDaemon(
      { port: 1, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
      'echo never',
      { abortSignal: controller.signal, runId: 'run_test_pre_open' },
    );
    // Fire abort synchronously after kicking off the call — the
    // binding is in `connecting` because the bogus port can't open.
    controller.abort();
    const caught = await promise.catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AbortError');
    expect(caught).not.toBeInstanceOf(LocalDaemonUnreachableError);
  });

  it('rejects with AbortError when the signal is already aborted at call time', async () => {
    // Synchronous-aborted case: the signal has `aborted: true` before
    // we even start. The wrapper must surface AbortError without
    // hanging or surfacing the connection-failure path.
    const controller = new AbortController();
    controller.abort();
    const cs = await startCancelObservingServer();
    try {
      const promise = execLocalDaemon(
        { port: cs.port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
        'echo never',
        { abortSignal: controller.signal, runId: 'run_test_already_aborted' },
      );
      const caught = await promise.catch((e) => e);
      expect((caught as Error).name).toBe('AbortError');
    } finally {
      await cs.close();
    }
  });

  it('rejects with an AbortError (not LocalDaemonUnreachableError) when cancelled', async () => {
    // Callers in `sandbox-tools.ts` distinguish cancel from unreachable
    // on `err.name === 'AbortError'`. Pin the contract here so a future
    // refactor doesn't accidentally collapse them.
    const cs = await startCancelObservingServer();
    try {
      const controller = new AbortController();
      const promise = execLocalDaemon(
        { port: cs.port, token: VALID_TOKEN, boundOrigin: 'http://localhost:5173' },
        'sleep 30',
        { abortSignal: controller.signal },
      );
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      const caught = await promise.catch((e) => e);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('AbortError');
      expect(caught).not.toBeInstanceOf(LocalDaemonUnreachableError);
    } finally {
      await cs.close();
    }
  });
});

// Phase 2.f: binding-shape discriminator drives the polymorphic
// transport pick in `createTransientAdapter`. The helper is the
// only place sandbox-tools dispatch differentiates relay from
// loopback, so the discriminator's shape contract is load-bearing.
describe('isRelayBinding', () => {
  it('returns true for a relay binding (has deploymentUrl)', () => {
    const relay: RelayBinding = {
      deploymentUrl: 'https://relay.example',
      sessionId: 'sess',
      token: 'pushd_da_xxx',
    };
    expect(isRelayBinding(relay)).toBe(true);
  });
  it('returns false for a loopback binding (has port)', () => {
    const loop: LocalPcBinding = {
      port: 49152,
      token: 'pushd_xxx',
      boundOrigin: 'http://localhost:5173',
    };
    expect(isRelayBinding(loop)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LiveDaemonBinding reuse path
// ---------------------------------------------------------------------------
// When chat-layer dispatch carries a LiveDaemonBinding (the hook-owned
// long-lived WS adapter), the per-tool helpers MUST route through its
// bound `request` fn instead of opening a transient WebSocket per call.
// These tests stand in a stub `request` and assert (a) the stub is
// called, and (b) no transient WS gets opened — verified indirectly by
// using a binding whose `port` is closed (would hang or fail with
// LocalDaemonUnreachableError if the transient path fired).
// ---------------------------------------------------------------------------

describe('LiveDaemonBinding reuse path', () => {
  // The handler is non-generic on the test surface so callers can pass
  // plain `async () => ({...})` arrows. The wrapper inside `request`
  // casts the returned response through to the generic T the caller
  // requested — that's sound for tests because the stub controls the
  // payload shape end-to-end. Typing the handler itself as
  // `<T>(...) => Promise<SessionResponse<T>>` would force every caller
  // to write a generic arrow, which TypeScript 5 cannot infer from a
  // single-shape return.
  type StubHandler = (opts: RequestOptions) => Promise<SessionResponse<unknown>>;
  function makeStubLive(handler: StubHandler): {
    binding: LiveDaemonBinding;
    calls: RequestOptions[];
  } {
    const calls: RequestOptions[] = [];
    const binding: LiveDaemonBinding = {
      // Closed port — if the helpers fell through to the transient path
      // they'd hang on connect and the 5s open-timeout would fire. By
      // pointing at a closed port we get a fast, observable failure
      // shape that proves the live `request` is the only path taken.
      params: {
        port: 1,
        token: 'pushd_unused_in_reuse_path',
        boundOrigin: 'http://localhost:5173',
      } as LocalPcBinding,
      request: <T = unknown>(opts: RequestOptions): Promise<SessionResponse<T>> => {
        calls.push(opts);
        return handler(opts) as Promise<SessionResponse<T>>;
      },
    };
    return { binding, calls };
  }

  it('isLiveDaemonBinding discriminates live from params', () => {
    const { binding } = makeStubLive(async () => ({ ok: true }) as never);
    expect(isLiveDaemonBinding(binding)).toBe(true);
    expect(
      isLiveDaemonBinding({
        port: 1,
        token: 'pushd_xxx',
        boundOrigin: 'http://localhost:5173',
      } as LocalPcBinding),
    ).toBe(false);
  });

  it('execLocalDaemon routes through binding.request without opening a transient WS', async () => {
    const { binding, calls } = makeStubLive(
      async () =>
        ({
          v: PROTOCOL_VERSION,
          kind: 'response',
          requestId: 'req_x',
          type: 'sandbox_exec',
          sessionId: null,
          ok: true,
          payload: {
            stdout: 'hi\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
            truncated: false,
          },
          error: null,
        }) as SessionResponse<unknown>,
    );

    const result = await execLocalDaemon(binding, 'echo hi');

    expect(result.stdout).toBe('hi\n');
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('sandbox_exec');
    // runId is generated when no caller-supplied one is passed; assert
    // shape rather than value.
    expect(typeof (calls[0].payload as { runId?: unknown })?.runId).toBe('string');
  });

  it('readFileLocalDaemon / writeFileLocalDaemon / listDirLocalDaemon / getDiffLocalDaemon all route through the live request', async () => {
    const responses: Record<string, unknown> = {
      sandbox_read_file: { content: 'hello', truncated: false },
      sandbox_write_file: { ok: true, bytesWritten: 5 },
      sandbox_list_dir: { entries: [], truncated: false },
      sandbox_diff: { diff: '', truncated: false },
    };
    const { binding, calls } = makeStubLive(
      async (opts) =>
        ({
          v: PROTOCOL_VERSION,
          kind: 'response',
          requestId: 'req_x',
          type: opts.type,
          sessionId: null,
          ok: true,
          payload: responses[opts.type] ?? {},
          error: null,
        }) as SessionResponse<unknown>,
    );

    await readFileLocalDaemon(binding, '/some/path');
    await writeFileLocalDaemon(binding, '/some/path', 'hello');
    await listDirLocalDaemon(binding, '/some');
    await getDiffLocalDaemon(binding);

    expect(calls.map((c) => c.type)).toEqual([
      'sandbox_read_file',
      'sandbox_write_file',
      'sandbox_list_dir',
      'sandbox_diff',
    ]);
  });

  it('identifyLocalDaemon routes through the live request', async () => {
    const { binding, calls } = makeStubLive(
      async () =>
        ({
          v: PROTOCOL_VERSION,
          kind: 'response',
          requestId: 'req_x',
          type: 'daemon_identify',
          sessionId: null,
          ok: true,
          payload: {
            tokenId: 'pdt_xxx',
            boundOrigin: 'http://localhost:5173',
            daemonVersion: '0.0.0',
            protocolVersion: PROTOCOL_VERSION,
          },
          error: null,
        }) as SessionResponse<unknown>,
    );

    const result = await identifyLocalDaemon(binding);
    expect(result.tokenId).toBe('pdt_xxx');
    expect(calls.map((c) => c.type)).toEqual(['daemon_identify']);
  });

  it('runWithBinding fires cancel_run on abort and rejects with AbortError (no transient WS opened)', async () => {
    const controller = new AbortController();
    const seenTypes: string[] = [];
    // Boxed in an object so TS keeps the field's declared union type
    // across the makeStubLive callback boundary. A bare `let resolveInner:
    // (() => void) | null = null` got narrowed to `null` because the
    // assignment lives inside a nested executor TS doesn't track —
    // surfaces at the call site as "type 'never' has no call signatures."
    const resolveInner: { fn: (() => void) | null } = { fn: null };
    const { binding, calls } = makeStubLive((opts) => {
      seenTypes.push(opts.type);
      if (opts.type === 'cancel_run') {
        return Promise.resolve({
          v: PROTOCOL_VERSION,
          kind: 'response',
          requestId: 'req_cancel',
          type: 'cancel_run',
          sessionId: null,
          ok: true,
          payload: { accepted: true },
          error: null,
        } as SessionResponse<unknown>);
      }
      // The main request never resolves on its own — the abort path
      // must reject the outer promise instead. Resolve only as a
      // cleanup hatch in case the test fails.
      return new Promise<SessionResponse<unknown>>((res) => {
        resolveInner.fn = () => res({} as SessionResponse<unknown>);
      });
    });

    const promise = runWithBinding(
      binding,
      (request) =>
        request({ type: 'sandbox_exec', payload: { command: 'sleep 60', runId: 'run_x' } }),
      { abortSignal: controller.signal, runId: 'run_x' },
    );

    // Give the request fn a tick to be invoked before aborting.
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // cancel_run was dispatched on the same live binding.
    expect(seenTypes).toContain('cancel_run');
    const cancel = calls.find((c) => c.type === 'cancel_run');
    expect((cancel?.payload as { runId?: string })?.runId).toBe('run_x');
    // Clean up the dangling inner promise so vitest doesn't warn.
    resolveInner.fn?.();
  });
});
