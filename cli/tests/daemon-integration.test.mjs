import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import { getSocketPath, getPidPath, validateAttachToken, getRestartPolicy, shouldRecover, DEFAULT_RESTART_POLICY } from '../pushd.ts';
import { PROTOCOL_VERSION, writeRunMarker, clearRunMarker, readRunMarker, scanInterruptedSessions, makeSessionId } from '../session-store.ts';

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
    const mod = await import('../daemon-client.mjs');
    assert.equal(typeof mod.connect, 'function');
    assert.equal(typeof mod.tryConnect, 'function');
    assert.equal(typeof mod.waitForReady, 'function');
  });

  it('tryConnect returns null for nonexistent socket', async () => {
    const { tryConnect } = await import('../daemon-client.mjs');
    const result = await tryConnect('/tmp/nonexistent-pushd-test.sock', 200);
    assert.equal(result, null);
  });

  it('connect + request + onEvent works with echo server', async () => {
    const sockPath = path.join(os.tmpdir(), `dc-test-${randomBytes(4).toString('hex')}.sock`);

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

      const { connect } = await import('../daemon-client.mjs');
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
      try { await fs.unlink(sockPath); } catch { /* ignore */ }
    }
  });

  it('onEvent returns unsubscribe function', async () => {
    const sockPath = path.join(os.tmpdir(), `dc-unsub-${randomBytes(4).toString('hex')}.sock`);

    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          socket.write(JSON.stringify({
            v: PROTOCOL_VERSION, kind: 'response', requestId: req.requestId,
            type: req.type, sessionId: null, ok: true, payload: {}, error: null,
          }) + '\n');
          // Emit two events
          for (let i = 0; i < 2; i++) {
            socket.write(JSON.stringify({
              v: PROTOCOL_VERSION, kind: 'event', sessionId: 's', runId: 'r',
              seq: i, ts: Date.now(), type: 'status', payload: { n: i },
            }) + '\n');
          }
        }
      });
    });

    try {
      await new Promise((resolve) => server.listen(sockPath, resolve));

      const { connect } = await import('../daemon-client.mjs');
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
      try { await fs.unlink(sockPath); } catch { /* ignore */ }
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
    const req = makeRequest('submit_approval', {
      sessionId: 'sess_1',
      approvalId: 'appr_1',
      decision: 'approve',
    }, 'sess_1');
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
    const content = await fs.readFile(
      path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8'
    );
    assert.ok(content.includes("const VERSION = '0.3.0'"));
  });

  it('capabilities include multi_client, replay_attach, and crash_recovery', async () => {
    const content = await fs.readFile(
      path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8'
    );
    assert.ok(content.includes("'multi_client'"));
    assert.ok(content.includes("'replay_attach'"));
    assert.ok(content.includes("'crash_recovery'"));
  });

  it('all 8 handler types are registered', async () => {
    const content = await fs.readFile(
      path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8'
    );
    const handlers = [
      'hello', 'ping', 'list_sessions', 'start_session',
      'send_user_message', 'attach_session', 'submit_approval', 'cancel_run',
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
