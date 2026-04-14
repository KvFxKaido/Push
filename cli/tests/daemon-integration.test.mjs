import { after, before, describe, it } from 'node:test';
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
  collectOrphanedDelegations,
  formatDelegationInterruptedNote,
  broadcastEvent,
  wrapCliDetectAllToolCalls,
  makeDaemonCoderToolExec,
  makeDaemonExplorerToolExec,
  __getActiveSessionForTesting,
  __evictActiveSessionForTesting,
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
  saveSessionState,
  appendSessionEvent,
  loadSessionEvents,
} from '../session-store.ts';
import { READ_ONLY_TOOLS, READ_ONLY_TOOL_PROTOCOL } from '../tools.ts';
import { buildExplorerSystemPrompt } from '../../lib/explorer-agent.ts';
import { startMockProviderServer, patchProviderConfig } from './mock-provider-server.mjs';

// Enable protocol strict mode for every test in this file via
// `before`/`after` hooks rather than a raw module-scope assignment.
// `broadcastEvent` reads `PUSH_PROTOCOL_STRICT` at call time via
// `isStrictModeEnabled()`, so setting it in a top-level `before` is
// sufficient — the hook fires before any `it` runs, and any handler
// dispatched below executes with the validator wired in. Drift between
// the wire-format contract (`cli/protocol-schema.ts`) and what a
// handler actually produces lands as a test failure instead of silent
// consumer-side breakage.
//
// Why hooks instead of `process.env.PUSH_PROTOCOL_STRICT = '1'` at
// module top? Node's `--test` runner defaults to one subprocess per
// test file, but if a caller runs with `--test-concurrency=1` or
// otherwise shares a process, a bare module-scope env mutation can
// leak into unrelated test files. Scoping via `before`/`after` keeps
// the flag's lifetime pinned to this file's test run and unsets it on
// completion so the next file starts clean. The strict-mode-toggle
// test lower in this file explicitly manages the var in its own
// try/finally so the hook-set value is restored on exit.
let previousStrictMode;
before(() => {
  previousStrictMode = process.env.PUSH_PROTOCOL_STRICT;
  process.env.PUSH_PROTOCOL_STRICT = '1';
});
after(() => {
  if (previousStrictMode === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
  else process.env.PUSH_PROTOCOL_STRICT = previousStrictMode;
});

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

  it('hello capabilities advertise the full multi-agent stack', async () => {
    const response = await handleRequest(makeRequest('hello', { clientName: 'test' }), () => {});
    assert.equal(response.ok, true);
    assert.ok(response.payload.capabilities.includes('multi_client'));
    assert.ok(response.payload.capabilities.includes('replay_attach'));
    assert.ok(response.payload.capabilities.includes('crash_recovery'));
    assert.ok(response.payload.capabilities.includes('role_routing'));
    assert.ok(response.payload.capabilities.includes('delegation_explorer_v1'));
    assert.ok(response.payload.capabilities.includes('delegation_coder_v1'));
    assert.ok(response.payload.capabilities.includes('delegation_reviewer_v1'));
    assert.ok(response.payload.capabilities.includes('task_graph_v1'));
    assert.ok(response.payload.capabilities.includes('event_v2'));
    // `multi_agent` now advertised — both Explorer and Coder daemon-side
    // tool executors are real (see `makeDaemonExplorerToolExec` +
    // `makeDaemonCoderToolExec` in cli/pushd.ts).
    assert.ok(response.payload.capabilities.includes('multi_agent'));
    // The versioned-suffix form is the canonical name; bare `task_graph`
    // (without `_v1`) is still NOT advertised.
    assert.ok(!response.payload.capabilities.includes('task_graph'));
  });

  it('all 15 handler types are registered', async () => {
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
      'delegate_coder',
      'delegate_reviewer',
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

// ─── submit_task_graph ──────────────────────────────────────────

// Wait for a task-graph background run to emit its terminal
// task_graph.graph_completed event — handleSubmitTaskGraph appends and
// broadcasts that terminal event BEFORE deleting the execution from
// activeGraphs, so polling activeGraphs alone can still race with the
// terminal event being written to the events log (and a caller that
// only checks activeGraphs.has() can observe "gone" before the events
// log has caught up). Poll both to be safe.
async function waitForTaskGraphComplete(entry, executionId, sessionId, timeoutMs = 5000) {
  const startWait = Date.now();
  while (Date.now() - startWait < timeoutMs) {
    const stillActive = entry.activeGraphs && entry.activeGraphs.has(executionId);
    if (!stillActive) {
      const events = await loadSessionEvents(sessionId);
      const terminal = events.find(
        (e) => e.type === 'task_graph.graph_completed' && e.payload?.executionId === executionId,
      );
      if (terminal) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `task-graph background run did not complete within ${timeoutMs}ms (executionId=${executionId})`,
  );
}

describe('submit_task_graph', () => {
  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('submit_task_graph', { graph: { tasks: [] } }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.ok(response.error.message.includes('sessionId'));
  });

  it('rejects missing or malformed graph.tasks', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-shape-'));
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

      const missingGraph = await handleRequest(
        makeRequest('submit_task_graph', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(missingGraph.ok, false);
      assert.equal(missingGraph.error.code, 'INVALID_REQUEST');
      assert.ok(missingGraph.error.message.includes('graph.tasks'));

      const malformed = await handleRequest(
        makeRequest(
          'submit_task_graph',
          { sessionId, attachToken, graph: { tasks: 'not-an-array' } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(malformed.ok, false);
      assert.equal(malformed.error.code, 'INVALID_REQUEST');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns INVALID_TASK_GRAPH on empty task list', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-empty-'));
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
          'submit_task_graph',
          { sessionId, attachToken, graph: { tasks: [] } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_TASK_GRAPH');
      assert.ok(response.error.message.includes('empty_graph'));
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns INVALID_TASK_GRAPH on duplicate ids', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-dupe-'));
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
          'submit_task_graph',
          {
            sessionId,
            attachToken,
            graph: {
              tasks: [
                { id: 'a', agent: 'explorer', task: 'first' },
                { id: 'a', agent: 'explorer', task: 'second' },
              ],
            },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_TASK_GRAPH');
      assert.ok(response.error.message.includes('duplicate_id'));
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid attach token', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-token-'));
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
          'submit_task_graph',
          {
            sessionId,
            attachToken: 'att_wrong',
            graph: {
              tasks: [{ id: 'a', agent: 'explorer', task: 'explore' }],
            },
          },
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
        'submit_task_graph',
        {
          sessionId: 'sess_unknown_xyz',
          graph: { tasks: [{ id: 'a', agent: 'explorer', task: 'explore' }] },
        },
        'sess_unknown_xyz',
      ),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  });

  it('executes a single explorer node end-to-end and emits task_graph.* events', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-happy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    const mock = await startMockProviderServer({
      tokens: ['MOCK_TG_ALPHA ', 'MOCK_TG_OMEGA'],
    });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'submit_task_graph',
          {
            sessionId,
            attachToken,
            graph: {
              tasks: [{ id: 'explore-1', agent: 'explorer', task: 'explore daemon surface' }],
            },
          },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);
      assert.equal(response.payload.nodeCount, 1);
      assert.ok(response.payload.executionId);
      assert.ok(response.payload.executionId.startsWith('graph_'));

      const { executionId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      assert.ok(entry.activeGraphs);
      assert.equal(entry.activeGraphs.has(executionId), true);

      await waitForTaskGraphComplete(entry, executionId, sessionId);
      assert.equal(entry.activeGraphs.has(executionId), false);

      const events = await loadSessionEvents(sessionId);
      const started = events.find(
        (e) => e.type === 'task_graph.task_started' && e.payload.executionId === executionId,
      );
      const completedTask = events.find(
        (e) => e.type === 'task_graph.task_completed' && e.payload.executionId === executionId,
      );
      const completedGraph = events.find(
        (e) => e.type === 'task_graph.graph_completed' && e.payload.executionId === executionId,
      );
      assert.ok(started, 'expected task_graph.task_started event');
      assert.ok(completedTask, 'expected task_graph.task_completed event');
      assert.ok(completedGraph, 'expected task_graph.graph_completed event');
      assert.equal(started.payload.agent, 'explorer');
      assert.equal(started.payload.taskId, 'explore-1');
      assert.equal(completedTask.payload.agent, 'explorer');
      assert.equal(completedGraph.payload.success, true);
      assert.equal(completedGraph.payload.nodeCount, 1);
      assert.equal(completedGraph.payload.aborted, false);

      const broadcastGraphCompleted = broadcasted.find(
        (e) => e.type === 'task_graph.graph_completed' && e.payload.executionId === executionId,
      );
      assert.ok(broadcastGraphCompleted, 'expected task_graph.graph_completed broadcast');
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('serializes events from parallel explorer nodes into monotonic seq order', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-parallel-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // executeTaskGraph runs explorer nodes in parallel (up to 3). If
    // emitTaskGraphEvent isn't serialized, overlapping appendSessionEvent
    // calls can interleave: state.eventSeq is bumped synchronously before
    // the filesystem append resolves, so the on-disk order (and the
    // broadcast envelope seq) can drift. This test submits three
    // independent explorer nodes and asserts that all task_graph.* events
    // for the graph land in strictly increasing seq both on disk and on
    // the broadcast stream.
    const mock = await startMockProviderServer({
      tokens: ['MOCK_PARALLEL_ALPHA ', 'MOCK_PARALLEL_OMEGA'],
    });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'submit_task_graph',
          {
            sessionId,
            attachToken,
            graph: {
              tasks: [
                { id: 'explore-a', agent: 'explorer', task: 'a' },
                { id: 'explore-b', agent: 'explorer', task: 'b' },
                { id: 'explore-c', agent: 'explorer', task: 'c' },
              ],
            },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, true);
      const { executionId } = response.payload;

      const entry = __getActiveSessionForTesting(sessionId);
      await waitForTaskGraphComplete(entry, executionId, sessionId);

      const events = await loadSessionEvents(sessionId);
      const graphEvents = events.filter(
        (e) => e.type.startsWith('task_graph.') && e.payload?.executionId === executionId,
      );
      assert.ok(
        graphEvents.length >= 7,
        'expected at least 3 started + 3 completed + 1 graph_completed events',
      );

      // Disk order = emission order; seq must be strictly increasing.
      let prevSeq = -Infinity;
      for (const e of graphEvents) {
        assert.ok(
          typeof e.seq === 'number' && e.seq > prevSeq,
          `events.jsonl task_graph.* seq regressed: ${e.seq} <= ${prevSeq}`,
        );
        prevSeq = e.seq;
      }

      // The broadcast stream must also be monotonic and free of seq collisions.
      const broadcastGraphEvents = broadcasted.filter(
        (e) => e.type.startsWith('task_graph.') && e.payload?.executionId === executionId,
      );
      const broadcastSeqs = broadcastGraphEvents.map((e) => e.seq);
      const uniqueBroadcastSeqs = new Set(broadcastSeqs);
      assert.equal(
        uniqueBroadcastSeqs.size,
        broadcastSeqs.length,
        'broadcast envelopes reused seq values',
      );
      let prevBroadcastSeq = -Infinity;
      for (const seq of broadcastSeqs) {
        assert.ok(
          seq > prevBroadcastSeq,
          `broadcast task_graph.* seq regressed: ${seq} <= ${prevBroadcastSeq}`,
        );
        prevBroadcastSeq = seq;
      }

      // graph_completed must be the last task_graph.* event on both streams.
      assert.equal(
        graphEvents[graphEvents.length - 1].type,
        'task_graph.graph_completed',
        'graph_completed must be the final task_graph.* event in events.jsonl',
      );
      assert.equal(
        broadcastGraphEvents[broadcastGraphEvents.length - 1].type,
        'task_graph.graph_completed',
        'graph_completed must be the final task_graph.* event on the broadcast',
      );
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('omits runId from task_graph event envelopes when parentRunId is null', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-nullrun-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    const mock = await startMockProviderServer({
      tokens: ['MOCK_NULLRUN_ALPHA'],
    });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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
      await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
        (event) => broadcasted.push(event),
      );
      broadcasted.length = 0;

      // No parentRunId in payload and no active run — parentRunId resolves
      // to null inside the handler. Wire envelopes must omit the field
      // rather than serializing `"runId":null`, matching how the session
      // store persists events via appendSessionEvent.
      const response = await handleRequest(
        makeRequest(
          'submit_task_graph',
          {
            sessionId,
            attachToken,
            graph: {
              tasks: [{ id: 'explore-1', agent: 'explorer', task: 'nullrun' }],
            },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, true);
      const { executionId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      await waitForTaskGraphComplete(entry, executionId, sessionId);

      const events = await loadSessionEvents(sessionId);
      const graphEvents = events.filter(
        (e) => e.type.startsWith('task_graph.') && e.payload?.executionId === executionId,
      );
      assert.ok(graphEvents.length > 0);
      for (const e of graphEvents) {
        assert.ok(
          !('runId' in e),
          `persisted event should omit runId when parentRunId is null, got: ${JSON.stringify(e)}`,
        );
      }

      const broadcastGraphEvents = broadcasted.filter(
        (e) => e.type.startsWith('task_graph.') && e.payload?.executionId === executionId,
      );
      assert.ok(broadcastGraphEvents.length > 0);
      for (const e of broadcastGraphEvents) {
        assert.ok(
          !('runId' in e) || e.runId !== null,
          `broadcast envelope must omit runId (or make it non-null) when parentRunId is null, got: ${JSON.stringify(e)}`,
        );
        assert.ok(
          !('runId' in e),
          `broadcast envelope should omit runId entirely: ${JSON.stringify(e)}`,
        );
      }
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('executes a coder node through the real daemon tool executor and marks the graph successful', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-submit-graph-coder-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // Phase 6 wrap-up: coder task-graph nodes route through
    // `runCoderForTaskGraph` against `runCoderAgent` with the real
    // daemon tool executor (`makeDaemonCoderToolExec`). The LLM streams
    // real tokens through the mock provider, the node completes with a
    // `'complete'` DelegationOutcome, and the graph succeeds.
    const MOCK_TOKENS = ['MOCK_CODER_ALPHA ', 'MOCK_CODER_OMEGA'];
    const mock = await startMockProviderServer({ tokens: MOCK_TOKENS });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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

      const response = await handleRequest(
        makeRequest(
          'submit_task_graph',
          {
            sessionId,
            attachToken,
            graph: {
              tasks: [{ id: 'build-1', agent: 'coder', task: 'write some code' }],
            },
          },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      const { executionId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);

      await waitForTaskGraphComplete(entry, executionId, sessionId);

      const events = await loadSessionEvents(sessionId);
      const taskStarted = events.find(
        (e) => e.type === 'task_graph.task_started' && e.payload.executionId === executionId,
      );
      const taskCompleted = events.find(
        (e) => e.type === 'task_graph.task_completed' && e.payload.executionId === executionId,
      );
      const taskFailed = events.find(
        (e) => e.type === 'task_graph.task_failed' && e.payload.executionId === executionId,
      );
      const completedGraph = events.find(
        (e) => e.type === 'task_graph.graph_completed' && e.payload.executionId === executionId,
      );

      assert.ok(taskStarted, 'expected task_graph.task_started event');
      assert.equal(taskStarted.payload.agent, 'coder');
      assert.ok(!taskFailed, 'coder nodes should no longer fail fast');
      assert.ok(taskCompleted, 'expected task_graph.task_completed event');
      assert.equal(taskCompleted.payload.agent, 'coder');
      assert.ok(completedGraph);
      assert.equal(completedGraph.payload.success, true);
      assert.equal(completedGraph.payload.aborted, false);
      assert.equal(completedGraph.payload.nodeCount, 1);
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── delegate_explorer ──────────────────────────────────────────

// Wait for a delegation background task to finish.
//
// Ownership is claimed by deleting the entry from `activeDelegations` BEFORE
// the terminal event is persisted (see handleDelegateExplorer / handleDelegateReviewer)
// — polling `activeDelegations.has()` alone races the `await appendSessionEvent`
// that lands `subagent.completed`/`subagent.failed` on disk. When a `sessionId`
// is provided, also poll the events log until the terminal event appears so
// callers can immediately `loadSessionEvents` without hitting the write race.
async function waitForDelegationComplete(entry, subagentId, sessionId = null, timeoutMs = 5000) {
  const startWait = Date.now();
  while (Date.now() - startWait < timeoutMs) {
    const stillActive = entry.activeDelegations && entry.activeDelegations.has(subagentId);
    if (!stillActive) {
      if (!sessionId) return;
      const events = await loadSessionEvents(sessionId);
      const terminal = events.find(
        (e) =>
          (e.type === 'subagent.completed' || e.type === 'subagent.failed') &&
          e.payload?.subagentId === subagentId,
      );
      if (terminal) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const details = sessionId
    ? `subagentId=${subagentId}, sessionId=${sessionId}`
    : `subagentId=${subagentId}`;
  throw new Error(`delegation background run did not complete within ${timeoutMs}ms (${details})`);
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

  it('rejects stale explorer role routing with an unknown provider before acking', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer-stale-'));
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
      entry.state.roleRouting = {
        explorer: {
          provider: 'google',
          model: 'stale-model',
        },
      };

      const response = await handleRequest(
        makeRequest(
          'delegate_explorer',
          { sessionId, attachToken, task: 'scaffold exploration' },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'PROVIDER_NOT_CONFIGURED');
      assert.ok(response.error.message.includes('google'));
      assert.equal(entry.activeDelegations?.size ?? 0, 0);

      const events = await loadSessionEvents(sessionId);
      const subagentEvents = events.filter((event) => event.type.startsWith('subagent.'));
      assert.equal(subagentEvents.length, 0);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs the lib kernel end-to-end with a real streamFn adapter and persists a complete outcome', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer-happy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // The daemon ProviderStreamFn adapter wraps cli/provider.ts#streamCompletion,
    // which does a real fetch against `PROVIDER_CONFIGS[provider].url`. Point
    // that at an in-process mock emitting canned SSE tokens so we exercise the
    // full adapter → streamCompletion → SSE-parser path without a real LLM.
    const MOCK_TOKENS = [
      'MOCK_EXPLORER_TOKEN_ALPHA ',
      'scaffold-result-from-mock ',
      'MOCK_EXPLORER_TOKEN_OMEGA',
    ];
    const mock = await startMockProviderServer({ tokens: MOCK_TOKENS });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
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

      await waitForDelegationComplete(entry, subagentId, sessionId);

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
      // Real Explorer tool executor landed — a clean kernel return now
      // marks the outcome as `'complete'` with an empty missingRequirements
      // list (previously `'inconclusive'` with a tool-executor gate).
      assert.equal(completed.payload.delegationOutcome.status, 'complete');

      // Proof that the real streamFn adapter ran: the mock's canned tokens
      // land in the delegation outcome (either in summary or in the broadcast
      // event) instead of the old '[pushd scaffold]' canned string.
      const summary = completed.payload.delegationOutcome.summary;
      assert.equal(typeof summary, 'string');
      assert.ok(summary.length > 0, 'expected non-empty delegation summary');
      assert.ok(
        !summary.includes('[pushd scaffold]'),
        'stub canned report should no longer appear — adapter must stream from provider',
      );

      // `missingRequirements` is now empty — both the streamFn adapter
      // (wired earlier) and the tool executor (wired in this slice) are
      // live. Keeping the explicit length assertion so a regression that
      // re-introduces a scaffold-level gate fails loudly.
      const missing = completed.payload.delegationOutcome.missingRequirements;
      assert.ok(Array.isArray(missing));
      assert.equal(missing.length, 0, 'expected no remaining Explorer requirements');
      assert.equal(completed.payload.delegationOutcome.nextRequiredAction, null);

      const loaded = await loadSessionState(sessionId);
      assert.ok(Array.isArray(loaded.delegationOutcomes));
      const record = loaded.delegationOutcomes.find((r) => r.subagentId === subagentId);
      assert.ok(record, 'expected delegationOutcome record in session state');
      assert.equal(record.outcome.status, 'complete');
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
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not emit completion after cancellation wins before terminal claim', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-explorer-race-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // Race test stages the terminal-claim race via the beforeTerminalClaim
    // hook — the hook fires AFTER runExplorerAgent resolves, so we need the
    // adapter to complete deterministically regardless of ambient env vars.
    // Point the adapter at a mock that emits canned tokens + [DONE].
    const mock = await startMockProviderServer({
      tokens: ['race-mock-content'],
    });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
    });

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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
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
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── delegate_reviewer ──────────────────────────────────────────

const MINIMAL_REVIEWER_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' line one',
  ' line two',
  '+added line',
  ' line three',
  '',
].join('\n');

// ─── delegate_coder ─────────────────────────────────────────────

// Mirrors the delegate_explorer suite: validates input, token, stale
// routing, and a happy-path kernel run where the lib Coder streams
// through a mock provider and the handler persists a `'complete'`
// DelegationOutcome backed by the real daemon tool executor
// (`makeDaemonCoderToolExec`). Cancellation race coverage is
// deliberately omitted for this tranche — the explorer race test
// already pins the shared terminal-claim pattern and the coder handler
// uses the same flow.
describe('delegate_coder', () => {
  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('delegate_coder', { task: 'write a script' }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.ok(response.error.message.includes('sessionId'));
  });

  it('rejects missing task', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-coder-'));
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
        makeRequest('delegate_coder', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_REQUEST');
      assert.ok(response.error.message.includes('task'));

      const emptyTask = await handleRequest(
        makeRequest('delegate_coder', { sessionId, attachToken, task: '   ' }, sessionId),
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
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-coder-token-'));
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
          'delegate_coder',
          { sessionId, attachToken: 'att_wrong', task: 'write a script' },
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
        'delegate_coder',
        { sessionId: 'sess_abc123_def456', task: 'write a script' },
        'sess_abc123_def456',
      ),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  });

  it('rejects stale coder role routing with an unknown provider before acking', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-coder-stale-'));
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
      entry.state.roleRouting = {
        coder: {
          provider: 'google',
          model: 'stale-model',
        },
      };

      const response = await handleRequest(
        makeRequest(
          'delegate_coder',
          { sessionId, attachToken, task: 'scaffold coding' },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'PROVIDER_NOT_CONFIGURED');
      assert.ok(response.error.message.includes('google'));
      assert.equal(entry.activeDelegations?.size ?? 0, 0);

      const events = await loadSessionEvents(sessionId);
      const subagentEvents = events.filter((event) => event.type.startsWith('subagent.'));
      assert.equal(subagentEvents.length, 0);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs the lib Coder kernel end-to-end with real streamFn + real tool executor and persists a complete outcome', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-coder-happy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    const MOCK_TOKENS = [
      'MOCK_CODER_TOKEN_ALPHA ',
      'scaffold-coder-result ',
      'MOCK_CODER_TOKEN_OMEGA',
    ];
    const mock = await startMockProviderServer({ tokens: MOCK_TOKENS });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'delegate_coder',
          { sessionId, attachToken, task: 'scaffold coding' },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);
      assert.ok(response.payload.subagentId);
      assert.ok(response.payload.subagentId.startsWith('sub_coder_'));
      assert.ok(response.payload.childRunId);
      assert.ok(response.payload.childRunId.startsWith('run_'));

      const { subagentId, childRunId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      assert.ok(entry.activeDelegations);
      assert.equal(entry.activeDelegations.has(subagentId), true);

      await waitForDelegationComplete(entry, subagentId, sessionId);

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
      assert.equal(started.payload.agent, 'coder');
      assert.equal(started.payload.role, 'coder');
      assert.equal(started.payload.detail, 'scaffold coding');
      assert.equal(completed.runId, childRunId);
      assert.equal(completed.payload.agent, 'coder');
      assert.ok(completed.payload.delegationOutcome);
      assert.equal(completed.payload.delegationOutcome.agent, 'coder');
      // With the real daemon tool executor wired (replacing the
      // scaffold stub that always returned `inconclusive`), a clean
      // kernel return now lands as `'complete'`. Structural failures
      // still fall through to `'inconclusive'` via the caller's
      // catch block, covered by a separate test if needed.
      assert.equal(completed.payload.delegationOutcome.status, 'complete');
      // The real executor clears `missingRequirements` because the
      // kernel is no longer running against stubs. If the model didn't
      // emit any tool calls (the mock provider just returns plain
      // tokens), the outcome is still 'complete' — it just has no
      // evidence or checks.
      assert.deepEqual(completed.payload.delegationOutcome.missingRequirements, []);
      assert.equal(completed.payload.delegationOutcome.nextRequiredAction, null);

      const loaded = await loadSessionState(sessionId);
      assert.ok(Array.isArray(loaded.delegationOutcomes));
      const record = loaded.delegationOutcomes.find((r) => r.subagentId === subagentId);
      assert.ok(record, 'expected delegationOutcome record in session state');
      assert.equal(record.outcome.status, 'complete');
      assert.equal(record.outcome.agent, 'coder');

      const broadcastStarted = broadcasted.find(
        (e) => e.type === 'subagent.started' && e.payload.subagentId === subagentId,
      );
      const broadcastCompleted = broadcasted.find(
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
      );
      assert.ok(broadcastStarted, 'expected subagent.started broadcast');
      assert.ok(broadcastCompleted, 'expected subagent.completed broadcast');
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('honours coder role routing via configure_role_routing (distinct provider)', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-coder-routing-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // Proof-of-routing test: spin up TWO mock servers and pin the
    // session default to one (`ollama` → sessionMock) while routing
    // `coder` to the other (`openrouter` → routedMock). Each mock
    // emits a distinct token so the delegation summary tells us
    // unambiguously which backend served the request. Routing the
    // coder role to `ollama` (the session default) would only prove
    // the RPC accepts the `coder` key, not that role routing is
    // consulted at request time — hence the extra mock.
    const SESSION_ONLY_TOKEN = 'SESSION_PROVIDER_SHOULD_NOT_APPEAR';
    const ROUTED_ONLY_TOKEN = 'ROUTED_CODER_PROVIDER_DID_APPEAR';

    const sessionMock = await startMockProviderServer({ tokens: [SESSION_ONLY_TOKEN] });
    const routedMock = await startMockProviderServer({ tokens: [ROUTED_ONLY_TOKEN] });
    const restoreSession = patchProviderConfig('ollama', {
      url: sessionMock.url,
      apiKey: 'session-mock-key',
    });
    const restoreRouted = patchProviderConfig('openrouter', {
      url: routedMock.url,
      apiKey: 'routed-mock-key',
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

      const routing = await handleRequest(
        makeRequest(
          'configure_role_routing',
          { sessionId, attachToken, routing: { coder: { provider: 'openrouter' } } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(routing.ok, true);
      assert.equal(routing.payload.roleRouting.coder.provider, 'openrouter');

      const response = await handleRequest(
        makeRequest(
          'delegate_coder',
          { sessionId, attachToken, task: 'routed coder task' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, true);

      const { subagentId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      await waitForDelegationComplete(entry, subagentId, sessionId);

      const events = await loadSessionEvents(sessionId);
      const completed = events.find(
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
      );
      assert.ok(completed);
      assert.equal(completed.payload.agent, 'coder');

      // The only way these tokens end up in the delegation summary is
      // if the Coder kernel's streamFn actually connected to the mock
      // server we pointed the openrouter config at. If the routing
      // override were silently ignored, the summary would carry the
      // ollama session-mock token instead.
      const summary = completed.payload.delegationOutcome.summary;
      assert.ok(
        summary.includes(ROUTED_ONLY_TOKEN),
        `expected routed-provider token in summary, got ${JSON.stringify(summary)}`,
      );
      assert.ok(
        !summary.includes(SESSION_ONLY_TOKEN),
        `session-provider token should not appear — routing override was bypassed. summary=${JSON.stringify(summary)}`,
      );
    } finally {
      restoreRouted();
      restoreSession();
      await routedMock.stop();
      await sessionMock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── Daemon Coder tool executor (direct unit tests) ────────────

// Rather than drive `runCoderAgent` through a multi-round mock provider
// to test the tool executor end-to-end (which would require either a
// stateful mock that emits a tool call on round 1 and plain text on
// round 2, or tolerating the kernel's own round cap), these tests call
// the exported `makeDaemonCoderToolExec` and `wrapCliDetectAllToolCalls`
// helpers directly. That proves the two load-bearing pieces — the CLI
// detector → lib `DetectedToolCalls` shape transform, and the closure
// that routes the kernel's `toolExec` slot through `executeToolCall`
// from `cli/tools.ts` — without coupling the test to kernel-loop
// internals that are already covered elsewhere.
describe('wrapCliDetectAllToolCalls', () => {
  it('classifies read_file as read-only', () => {
    const text = [
      '```json',
      JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } }),
      '```',
    ].join('\n');
    const detected = wrapCliDetectAllToolCalls(text);
    assert.equal(detected.readOnly.length, 1);
    assert.equal(detected.readOnly[0].source, 'cli');
    assert.equal(detected.readOnly[0].call.tool, 'read_file');
    assert.deepEqual(detected.fileMutations, []);
    assert.equal(detected.mutating, null);
    assert.deepEqual(detected.extraMutations, []);
  });

  it('classifies write_file as a file mutation (batchable)', () => {
    const text = [
      '```json',
      JSON.stringify({ tool: 'write_file', args: { path: 'a.txt', content: 'x' } }),
      '```',
    ].join('\n');
    const detected = wrapCliDetectAllToolCalls(text);
    assert.deepEqual(detected.readOnly, []);
    assert.equal(detected.fileMutations.length, 1);
    assert.equal(detected.fileMutations[0].source, 'cli');
    assert.equal(detected.fileMutations[0].call.tool, 'write_file');
    assert.equal(detected.mutating, null);
    assert.deepEqual(detected.extraMutations, []);
  });

  it('batches multiple file mutations in one turn', () => {
    const write1 = JSON.stringify({ tool: 'write_file', args: { path: 'a.txt', content: '1' } });
    const write2 = JSON.stringify({ tool: 'write_file', args: { path: 'b.txt', content: '2' } });
    const text = `\`\`\`json\n${write1}\n\`\`\`\n\n\`\`\`json\n${write2}\n\`\`\``;
    const detected = wrapCliDetectAllToolCalls(text);
    assert.deepEqual(detected.readOnly, []);
    assert.equal(detected.fileMutations.length, 2);
    assert.equal(detected.fileMutations[0].call.args.path, 'a.txt');
    assert.equal(detected.fileMutations[1].call.args.path, 'b.txt');
    assert.equal(detected.mutating, null);
    assert.deepEqual(detected.extraMutations, []);
  });

  it('classifies exec as a trailing side-effect', () => {
    const write = JSON.stringify({ tool: 'write_file', args: { path: 'a.txt', content: '1' } });
    const exec = JSON.stringify({ tool: 'exec', args: { command: 'npm test' } });
    const text = `\`\`\`json\n${write}\n\`\`\`\n\`\`\`json\n${exec}\n\`\`\``;
    const detected = wrapCliDetectAllToolCalls(text);
    assert.equal(detected.fileMutations.length, 1);
    assert.ok(detected.mutating);
    assert.equal(detected.mutating.call.tool, 'exec');
    assert.deepEqual(detected.extraMutations, []);
  });

  it('rejects a second side-effect after the batch', () => {
    const write = JSON.stringify({ tool: 'write_file', args: { path: 'a.txt', content: '1' } });
    const exec1 = JSON.stringify({ tool: 'exec', args: { command: 'npm test' } });
    const exec2 = JSON.stringify({ tool: 'exec', args: { command: 'npm run build' } });
    const text = `\`\`\`json\n${write}\n\`\`\`\n\`\`\`json\n${exec1}\n\`\`\`\n\`\`\`json\n${exec2}\n\`\`\``;
    const detected = wrapCliDetectAllToolCalls(text);
    assert.equal(detected.fileMutations.length, 1);
    assert.ok(detected.mutating);
    assert.equal(detected.mutating.call.tool, 'exec');
    assert.equal(detected.mutating.call.args.command, 'npm test');
    assert.equal(detected.extraMutations.length, 1);
    assert.equal(detected.extraMutations[0].call.tool, 'exec');
  });

  it('collects parallel reads + file-mutation batch + trailing side-effect', () => {
    const read1 = JSON.stringify({ tool: 'read_file', args: { path: 'a.txt' } });
    const read2 = JSON.stringify({ tool: 'list_dir', args: { path: '.' } });
    const write = JSON.stringify({ tool: 'write_file', args: { path: 'c.txt', content: '3' } });
    const exec = JSON.stringify({ tool: 'exec', args: { command: 'npm test' } });
    const text = `\`\`\`json\n${read1}\n\`\`\`\n\`\`\`json\n${read2}\n\`\`\`\n\`\`\`json\n${write}\n\`\`\`\n\`\`\`json\n${exec}\n\`\`\``;
    const detected = wrapCliDetectAllToolCalls(text);
    assert.equal(detected.readOnly.length, 2);
    assert.equal(detected.readOnly[0].call.tool, 'read_file');
    assert.equal(detected.readOnly[1].call.tool, 'list_dir');
    assert.equal(detected.fileMutations.length, 1);
    assert.equal(detected.fileMutations[0].call.tool, 'write_file');
    assert.ok(detected.mutating);
    assert.equal(detected.mutating.call.tool, 'exec');
    assert.deepEqual(detected.extraMutations, []);
  });

  it('returns empty slots when text has no tool calls', () => {
    const detected = wrapCliDetectAllToolCalls('just some prose with no fenced json at all.');
    assert.deepEqual(detected.readOnly, []);
    assert.deepEqual(detected.fileMutations, []);
    assert.equal(detected.mutating, null);
    assert.deepEqual(detected.extraMutations, []);
  });
});

describe('makeDaemonCoderToolExec', () => {
  it('reads a real file off disk and returns an executed result', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-coder-exec-read-'));
    try {
      const FILE_CONTENT = 'DAEMON_CODER_REAL_READ_SENTINEL_0x1F';
      await fs.writeFile(path.join(workspaceRoot, 'fixture.txt'), FILE_CONTENT, 'utf8');

      // Fake session entry shape — we only need `state.cwd` for the
      // tool executor closure, and a `pendingApproval` slot that
      // buildApprovalFn will attach to if any high-risk exec is
      // attempted (not triggered by `read_file`).
      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonCoderToolExec({
        sessionId: 'sess_test_coder_read_fake1',
        entry,
        runId: 'run_test',
        signal: abortController.signal,
      });

      const result = await toolExec(
        { tool: 'read_file', args: { path: 'fixture.txt' } },
        { round: 1 },
      );

      assert.equal(result.kind, 'executed');
      assert.ok(
        result.resultText.includes(FILE_CONTENT),
        `expected sentinel in result, got ${JSON.stringify(result.resultText)}`,
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('writes a real file to disk and returns an executed result', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-coder-exec-write-'));
    try {
      const FILE_CONTENT = 'WRITTEN_BY_DAEMON_CODER_0xBEEF';
      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonCoderToolExec({
        sessionId: 'sess_test_coder_write_fake',
        entry,
        runId: 'run_test',
        signal: abortController.signal,
      });

      const result = await toolExec(
        { tool: 'write_file', args: { path: 'output.txt', content: FILE_CONTENT } },
        { round: 1 },
      );

      assert.equal(result.kind, 'executed');

      // The real assertion: the file landed on disk. If the stub is
      // still wired, this read fails.
      const written = await fs.readFile(path.join(workspaceRoot, 'output.txt'), 'utf8');
      assert.equal(written, FILE_CONTENT);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists a directory', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-coder-exec-list-'));
    try {
      await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'a', 'utf8');
      await fs.writeFile(path.join(workspaceRoot, 'b.txt'), 'b', 'utf8');
      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonCoderToolExec({
        sessionId: 'sess_test_coder_list_fake',
        entry,
        runId: 'run_test',
        signal: abortController.signal,
      });

      const result = await toolExec({ tool: 'list_dir', args: { path: '.' } }, { round: 1 });
      assert.equal(result.kind, 'executed');
      assert.ok(
        result.resultText.includes('a.txt') && result.resultText.includes('b.txt'),
        `expected both files in list output, got ${JSON.stringify(result.resultText)}`,
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns an executed result with an errorType when the tool fails', async () => {
    // Force an error by trying to read a file that doesn't exist.
    // `executeToolCall` returns `{ ok: false, structuredError: {...} }`;
    // the wrapper translates that into `{ kind: 'executed', resultText,
    // errorType }` so the kernel's mutation-failure tracker can count
    // repeated failures. The `errorType` must be present and non-empty.
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-coder-exec-err-'));
    try {
      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonCoderToolExec({
        sessionId: 'sess_test_coder_err_fake',
        entry,
        runId: 'run_test',
        signal: abortController.signal,
      });

      const result = await toolExec(
        { tool: 'read_file', args: { path: 'does-not-exist.txt' } },
        { round: 1 },
      );

      assert.equal(result.kind, 'executed');
      assert.equal(typeof result.resultText, 'string');
      // `errorType` is what feeds the mutation-failure tracker; for a
      // missing file, `executeToolCall` sets a structured error code.
      // Assert it's a non-empty string (exact code is an impl detail
      // of cli/tools.ts — we just pin "something is set").
      assert.ok(
        typeof result.errorType === 'string' && result.errorType.length > 0,
        `expected non-empty errorType for missing file, got ${JSON.stringify(result.errorType)}`,
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

// ─── Daemon Explorer tool executor (direct unit tests) ────────────

// Mirrors the `makeDaemonCoderToolExec` tests but for Explorer's
// simpler `{ resultText, card? }` return shape. Pins (1) real file
// reads off disk via `executeToolCall`, (2) mutation refusal on the
// read-only contract, (3) the wrapped `{ call: { tool, args } }` vs
// flat `{ tool, args }` unwrap path. The Explorer kernel end-to-end
// smoke path is covered by the `delegate_explorer` integration test
// further up.
describe('makeDaemonExplorerToolExec', () => {
  it('reads a real file off disk via the wrapped CLI call shape', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-explorer-exec-read-'));
    try {
      const FILE_CONTENT = 'DAEMON_EXPLORER_READ_SENTINEL_0xFACE';
      await fs.writeFile(path.join(workspaceRoot, 'notes.md'), FILE_CONTENT, 'utf8');

      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      // The kernel hands the executor the wrapped `{ source, call }`
      // shape that `wrapCliDetectAllToolCalls` produces. The executor
      // must unwrap it internally before calling `executeToolCall`.
      const result = await toolExec(
        { source: 'cli', call: { tool: 'read_file', args: { path: 'notes.md' } } },
        { round: 1 },
      );

      assert.equal(typeof result.resultText, 'string');
      assert.ok(
        result.resultText.includes(FILE_CONTENT),
        `expected sentinel in result, got ${JSON.stringify(result.resultText)}`,
      );
      // Explorer kernel shape is `{ resultText, card? }` — no `kind`
      // discriminant (that's Coder's shape).
      assert.equal(result.kind, undefined);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('accepts a bare CLI call (unwrapped shape) for direct test use', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-explorer-exec-bare-'));
    try {
      await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'a', 'utf8');
      await fs.writeFile(path.join(workspaceRoot, 'b.txt'), 'b', 'utf8');

      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec({ tool: 'list_dir', args: { path: '.' } }, { round: 1 });

      assert.ok(
        result.resultText.includes('a.txt') && result.resultText.includes('b.txt'),
        `expected both files in list output, got ${JSON.stringify(result.resultText)}`,
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('refuses mutating tools with a denial resultText (read-only contract)', async () => {
    // Even though the Explorer kernel is "read-only", it still routes
    // the optional `mutating` slot from `wrapCliDetectAllToolCalls`
    // through `toolExec` when the model emits one. The executor must
    // reject by returning a polite denial resultText — the kernel
    // surfaces it as a user message in the next round and the model
    // can course-correct. It must NOT touch the file system.
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-explorer-exec-deny-'));
    try {
      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec(
        {
          source: 'cli',
          call: { tool: 'write_file', args: { path: 'should-not-exist.txt', content: 'x' } },
        },
        { round: 1 },
      );

      assert.equal(typeof result.resultText, 'string');
      assert.ok(
        result.resultText.includes('write_file') &&
          result.resultText.toLowerCase().includes('not available'),
        `expected denial mentioning the tool name, got ${JSON.stringify(result.resultText)}`,
      );

      // Denial phrasing must NOT name `delegate_coder` as a fallback:
      // the Explorer model cannot invoke it from inside the kernel
      // (delegation is an RPC initiated by the orchestrator / client,
      // not a tool the Explorer model can emit). Naming it would send
      // the model down a dead-end loop of trying to call it as a tool
      // (Copilot review on PR #284).
      assert.ok(
        !result.resultText.includes('delegate_coder'),
        `denial must not name delegate_coder as a tool; got ${JSON.stringify(result.resultText)}`,
      );

      // The file must not have been created.
      await assert.rejects(
        fs.access(path.join(workspaceRoot, 'should-not-exist.txt')),
        /ENOENT/,
        'Explorer executor wrote a mutation despite the read-only contract',
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns a denial resultText when the call has no tool name', async () => {
    // Defensive: a malformed call that reaches the executor (e.g. a
    // test stubbing the detector wrong) should still get a deterministic
    // denial rather than crashing the delegation.
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-explorer-exec-malformed-'));
    try {
      const entry = { state: { cwd: workspaceRoot, eventSeq: 0 } };
      const abortController = new AbortController();

      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
      });

      const result = await toolExec({ source: 'cli', call: {} }, { round: 1 });

      assert.equal(typeof result.resultText, 'string');
      assert.ok(result.resultText.includes('(unknown)'));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

// ─── Explorer daemon-side tool protocol namespace ──────────────────

// Regression coverage for codex + Copilot P1 on PR #284: the
// `runExplorerAgent` kernel splices `EXPLORER_TOOL_PROTOCOL` from
// `lib/explorer-agent.ts` into its system prompt, which advertises
// web-side public tool names (`read`, `repo_read`, `search`, …) that
// the daemon's `wrapCliDetectAllToolCalls` + `executeToolCall` stack
// doesn't recognize. Without the `sandboxToolProtocol` override, a
// real model follows the prompt, emits web names, and every tool call
// silently fails detection — the delegation spins rounds without
// investigating anything, despite the daemon advertising `multi_agent`.
//
// The fix is a read-only CLI-named tool protocol in `cli/tools.ts`
// (`READ_ONLY_TOOL_PROTOCOL`) that pushd passes as the
// `sandboxToolProtocol` override on both Explorer call sites. These
// tests pin (1) the protocol block and `READ_ONLY_TOOLS` set stay in
// sync, and (2) the lib kernel's builder actually replaces the default
// when the override is passed.
describe('Explorer daemon tool protocol namespace', () => {
  it('READ_ONLY_TOOL_PROTOCOL advertises exactly the tools in READ_ONLY_TOOLS', () => {
    // Parse tool names out of the protocol block. Each read-only tool
    // is documented on a line like `- <name>(<args>) — <desc>`.
    const toolLinePattern = /^- (\w+)\(/gm;
    const advertised = new Set();
    for (const match of READ_ONLY_TOOL_PROTOCOL.matchAll(toolLinePattern)) {
      advertised.add(match[1]);
    }

    // Every advertised tool must exist in the executor's allowlist,
    // otherwise the model will emit a call that the executor refuses.
    for (const name of advertised) {
      assert.ok(
        READ_ONLY_TOOLS.has(name),
        `READ_ONLY_TOOL_PROTOCOL advertises "${name}" but READ_ONLY_TOOLS does not contain it`,
      );
    }

    // Every entry in READ_ONLY_TOOLS must be advertised in the
    // protocol, otherwise the model won't know it's available. If
    // this ever fails because a new read-only tool landed in
    // `cli/tools.ts`, add a bullet to `READ_ONLY_TOOL_PROTOCOL`.
    for (const name of READ_ONLY_TOOLS) {
      assert.ok(
        advertised.has(name),
        `READ_ONLY_TOOLS contains "${name}" but READ_ONLY_TOOL_PROTOCOL does not document it`,
      );
    }
  });

  it('buildExplorerSystemPrompt default path still advertises web-side public tool names', () => {
    // Web-shim contract: when the daemon-specific override is NOT
    // passed, the kernel must fall through to the built-in
    // `EXPLORER_TOOL_PROTOCOL` block that documents web public names
    // (`repo_read`, `read`, etc.). This test guards against a
    // regression where someone changes the default to CLI names and
    // silently breaks the web shim.
    const prompt = buildExplorerSystemPrompt('');
    assert.ok(
      prompt.includes('repo_read'),
      'default prompt should contain web public name repo_read',
    );
    assert.ok(prompt.includes('You may use only these read-only tools'));
  });

  it('buildExplorerSystemPrompt override path swaps in the daemon tool protocol', () => {
    // Daemon contract: when `sandboxToolProtocol` is passed, the
    // kernel must replace the default `EXPLORER_TOOL_PROTOCOL` block
    // entirely with the caller's CLI-named protocol. Web public names
    // from the default block must NOT leak into the final system
    // prompt, and the CLI tool names must be present verbatim so the
    // daemon detector can match them.
    const prompt = buildExplorerSystemPrompt('', READ_ONLY_TOOL_PROTOCOL);

    // CLI names the daemon's detector + executor + READ_ONLY_TOOLS
    // actually recognize must be present.
    assert.ok(prompt.includes('read_file'), 'override prompt must contain CLI name read_file');
    assert.ok(prompt.includes('list_dir'), 'override prompt must contain CLI name list_dir');
    assert.ok(
      prompt.includes('search_files'),
      'override prompt must contain CLI name search_files',
    );

    // The default block's distinctive phrasing must NOT survive. This
    // is the narrow assertion that makes the override meaningful —
    // presence of the CLI names alone wouldn't prove we replaced the
    // default (both blocks could coexist in the system prompt).
    assert.ok(
      !prompt.includes('You may use only these read-only tools'),
      'override must replace the default EXPLORER_TOOL_PROTOCOL block, not append to it',
    );

    // Web public names from the default sandbox listing must not
    // leak through when the override is active. We target the most
    // ambiguous name — `repo_read` — which appears in the default
    // `EXPLORER_TOOL_PROTOCOL` via `EXPLORER_GITHUB_TOOL_NAMES` but
    // has no corresponding CLI tool.
    assert.ok(
      !prompt.includes('repo_read'),
      'override prompt must not leak default-block web public name repo_read',
    );
  });
});

describe('delegate_reviewer', () => {
  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('delegate_reviewer', { diff: MINIMAL_REVIEWER_DIFF }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.ok(response.error.message.includes('sessionId'));
  });

  it('rejects missing diff', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-reviewer-nodiff-'));
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
        makeRequest('delegate_reviewer', { sessionId, attachToken }, sessionId),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'INVALID_REQUEST');
      assert.ok(response.error.message.includes('diff'));
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid attach token', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-reviewer-badtok-'));
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
          'delegate_reviewer',
          { sessionId, attachToken: 'att_wrong', diff: MINIMAL_REVIEWER_DIFF },
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
        'delegate_reviewer',
        { sessionId: 'sess_abc123_def456', diff: MINIMAL_REVIEWER_DIFF },
        'sess_abc123_def456',
      ),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  });

  it('rejects stale reviewer role routing with an unknown provider before acking', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-reviewer-stale-'));
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
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      entry.state.roleRouting = {
        reviewer: {
          provider: 'google',
          model: 'stale-model',
        },
      };

      const response = await handleRequest(
        makeRequest(
          'delegate_reviewer',
          { sessionId, attachToken, diff: MINIMAL_REVIEWER_DIFF },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'PROVIDER_NOT_CONFIGURED');
      assert.ok(response.error.message.includes('google'));
      assert.equal(entry.activeDelegations?.size ?? 0, 0);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs the lib kernel end-to-end and persists a ReviewResult with comments', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-reviewer-happy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // Reviewer parser requires valid JSON (optionally in a ```json fence).
    // Concatenating these tokens yields a parseable ReviewResult with one
    // comment targeting the single added line in MINIMAL_REVIEWER_DIFF.
    const MOCK_REVIEWER_TOKENS = [
      '{"summary": "MOCK_REVIEWER_SUMMARY: diff introduces a single added line.",',
      ' "comments": [',
      '{"file": "src/a.ts", "line": 3, "severity": "warning",',
      ' "comment": "MOCK_REVIEWER_COMMENT: consider a null check here"}',
      ']}',
    ];
    const mock = await startMockProviderServer({ tokens: MOCK_REVIEWER_TOKENS });
    const restoreConfig = patchProviderConfig('ollama', {
      url: mock.url,
      apiKey: 'test-mock-key',
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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const response = await handleRequest(
        makeRequest(
          'delegate_reviewer',
          { sessionId, attachToken, diff: MINIMAL_REVIEWER_DIFF },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);
      assert.ok(response.payload.subagentId);
      assert.ok(response.payload.subagentId.startsWith('sub_reviewer_'));
      assert.ok(response.payload.childRunId);
      assert.ok(response.payload.childRunId.startsWith('run_'));

      const { subagentId, childRunId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      assert.ok(entry.activeDelegations);

      await waitForDelegationComplete(entry, subagentId, sessionId);
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
      assert.equal(started.payload.agent, 'reviewer');
      assert.equal(started.payload.role, 'reviewer');
      assert.equal(completed.runId, childRunId);
      assert.equal(completed.payload.agent, 'reviewer');
      assert.equal(completed.payload.role, 'reviewer');

      const reviewResult = completed.payload.reviewResult;
      assert.ok(reviewResult, 'expected reviewResult payload on subagent.completed');
      assert.ok(reviewResult.summary.includes('MOCK_REVIEWER_SUMMARY'));
      assert.ok(Array.isArray(reviewResult.comments));
      assert.equal(reviewResult.comments.length, 1);
      assert.equal(reviewResult.comments[0].file, 'src/a.ts');
      assert.equal(reviewResult.comments[0].severity, 'warning');
      assert.ok(reviewResult.comments[0].comment.includes('MOCK_REVIEWER_COMMENT'));
      assert.equal(typeof reviewResult.filesReviewed, 'number');
      assert.equal(typeof reviewResult.totalFiles, 'number');
      assert.equal(typeof reviewResult.truncated, 'boolean');
      assert.equal(reviewResult.provider, 'ollama');

      const loaded = await loadSessionState(sessionId);
      assert.ok(Array.isArray(loaded.reviewOutcomes));
      const record = loaded.reviewOutcomes.find((r) => r.subagentId === subagentId);
      assert.ok(record, 'expected reviewOutcome record in session state');
      assert.ok(record.result.summary.includes('MOCK_REVIEWER_SUMMARY'));
      assert.equal(record.result.comments.length, 1);

      const broadcastCompleted = broadcasted.find(
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
      );
      assert.ok(broadcastCompleted, 'expected subagent.completed broadcast');
      assert.ok(broadcastCompleted.payload.reviewResult);
    } finally {
      restoreConfig();
      await mock.stop();
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
        makeRequest(
          'attach_session',
          { sessionId, attachToken, capabilities: ['event_v2'] },
          sessionId,
        ),
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

// ─── collectOrphanedDelegations / DELEGATION_INTERRUPTED ─────────

describe('collectOrphanedDelegations', () => {
  const runId = 'run_parent_abc';

  it('returns empty lists when no delegations ever ran', () => {
    const orphans = collectOrphanedDelegations([], runId);
    assert.deepEqual(orphans, { subagents: [], graphs: [] });
  });

  it('ignores subagents whose parentRunId does not match', () => {
    const events = [
      {
        type: 'subagent.started',
        runId: 'run_child_1',
        payload: { subagentId: 'sub_1', agent: 'explorer', parentRunId: 'run_other' },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.subagents.length, 0);
  });

  it('reports an unterminated subagent as orphaned', () => {
    const events = [
      {
        type: 'subagent.started',
        runId: 'run_child_1',
        payload: { subagentId: 'sub_1', agent: 'explorer', parentRunId: runId },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.subagents.length, 1);
    assert.equal(orphans.subagents[0].subagentId, 'sub_1');
    assert.equal(orphans.subagents[0].agent, 'explorer');
  });

  it('does not report a subagent that completed', () => {
    const events = [
      {
        type: 'subagent.started',
        runId: 'run_child_1',
        payload: { subagentId: 'sub_1', agent: 'explorer', parentRunId: runId },
      },
      {
        type: 'subagent.completed',
        runId: 'run_child_1',
        payload: { subagentId: 'sub_1', agent: 'explorer' },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.subagents.length, 0);
  });

  it('does not report a subagent that failed', () => {
    const events = [
      {
        type: 'subagent.started',
        runId: 'run_child_1',
        payload: { subagentId: 'sub_1', agent: 'explorer', parentRunId: runId },
      },
      {
        type: 'subagent.failed',
        runId: 'run_child_1',
        payload: { subagentId: 'sub_1', agent: 'explorer', error: 'boom' },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.subagents.length, 0);
  });

  it('reports an unfinished task graph as orphaned', () => {
    const events = [
      {
        type: 'task_graph.task_started',
        runId,
        payload: { executionId: 'graph_1', taskId: 'a', agent: 'explorer' },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.graphs.length, 1);
    assert.equal(orphans.graphs[0].executionId, 'graph_1');
  });

  it('does not report a task graph that emitted graph_completed', () => {
    const events = [
      {
        type: 'task_graph.task_started',
        runId,
        payload: { executionId: 'graph_1', taskId: 'a', agent: 'explorer' },
      },
      {
        type: 'task_graph.graph_completed',
        runId,
        payload: { executionId: 'graph_1', success: true },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.graphs.length, 0);
  });

  it('ignores task graphs bound to a different parent runId', () => {
    const events = [
      {
        type: 'task_graph.task_started',
        runId: 'run_other',
        payload: { executionId: 'graph_other', taskId: 'a', agent: 'explorer' },
      },
    ];
    const orphans = collectOrphanedDelegations(events, runId);
    assert.equal(orphans.graphs.length, 0);
  });
});

describe('formatDelegationInterruptedNote', () => {
  it('returns null when nothing is orphaned', () => {
    assert.equal(formatDelegationInterruptedNote({ subagents: [], graphs: [] }), null);
  });

  it('lists orphaned subagents', () => {
    const note = formatDelegationInterruptedNote({
      subagents: [{ subagentId: 'sub_1', agent: 'explorer' }],
      graphs: [],
    });
    assert.ok(note);
    assert.ok(note.includes('[DELEGATION_INTERRUPTED]'));
    assert.ok(note.includes('explorer (sub_1)'));
    assert.ok(note.includes('[/DELEGATION_INTERRUPTED]'));
  });

  it('lists orphaned task graphs', () => {
    const note = formatDelegationInterruptedNote({
      subagents: [],
      graphs: [{ executionId: 'graph_1' }],
    });
    assert.ok(note);
    assert.ok(note.includes('Unfinished task graphs'));
    assert.ok(note.includes('graph_1'));
  });

  it('lists both subagents and graphs when both are orphaned', () => {
    const note = formatDelegationInterruptedNote({
      subagents: [{ subagentId: 'sub_1', agent: 'coder' }],
      graphs: [{ executionId: 'graph_1' }],
    });
    assert.ok(note);
    assert.ok(note.includes('coder (sub_1)'));
    assert.ok(note.includes('graph_1'));
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

// ─── attachToken persistence across daemon-restart / disk-load ────

// Before this fix, every handler that lazy-loaded a session from disk
// minted a fresh in-memory attachToken and then immediately validated
// the caller's ORIGINAL token against it — so any client that had
// successfully called start_session lost the ability to use that session
// as soon as it was evicted from `activeSessions` (including after a
// daemon crash + restart). The fix persists `attachToken` on the session
// state and restores it on disk-load; legacy sessions without a
// persisted token fall through `validateAttachToken`'s bypass.
describe('attach token persistence', () => {
  it('start_session persists attachToken to the session state file', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-persist-'));
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
      assert.ok(typeof attachToken === 'string' && attachToken.length > 0);

      const persisted = await loadSessionState(sessionId);
      assert.equal(persisted.attachToken, attachToken);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('lazy disk-load restores the original attachToken (daemon-restart path)', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-reload-'));
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

      // Simulate daemon restart: evict the in-memory entry so the next
      // handler call has to lazy-load session state from disk.
      const evicted = __evictActiveSessionForTesting(sessionId);
      assert.equal(evicted, true);
      assert.equal(__getActiveSessionForTesting(sessionId), null);

      // configure_role_routing is a cheap handler that exercises the
      // disk-load + validateAttachToken path without needing a mock
      // provider. The client presents its ORIGINAL attachToken, which
      // must still be accepted after the reload.
      const response = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken,
            routing: { explorer: { provider: 'ollama' } },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, true, `expected success, got ${JSON.stringify(response.error)}`);

      const reloaded = __getActiveSessionForTesting(sessionId);
      assert.ok(reloaded, 'handler should have lazy-loaded the session');
      assert.equal(
        reloaded.attachToken,
        attachToken,
        'restored in-memory attachToken must equal the original',
      );
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects a wrong attachToken after disk-load', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-wrong-'));
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
      __evictActiveSessionForTesting(sessionId);

      const response = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            attachToken: 'att_wrong',
            routing: { explorer: { provider: 'ollama' } },
          },
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

  it('legacy session without persisted attachToken falls through the bypass', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-legacy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      // Create a session the normal way, then manually strip the
      // attachToken field from its persisted state to simulate a session
      // created before this field existed.
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      const { sessionId } = start.payload;
      __evictActiveSessionForTesting(sessionId);

      const raw = await loadSessionState(sessionId);
      delete raw.attachToken;
      await saveSessionState(raw);

      // With no persisted token, the disk-load path leaves
      // entry.attachToken undefined, and validateAttachToken's bypass
      // accepts any caller-provided token (including empty/missing).
      const response = await handleRequest(
        makeRequest(
          'configure_role_routing',
          {
            sessionId,
            routing: { explorer: { provider: 'ollama' } },
          },
          sessionId,
        ),
        () => {},
      );
      assert.equal(
        response.ok,
        true,
        `expected legacy bypass success, got ${JSON.stringify(response.error)}`,
      );

      const reloaded = __getActiveSessionForTesting(sessionId);
      assert.ok(reloaded);
      assert.equal(reloaded.attachToken, undefined);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('applies the same persistence across every disk-load handler', async () => {
    // Guard that future handlers added to the family stay consistent.
    // This test loads the source of pushd.ts and asserts that nobody
    // reintroduces the old `attachToken: makeAttachToken()` pattern on a
    // disk-load path — anyone tempted to copy it will fail this test.
    const content = await fs.readFile(path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8');
    const offenders = content
      .split('\n')
      .map((line, idx) => ({ line, n: idx + 1 }))
      .filter(({ line }) => /attachToken:\s*makeAttachToken\(\)/.test(line));
    assert.equal(
      offenders.length,
      0,
      `Found ${offenders.length} disk-load site(s) still minting fresh attach tokens: ` +
        offenders.map((o) => `L${o.n}: ${o.line.trim()}`).join(' | '),
    );
  });
});

// ─── attach_session resume from lastSeenSeq ──────────────────────

// Exercises the daemon-side replay semantics that `push attach` relies on
// to recover after a disconnect: when the client re-sends `attach_session`
// with the highest `seq` it has already processed, the handler must replay
// ONLY the events it missed — never the full log from seq 0, and never the
// empty set when events have landed since the drop.
describe('attach_session resume from lastSeenSeq', () => {
  // Append `count` synthetic events while a session is live in
  // `activeSessions`. Mutates the SAME state object the handler sees so
  // `entry.state.eventSeq` advances in lockstep with the on-disk event
  // log — without that, `handleAttachSession` caps replay at the stale
  // in-memory tip and misses everything we just seeded.
  async function seedSessionWithEvents(sessionId, count) {
    const entry = __getActiveSessionForTesting(sessionId);
    assert.ok(entry, `seedSessionWithEvents: session ${sessionId} not active`);
    for (let i = 0; i < count; i += 1) {
      await appendSessionEvent(entry.state, 'status', { phase: 'test', n: i + 1 }, 'run_seed');
    }
    await saveSessionState(entry.state);
  }

  it('replays exactly the missed events when lastSeenSeq is set (live session)', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-resume-'));
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

      // Seed the event log with 5 status events (seqs 2–6 after the
      // session_started event at seq 1).
      await seedSessionWithEvents(sessionId, 5);

      // First attach from seq 0 — should replay every event including the
      // session_started one.
      const firstEvents = [];
      const firstAttach = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken, lastSeenSeq: 0 }, sessionId),
        (event) => firstEvents.push(event),
      );
      assert.equal(firstAttach.ok, true);
      assert.equal(firstAttach.payload.replay.fromSeq, 1);
      assert.equal(firstEvents.length, 6);
      const highestSeq = firstEvents[firstEvents.length - 1].seq;
      assert.equal(highestSeq, 6);

      // Simulate a flaky client: the session is still live (daemon never
      // restarted), but the client is recovering from a socket drop. Seed
      // 3 more events on the same active session, then re-attach with the
      // highest seq we observed earlier. The handler must replay ONLY the
      // three new events, not the six we already saw.
      await seedSessionWithEvents(sessionId, 3);

      const resumeEvents = [];
      const resume = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId, attachToken, lastSeenSeq: highestSeq },
          sessionId,
        ),
        (event) => resumeEvents.push(event),
      );
      assert.equal(resume.ok, true, `resume attach failed: ${JSON.stringify(resume.error)}`);
      assert.equal(resume.payload.replay.fromSeq, highestSeq + 1);
      assert.equal(resume.payload.replay.toSeq, 9);
      assert.equal(resumeEvents.length, 3);
      assert.deepEqual(
        resumeEvents.map((e) => e.seq),
        [7, 8, 9],
      );
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty replay when lastSeenSeq is already at the tip', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-caught-up-'));
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
      const tip = state.eventSeq;

      const events = [];
      const response = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken, lastSeenSeq: tip }, sessionId),
        (event) => events.push(event),
      );
      assert.equal(response.ok, true);
      assert.equal(events.length, 0);
      assert.equal(response.payload.replay.fromSeq, tip + 1);
      assert.equal(response.payload.replay.toSeq, tip);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('handles a disk-reload resume after daemon-restart eviction', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-restart-'));
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

      // Seed events while the session is live (session_started at seq 1
      // plus four status events at seqs 2–5), THEN evict the in-memory
      // entry. This is the full "daemon restart" path: events are durable
      // on disk, clients still hold their original token, and the next
      // attach_session has to re-load state and replay the tail of the
      // log from whatever seq the client last observed.
      await seedSessionWithEvents(sessionId, 4);
      __evictActiveSessionForTesting(sessionId);
      assert.equal(__getActiveSessionForTesting(sessionId), null);

      const resumeEvents = [];
      const resume = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken, lastSeenSeq: 2 }, sessionId),
        (event) => resumeEvents.push(event),
      );
      assert.equal(resume.ok, true, `resume failed: ${JSON.stringify(resume.error)}`);
      // session_started at seq 1, 4 seeded events at seqs 2–5. Starting
      // from lastSeenSeq=2 means we expect seqs 3, 4, 5 replayed.
      assert.deepEqual(
        resumeEvents.map((e) => e.seq),
        [3, 4, 5],
      );
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── Protocol strict mode wiring ─────────────────────────────────

// End-to-end guard that `broadcastEvent` actually runs the schema
// validator when `PUSH_PROTOCOL_STRICT=1` is set. The dedicated
// `cli/tests/protocol-schema.test.mjs` suite covers the validator
// functions in isolation; this block proves the wiring inside
// pushd.ts catches bad events before they reach attached clients.
describe('broadcastEvent strict-mode schema enforcement', () => {
  const SESSION_ID = 'sess_strict_abcdef';

  it('throws when a malformed event is broadcast under strict mode', () => {
    // Confirm we're actually running under strict mode (the top-of-file
    // `process.env.PUSH_PROTOCOL_STRICT = '1'` should have taken effect).
    assert.equal(process.env.PUSH_PROTOCOL_STRICT, '1');

    // A malformed event mirroring the PR #276 review regression: `runId`
    // serialised as `null` instead of omitted. No client listener needs
    // to be attached — the strict check runs before the fan-out loop.
    const bogus = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: SESSION_ID,
      runId: null,
      seq: 42,
      ts: Date.now(),
      type: 'subagent.started',
      payload: { executionId: 'sub_1', agent: 'explorer' },
    };
    assert.throws(
      () => broadcastEvent(SESSION_ID, bogus),
      /Protocol schema violation.*subagent\.started/s,
    );
  });

  it('throws when a delegation payload is missing a required field', () => {
    const bogus = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: SESSION_ID,
      seq: 7,
      ts: Date.now(),
      type: 'task_graph.task_failed',
      payload: {
        executionId: 'graph_1',
        taskId: 'a',
        agent: 'coder',
        // `error` missing — required by schema.
      },
    };
    assert.throws(
      () => broadcastEvent(SESSION_ID, bogus),
      /Protocol schema violation.*task_graph\.task_failed.*error/s,
    );
  });

  it('is a no-op when strict mode is disabled', () => {
    // Temporarily unset the env var to prove strict mode is gated on it.
    // No listeners are attached, so broadcastEvent should return silently
    // even for an obviously bad event.
    const prev = process.env.PUSH_PROTOCOL_STRICT;
    delete process.env.PUSH_PROTOCOL_STRICT;
    try {
      assert.doesNotThrow(() =>
        broadcastEvent(SESSION_ID, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId: SESSION_ID,
          runId: null,
          seq: -1,
          ts: Date.now(),
          type: 'subagent.started',
          payload: {},
        }),
      );
    } finally {
      if (prev !== undefined) process.env.PUSH_PROTOCOL_STRICT = prev;
    }
  });

  it('lets a valid event through when strict mode is on (no listeners)', () => {
    // With no clients attached for this sessionId, broadcastEvent
    // should validate then return without emitting. This guards against
    // the validator failing an otherwise-legitimate event shape.
    const ok = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: SESSION_ID,
      seq: 99,
      ts: Date.now(),
      type: 'task_graph.graph_completed',
      payload: {
        executionId: 'graph_1',
        summary: 'done',
        success: true,
        aborted: false,
        nodeCount: 2,
        totalRounds: 3,
        wallTimeMs: 42,
      },
    };
    assert.doesNotThrow(() => broadcastEvent(SESSION_ID, ok));
  });
});

// ─── v1 synthetic downgrade ──────────────────────────────────────

// Exercises Option C from docs/decisions/push-runtime-v2.md: clients
// that don't advertise `event_v2` at attach time receive
// `subagent.*` / `task_graph.*` events synthesized into plain
// `assistant_token` events on the parent runId, prefixed with
// `[Role]`. v2 clients (those that include `event_v2` in
// `attach_session.capabilities`) continue to receive raw envelopes.
describe('v1 synthetic downgrade', () => {
  async function startTestSession() {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-v1-downgrade-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    const start = await handleRequest(
      makeRequest('start_session', {
        provider: 'ollama',
        repo: { rootPath: process.cwd() },
      }),
      () => {},
    );
    assert.equal(start.ok, true);
    const { sessionId, attachToken } = start.payload;
    return {
      sessionId,
      attachToken,
      cleanup: async () => {
        if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
        else process.env.PUSH_SESSION_DIR = originalSessionDir;
        await fs.rm(tmpRoot, { recursive: true, force: true });
      },
    };
  }

  function makeSubagentStarted(sessionId) {
    return {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: 'run_child_downgrade',
      seq: 50,
      ts: Date.now(),
      type: 'subagent.started',
      payload: {
        executionId: 'sub_downgrade_1',
        subagentId: 'sub_downgrade_1',
        parentRunId: 'run_parent_downgrade',
        childRunId: 'run_child_downgrade',
        agent: 'explorer',
        role: 'explorer',
        detail: 'inspect repo layout',
      },
    };
  }

  function makeTaskGraphCompleted(sessionId) {
    return {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: 'run_parent_graph_downgrade',
      seq: 77,
      ts: Date.now(),
      type: 'task_graph.task_completed',
      payload: {
        executionId: 'graph_downgrade_1',
        taskId: 'step-a',
        agent: 'coder',
        summary: 'wrote hello.ts',
        elapsedMs: 42,
      },
    };
  }

  it('v2 client with capabilities: ["event_v2"] sees raw delegation events', async () => {
    const ctx = await startTestSession();
    try {
      const events = [];
      const attach = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken, capabilities: ['event_v2'] },
          ctx.sessionId,
        ),
        (event) => events.push(event),
      );
      assert.equal(attach.ok, true, `attach failed: ${JSON.stringify(attach.error)}`);

      // Drain replay events first; only assert on what `broadcastEvent`
      // pushes from here on out.
      const baseline = events.length;
      broadcastEvent(ctx.sessionId, makeSubagentStarted(ctx.sessionId));

      const newEvents = events.slice(baseline);
      assert.equal(newEvents.length, 1, `v2 client got ${newEvents.length} events, expected 1`);
      assert.equal(newEvents[0].type, 'subagent.started');
      assert.equal(newEvents[0].payload.agent, 'explorer');
      assert.equal(newEvents[0].payload.detail, 'inspect repo layout');
    } finally {
      await ctx.cleanup();
    }
  });

  it('v1 client (no capabilities field) sees assistant_token synthesized from subagent.started', async () => {
    const ctx = await startTestSession();
    try {
      const events = [];
      const attach = await handleRequest(
        // No `capabilities` field at all — that's a stock v1 client.
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken },
          ctx.sessionId,
        ),
        (event) => events.push(event),
      );
      assert.equal(attach.ok, true);

      const baseline = events.length;
      broadcastEvent(ctx.sessionId, makeSubagentStarted(ctx.sessionId));

      const newEvents = events.slice(baseline);
      assert.equal(newEvents.length, 1, 'v1 client should receive exactly one shadow event');
      assert.equal(newEvents[0].type, 'assistant_token');
      // Parent runId attribution per Option C.
      assert.equal(newEvents[0].runId, 'run_parent_downgrade');
      assert.ok(
        newEvents[0].payload.text.startsWith('[Explorer] started:'),
        `unexpected text: ${newEvents[0].payload.text}`,
      );
      // The v1 client MUST NOT see the raw subagent.started envelope.
      assert.equal(
        newEvents.filter((e) => e.type === 'subagent.started').length,
        0,
        'v1 client should not receive raw subagent.started',
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it('v1 client (explicit empty capabilities array) is still treated as v1', async () => {
    const ctx = await startTestSession();
    try {
      const events = [];
      const attach = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken, capabilities: [] },
          ctx.sessionId,
        ),
        (event) => events.push(event),
      );
      assert.equal(attach.ok, true);

      const baseline = events.length;
      broadcastEvent(ctx.sessionId, makeSubagentStarted(ctx.sessionId));

      const newEvents = events.slice(baseline);
      assert.equal(newEvents.length, 1);
      assert.equal(newEvents[0].type, 'assistant_token');
      assert.equal(newEvents[0].runId, 'run_parent_downgrade');
      assert.ok(newEvents[0].payload.text.startsWith('[Explorer] started:'));
    } finally {
      await ctx.cleanup();
    }
  });

  it('mixed fleet: v1 and v2 clients on the same session each get the right stream', async () => {
    const ctx = await startTestSession();
    try {
      const v1Events = [];
      const v2Events = [];
      const v1Attach = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken },
          ctx.sessionId,
        ),
        (event) => v1Events.push(event),
      );
      assert.equal(v1Attach.ok, true);

      const v2Attach = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken, capabilities: ['event_v2'] },
          ctx.sessionId,
        ),
        (event) => v2Events.push(event),
      );
      assert.equal(v2Attach.ok, true);

      const v1Baseline = v1Events.length;
      const v2Baseline = v2Events.length;
      broadcastEvent(ctx.sessionId, makeTaskGraphCompleted(ctx.sessionId));

      const newV1 = v1Events.slice(v1Baseline);
      const newV2 = v2Events.slice(v2Baseline);

      assert.equal(newV1.length, 1);
      assert.equal(newV1[0].type, 'assistant_token');
      assert.equal(newV1[0].runId, 'run_parent_graph_downgrade');
      assert.ok(
        newV1[0].payload.text.startsWith('[TaskGraph] task completed: step-a (coder)'),
        `unexpected v1 text: ${newV1[0].payload.text}`,
      );

      assert.equal(newV2.length, 1);
      assert.equal(newV2[0].type, 'task_graph.task_completed');
      assert.equal(newV2[0].payload.taskId, 'step-a');
      assert.equal(newV2[0].payload.summary, 'wrote hello.ts');
    } finally {
      await ctx.cleanup();
    }
  });

  it('non-delegation events pass through unchanged to both v1 and v2 clients', async () => {
    const ctx = await startTestSession();
    try {
      const v1Events = [];
      const v2Events = [];
      await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken },
          ctx.sessionId,
        ),
        (event) => v1Events.push(event),
      );
      await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken, capabilities: ['event_v2'] },
          ctx.sessionId,
        ),
        (event) => v2Events.push(event),
      );

      const v1Baseline = v1Events.length;
      const v2Baseline = v2Events.length;

      // A plain `assistant_token` event — the shape and type both v1
      // and v2 clients already expect today.
      const passthrough = {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId: ctx.sessionId,
        runId: 'run_parent_passthrough',
        seq: 42,
        ts: Date.now(),
        type: 'assistant_token',
        payload: { text: 'hello from parent' },
      };
      broadcastEvent(ctx.sessionId, passthrough);

      const newV1 = v1Events.slice(v1Baseline);
      const newV2 = v2Events.slice(v2Baseline);
      assert.equal(newV1.length, 1);
      assert.equal(newV2.length, 1);
      // Both clients see the exact same envelope.
      assert.equal(newV1[0].type, 'assistant_token');
      assert.equal(newV2[0].type, 'assistant_token');
      assert.equal(newV1[0].payload.text, 'hello from parent');
      assert.equal(newV2[0].payload.text, 'hello from parent');
    } finally {
      await ctx.cleanup();
    }
  });

  it('hello response advertises event_v2 capability', async () => {
    const response = await handleRequest(makeRequest('hello', { clientName: 'test' }), () => {});
    assert.equal(response.ok, true);
    assert.ok(
      response.payload.capabilities.includes('event_v2'),
      `expected event_v2 in capabilities, got: ${JSON.stringify(response.payload.capabilities)}`,
    );
  });
});
