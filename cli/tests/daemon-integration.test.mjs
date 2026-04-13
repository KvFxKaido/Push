import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  getSocketPath,
  getPidPath,
  validateAttachToken,
  getRestartPolicy,
  shouldRecover,
  DEFAULT_RESTART_POLICY,
  VALID_AGENT_ROLES,
  handleRequest,
  ensureRuntimeState,
  __getActiveSessionForTesting,
  __setDelegateExplorerHooksForTesting,
} from '../pushd.ts';
import {
  PROTOCOL_VERSION,
  writeRunMarker,
  clearRunMarker,
  readRunMarker,
  scanInterruptedSessions,
  makeSessionId,
  loadSessionState,
  appendSessionEvent,
  loadSessionEvents,
} from '../session-store.ts';

// ─── Helpers ──────────────────────────────────────────────────────

function makeRequest(type, payload = {}, sessionId = null) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${randomBytes(4).toString('hex')}`,
    type,
    sessionId,
    payload,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function canListenOnUnixSocket(socketPath) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'EPERM' || code === 'EACCES') {
      return { ok: false, reason: `unix sockets unavailable in this environment (${code})` };
    }
    throw err;
  } finally {
    try {
      server.close();
    } catch {
      // ignore
    }
    try {
      await fs.unlink(socketPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Connect to a socket and send/receive NDJSON messages.
 */
function connectClient(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      let buffer = '';
      const pendingMessages = [];
      let messageWaiters = [];

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (messageWaiters.length > 0) {
            messageWaiters.shift()(msg);
          } else {
            pendingMessages.push(msg);
          }
        }
      });

      resolve({
        send(msg) {
          socket.write(JSON.stringify(msg) + '\n');
        },
        receive(timeoutMs = 2000) {
          if (pendingMessages.length > 0) {
            return Promise.resolve(pendingMessages.shift());
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('Receive timeout')), timeoutMs);
            messageWaiters.push((msg) => {
              clearTimeout(timer);
              res(msg);
            });
          });
        },
        receiveAll(timeoutMs = 500) {
          return new Promise((resolve) => {
            const collected = [...pendingMessages];
            pendingMessages.length = 0;
            const collectMore = (msg) => collected.push(msg);
            messageWaiters.push(collectMore);
            setTimeout(() => {
              const idx = messageWaiters.indexOf(collectMore);
              if (idx >= 0) messageWaiters.splice(idx, 1);
              resolve(collected);
            }, timeoutMs);
          });
        },
        close() {
          socket.end();
        },
        socket,
      });
    });
    socket.on('error', reject);
  });
}

// ─── Path helpers (existing tests preserved) ──────────────────────

describe('pushd path helpers', () => {
  it('getSocketPath returns default under ~/.push/run/', () => {
    const original = process.env.PUSHD_SOCKET;
    delete process.env.PUSHD_SOCKET;
    const p = getSocketPath();
    assert.ok(p.includes('.push'));
    assert.ok(p.endsWith('pushd.sock'));
    if (original !== undefined) process.env.PUSHD_SOCKET = original;
  });

  it('getSocketPath respects PUSHD_SOCKET env', () => {
    const original = process.env.PUSHD_SOCKET;
    process.env.PUSHD_SOCKET = '/tmp/test.sock';
    assert.equal(getSocketPath(), '/tmp/test.sock');
    if (original !== undefined) process.env.PUSHD_SOCKET = original;
    else delete process.env.PUSHD_SOCKET;
  });

  it('getPidPath returns path under ~/.push/run/', () => {
    const p = getPidPath();
    assert.ok(p.includes('.push'));
    assert.ok(p.endsWith('pushd.pid'));
  });
});

// ─── NDJSON protocol compliance ──────────────────────────────────

describe('NDJSON protocol compliance', () => {
  it('envelope structure matches expected schema', () => {
    const response = {
      v: 'push.runtime.v1',
      kind: 'response',
      requestId: 'req_test',
      type: 'hello',
      sessionId: null,
      ok: true,
      payload: { runtimeName: 'pushd' },
      error: null,
    };

    const line = JSON.stringify(response);
    const parsed = JSON.parse(line);
    assert.equal(parsed.v, 'push.runtime.v1');
    assert.equal(parsed.kind, 'response');
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.payload, 'object');
  });

  it('event envelope has expected fields', () => {
    const event = {
      v: 'push.runtime.v1',
      kind: 'event',
      sessionId: 'sess_test',
      runId: 'run_test',
      seq: 1,
      ts: Date.now(),
      type: 'assistant_token',
      payload: { text: 'hello' },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    assert.equal(parsed.kind, 'event');
    assert.equal(parsed.type, 'assistant_token');
    assert.equal(typeof parsed.seq, 'number');
    assert.equal(typeof parsed.ts, 'number');
  });
});

// ─── validateAttachToken ────────────────────────────────────────

describe('validateAttachToken', () => {
  it('rejects missing token when entry has one', () => {
    const entry = { state: {}, attachToken: 'att_abc123' };
    assert.equal(validateAttachToken(entry, undefined), false);
    assert.equal(validateAttachToken(entry, null), false);
    assert.equal(validateAttachToken(entry, ''), false);
  });

  it('rejects wrong token', () => {
    const entry = { state: {}, attachToken: 'att_abc123' };
    assert.equal(validateAttachToken(entry, 'att_wrong'), false);
  });

  it('accepts correct token', () => {
    const entry = { state: {}, attachToken: 'att_abc123' };
    assert.equal(validateAttachToken(entry, 'att_abc123'), true);
  });

  it('passes when no token set on entry (legacy/internal)', () => {
    assert.equal(validateAttachToken({ state: {} }, undefined), true);
    assert.equal(validateAttachToken({ state: {}, attachToken: '' }, 'anything'), true);
    assert.equal(validateAttachToken({ state: {}, attachToken: null }, undefined), true);
  });

  it('allows when entry is null/undefined (no entry = no token requirement)', () => {
    assert.equal(validateAttachToken(null, 'token'), true);
    assert.equal(validateAttachToken(undefined, 'token'), true);
  });
});

// ─── Daemon client library ──────────────────────────────────────

describe('daemon-client module', () => {
  it('exports connect, tryConnect, waitForReady', async () => {
    const mod = await import('../daemon-client.ts');
    assert.equal(typeof mod.connect, 'function');
    assert.equal(typeof mod.tryConnect, 'function');
    assert.equal(typeof mod.waitForReady, 'function');
  });

  it('tryConnect returns null for nonexistent socket', async () => {
    const { tryConnect } = await import('../daemon-client.ts');
    const result = await tryConnect('/tmp/nonexistent-pushd-test.sock', 200);
    assert.equal(result, null);
  });

  it('connect + request + onEvent works with echo server', async (t) => {
    const sockPath = path.join(os.tmpdir(), `dc-test-${randomBytes(4).toString('hex')}.sock`);
    const availability = await canListenOnUnixSocket(sockPath);
    if (!availability.ok) return t.skip(availability.reason);

    // Create a minimal echo server
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          // Respond with ok
          const res = {
            v: PROTOCOL_VERSION,
            kind: 'response',
            requestId: req.requestId,
            type: req.type,
            sessionId: null,
            ok: true,
            payload: { pong: true, ts: Date.now() },
            error: null,
          };
          socket.write(JSON.stringify(res) + '\n');

          // Also emit a test event
          const event = {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId: 'test_sess',
            runId: 'test_run',
            seq: 1,
            ts: Date.now(),
            type: 'status',
            payload: { phase: 'test' },
          };
          socket.write(JSON.stringify(event) + '\n');
        }
      });
    });

    try {
      await new Promise((resolve) => server.listen(sockPath, resolve));

      const { connect } = await import('../daemon-client.ts');
      const client = await connect(sockPath);
      assert.ok(client.connected);

      // Collect events
      const events = [];
      client.onEvent((e) => events.push(e));

      // Send request
      const res = await client.request('ping', {});
      assert.ok(res.ok);
      assert.equal(res.payload.pong, true);

      // Wait for event delivery
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(events.length > 0);
      assert.equal(events[0].type, 'status');

      client.close();
    } finally {
      server.close();
      try {
        await fs.unlink(sockPath);
      } catch {
        /* ignore */
      }
    }
  });

  it('onEvent returns unsubscribe function', async (t) => {
    const sockPath = path.join(os.tmpdir(), `dc-unsub-${randomBytes(4).toString('hex')}.sock`);
    const availability = await canListenOnUnixSocket(sockPath);
    if (!availability.ok) return t.skip(availability.reason);

    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          socket.write(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              requestId: req.requestId,
              type: req.type,
              sessionId: null,
              ok: true,
              payload: {},
              error: null,
            }) + '\n',
          );
          // Emit two events
          for (let i = 0; i < 2; i++) {
            socket.write(
              JSON.stringify({
                v: PROTOCOL_VERSION,
                kind: 'event',
                sessionId: 's',
                runId: 'r',
                seq: i,
                ts: Date.now(),
                type: 'status',
                payload: { n: i },
              }) + '\n',
            );
          }
        }
      });
    });

    try {
      await new Promise((resolve) => server.listen(sockPath, resolve));

      const { connect } = await import('../daemon-client.ts');
      const client = await connect(sockPath);

      const events = [];
      const unsub = client.onEvent((e) => events.push(e));

      await client.request('ping', {});
      await new Promise((r) => setTimeout(r, 50));

      const countBefore = events.length;
      assert.ok(countBefore > 0);

      // Unsubscribe
      unsub();

      // Send another request that generates more events
      await client.request('ping', {});
      await new Promise((r) => setTimeout(r, 50));

      // Should not have received more events
      assert.equal(events.length, countBefore);

      client.close();
    } finally {
      server.close();
      try {
        await fs.unlink(sockPath);
      } catch {
        /* ignore */
      }
    }
  });
});

// ─── Protocol handler tests (request/response format) ──────────

describe('protocol request format', () => {
  it('makeRequest helper produces valid envelope', () => {
    const req = makeRequest('hello', { clientName: 'test' });
    assert.equal(req.v, PROTOCOL_VERSION);
    assert.equal(req.kind, 'request');
    assert.equal(req.type, 'hello');
    assert.ok(req.requestId.startsWith('req_'));
    assert.deepEqual(req.payload, { clientName: 'test' });
  });

  it('cancel_run request format is correct', () => {
    const req = makeRequest('cancel_run', { sessionId: 'sess_1', runId: 'run_1' }, 'sess_1');
    assert.equal(req.type, 'cancel_run');
    assert.equal(req.payload.sessionId, 'sess_1');
    assert.equal(req.payload.runId, 'run_1');
  });

  it('submit_approval request format is correct', () => {
    const req = makeRequest(
      'submit_approval',
      {
        sessionId: 'sess_1',
        approvalId: 'appr_1',
        decision: 'approve',
      },
      'sess_1',
    );
    assert.equal(req.type, 'submit_approval');
    assert.equal(req.payload.decision, 'approve');
  });

  it('list_sessions request format is correct', () => {
    const req = makeRequest('list_sessions', { limit: 10 });
    assert.equal(req.type, 'list_sessions');
    assert.equal(req.payload.limit, 10);
  });
});

// ─── Approval ID generation ─────────────────────────────────────

describe('approval ID format', () => {
  it('approval_required event has expected fields', () => {
    const event = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: 'sess_test',
      runId: 'run_test',
      seq: 5,
      ts: Date.now(),
      type: 'approval_required',
      payload: {
        approvalId: 'appr_test123',
        kind: 'exec',
        title: 'Approve exec',
        summary: 'rm -rf /tmp/test',
        options: ['approve', 'deny'],
      },
    };

    assert.equal(event.type, 'approval_required');
    assert.ok(event.payload.approvalId.startsWith('appr_'));
    assert.deepEqual(event.payload.options, ['approve', 'deny']);
  });

  it('approval_received event has expected fields', () => {
    const event = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: 'sess_test',
      runId: 'run_test',
      seq: 6,
      ts: Date.now(),
      type: 'approval_received',
      payload: {
        approvalId: 'appr_test123',
        decision: 'approve',
        by: 'client',
      },
    };

    assert.equal(event.type, 'approval_received');
    assert.equal(event.payload.decision, 'approve');
    assert.equal(event.payload.by, 'client');
  });
});

// ─── Multi-client fan-out structure ──────────────────────────────

describe('multi-client fan-out', () => {
  it('event broadcast format supports multiple recipients', () => {
    // Verify the broadcast event structure is correct
    const event = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: 'sess_multi',
      runId: 'run_1',
      seq: 1,
      ts: Date.now(),
      type: 'assistant_token',
      payload: { text: 'hello' },
    };

    // Multiple clients should receive the same event shape
    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.kind, 'event');
    assert.equal(parsed.sessionId, 'sess_multi');
    assert.equal(parsed.payload.text, 'hello');
  });
});

// ─── Daemon version bump ─────────────────────────────────────────

describe('daemon version', () => {
  it('pushd version is 0.3.0 with crash recovery', async () => {
    const content = await fs.readFile(path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8');
    assert.ok(content.includes("const VERSION = '0.3.0'"));
  });

  it('hello capabilities advertise delegation_explorer_v1 but not multi_agent', async () => {
    const response = await handleRequest(makeRequest('hello', { clientName: 'test' }), () => {});
    assert.equal(response.ok, true);
    assert.ok(response.payload.capabilities.includes('multi_client'));
    assert.ok(response.payload.capabilities.includes('replay_attach'));
    assert.ok(response.payload.capabilities.includes('crash_recovery'));
    assert.ok(response.payload.capabilities.includes('role_routing'));
    assert.ok(response.payload.capabilities.includes('delegation_explorer_v1'));
    assert.ok(!response.payload.capabilities.includes('multi_agent'));
    assert.ok(!response.payload.capabilities.includes('task_graph'));
  });

  it('all 13 handler types are registered', async () => {
    const content = await fs.readFile(path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8');
    const handlers = [
      'hello',
      'ping',
      'list_sessions',
      'start_session',
      'send_user_message',
      'attach_session',
      'submit_approval',
      'cancel_run',
      'configure_role_routing',
      'submit_task_graph',
      'delegate_explorer',
      'cancel_delegation',
      'fetch_delegation_events',
    ];
    for (const h of handlers) {
      assert.ok(content.includes(`${h}: handle`), `Missing handler: ${h}`);
    }
  });
});

// ─── Restart policies ────────────────────────────────────────────

describe('restart policies', () => {
  it('default restart policy is on-failure', () => {
    assert.equal(DEFAULT_RESTART_POLICY, 'on-failure');
  });

  it('getRestartPolicy returns default for missing/invalid policy', () => {
    assert.equal(getRestartPolicy({}), 'on-failure');
    assert.equal(getRestartPolicy({ restartPolicy: 'bogus' }), 'on-failure');
    assert.equal(getRestartPolicy(null), 'on-failure');
    assert.equal(getRestartPolicy(undefined), 'on-failure');
  });

  it('getRestartPolicy returns valid policies', () => {
    assert.equal(getRestartPolicy({ restartPolicy: 'on-failure' }), 'on-failure');
    assert.equal(getRestartPolicy({ restartPolicy: 'always' }), 'always');
    assert.equal(getRestartPolicy({ restartPolicy: 'never' }), 'never');
  });

  it('shouldRecover respects never policy', () => {
    assert.equal(shouldRecover('never', { startedAt: Date.now() }), false);
  });

  it('shouldRecover allows on-failure for recent markers', () => {
    assert.equal(shouldRecover('on-failure', { startedAt: Date.now() - 1000 }), true);
  });

  it('shouldRecover allows always for recent markers', () => {
    assert.equal(shouldRecover('always', { startedAt: Date.now() - 1000 }), true);
  });

  it('shouldRecover rejects markers older than 1 hour', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    assert.equal(shouldRecover('on-failure', { startedAt: twoHoursAgo }), false);
    assert.equal(shouldRecover('always', { startedAt: twoHoursAgo }), false);
  });

  it('shouldRecover handles missing startedAt', () => {
    assert.equal(shouldRecover('on-failure', {}), false);
  });

  it('shouldRecover rejects non-finite startedAt', () => {
    assert.equal(shouldRecover('on-failure', { startedAt: 'bogus' }), false);
    assert.equal(shouldRecover('on-failure', { startedAt: NaN }), false);
    assert.equal(shouldRecover('on-failure', { startedAt: Infinity }), false);
  });

  it('shouldRecover rejects negative age (clock skew)', () => {
    const futureTs = Date.now() + 60_000;
    assert.equal(shouldRecover('on-failure', { startedAt: futureTs }), false);
  });
});

// ─── Run markers (crash recovery) ───────────────────────────────

describe('run markers', () => {
  let testSessionDir;
  let testSessionId;
  const originalEnv = process.env.PUSH_SESSION_DIR;

  // Use a temp directory so tests don't interfere with real sessions
  const tmpRoot = path.join(os.tmpdir(), `push-test-markers-${randomBytes(4).toString('hex')}`);

  // Setup: point session store at temp dir
  // Teardown: restore and clean up
  it('write, read, and clear run marker', async () => {
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      testSessionId = makeSessionId();
      testSessionDir = path.join(tmpRoot, testSessionId);
      await fs.mkdir(testSessionDir, { recursive: true });

      // Write
      await writeRunMarker(testSessionId, 'run_test_123', { provider: 'ollama' });

      // Read
      const marker = await readRunMarker(testSessionId);
      assert.ok(marker);
      assert.equal(marker.runId, 'run_test_123');
      assert.equal(marker.provider, 'ollama');
      assert.equal(typeof marker.startedAt, 'number');

      // Clear
      await clearRunMarker(testSessionId);
      const cleared = await readRunMarker(testSessionId);
      assert.equal(cleared, null);
    } finally {
      process.env.PUSH_SESSION_DIR = originalEnv || '';
      if (!originalEnv) delete process.env.PUSH_SESSION_DIR;
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('readRunMarker returns null for missing marker', async () => {
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const sid = makeSessionId();
      await fs.mkdir(path.join(tmpRoot, sid), { recursive: true });
      const marker = await readRunMarker(sid);
      assert.equal(marker, null);
    } finally {
      process.env.PUSH_SESSION_DIR = originalEnv || '';
      if (!originalEnv) delete process.env.PUSH_SESSION_DIR;
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('scanInterruptedSessions finds sessions with markers', async () => {
    const scanRoot = path.join(os.tmpdir(), `push-test-scan-${randomBytes(4).toString('hex')}`);
    process.env.PUSH_SESSION_DIR = scanRoot;
    try {
      const sid1 = makeSessionId();
      const sid2 = makeSessionId();
      await fs.mkdir(path.join(scanRoot, sid1), { recursive: true });
      await fs.mkdir(path.join(scanRoot, sid2), { recursive: true });

      // Only sid1 has a run marker
      await writeRunMarker(sid1, 'run_a');

      const interrupted = await scanInterruptedSessions();
      assert.equal(interrupted.length, 1);
      assert.equal(interrupted[0].sessionId, sid1);
      assert.equal(interrupted[0].marker.runId, 'run_a');
    } finally {
      process.env.PUSH_SESSION_DIR = originalEnv || '';
      if (!originalEnv) delete process.env.PUSH_SESSION_DIR;
      await fs.rm(scanRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('scanInterruptedSessions returns empty when no markers exist', async () => {
    const emptyRoot = path.join(os.tmpdir(), `push-test-empty-${randomBytes(4).toString('hex')}`);
    process.env.PUSH_SESSION_DIR = emptyRoot;
    try {
      await fs.mkdir(emptyRoot, { recursive: true });
      const interrupted = await scanInterruptedSessions();
      assert.equal(interrupted.length, 0);
    } finally {
      process.env.PUSH_SESSION_DIR = originalEnv || '';
      if (!originalEnv) delete process.env.PUSH_SESSION_DIR;
      await fs.rm(emptyRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ─── VALID_AGENT_ROLES ─────────────────────────────────────────

describe('VALID_AGENT_ROLES', () => {
  it('contains all five runtime-contract roles', () => {
    const expected = ['orchestrator', 'explorer', 'coder', 'reviewer', 'auditor'];
    for (const role of expected) {
      assert.ok(VALID_AGENT_ROLES.has(role), `Missing role: ${role}`);
    }
    assert.equal(VALID_AGENT_ROLES.size, 5);
  });
});

// ─── configure_role_routing behavior ───────────────────────────

describe('configure_role_routing behavior', () => {
  it('normalizes, merges, and persists role routing', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-role-routing-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          model: 'session-model',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );

      assert.equal(start.ok, true);
      const { sessionId, attachToken } = start.payload;
      assert.deepEqual(start.payload.roleRouting, {});

      const configured = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken,
            routing: {
              coder: { provider: 'openrouter', model: 'coder-model' },
              explorer: { provider: ' ollama ' },
            },
          },
          sessionId,
        ),
        () => {},
      );

      assert.equal(configured.ok, true);
      assert.equal(configured.payload.roleRouting.coder.provider, 'openrouter');
      assert.equal(configured.payload.roleRouting.coder.model, 'coder-model');
      assert.equal(configured.payload.roleRouting.explorer.provider, 'ollama');
      assert.equal(typeof configured.payload.roleRouting.explorer.model, 'string');
      assert.ok(configured.payload.roleRouting.explorer.model.length > 0);

      const merged = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken,
            routing: {
              reviewer: { provider: 'ollama', model: 'reviewer-model' },
            },
          },
          sessionId,
        ),
        () => {},
      );

      assert.equal(merged.ok, true);
      assert.equal(merged.payload.roleRouting.coder.model, 'coder-model');
      assert.equal(merged.payload.roleRouting.reviewer.model, 'reviewer-model');

      const loaded = await loadSessionState(sessionId);
      assert.deepEqual(loaded.roleRouting, merged.payload.roleRouting);

      const attached = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(attached.ok, true);
      assert.deepEqual(attached.payload.roleRouting, merged.payload.roleRouting);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid roles, providers, and tokens', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-role-routing-invalid-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      assert.equal(start.ok, true);
      const { sessionId, attachToken } = start.payload;

      const wrongToken = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken: 'att_wrong',
            routing: { coder: { provider: 'ollama' } },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(wrongToken.ok, false);
      assert.equal(wrongToken.error.code, 'INVALID_TOKEN');

      const invalidRole = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken,
            routing: { planner: { provider: 'ollama' } },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(invalidRole.ok, false);
      assert.equal(invalidRole.error.code, 'INVALID_ROLE');

      const invalidProvider = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken,
            routing: { coder: { provider: 'missing-provider' } },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(invalidProvider.ok, false);
      assert.equal(invalidProvider.error.code, 'PROVIDER_NOT_CONFIGURED');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── submit_task_graph scaffold ─────────────────────────────────

describe('submit_task_graph scaffold', () => {
  it('handler returns a non-retryable scaffold error', async () => {
    const response = await handleRequest(
      makeRequest('submit_task_graph', {
        sessionId: 'sess_abc_def123',
        graph: { tasks: [] },
      }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'NOT_IMPLEMENTED');
    assert.equal(response.error.retryable, false);
  });
});

// ─── delegate_explorer ──────────────────────────────────────────

async function waitForDelegationComplete(entry, subagentId, timeoutMs = 5000) {
  const startWait = Date.now();
  while (Date.now() - startWait < timeoutMs) {
    if (!entry.activeDelegations || !entry.activeDelegations.has(subagentId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`delegate_explorer background run did not complete within ${timeoutMs}ms`);
}

describe('delegate_explorer', () => {
  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('delegate_explorer', { task: 'explore the daemon' }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.ok(response.error.message.includes('sessionId'));
  });

  it('rejects missing task', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const response = await handleRequest(
        makeRequest('delegate_explorer', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_REQUEST');
      assert.ok(response.error.message.includes('task'));

      const emptyTask = await handleRequest(
        makeRequest('delegate_explorer', { sessionId, attachToken, task: '   ' }, sessionId),
        () => {},
      );
      assert.equal(emptyTask.ok, false);
      assert.equal(emptyTask.error.code, 'INVALID_REQUEST');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid attach token', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer2-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId } = start.payload;

      const response = await handleRequest(
        makeRequest(
          'delegate_explorer',
          { sessionId, attachToken: 'att_wrong', task: 'find files' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_TOKEN');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns SESSION_NOT_FOUND for unknown session', async () => {
    const response = await handleRequest(
      makeRequest(
        'delegate_explorer',
        { sessionId: 'sess_abc123_def456', task: 'find files' },
        'sess_abc123_def456',
      ),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  });

  it('runs the lib kernel end-to-end and persists an inconclusive outcome', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer-happy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const broadcasted = [];
      const attached = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken }, sessionId),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'delegate_explorer',
          { sessionId, attachToken, task: 'scaffold exploration' },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);
      assert.ok(response.payload.subagentId);
      assert.ok(response.payload.subagentId.startsWith('sub_explorer_'));
      assert.ok(response.payload.childRunId);
      assert.ok(response.payload.childRunId.startsWith('run_'));

      const { subagentId, childRunId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      assert.ok(entry.activeDelegations);
      assert.equal(entry.activeDelegations.has(subagentId), true);

      await waitForDelegationComplete(entry, subagentId);

      assert.equal(entry.activeDelegations.has(subagentId), false);

      const events = await loadSessionEvents(sessionId);
      const started = events.find(
        (e) => e.type === 'subagent.started' && e.payload.subagentId === subagentId,
      );
      const completed = events.find(
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
      );
      assert.ok(started, 'expected subagent.started event');
      assert.ok(completed, 'expected subagent.completed event');
      assert.equal(started.runId, childRunId);
      assert.equal(started.payload.agent, 'explorer');
      assert.equal(started.payload.role, 'explorer');
      assert.equal(started.payload.detail, 'scaffold exploration');
      assert.equal(completed.runId, childRunId);
      assert.equal(completed.payload.agent, 'explorer');
      assert.ok(completed.payload.delegationOutcome);
      assert.equal(completed.payload.delegationOutcome.agent, 'explorer');
      assert.equal(completed.payload.delegationOutcome.status, 'inconclusive');
      assert.ok(completed.payload.delegationOutcome.summary.includes('[pushd scaffold]'));
      assert.ok(Array.isArray(completed.payload.delegationOutcome.missingRequirements));
      assert.ok(completed.payload.delegationOutcome.missingRequirements.length >= 2);
      assert.ok(completed.payload.delegationOutcome.nextRequiredAction);

      const loaded = await loadSessionState(sessionId);
      assert.ok(Array.isArray(loaded.delegationOutcomes));
      const record = loaded.delegationOutcomes.find((r) => r.subagentId === subagentId);
      assert.ok(record, 'expected delegationOutcome record in session state');
      assert.equal(record.outcome.status, 'inconclusive');
      assert.equal(record.outcome.agent, 'explorer');

      const broadcastStarted = broadcasted.find(
        (e) => e.type === 'subagent.started' && e.payload.subagentId === subagentId,
      );
      const broadcastCompleted = broadcasted.find(
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
      );
      assert.ok(broadcastStarted, 'expected subagent.started broadcast');
      assert.ok(broadcastCompleted, 'expected subagent.completed broadcast');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not emit completion after cancellation wins before terminal claim', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer-race-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    const terminalClaimReached = createDeferred();
    const releaseTerminalClaim = createDeferred();
    const terminalDecision = createDeferred();

    __setDelegateExplorerHooksForTesting({
      beforeTerminalClaim: async ({ subagentId }) => {
        terminalClaimReached.resolve(subagentId);
        await releaseTerminalClaim.promise;
      },
      afterTerminalDecision: (result) => {
        terminalDecision.resolve(result);
      },
    });

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const broadcasted = [];
      const attached = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken }, sessionId),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'delegate_explorer',
          { sessionId, attachToken, task: 'scaffold exploration' },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);

      const { subagentId, childRunId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      assert.equal(entry.activeDelegations.has(subagentId), true);

      const hookSubagentId = await Promise.race([
        terminalClaimReached.promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('delegate_explorer did not reach terminal claim hook')),
            5000,
          ),
        ),
      ]);
      assert.equal(hookSubagentId, subagentId);

      const cancel = await handleRequest(
        makeRequest('cancel_delegation', { sessionId, attachToken, subagentId }, sessionId),
        () => {},
      );
      assert.equal(cancel.ok, true);
      assert.equal(cancel.payload.accepted, true);

      releaseTerminalClaim.resolve();

      const decision = await Promise.race([
        terminalDecision.promise,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('delegate_explorer did not finish terminal decision after cancellation'),
              ),
            5000,
          ),
        ),
      ]);
      assert.equal(decision.emittedTerminalEvent, false);
      assert.equal(decision.terminalEventType, null);

      const events = await loadSessionEvents(sessionId);
      const terminalEvents = events.filter(
        (event) =>
          (event.type === 'subagent.completed' || event.type === 'subagent.failed') &&
          event.payload.subagentId === subagentId,
      );
      assert.equal(terminalEvents.length, 1);
      assert.equal(terminalEvents[0].type, 'subagent.failed');
      assert.equal(terminalEvents[0].runId, childRunId);
      assert.equal(terminalEvents[0].payload.errorDetails.code, 'CANCELLED');

      const completed = events.find(
        (event) => event.type === 'subagent.completed' && event.payload.subagentId === subagentId,
      );
      assert.equal(completed, undefined);

      const terminalBroadcasts = broadcasted.filter(
        (event) =>
          (event.type === 'subagent.completed' || event.type === 'subagent.failed') &&
          event.payload.subagentId === subagentId,
      );
      assert.equal(terminalBroadcasts.length, 1);
      assert.equal(terminalBroadcasts[0].type, 'subagent.failed');

      const loaded = await loadSessionState(sessionId);
      const record = loaded.delegationOutcomes.find((r) => r.subagentId === subagentId);
      assert.ok(record, 'expected delegationOutcome record in session state');
      assert.equal(record.outcome.agent, 'explorer');
    } finally {
      __setDelegateExplorerHooksForTesting(null);
      releaseTerminalClaim.resolve();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── cancel_delegation ──────────────────────────────────────────

describe('cancel_delegation', () => {
  it('returns DELEGATION_NOT_FOUND when no active delegation exists', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-cancel-deleg-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      assert.equal(start.ok, true);
      const { sessionId, attachToken } = start.payload;

      const response = await handleRequest(
        makeRequest(
          'cancel_delegation',
          { sessionId, attachToken, subagentId: 'sub_nonexistent' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'DELEGATION_NOT_FOUND');
      assert.equal(response.error.retryable, false);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('cancel_delegation', { subagentId: 'sub_1' }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
  });

  it('rejects missing subagentId', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-cancel-deleg2-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const response = await handleRequest(
        makeRequest('cancel_delegation', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_REQUEST');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid attach token', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-cancel-deleg3-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId } = start.payload;

      const response = await handleRequest(
        makeRequest(
          'cancel_delegation',
          { sessionId, attachToken: 'att_wrong', subagentId: 'sub_1' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_TOKEN');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('cancels an active delegation and emits a cancellation event', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-cancel-deleg4-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      assert.equal(start.ok, true);
      const { sessionId, attachToken } = start.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);

      const abortController = new AbortController();
      ensureRuntimeState(entry).activeDelegations.set('sub_active', {
        childRunId: 'run_child_cancel',
        parentRunId: 'run_parent_1',
        role: 'coder',
        abortController,
        messages: [],
      });

      const broadcasted = [];
      const attached = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken }, sessionId),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'cancel_delegation',
          { sessionId, attachToken, subagentId: 'sub_active' },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);
      assert.equal(abortController.signal.aborted, true);
      assert.equal(entry.activeDelegations.has('sub_active'), false);

      const events = await loadSessionEvents(sessionId);
      const failed = events.find((event) => event.type === 'subagent.failed');
      assert.ok(failed);
      assert.equal(failed.runId, 'run_child_cancel');
      assert.equal(failed.payload.executionId, 'sub_active');
      assert.equal(failed.payload.subagentId, 'sub_active');
      assert.equal(failed.payload.parentRunId, 'run_parent_1');
      assert.equal(failed.payload.childRunId, 'run_child_cancel');
      assert.equal(failed.payload.agent, 'coder');
      assert.equal(failed.payload.role, 'coder');
      assert.equal(failed.payload.error, 'Cancelled by client');
      assert.equal(failed.payload.errorDetails.code, 'CANCELLED');
      assert.equal(failed.payload.errorDetails.retryable, false);

      assert.equal(broadcasted.length, 1);
      assert.equal(broadcasted[0].type, 'subagent.failed');
      assert.equal(broadcasted[0].seq, failed.seq);

      const loaded = await loadSessionState(sessionId);
      assert.equal(loaded.eventSeq, failed.seq);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── fetch_delegation_events ────────────────────────────────────

describe('fetch_delegation_events', () => {
  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('fetch_delegation_events', { subagentId: 'sub_1' }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
  });

  it('requires at least one of subagentId or childRunId', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-fetch-deleg-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const response = await handleRequest(
        makeRequest('fetch_delegation_events', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_REQUEST');
      assert.ok(response.error.message.includes('subagentId'));
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid attach token', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-fetch-deleg2-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId } = start.payload;

      const response = await handleRequest(
        makeRequest(
          'fetch_delegation_events',
          { sessionId, attachToken: 'att_wrong', subagentId: 'sub_1' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_TOKEN');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns SESSION_NOT_FOUND for unknown session', async () => {
    const response = await handleRequest(
      makeRequest(
        'fetch_delegation_events',
        { sessionId: 'sess_abc123_def456', subagentId: 'sub_1' },
        'sess_abc123_def456',
      ),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  });

  it('filters events by subagentId and childRunId', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-fetch-deleg3-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      // Load the state so we can append events to it
      const state = await loadSessionState(sessionId);

      // Append events with different delegation markers
      await appendSessionEvent(state, 'subagent.started', {
        executionId: 'sub_a',
        agent: 'coder',
      });
      await appendSessionEvent(
        state,
        'subagent.completed',
        { executionId: 'sub_a', agent: 'coder', summary: 'done' },
        'run_child_1',
      );
      await appendSessionEvent(state, 'subagent.started', {
        executionId: 'sub_b',
        agent: 'explorer',
      });
      await appendSessionEvent(state, 'user_message', { chars: 5, preview: 'hello' });

      // Filter by subagentId (matches executionId)
      const bySub = await handleRequest(
        makeRequest(
          'fetch_delegation_events',
          { sessionId, attachToken, subagentId: 'sub_a' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(bySub.ok, true);
      assert.equal(bySub.payload.events.length, 2);
      assert.equal(bySub.payload.events[0].payload.executionId, 'sub_a');
      assert.equal(bySub.payload.events[1].payload.executionId, 'sub_a');
      assert.equal(bySub.payload.replay.completed, true);

      // Filter by childRunId (matches event.runId)
      const byRun = await handleRequest(
        makeRequest(
          'fetch_delegation_events',
          { sessionId, attachToken, childRunId: 'run_child_1' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(byRun.ok, true);
      assert.equal(byRun.payload.events.length, 1);
      assert.equal(byRun.payload.events[0].runId, 'run_child_1');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('applies sinceSeq and limit', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-fetch-deleg4-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;
      const state = await loadSessionState(sessionId);

      // Append 4 events all tagged with the same subagentId
      for (let i = 0; i < 4; i++) {
        await appendSessionEvent(state, 'subagent.started', {
          executionId: 'sub_x',
          agent: 'coder',
          n: i,
        });
      }

      // sinceSeq: skip events with seq <= 3 (first event is seq 2 since session_started is seq 1)
      const sinceFetch = await handleRequest(
        makeRequest(
          'fetch_delegation_events',
          { sessionId, attachToken, subagentId: 'sub_x', sinceSeq: 3 },
          sessionId,
        ),
        () => {},
      );
      assert.equal(sinceFetch.ok, true);
      assert.ok(sinceFetch.payload.events.length > 0);
      for (const e of sinceFetch.payload.events) {
        assert.ok(e.seq > 3, `expected seq > 3 but got ${e.seq}`);
      }

      // limit: only return first 2
      const limitFetch = await handleRequest(
        makeRequest(
          'fetch_delegation_events',
          { sessionId, attachToken, subagentId: 'sub_x', limit: 2 },
          sessionId,
        ),
        () => {},
      );
      assert.equal(limitFetch.ok, true);
      assert.equal(limitFetch.payload.events.length, 2);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns empty events array when no matches', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-fetch-deleg5-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const response = await handleRequest(
        makeRequest(
          'fetch_delegation_events',
          { sessionId, attachToken, subagentId: 'sub_nonexistent' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, true);
      assert.equal(response.payload.events.length, 0);
      assert.equal(response.payload.replay.fromSeq, 0);
      assert.equal(response.payload.replay.toSeq, 0);
      assert.equal(response.payload.replay.completed, true);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── ensureRuntimeState ─────────────────────────────────────────

describe('ensureRuntimeState', () => {
  it('initializes activeDelegations and activeGraphs maps', () => {
    const entry = { state: {}, attachToken: 'att_test' };
    ensureRuntimeState(entry);
    assert.ok(entry.activeDelegations instanceof Map);
    assert.ok(entry.activeGraphs instanceof Map);
    assert.equal(entry.activeDelegations.size, 0);
    assert.equal(entry.activeGraphs.size, 0);
  });

  it('does not overwrite existing maps', () => {
    const entry = { state: {}, attachToken: 'att_test' };
    const delegMap = new Map([['sub_1', { agent: 'coder' }]]);
    entry.activeDelegations = delegMap;
    ensureRuntimeState(entry);
    assert.equal(entry.activeDelegations, delegMap);
    assert.equal(entry.activeDelegations.size, 1);
  });
});

// ─── start_session defaults ─────────────────────────────────────

describe('start_session defaults', () => {
  it('new session includes delegationOutcomes: []', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-start-defaults-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      assert.equal(start.ok, true);
      const { sessionId } = start.payload;

      const loaded = await loadSessionState(sessionId);
      assert.ok(Array.isArray(loaded.delegationOutcomes));
      assert.equal(loaded.delegationOutcomes.length, 0);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
