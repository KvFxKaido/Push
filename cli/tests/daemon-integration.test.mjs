// Must be first: several describe blocks below (e.g. `update_session`) call
// `start_session` in-process with no PUSH_SESSION_DIR scoping of their own,
// relying entirely on this isolation. Without it, running this file directly
// (the single-test shortcut in CLAUDE.md skips the --import flag that
// normally provides it) writes real sessions into ~/.push/sessions — this
// leaked 127 fixture sessions into the real store before being caught.
import './setup-test-home-isolation.mjs';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  getSocketPath,
  getPidPath,
  isNamedPipePath,
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
  emitEventWithDowngrade,
  wrapCliDetectAllToolCalls,
  makeDaemonCoderToolExec,
  makeDaemonExplorerToolExec,
  __getActiveSessionForTesting,
  __evictActiveSessionForTesting,
  __setActiveSessionForTesting,
  __setDelegateExplorerHooksForTesting,
  handleGetSessionMessages,
  resolveOrMintTargetAttachToken,
  __emitWorkspaceStateForTesting,
  __handleConnectionForTesting,
  __setLifecycleExitForTesting,
} from '../pushd.ts';
import {
  PROTOCOL_VERSION,
  createSessionState,
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
import { roleCanUseTool } from '../../lib/capabilities.ts';
import {
  DAEMON_CAPABILITIES,
  TUI_DAEMON_CAPABILITIES,
  ATTACH_CLIENT_CAPABILITIES,
  EVENT_V2,
  TOOL_CARDS_V1,
  WORKSPACE_STATE_V1,
  isDaemonCapability,
} from '../../lib/daemon-capabilities.ts';
import { getToolSpec } from '../../lib/tool-registry.ts';
import { buildExplorerSystemPrompt } from '../../lib/explorer-agent.ts';
import { startMockProviderServer, patchProviderConfig } from './mock-provider-server.mjs';
import { canListenOnLoopback, rmWorkspace } from './test-environment.mjs';

const loopbackAvailable = await canListenOnLoopback();
const needsLoopback = {
  skip: !loopbackAvailable && 'loopback HTTP listeners are unavailable in this sandbox',
};
const execFileAsync = promisify(execFile);

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

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timeout waiting for condition');
}

/**
 * Poll a broadcaster array until an event matching `predicate` arrives, then
 * return it. The persist path (loadSessionEvents) flushes synchronously when
 * delegations complete, but broadcasts dispatch on the next tick — so a bare
 * `broadcasted.find(...)` immediately after `waitForDelegationComplete` is
 * racy under CI load. Callers replace the find+assert.ok pair with a single
 * await.
 */
async function waitForBroadcast(
  broadcasted,
  predicate,
  { timeoutMs = 5000, intervalMs = 25, message = 'expected broadcast event' } = {},
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = broadcasted.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout: ${message}`);
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
      return { ok: false, reason: `daemon transport unavailable in this environment (${code})` };
    }
    throw err;
  } finally {
    try {
      server.close();
    } catch {
      // ignore
    }
    try {
      if (!isNamedPipePath(socketPath)) {
        await fs.unlink(socketPath);
      }
    } catch {
      // ignore
    }
  }
}

function makeTestSocketPath(name) {
  const suffix = randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${name}-${suffix}`;
  }
  return path.join(os.tmpdir(), `${name}-${suffix}.sock`);
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

async function receiveMatching(client, predicate, { timeoutMs = 3000, message = 'message' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const msg = await client.receive(Math.min(remaining, 250)).catch(() => null);
    if (!msg) continue;
    if (predicate(msg)) return msg;
  }
  throw new Error(`timeout waiting for ${message}`);
}

async function createWorkspaceStateGitRepo(prefix = 'push-ws-repo-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  } catch {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'main'], { cwd: root });
  }
  await fs.writeFile(path.join(root, 'README.md'), 'hello\n');
  return root;
}

// ─── Path helpers (existing tests preserved) ──────────────────────

describe('pushd path helpers', () => {
  it('getSocketPath returns default under ~/.push/run/', () => {
    const original = process.env.PUSHD_SOCKET;
    delete process.env.PUSHD_SOCKET;
    const p = getSocketPath();
    if (isNamedPipePath(p)) {
      assert.ok(p.startsWith('\\\\.\\pipe\\pushd-'));
    } else {
      assert.ok(p.includes('.push'));
      assert.ok(p.endsWith('pushd.sock'));
    }
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

describe('handleGetSessionMessages (#687 transcript hydration)', () => {
  const sessionId = 'sess_test_get_messages';

  after(() => {
    __evictActiveSessionForTesting(sessionId);
  });

  it('returns user + assistant pairs, filters system/tool, generates stable IDs', async () => {
    __setActiveSessionForTesting(sessionId, {
      state: {
        attachToken: 'att_test',
        messages: [
          { role: 'system', content: 'you are a helpful assistant' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'tool', content: 'tool_result_payload' },
          { role: 'user', content: 'another question' },
        ],
      },
      attachToken: 'att_test',
    });
    const response = await handleGetSessionMessages({
      requestId: 'req_1',
      payload: { sessionId, attachToken: 'att_test' },
    });
    assert.equal(response.ok, true);
    assert.equal(response.payload.sessionId, sessionId);
    assert.deepEqual(response.payload.messages, [
      { id: `daemon-${sessionId}-1`, role: 'user', content: 'hi' },
      { id: `daemon-${sessionId}-2`, role: 'assistant', content: 'hello' },
      { id: `daemon-${sessionId}-4`, role: 'user', content: 'another question' },
    ]);
  });

  it('rejects missing sessionId with INVALID_REQUEST', async () => {
    const response = await handleGetSessionMessages({
      requestId: 'req_2',
      payload: { attachToken: 'att_test' },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
  });

  it('rejects unknown sessionId with SESSION_NOT_FOUND', async () => {
    const response = await handleGetSessionMessages({
      requestId: 'req_3',
      payload: { sessionId: 'sess_never_existed', attachToken: 'att_any' },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'SESSION_NOT_FOUND');
  });

  it('rejects wrong attach token with INVALID_TOKEN', async () => {
    __setActiveSessionForTesting(sessionId, {
      state: { attachToken: 'att_correct', messages: [{ role: 'user', content: 'hi' }] },
      attachToken: 'att_correct',
    });
    const response = await handleGetSessionMessages({
      requestId: 'req_4',
      payload: { sessionId, attachToken: 'att_wrong' },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_TOKEN');
  });

  it('coerces non-string message content to empty string', async () => {
    __setActiveSessionForTesting(sessionId, {
      state: {
        attachToken: 'att_test',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'multimodal' }] },
          { role: 'assistant', content: 'reply' },
        ],
      },
      attachToken: 'att_test',
    });
    const response = await handleGetSessionMessages({
      requestId: 'req_5',
      payload: { sessionId, attachToken: 'att_test' },
    });
    assert.equal(response.ok, true);
    assert.equal(response.payload.messages[0].content, '');
    assert.equal(response.payload.messages[1].content, 'reply');
  });
});

describe('get_session_snapshot (remote session status packet)', () => {
  let tmpRoot;
  let originalSessionDir;

  before(async () => {
    originalSessionDir = process.env.PUSH_SESSION_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-session-snapshot-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
  });

  after(async () => {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns daemon-owned reconnect state for an active session', async () => {
    const sessionId = makeSessionId();
    const attachToken = 'pushd_test_snapshot_token';
    const state = createSessionState({
      sessionId,
      attachToken,
      provider: 'ollama',
      model: 'llama-test',
      cwd: tmpRoot,
      mode: 'tui',
      messages: [{ role: 'system', content: 'system' }],
    });
    state.roleRouting = { coder: { provider: 'ollama', model: 'coder-test' } };
    await saveSessionState(state);
    await appendSessionEvent(state, 'user_message', { chars: 2, preview: 'hi' }, 'run_parent');
    await appendSessionEvent(
      state,
      'approval_required',
      { approvalId: 'appr_snapshot', title: 'Approve x', options: ['approve', 'deny'] },
      'run_parent',
    );

    __setActiveSessionForTesting(sessionId, {
      state,
      attachToken,
      activeRunId: 'run_parent',
      pendingApproval: {
        approvalId: 'appr_snapshot',
        runId: 'run_parent',
        kind: 'run_shell',
        title: 'Approve run_shell',
        summary: 'rm -rf build/',
      },
    });

    const response = await handleRequest(
      makeRequest('get_session_snapshot', { sessionId, attachToken, recentEventLimit: 1 }),
      () => {},
    );

    assert.equal(response.ok, true);
    assert.equal(response.type, 'get_session_snapshot');
    assert.equal(response.payload.host.daemonVersion, '0.3.0');
    assert.equal(response.payload.host.protocolVersion, PROTOCOL_VERSION);
    assert.equal(typeof response.payload.host.hostname, 'string');
    assert.equal(typeof response.payload.host.startedAtMs, 'number');
    assert.deepEqual(response.payload.repo, { rootPath: tmpRoot, branch: null });
    assert.equal(response.payload.relay.live.running, false);
    assert.equal(response.payload.session.sessionId, sessionId);
    assert.equal(response.payload.session.state, 'running');
    assert.equal(response.payload.session.activeRunId, 'run_parent');
    assert.equal(response.payload.session.provider, 'ollama');
    assert.equal(response.payload.session.model, 'llama-test');
    assert.equal(response.payload.session.mode, 'tui');
    assert.deepEqual(response.payload.session.roleRouting, {
      coder: { provider: 'ollama', model: 'coder-test' },
    });
    assert.equal(response.payload.session.eventSeq, 2);
    assert.equal(response.payload.session.attachTokenPresent, true);
    assert.deepEqual(response.payload.activeRun, {
      runId: 'run_parent',
      type: 'assistant_turn',
      cancellable: true,
    });
    // #746: the snapshot surfaces the approval display context so a reconnect
    // pane matches the live approval_required pane.
    assert.deepEqual(response.payload.pendingApproval, {
      approvalId: 'appr_snapshot',
      runId: 'run_parent',
      kind: 'run_shell',
      title: 'Approve run_shell',
      summary: 'rm -rf build/',
    });
    assert.equal(response.payload.transcript.lastSeq, 2);
    assert.ok(Array.isArray(response.payload.transcript.mirror.rows));
    assert.equal(response.payload.transcript.recentEvents.length, 1);
    assert.equal(response.payload.transcript.recentEvents[0].type, 'approval_required');
  });

  it('capability-gates cards in reconnect events and mirror rows without mutating state', async () => {
    const sessionId = makeSessionId();
    const attachToken = 'pushd_test_snapshot_cards';
    const card = { type: 'ci-status', data: { checks: 3 } };
    const state = createSessionState({
      sessionId,
      attachToken,
      provider: 'ollama',
      model: 'card-test',
      cwd: tmpRoot,
      messages: [{ role: 'system', content: 'system' }],
    });
    await saveSessionState(state);
    await appendSessionEvent(
      state,
      'tool.execution_complete',
      {
        round: 1,
        executionId: 'exec_snapshot_card',
        toolName: 'ci_status',
        durationMs: 12,
        isError: false,
        preview: '3 checks',
        card,
      },
      'run_snapshot_card',
    );
    const transcriptMirror = {
      rows: [
        {
          id: 'tool-snapshot-card',
          kind: 'tool',
          role: 'assistant',
          text: 'ci_status complete',
          toolName: 'ci_status',
          card,
        },
      ],
      liveText: '',
      lastSeq: state.eventSeq,
      nextLocalId: 0,
    };
    __setActiveSessionForTesting(sessionId, { state, attachToken, transcriptMirror });

    const legacy = await handleRequest(
      makeRequest('get_session_snapshot', { sessionId, attachToken }),
      () => {},
    );
    const capable = await handleRequest(
      makeRequest('get_session_snapshot', {
        sessionId,
        attachToken,
        capabilities: [TOOL_CARDS_V1],
      }),
      () => {},
    );

    assert.equal(Object.hasOwn(legacy.payload.transcript.recentEvents[0].payload, 'card'), false);
    assert.equal(Object.hasOwn(legacy.payload.transcript.mirror.rows[0], 'card'), false);
    assert.deepEqual(capable.payload.transcript.recentEvents[0].payload.card, card);
    assert.deepEqual(capable.payload.transcript.mirror.rows[0].card, card);
    assert.deepEqual(transcriptMirror.rows[0].card, card);
  });

  it('reports background delegation/graph work as running even when activeRunId is null', async () => {
    // Codex #743: the orchestrator turn that kicks off a delegation returns
    // (clearing activeRunId) while the sub-agent work is still in flight.
    // handleUpdateSession treats non-empty activeDelegations/activeGraphs as
    // RUN_IN_PROGRESS; the snapshot must agree or a reconnecting client renders
    // the session as idle mid-delegation.
    const sessionId = makeSessionId();
    const attachToken = 'pushd_test_snapshot_bg';
    const state = createSessionState({
      sessionId,
      attachToken,
      provider: 'ollama',
      model: 'bg-test',
      cwd: tmpRoot,
      messages: [{ role: 'system', content: 'system' }],
    });
    await saveSessionState(state);

    __setActiveSessionForTesting(sessionId, {
      state,
      attachToken,
      activeRunId: null,
      activeDelegations: new Map([['sub_a', { kind: 'explorer' }]]),
      activeGraphs: new Map([['graph_a', { executionId: 'graph_a' }]]),
    });

    const response = await handleRequest(
      makeRequest('get_session_snapshot', { sessionId, attachToken }),
      () => {},
    );

    assert.equal(response.ok, true);
    assert.equal(response.payload.session.state, 'running');
    assert.equal(response.payload.session.activeRunId, null);
    // No foreground run descriptor — the in-flight work is background.
    assert.equal(response.payload.activeRun, null);
    assert.deepEqual(response.payload.session.backgroundWork, { delegations: 1, graphs: 1 });
  });

  it('returns null approval display fields when the entry lacks them (pre-#746 back-compat)', async () => {
    const sessionId = makeSessionId();
    const attachToken = 'pushd_test_snapshot_legacy_appr';
    const state = createSessionState({
      sessionId,
      attachToken,
      provider: 'ollama',
      model: 'legacy-test',
      cwd: tmpRoot,
      messages: [{ role: 'system', content: 'system' }],
    });
    await saveSessionState(state);
    // Entry shaped like an older daemon that only tracked approvalId + runId.
    __setActiveSessionForTesting(sessionId, {
      state,
      attachToken,
      activeRunId: 'run_legacy',
      pendingApproval: { approvalId: 'appr_legacy', runId: 'run_legacy' },
    });

    const response = await handleRequest(
      makeRequest('get_session_snapshot', { sessionId, attachToken }),
      () => {},
    );

    assert.equal(response.ok, true);
    assert.deepEqual(response.payload.pendingApproval, {
      approvalId: 'appr_legacy',
      runId: 'run_legacy',
      kind: null,
      title: null,
      summary: null,
    });
  });

  it('lazy-loads persisted sessions and rejects wrong attach tokens', async () => {
    const sessionId = makeSessionId();
    const attachToken = 'pushd_test_snapshot_lazy';
    const state = createSessionState({
      sessionId,
      attachToken,
      provider: 'ollama',
      model: 'lazy-test',
      cwd: tmpRoot,
      messages: [{ role: 'system', content: 'system' }],
    });
    await saveSessionState(state);
    __evictActiveSessionForTesting(sessionId);

    const wrong = await handleRequest(
      makeRequest('get_session_snapshot', { sessionId, attachToken: 'wrong' }),
      () => {},
    );
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.code, 'INVALID_TOKEN');

    const ok = await handleRequest(
      makeRequest('get_session_snapshot', { sessionId, attachToken }),
      () => {},
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.payload.session.state, 'idle');
    assert.equal(ok.payload.activeRun, null);
    assert.equal(ok.payload.pendingApproval, null);
    assert.equal(ok.payload.transcript.lastSeq, 0);
  });
});

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

  it('REJECTS a tokenless entry — the !entry.attachToken bypass is removed (Universal Session Bearer)', () => {
    assert.equal(validateAttachToken({ state: {} }, undefined), false);
    assert.equal(validateAttachToken({ state: {}, attachToken: '' }, 'anything'), false);
    assert.equal(validateAttachToken({ state: {}, attachToken: null }, undefined), false);
  });

  it('allows when entry is null/undefined (no entry = nothing to gate; existence checked separately)', () => {
    assert.equal(validateAttachToken(null, 'token'), true);
    assert.equal(validateAttachToken(undefined, 'token'), true);
  });

  it('honors the explicit openAttach opt-out (per-session flag, on entry or state)', () => {
    assert.equal(validateAttachToken({ state: {}, openAttach: true }, undefined), true);
    assert.equal(validateAttachToken({ state: { openAttach: true } }, undefined), true);
    // A tokened session can still be force-opened by the flag.
    assert.equal(
      validateAttachToken({ state: {}, attachToken: 'att_x', openAttach: true }, ''),
      true,
    );
  });

  it('honors the process-wide PUSHD_OPEN_ATTACH=1 opt-out', () => {
    const original = process.env.PUSHD_OPEN_ATTACH;
    process.env.PUSHD_OPEN_ATTACH = '1';
    try {
      assert.equal(validateAttachToken({ state: {}, attachToken: 'att_x' }, undefined), true);
      assert.equal(validateAttachToken({ state: {} }, undefined), true);
    } finally {
      if (original === undefined) delete process.env.PUSHD_OPEN_ATTACH;
      else process.env.PUSHD_OPEN_ATTACH = original;
    }
  });

  it('emits open_attach_used once per entry with precise source attribution', () => {
    const originalEnv = process.env.PUSHD_OPEN_ATTACH;
    const originalWrite = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      // session-only (env off): two calls on the SAME entry → one log (deduped).
      delete process.env.PUSHD_OPEN_ATTACH;
      const sessionEntry = { state: { sessionId: 's_sess' }, openAttach: true };
      validateAttachToken(sessionEntry, undefined);
      validateAttachToken(sessionEntry, undefined);
      // env-only: a tokened entry forced open purely by the env flag.
      process.env.PUSHD_OPEN_ATTACH = '1';
      validateAttachToken({ state: { sessionId: 's_env' }, attachToken: 'att_x' }, undefined);
      // both: per-session flag AND env set → combined attribution.
      validateAttachToken({ state: { sessionId: 's_both' }, openAttach: true }, undefined);
    } finally {
      process.stderr.write = originalWrite;
      if (originalEnv === undefined) delete process.env.PUSHD_OPEN_ATTACH;
      else process.env.PUSHD_OPEN_ATTACH = originalEnv;
    }
    const events = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.event === 'open_attach_used');
    const bySession = Object.fromEntries(events.map((e) => [e.sessionId, e]));
    // Deduped to one per entry.
    assert.equal(events.filter((e) => e.sessionId === 's_sess').length, 1);
    assert.equal(bySession.s_sess.level, 'warn');
    assert.equal(bySession.s_sess.source, 'session');
    assert.equal(bySession.s_env.source, 'env');
    assert.equal(bySession.s_both.source, 'session+env');
  });
});

// ─── resolveOrMintTargetAttachToken (remote-pair tokenless fix) ──

describe('resolveOrMintTargetAttachToken', () => {
  it('returns the existing token without minting when the session has one', () => {
    const entry = {
      state: { sessionId: 's1', attachToken: 'att_existing' },
      attachToken: 'att_existing',
    };
    const result = resolveOrMintTargetAttachToken(entry);
    assert.equal(result.token, 'att_existing');
    assert.equal(result.minted, false);
    // Untouched.
    assert.equal(entry.attachToken, 'att_existing');
    assert.equal(entry.state.attachToken, 'att_existing');
  });

  it('mints and pins a token for a tokenless session (the TUI/session-store case)', () => {
    const entry = { state: { sessionId: 's2' } };
    const result = resolveOrMintTargetAttachToken(entry);
    assert.equal(result.minted, true);
    assert.equal(typeof result.token, 'string');
    assert.ok(result.token.length > 0);
    // Pinned both in-memory (entry) and on the state object the caller persists.
    assert.equal(entry.attachToken, result.token);
    assert.equal(entry.state.attachToken, result.token);
  });

  it('treats empty-string / null attach tokens as tokenless and mints', () => {
    for (const empty of ['', null, undefined]) {
      const entry = { state: { sessionId: 's3' }, attachToken: empty };
      const result = resolveOrMintTargetAttachToken(entry);
      assert.equal(result.minted, true);
      assert.equal(entry.attachToken, result.token);
    }
  });

  it('mints even when state is absent, without throwing (token still pinned on entry)', () => {
    const entry = {};
    const result = resolveOrMintTargetAttachToken(entry);
    assert.equal(result.minted, true);
    assert.equal(entry.attachToken, result.token);
  });

  it('throws loudly on a missing/non-object entry instead of a cryptic assignment error', () => {
    assert.throws(() => resolveOrMintTargetAttachToken(null), /requires a session entry/);
    assert.throws(() => resolveOrMintTargetAttachToken(undefined), /requires a session entry/);
    assert.throws(() => resolveOrMintTargetAttachToken('nope'), /requires a session entry/);
  });

  it('logs the attach_token_minted_unexpectedly tripwire on the mint branch, silent on resolve', () => {
    // Under Universal Session Bearer the mint branch is a tripwire: reaching it
    // means a creation path slipped past the factory. Capture stderr to assert
    // the warn fires exactly once (mint), never on the resolve (tokened) path.
    const original = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      // Resolve branch (tokened): no tripwire.
      resolveOrMintTargetAttachToken({
        state: { sessionId: 's_ok', attachToken: 'att_ok' },
        attachToken: 'att_ok',
      });
      // Mint branch (tokenless): tripwire fires.
      resolveOrMintTargetAttachToken({ state: { sessionId: 's_trip' } });
    } finally {
      process.stderr.write = original;
    }
    const tripwires = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.event === 'attach_token_minted_unexpectedly');
    assert.equal(tripwires.length, 1, 'tripwire must fire exactly once (mint branch only)');
    assert.equal(tripwires[0].level, 'warn');
    assert.equal(tripwires[0].sessionId, 's_trip');
  });
});

// ─── cancel_run bearer gate (Addressable Session Verbs phase 2) ──
//
// Closes the auth gap the Universal Session Bearer sweep missed: the
// session-ful cancel_run path aborted a run from sessionId alone with no
// validateAttachToken. The gate sits AFTER the existence check so a cancel
// for a session the daemon doesn't have still returns SESSION_NOT_FOUND (the
// benign loopback best-effort path), and BEFORE the run-state check so an
// unauthenticated caller can't probe run state.
describe('cancel_run bearer gate', () => {
  const sessionId = 'sess_cancelgate_aabbcc';
  after(() => __evictActiveSessionForTesting(sessionId));

  // Seed a live session with an active run and a fake abort controller.
  function seedActiveRun(token) {
    let aborted = false;
    __setActiveSessionForTesting(sessionId, {
      state: { sessionId, attachToken: token },
      attachToken: token,
      activeRunId: 'run_cancelgate',
      abortController: {
        abort: () => {
          aborted = true;
        },
      },
    });
    return () => aborted;
  }

  it('rejects a session-ful cancel with NO token (gap closed)', async () => {
    seedActiveRun('att_cancelgate');
    const res = await handleRequest(makeRequest('cancel_run', { sessionId }), () => {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('rejects a wrong token', async () => {
    seedActiveRun('att_cancelgate');
    const res = await handleRequest(
      makeRequest('cancel_run', { sessionId, attachToken: 'att_wrong' }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('accepts the correct token and aborts the run', async () => {
    const wasAborted = seedActiveRun('att_cancelgate');
    const res = await handleRequest(
      makeRequest('cancel_run', { sessionId, attachToken: 'att_cancelgate' }),
      () => {},
    );
    assert.equal(res.ok, true, `expected accept, got ${JSON.stringify(res.error)}`);
    assert.equal(wasAborted(), true, 'the run controller should have been aborted');
  });

  it('checks auth BEFORE run-state — no NO_ACTIVE_RUN leak to an unauthenticated caller', async () => {
    // Entry with NO activeRunId: a tokenless cancel must still see
    // INVALID_TOKEN, not NO_ACTIVE_RUN (which would leak run state).
    __setActiveSessionForTesting(sessionId, {
      state: { sessionId, attachToken: 'att_cancelgate' },
      attachToken: 'att_cancelgate',
    });
    const res = await handleRequest(makeRequest('cancel_run', { sessionId }), () => {});
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('unknown session still returns SESSION_NOT_FOUND (gate after existence; loopback benign path unchanged)', async () => {
    const res = await handleRequest(
      makeRequest('cancel_run', { sessionId: 'sess_cancelgone_ddeeff', attachToken: 'whatever' }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'SESSION_NOT_FOUND');
  });
});

// ─── submit_approval bearer gate (Addressable Session Verbs follow-up) ──
//
// Closes the auth gap the cancel_run fix (#723) left open: handleSubmitApproval
// resolved a paused tool call from sessionId + approvalId alone with no
// validateAttachToken. Same shape as the cancel_run gate — AFTER the existence
// check (unknown session → SESSION_NOT_FOUND, the benign loopback path) and
// BEFORE the pending-approval lookup (a stolen approvalId can't even probe
// whether one is outstanding).
describe('submit_approval bearer gate', () => {
  let originalSessionDir;
  let tmpRoot;
  const sessionId = 'sess_apvgate_aabbcc';
  before(async () => {
    originalSessionDir = process.env.PUSH_SESSION_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-apvgate-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
  });
  after(async () => {
    __evictActiveSessionForTesting(sessionId);
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // Seed a live session carrying a pending approval. The resolve spy lets the
  // accept test prove the paused call was actually released; the timer is
  // unref'd so a rejection path that never clears it can't keep the process
  // alive.
  function seedPendingApproval(token) {
    let resolvedWith = null;
    const timer = setTimeout(() => {}, 60_000);
    timer.unref?.();
    __setActiveSessionForTesting(sessionId, {
      state: { sessionId, attachToken: token, eventSeq: 0, updatedAt: 0 },
      attachToken: token,
      activeRunId: 'run_apvgate',
      pendingApproval: {
        approvalId: 'apv_gate',
        runId: 'run_apvgate',
        timer,
        resolve: (decision) => {
          resolvedWith = decision;
        },
      },
    });
    return () => resolvedWith;
  }

  it('rejects a tokenless approval decision (gap closed)', async () => {
    seedPendingApproval('att_apvgate');
    const res = await handleRequest(
      makeRequest('submit_approval', { sessionId, approvalId: 'apv_gate', decision: 'approve' }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('rejects a wrong token', async () => {
    seedPendingApproval('att_apvgate');
    const res = await handleRequest(
      makeRequest('submit_approval', {
        sessionId,
        approvalId: 'apv_gate',
        decision: 'approve',
        attachToken: 'att_wrong',
      }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('checks auth BEFORE the approval lookup — no APPROVAL_NOT_FOUND leak', async () => {
    // Session has NO pending approval. A tokenless caller must still see
    // INVALID_TOKEN, not APPROVAL_NOT_FOUND (which would confirm/deny that an
    // approval is outstanding to a client that doesn't hold the bearer).
    __setActiveSessionForTesting(sessionId, {
      state: { sessionId, attachToken: 'att_apvgate', eventSeq: 0, updatedAt: 0 },
      attachToken: 'att_apvgate',
    });
    const res = await handleRequest(
      makeRequest('submit_approval', { sessionId, approvalId: 'apv_gate', decision: 'approve' }),
      () => {},
    );
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('accepts the correct token and resolves the pending approval', async () => {
    const decidedWith = seedPendingApproval('att_apvgate');
    const res = await handleRequest(
      makeRequest('submit_approval', {
        sessionId,
        approvalId: 'apv_gate',
        decision: 'approve',
        attachToken: 'att_apvgate',
      }),
      () => {},
    );
    assert.equal(res.ok, true, `expected accept, got ${JSON.stringify(res.error)}`);
    assert.equal(decidedWith(), 'approve', 'the paused tool call should have been released');
  });

  it('unknown session still returns SESSION_NOT_FOUND (gate after existence)', async () => {
    const res = await handleRequest(
      makeRequest('submit_approval', {
        sessionId: 'sess_apvgone_ddeeff',
        approvalId: 'apv_x',
        decision: 'approve',
        attachToken: 'whatever',
      }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'SESSION_NOT_FOUND');
  });
});

// ─── Addressable child sessions (Addressable Session Verbs phase 3) ──
//
// list_children enumerates a session's delegated runs (active from the
// in-memory map, completed from persisted delegationOutcomes); get_child_session
// returns one as a structured descriptor + event summary, recovering metadata
// for completed children from their subagent.started event. Both are bearer-
// gated reads over the PARENT session's attach token (13th + 14th enforcement
// sites).
describe('addressable child sessions — list_children + get_child_session', () => {
  let originalSessionDir;
  let tmpRoot;
  before(async () => {
    originalSessionDir = process.env.PUSH_SESSION_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-children-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
  });
  after(async () => {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeSession() {
    const start = await handleRequest(
      makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
      () => {},
    );
    return { sessionId: start.payload.sessionId, token: start.payload.attachToken };
  }

  it('list_children rejects a tokenless read (13th enforcement site)', async () => {
    const { sessionId } = await makeSession();
    const res = await handleRequest(makeRequest('list_children', { sessionId }), () => {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('list_children returns active + completed children with a status discriminator', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    entry.activeDelegations = new Map([
      [
        'sub_explorer_aaa',
        {
          role: 'explorer',
          agent: 'explorer',
          parentRunId: 'run_p',
          childRunId: 'run_c1',
          startedAt: 1000,
          task: 'explore the auth flow',
        },
      ],
    ]);
    entry.state.delegationOutcomes = [
      {
        subagentId: 'sub_coder_bbb',
        outcome: {
          agent: 'coder',
          status: 'completed',
          summary: 'did the thing',
          rounds: 3,
          checkpoints: 1,
          elapsedMs: 4200,
        },
      },
    ];
    const res = await handleRequest(
      makeRequest('list_children', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.activeCount, 1);
    assert.equal(res.payload.completedCount, 1);
    const byId = Object.fromEntries(res.payload.children.map((c) => [c.subagentId, c]));
    assert.equal(byId.sub_explorer_aaa.status, 'active');
    assert.equal(byId.sub_explorer_aaa.task, 'explore the auth flow');
    assert.equal(byId.sub_explorer_aaa.childRunId, 'run_c1');
    assert.equal(byId.sub_coder_bbb.status, 'completed');
    assert.equal(byId.sub_coder_bbb.outcomeStatus, 'completed');
    assert.equal(byId.sub_coder_bbb.summary, 'did the thing');
  });

  it('list_children returns empty for a session with no delegations', async () => {
    const { sessionId, token } = await makeSession();
    const res = await handleRequest(
      makeRequest('list_children', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.payload.children, []);
    assert.equal(res.payload.activeCount, 0);
    assert.equal(res.payload.completedCount, 0);
  });

  it('list_children returns SESSION_NOT_FOUND for an unknown session', async () => {
    const res = await handleRequest(
      makeRequest('list_children', { sessionId: 'sess_nochild_aabbcc', attachToken: 'x' }),
      () => {},
    );
    assert.equal(res.error.code, 'SESSION_NOT_FOUND');
  });

  it('list_children dedups a completed child appended more than once (crash/retry)', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    const outcome = {
      agent: 'coder',
      status: 'completed',
      summary: 's',
      rounds: 1,
      checkpoints: 0,
      elapsedMs: 1,
    };
    entry.state.delegationOutcomes = [
      { subagentId: 'sub_coder_dup', outcome },
      { subagentId: 'sub_coder_dup', outcome },
    ];
    const res = await handleRequest(
      makeRequest('list_children', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.completedCount, 1, 'duplicate subagentId must surface once');
    assert.equal(res.payload.children.filter((c) => c.subagentId === 'sub_coder_dup').length, 1);
  });

  it('get_child_session returns an active child descriptor + event summary', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    entry.activeDelegations = new Map([
      [
        'sub_explorer_ccc',
        {
          role: 'explorer',
          agent: 'explorer',
          parentRunId: 'run_p',
          childRunId: 'run_c2',
          startedAt: 2000,
          task: 'trace the bug',
        },
      ],
    ]);
    await appendSessionEvent(
      entry.state,
      'subagent.started',
      {
        subagentId: 'sub_explorer_ccc',
        childRunId: 'run_c2',
        parentRunId: 'run_p',
        detail: 'trace the bug',
        agent: 'explorer',
        role: 'explorer',
      },
      'run_c2',
    );
    await appendSessionEvent(
      entry.state,
      'subagent.completed',
      { subagentId: 'sub_explorer_ccc', childRunId: 'run_c2' },
      'run_c2',
    );
    await saveSessionState(entry.state);

    const res = await handleRequest(
      makeRequest('get_child_session', {
        sessionId,
        attachToken: token,
        subagentId: 'sub_explorer_ccc',
      }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.child.status, 'active');
    assert.equal(res.payload.child.childRunId, 'run_c2');
    assert.equal(res.payload.child.task, 'trace the bug');
    assert.ok(res.payload.eventSummary.eventCount >= 2, 'child events should be summarized');
    assert.equal(typeof res.payload.eventSummary.firstSeq, 'number');
  });

  it('get_child_session recovers metadata for a completed child from its started event', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    // Completed: the outcome record carries no task/childRunId, but the
    // subagent.started event is on disk and the handler recovers from it.
    entry.state.delegationOutcomes = [
      {
        subagentId: 'sub_coder_ddd',
        outcome: {
          agent: 'coder',
          status: 'completed',
          summary: 'implemented X',
          rounds: 2,
          checkpoints: 0,
          elapsedMs: 999,
        },
      },
    ];
    await appendSessionEvent(
      entry.state,
      'subagent.started',
      {
        subagentId: 'sub_coder_ddd',
        childRunId: 'run_c3',
        parentRunId: 'run_p2',
        detail: 'implement X',
        agent: 'coder',
        role: 'coder',
      },
      'run_c3',
    );
    await saveSessionState(entry.state);

    const res = await handleRequest(
      makeRequest('get_child_session', {
        sessionId,
        attachToken: token,
        subagentId: 'sub_coder_ddd',
      }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.child.status, 'completed');
    assert.equal(res.payload.child.summary, 'implemented X');
    // Recovered from the started event:
    assert.equal(res.payload.child.childRunId, 'run_c3');
    assert.equal(res.payload.child.parentRunId, 'run_p2');
    assert.equal(res.payload.child.task, 'implement X');
  });

  it('get_child_session returns CHILD_NOT_FOUND for an unknown subagentId', async () => {
    const { sessionId, token } = await makeSession();
    const res = await handleRequest(
      makeRequest('get_child_session', {
        sessionId,
        attachToken: token,
        subagentId: 'sub_explorer_nope',
      }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'CHILD_NOT_FOUND');
  });

  it('get_child_session rejects a tokenless read (14th enforcement site)', async () => {
    const { sessionId } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    entry.activeDelegations = new Map([
      [
        'sub_explorer_eee',
        { role: 'explorer', agent: 'explorer', childRunId: 'run_c4', startedAt: 3000, task: 't' },
      ],
    ]);
    const res = await handleRequest(
      makeRequest('get_child_session', { sessionId, subagentId: 'sub_explorer_eee' }),
      () => {},
    );
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('get_child_session requires a subagentId', async () => {
    const { sessionId, token } = await makeSession();
    const res = await handleRequest(
      makeRequest('get_child_session', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.error.code, 'INVALID_REQUEST');
  });

  it('get_child_session reconstructs a completed reviewer child from events (event-derived)', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    // Reviewer children emit subagent.* events but persist NO DelegationOutcome
    // (its agent type is only coder|explorer), so they exist only in the log.
    await appendSessionEvent(
      entry.state,
      'subagent.started',
      {
        subagentId: 'sub_reviewer_z',
        childRunId: 'run_rv',
        parentRunId: 'run_pr',
        detail: 'review the diff',
        agent: 'reviewer',
        role: 'reviewer',
      },
      'run_rv',
    );
    await appendSessionEvent(
      entry.state,
      'subagent.completed',
      { subagentId: 'sub_reviewer_z', childRunId: 'run_rv' },
      'run_rv',
    );
    await saveSessionState(entry.state);

    const res = await handleRequest(
      makeRequest('get_child_session', {
        sessionId,
        attachToken: token,
        subagentId: 'sub_reviewer_z',
      }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.child.status, 'completed');
    assert.equal(res.payload.child.source, 'events');
    assert.equal(res.payload.child.terminalType, 'subagent.completed');
    assert.equal(res.payload.child.childRunId, 'run_rv');
    assert.equal(res.payload.child.task, 'review the diff');
    assert.equal(res.payload.child.role, 'reviewer');
  });

  it('list_children omits event-derived children by default, surfaces them on opt-in', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    await appendSessionEvent(
      entry.state,
      'subagent.started',
      {
        subagentId: 'sub_reviewer_w',
        childRunId: 'run_rw',
        parentRunId: 'run_pw',
        detail: 'review',
        agent: 'reviewer',
        role: 'reviewer',
      },
      'run_rw',
    );
    await appendSessionEvent(
      entry.state,
      'subagent.failed',
      { subagentId: 'sub_reviewer_w', childRunId: 'run_rw' },
      'run_rw',
    );
    await saveSessionState(entry.state);

    // Default: cheap, no event scan — the reviewer child is absent.
    const def = await handleRequest(
      makeRequest('list_children', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(def.ok, true);
    assert.equal(def.payload.eventDerivedCount, 0);
    assert.equal(
      def.payload.children.some((c) => c.subagentId === 'sub_reviewer_w'),
      false,
    );

    // Opt-in: the event-derived reviewer child is reconstructed.
    const inc = await handleRequest(
      makeRequest('list_children', { sessionId, attachToken: token, includeEventDerived: true }),
      () => {},
    );
    assert.equal(inc.ok, true);
    assert.equal(inc.payload.eventDerivedCount, 1);
    const rv = inc.payload.children.find((c) => c.subagentId === 'sub_reviewer_w');
    assert.ok(rv, 'event-derived child surfaces on opt-in');
    assert.equal(rv.status, 'completed');
    assert.equal(rv.source, 'events');
    assert.equal(rv.terminalType, 'subagent.failed');
  });

  it('includeEventDerived does NOT surface task-graph executions (no subagentId)', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    // Task-graph events are keyed by executionId and carry NO subagentId — they
    // are a separate concept and must not be reconstructed as children.
    await appendSessionEvent(
      entry.state,
      'task_graph.task_started',
      { executionId: 'exec_graph_1', taskId: 'n1' },
      'run_graph',
    );
    await appendSessionEvent(
      entry.state,
      'task_graph.graph_completed',
      { executionId: 'exec_graph_1' },
      'run_graph',
    );
    await saveSessionState(entry.state);

    const inc = await handleRequest(
      makeRequest('list_children', { sessionId, attachToken: token, includeEventDerived: true }),
      () => {},
    );
    assert.equal(inc.ok, true);
    assert.equal(
      inc.payload.eventDerivedCount,
      0,
      'task-graph executions must not become children',
    );
    assert.equal(
      inc.payload.children.some((c) => c.subagentId === 'exec_graph_1'),
      false,
    );
  });
});

// ─── abort sugar verb (Addressable Session Verbs phase 2b) ──────
//
// `abort` routes by id shape: a subagentId in the payload → cancel_delegation
// (child run); otherwise → cancel_run (parent run). It is registered in
// HANDLERS and re-stamps the response/error `type` to 'abort'. No new auth
// surface — it inherits the bearer gate from both targets.
describe('abort sugar verb', () => {
  let originalSessionDir;
  let tmpRoot;
  before(async () => {
    originalSessionDir = process.env.PUSH_SESSION_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-abort-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
  });
  after(async () => {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeSession() {
    const start = await handleRequest(
      makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
      () => {},
    );
    return { sessionId: start.payload.sessionId, token: start.payload.attachToken };
  }

  it('routes a parent abort to cancel_run, aborts the run, re-stamps type=abort', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    let aborted = false;
    entry.activeRunId = 'run_abort';
    entry.abortController = {
      abort: () => {
        aborted = true;
      },
    };
    const res = await handleRequest(
      makeRequest('abort', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.type, 'abort', 'response type must be re-stamped to abort');
    assert.equal(aborted, true, 'the parent run controller should have been aborted');
  });

  it('inherits the bearer gate on the parent path (tokenless → INVALID_TOKEN, type=abort)', async () => {
    const { sessionId } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    entry.activeRunId = 'run_abort2';
    entry.abortController = { abort: () => {} };
    const res = await handleRequest(makeRequest('abort', { sessionId }), () => {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
    assert.equal(res.type, 'abort');
  });

  it('routes a child abort (subagentId present) to cancel_delegation', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    let childAborted = false;
    entry.activeDelegations = new Map([
      [
        'sub_coder_x',
        {
          role: 'coder',
          agent: 'coder',
          childRunId: 'run_c',
          parentRunId: 'run_p',
          startedAt: 1,
          task: 't',
          abortController: {
            abort: () => {
              childAborted = true;
            },
          },
        },
      ],
    ]);
    const res = await handleRequest(
      makeRequest('abort', { sessionId, attachToken: token, subagentId: 'sub_coder_x' }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.type, 'abort');
    assert.equal(childAborted, true, 'the child delegation should have been aborted');
  });

  it('child abort surfaces DELEGATION_NOT_FOUND for an unknown subagentId (type=abort)', async () => {
    const { sessionId, token } = await makeSession();
    const res = await handleRequest(
      makeRequest('abort', { sessionId, attachToken: token, subagentId: 'sub_nope' }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'DELEGATION_NOT_FOUND');
    assert.equal(res.type, 'abort');
  });

  it('inherits the bearer gate on the child path (tokenless → INVALID_TOKEN)', async () => {
    const { sessionId } = await makeSession();
    const res = await handleRequest(
      makeRequest('abort', { sessionId, subagentId: 'sub_coder_x' }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
    assert.equal(res.type, 'abort');
  });
});

// ─── session_summarize (Addressable Session Verbs phase 4) ──────
//
// On-demand context compaction via the shared `compactContext`, reachable as a
// bearer-gated daemon verb (the 15th enforcement site). Compacts the message
// log, persists it (rewriteMessagesLog), emits context_compacted, and is
// rejected while a run is active.
describe('session_summarize verb', () => {
  let originalSessionDir;
  let tmpRoot;
  before(async () => {
    originalSessionDir = process.env.PUSH_SESSION_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-summarize-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
  });
  after(async () => {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeSession() {
    const start = await handleRequest(
      makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
      () => {},
    );
    return { sessionId: start.payload.sessionId, token: start.payload.attachToken };
  }

  // Seed N real user turns (system + N×[user, assistant]).
  function seedTurns(entry, n) {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < n; i += 1) {
      msgs.push({ role: 'user', content: `user message ${i}` });
      msgs.push({ role: 'assistant', content: `assistant reply ${i}` });
    }
    entry.state.messages = msgs;
  }

  it('rejects a tokenless summarize (15th enforcement site)', async () => {
    const { sessionId } = await makeSession();
    const res = await handleRequest(makeRequest('session_summarize', { sessionId }), () => {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('compacts when turns exceed preserveTurns, persists, and emits context_compacted', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 6);

    const res = await handleRequest(
      makeRequest('session_summarize', { sessionId, attachToken: token, preserveTurns: 2 }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.compacted, true);
    assert.equal(res.payload.preserveTurns, 2);
    assert.equal(res.payload.totalTurns, 6);
    assert.ok(res.payload.compactedCount > 0);

    // Persisted: the on-disk transcript is the compacted one.
    const reloaded = await loadSessionState(sessionId);
    assert.ok(
      reloaded.messages.length < 1 + 6 * 2,
      'transcript should be shorter after compaction',
    );
    // The context_compacted event landed in the log.
    const events = await loadSessionEvents(sessionId);
    assert.ok(
      events.some((e) => e.type === 'context_compacted'),
      'a context_compacted event should be persisted',
    );
  });

  it('is a no-op (compacted:false) when turns do not exceed preserveTurns', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 2);

    const res = await handleRequest(
      makeRequest('session_summarize', { sessionId, attachToken: token, preserveTurns: 6 }),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.compacted, false);
  });

  it('rejects while a run is active (RUN_IN_PROGRESS)', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 6);
    entry.activeRunId = 'run_busy';

    const res = await handleRequest(
      makeRequest('session_summarize', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'RUN_IN_PROGRESS');
  });

  it('rejects a non-positive or malformed preserveTurns (INVALID_REQUEST)', async () => {
    const { sessionId, token } = await makeSession();
    // Non-positive, fractional, and malformed strings must all be rejected
    // (not coerced like a lax parseInt would) — matches the CLI /compact.
    for (const bad of [0, -1, 2.7, '2abc', '1e2', 'abc', '']) {
      const res = await handleRequest(
        makeRequest('session_summarize', { sessionId, attachToken: token, preserveTurns: bad }),
        () => {},
      );
      assert.equal(res.ok, false, `preserveTurns=${JSON.stringify(bad)} should reject`);
      assert.equal(res.error.code, 'INVALID_REQUEST');
    }
  });

  it('accepts a digit-string preserveTurns', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 6);
    const res = await handleRequest(
      makeRequest('session_summarize', { sessionId, attachToken: token, preserveTurns: '2' }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.preserveTurns, 2);
  });
});

// ─── session_revert / session_unrevert (Addressable Session Verbs phase 5) ──
//
// Transcript revert: undo the last N user turns (truncate state.messages,
// persist, stash the removed tail) + unrevert restores it. Bearer-gated (16th +
// 17th enforcement sites), rejected mid-run; the stash is cleared by the next
// send_user_message.
describe('session_revert / session_unrevert', () => {
  let originalSessionDir;
  let tmpRoot;
  before(async () => {
    originalSessionDir = process.env.PUSH_SESSION_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-revert-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
  });
  after(async () => {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeSession() {
    const start = await handleRequest(
      makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
      () => {},
    );
    return { sessionId: start.payload.sessionId, token: start.payload.attachToken };
  }

  function seedTurns(entry, n) {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < n; i += 1) {
      msgs.push({ role: 'user', content: `user ${i}` });
      msgs.push({ role: 'assistant', content: `assistant ${i}` });
    }
    entry.state.messages = msgs;
  }

  it('rejects a tokenless revert (16th enforcement site)', async () => {
    const { sessionId } = await makeSession();
    const res = await handleRequest(makeRequest('session_revert', { sessionId }), () => {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('reverts the last N turns, truncates + persists the transcript', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 4); // [sys, u0,a0, u1,a1, u2,a2, u3,a3] = 9 messages, 4 turns

    const res = await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token, turns: 2 }),
      () => {},
    );
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.reverted, true);
    assert.equal(res.payload.turns, 2);
    assert.equal(res.payload.removedCount, 4); // u2,a2,u3,a3
    assert.equal(res.payload.remainingTurns, 2);
    assert.equal(entry.state.messages.length, 5); // sys + 2 turns

    const reloaded = await loadSessionState(sessionId);
    assert.equal(reloaded.messages.length, 5, 'truncation must be persisted');
  });

  it('unrevert restores exactly what revert removed', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 3);
    const before = entry.state.messages.length;

    await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token, turns: 2 }),
      () => {},
    );
    const un = await handleRequest(
      makeRequest('session_unrevert', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(un.ok, true, `expected ok, got ${JSON.stringify(un.error)}`);
    assert.equal(un.payload.unreverted, true);
    assert.equal(entry.state.messages.length, before, 'transcript fully restored');
    const reloaded = await loadSessionState(sessionId);
    assert.equal(reloaded.messages.length, before);
  });

  it('accumulates consecutive reverts so unrevert restores all of them', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 4);
    const before = entry.state.messages.length;

    await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token, turns: 2 }),
      () => {},
    );
    await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token, turns: 1 }),
      () => {},
    );
    const un = await handleRequest(
      makeRequest('session_unrevert', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(un.ok, true);
    assert.equal(entry.state.messages.length, before, 'two reverts fully undone by one unrevert');
  });

  it('unrevert with nothing pending returns NOTHING_TO_UNREVERT', async () => {
    const { sessionId, token } = await makeSession();
    const res = await handleRequest(
      makeRequest('session_unrevert', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOTHING_TO_UNREVERT');
  });

  it('a new send commits the fork — unrevert is no longer possible', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 3);
    await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token, turns: 1 }),
      () => {},
    );
    // Simulate what send_user_message does to the stash on a new message.
    entry.revertedTail = null;
    const un = await handleRequest(
      makeRequest('session_unrevert', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(un.ok, false);
    assert.equal(un.error.code, 'NOTHING_TO_UNREVERT');
  });

  it('reverting an empty conversation is a no-op (reverted:false)', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    entry.state.messages = [{ role: 'system', content: 'sys' }]; // no user turns
    const res = await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token }),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.reverted, false);
  });

  it('rejects revert while a run is active (RUN_IN_PROGRESS)', async () => {
    const { sessionId, token } = await makeSession();
    const entry = __getActiveSessionForTesting(sessionId);
    seedTurns(entry, 3);
    entry.activeRunId = 'run_busy';
    const res = await handleRequest(
      makeRequest('session_revert', { sessionId, attachToken: token, turns: 1 }),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'RUN_IN_PROGRESS');
  });

  it('rejects a malformed turns value (INVALID_REQUEST)', async () => {
    const { sessionId, token } = await makeSession();
    for (const bad of [0, -1, 1.5, '2abc']) {
      const res = await handleRequest(
        makeRequest('session_revert', { sessionId, attachToken: token, turns: bad }),
        () => {},
      );
      assert.equal(res.ok, false, `turns=${JSON.stringify(bad)} should reject`);
      assert.equal(res.error.code, 'INVALID_REQUEST');
    }
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
    const result = await tryConnect(makeTestSocketPath('nonexistent-pushd-test'), 200);
    assert.equal(result, null);
  });

  it('connect + request + onEvent works with echo server', async (t) => {
    const sockPath = makeTestSocketPath('dc-test');
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
        if (!isNamedPipePath(sockPath)) {
          await fs.unlink(sockPath);
        }
      } catch {
        /* ignore */
      }
    }
  });

  it('onEvent returns unsubscribe function', async (t) => {
    const sockPath = makeTestSocketPath('dc-unsub');
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
        if (!isNamedPipePath(sockPath)) {
          await fs.unlink(sockPath);
        }
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

// ─── list_sessions mode propagation (drift detector) ───────────────
//
// The mobile drawer's "Remote" bucket reads `mode` off the
// `list_sessions` response so they can hide headless runs and tag the
// origin surface. This test pins the daemon contract: the value passed
// into `start_session` round-trips through `state.json` and shows up on
// the listing payload. If a refactor drops the field on either side,
// this test fails before the drawer silently goes back to bucketing
// every CLI session as 'interactive'.
//
// The CLI-inline paths (`cli/cli.ts` REPL / headless and `cli/tui.ts`
// TUI) tag mode at session-creation time, not through the daemon's
// `start_session`. Round-trip coverage for those creation sites lives
// in the session-store unit tests — this block stays scoped to the
// daemon RPC contract so the two surfaces test independently.

describe('list_sessions mode propagation', () => {
  it('round-trips the start_session mode through to the listing row', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-list-sessions-mode-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const startTui = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
          mode: 'tui',
        }),
        () => {},
      );
      assert.equal(startTui.ok, true);
      const tuiSessionId = startTui.payload.sessionId;

      const startDefault = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
          // `mode` intentionally omitted to confirm the default lands
          // on the listing row (not just on the event payload).
        }),
        () => {},
      );
      assert.equal(startDefault.ok, true);
      const defaultSessionId = startDefault.payload.sessionId;

      const list = await handleRequest(makeRequest('list_sessions', { limit: 50 }), () => {});
      assert.equal(list.ok, true);
      const rows = list.payload.sessions;
      const tuiRow = rows.find((s) => s.sessionId === tuiSessionId);
      const defaultRow = rows.find((s) => s.sessionId === defaultSessionId);
      assert.equal(tuiRow?.mode, 'tui');
      assert.equal(defaultRow?.mode, 'interactive');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('applies excludeModes server-side so limit slices the post-filter set', async () => {
    // Without server-side filtering, a user with 50 consecutive
    // headless runs would see an empty drawer CLI section even though
    // older interactive sessions exist on disk. This test pins the
    // post-filter behavior: `excludeModes: ['headless']` removes those
    // rows BEFORE the `limit` slice, so the limit budget is spent on
    // the rows the consumer actually wants.
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-list-sessions-exclude-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const sessionIds = { headless: [], tui: [] };
      for (let i = 0; i < 3; i++) {
        const headless = await handleRequest(
          makeRequest('start_session', {
            provider: 'ollama',
            repo: { rootPath: process.cwd() },
            mode: 'headless',
          }),
          () => {},
        );
        sessionIds.headless.push(headless.payload.sessionId);
        const tui = await handleRequest(
          makeRequest('start_session', {
            provider: 'ollama',
            repo: { rootPath: process.cwd() },
            mode: 'tui',
          }),
          () => {},
        );
        sessionIds.tui.push(tui.payload.sessionId);
      }

      const unfiltered = await handleRequest(makeRequest('list_sessions', { limit: 50 }), () => {});
      const allModes = unfiltered.payload.sessions.map((s) => s.mode).sort();
      assert.deepEqual(
        allModes,
        ['headless', 'headless', 'headless', 'tui', 'tui', 'tui'],
        'baseline: every started session shows up unfiltered',
      );

      const filtered = await handleRequest(
        makeRequest('list_sessions', { limit: 50, excludeModes: ['headless'] }),
        () => {},
      );
      const filteredIds = filtered.payload.sessions.map((s) => s.sessionId).sort();
      assert.deepEqual(
        filteredIds,
        [...sessionIds.tui].sort(),
        'excludeModes drops headless rows on the server side',
      );

      // Slim-limit interaction: with limit=2 and excludeModes=['headless'],
      // the result should be 2 TUI rows — not 2 headless rows that get
      // dropped to 0 after client-side filtering.
      const limited = await handleRequest(
        makeRequest('list_sessions', { limit: 2, excludeModes: ['headless'] }),
        () => {},
      );
      assert.equal(limited.payload.sessions.length, 2);
      for (const row of limited.payload.sessions) {
        assert.equal(row.mode, 'tui');
      }
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('treats a missing or non-array excludeModes as no filter (back-compat)', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-list-sessions-back-compat-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
          mode: 'headless',
        }),
        () => {},
      );
      // Junk values for excludeModes should fall through to "no filter"
      // — CLI's existing `list_sessions` callers (cli.ts diagnostic path)
      // don't pass the param at all and must keep seeing every row.
      for (const value of [undefined, null, 'headless', [], [42]]) {
        const res = await handleRequest(
          makeRequest('list_sessions', { limit: 50, excludeModes: value }),
          () => {},
        );
        assert.equal(res.ok, true);
        assert.equal(res.payload.sessions.length, 1);
      }
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('trims whitespace on excludeModes entries before comparing', async () => {
    // `state.mode` is trimmed by `handleStartSession` on payload
    // normalization and by `listSessions()` on read; the filter has
    // to trim too so a client passing `' headless '` doesn't silently
    // fail to filter and leave headless rows in the drawer. Not every
    // write path normalizes (`saveSessionState` writes state as-is),
    // but every read path does.
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-list-sessions-trim-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
          mode: 'headless',
        }),
        () => {},
      );
      await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: process.cwd() },
          mode: 'tui',
        }),
        () => {},
      );

      const padded = await handleRequest(
        makeRequest('list_sessions', { limit: 50, excludeModes: ['  headless  '] }),
        () => {},
      );
      assert.equal(padded.payload.sessions.length, 1);
      assert.equal(padded.payload.sessions[0].mode, 'tui');

      // All-blank entries reduce to an empty filter set — back-compat
      // with the "no array elements" case so the listing isn't
      // accidentally over-filtered.
      const blanks = await handleRequest(
        makeRequest('list_sessions', { limit: 50, excludeModes: ['   ', '\t'] }),
        () => {},
      );
      assert.equal(blanks.payload.sessions.length, 2);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('validates and caps limit instead of forwarding malformed values to slice', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-list-sessions-limit-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      // Seed 3 sessions so we can observe the limit clamp.
      for (let i = 0; i < 3; i++) {
        await handleRequest(
          makeRequest('start_session', {
            provider: 'ollama',
            repo: { rootPath: process.cwd() },
            mode: 'interactive',
          }),
          () => {},
        );
      }

      // Non-numeric truthy values previously got passed to slice via
      // `req.payload?.limit || 20`. With validation, they fall back to
      // the default (20) so all 3 sessions appear.
      for (const malformed of ['2', true, {}, []]) {
        const res = await handleRequest(
          makeRequest('list_sessions', { limit: malformed }),
          () => {},
        );
        assert.equal(res.ok, true);
        assert.equal(res.payload.sessions.length, 3, `limit=${JSON.stringify(malformed)}`);
      }

      // Valid numeric limit clamps the result.
      const limited = await handleRequest(makeRequest('list_sessions', { limit: 2 }), () => {});
      assert.equal(limited.payload.sessions.length, 2);

      // `limit: 0` (a previously-impossible request because of the
      // truthy coalesce) now falls back to the default. This matches
      // the spirit of "empty result is not a useful query" — a client
      // who genuinely wants nothing shouldn't call the RPC at all.
      const zero = await handleRequest(makeRequest('list_sessions', { limit: 0 }), () => {});
      assert.equal(zero.payload.sessions.length, 3);

      // Fractional positive values floor to < 1 (the `> 0` check would
      // have admitted them, but the floor would silently produce a
      // zero-slice). They fall back to the default instead of returning
      // a surprising empty result. `limit: 1.5` floors to 1, which is
      // a legitimate request.
      const fractional = await handleRequest(
        makeRequest('list_sessions', { limit: 0.5 }),
        () => {},
      );
      assert.equal(fractional.payload.sessions.length, 3);
      const flooredToOne = await handleRequest(
        makeRequest('list_sessions', { limit: 1.5 }),
        () => {},
      );
      assert.equal(flooredToOne.payload.sessions.length, 1);

      // Negative values are non-positive — same fallback path.
      const negative = await handleRequest(makeRequest('list_sessions', { limit: -5 }), () => {});
      assert.equal(negative.payload.sessions.length, 3);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
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

  it('broadcasts user_message to an already-attached client, not just the sender (TUI-shows-Remote-chat)', async () => {
    // Regression: user_message was persisted (appendSessionEvent) but never
    // broadcast, so a second client attached to the same session (e.g. the
    // TUI that originated it, watching a phone-driven turn over Remote)
    // never saw the prompt — only the assistant's reply arrived, with no
    // visible question above it.
    const mock = await startMockProviderServer({ tokens: ['ack ', 'from mock'] });
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

      // A second client (the TUI) attaches to the same session as an
      // observer, distinct from whoever sends the message below.
      const broadcasted = [];
      const attached = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken }, sessionId),
        (event) => broadcasted.push(event),
      );
      assert.equal(attached.ok, true);
      broadcasted.length = 0;

      const sendResult = await handleRequest(
        makeRequest(
          'send_user_message',
          { sessionId, attachToken, text: 'what changed recently in push' },
          sessionId,
        ),
        () => {},
      );
      assert.equal(sendResult.ok, true);

      const userMessage = await waitForBroadcast(broadcasted, (e) => e.type === 'user_message', {
        message: 'expected user_message broadcast to the attached observer',
      });
      assert.equal(userMessage.payload.preview, 'what changed recently in push');
      assert.equal(userMessage.payload.text, 'what changed recently in push');
      assert.equal(userMessage.payload.chars, 'what changed recently in push'.length);
      assert.equal(userMessage.runId, sendResult.payload.runId);

      // Let the background turn finish so the mock server isn't torn down
      // mid-request.
      await waitForBroadcast(broadcasted, (e) => e.type === 'run_complete', {
        message: 'expected run_complete',
      });
    } finally {
      restoreConfig();
      await mock.stop();
    }
  });
});

describe('appendSessionEvent seq capture (Codex P2 on #1321)', () => {
  // handleSendUserMessage broadcasts with the seq captured synchronously
  // right when appendSessionEvent is called, not after awaiting it —
  // appendSessionEvent increments state.eventSeq before its own first
  // await, so a concurrent append for the SAME session (a background
  // delegation/task-graph run isn't blocked by send_user_message's
  // activeRunId check) landing during that await window would otherwise
  // make a post-await read pick up the LATER event's seq. Proven directly
  // against the real appendSessionEvent, not a reimplementation.
  it('captures the correct seq even when a concurrent append lands during the await window', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-seq-race-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const sessionId = makeSessionId();
      const state = createSessionState({
        sessionId,
        attachToken: 'pushd_test_seq_race_token',
        provider: 'ollama',
        model: 'llama-test',
        cwd: tmpRoot,
        mode: 'tui',
        messages: [{ role: 'system', content: 'system' }],
      });
      await saveSessionState(state);

      // Deliberately don't await the first append before starting the
      // second — this is the race window: both synchronous prefixes run
      // (both increments happen) before either disk write resolves.
      const firstAppend = appendSessionEvent(state, 'user_message', { chars: 2, preview: 'hi' });
      // The correct capture point: synchronous, right after initiating the
      // call, before this TUI's own code awaits anything.
      const capturedSeq = state.eventSeq;

      const secondAppend = appendSessionEvent(state, 'status', { detail: 'concurrent' });
      await Promise.all([firstAppend, secondAppend]);

      assert.equal(capturedSeq, 1, "must capture user_message's own seq, not a later one");
      // Proves the race scenario genuinely happened: state.eventSeq moved on
      // to 2 by the time both appends settled — a post-await read here would
      // have wrongly broadcast seq 2 for the user_message event actually
      // persisted at seq 1.
      assert.equal(state.eventSeq, 2, 'sanity: the concurrent append did land during the window');

      const events = await loadSessionEvents(sessionId);
      const persistedUserMessage = events.find((e) => e.type === 'user_message');
      assert.equal(persistedUserMessage.seq, capturedSeq);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── Daemon version bump ─────────────────────────────────────────

describe('daemon version', () => {
  it('pushd version is 0.3.0, single-sourced from build-stamp', async () => {
    // The version literal now lives in build-stamp.ts (RUNTIME_VERSION) so the
    // daemon's advertised version and its build-stamp freshness token can't
    // drift apart. Assert the value behaviorally via the hello payload, plus
    // that pushd sources VERSION from RUNTIME_VERSION rather than a local copy.
    const { RUNTIME_VERSION } = await import('../build-stamp.ts');
    assert.equal(RUNTIME_VERSION, '0.3.0');
    const response = await handleRequest(makeRequest('hello', { clientName: 'test' }), () => {});
    assert.equal(response.ok, true);
    assert.equal(response.payload.runtimeVersion, '0.3.0');
    const content = await fs.readFile(path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8');
    assert.ok(content.includes('const VERSION = RUNTIME_VERSION'));
  });

  it('hello advertises a code-freshness buildStamp', async () => {
    // The stale-runtime self-heal depends on the daemon advertising a build
    // stamp the TUI can compare against its own. Shape: `<version>+<sha|nogit>`.
    const response = await handleRequest(makeRequest('hello', { clientName: 'test' }), () => {});
    assert.equal(response.ok, true);
    assert.match(response.payload.buildStamp, /^0\.3\.0\+([0-9a-f]{7,40}|nogit)$/);
  });

  it('hello capabilities advertise the full multi-agent stack', async () => {
    const response = await handleRequest(makeRequest('hello', { clientName: 'test' }), () => {});
    assert.equal(response.ok, true);
    assert.ok(response.payload.capabilities.includes('multi_client'));
    assert.ok(response.payload.capabilities.includes('replay_attach'));
    assert.ok(response.payload.capabilities.includes('crash_recovery'));
    assert.ok(response.payload.capabilities.includes('role_routing'));
    assert.ok(response.payload.capabilities.includes('runtime_config_v1'));
    assert.ok(response.payload.capabilities.includes('delegation_explorer_v1'));
    assert.ok(response.payload.capabilities.includes('delegation_coder_v1'));
    assert.ok(response.payload.capabilities.includes('delegation_reviewer_v1'));
    assert.ok(response.payload.capabilities.includes('task_graph_v1'));
    assert.ok(response.payload.capabilities.includes('session_snapshot_v1'));
    assert.ok(response.payload.capabilities.includes('event_v2'));
    // `multi_agent` now advertised — both Explorer and Coder daemon-side
    // tool executors are real (see `makeDaemonExplorerToolExec` +
    // `makeDaemonCoderToolExec` in cli/pushd.ts).
    assert.ok(response.payload.capabilities.includes('multi_agent'));
    // The versioned-suffix form is the canonical name; bare `task_graph`
    // (without `_v1`) is still NOT advertised.
    assert.ok(!response.payload.capabilities.includes('task_graph'));
  });

  it('core handler types are registered', async () => {
    const content = await fs.readFile(path.join(import.meta.dirname, '..', 'pushd.ts'), 'utf8');
    const handlers = [
      'hello',
      'ping',
      'list_sessions',
      'start_session',
      'send_user_message',
      'attach_session',
      'get_session_snapshot',
      'update_session',
      'get_daemon_runtime_config',
      'set_daemon_runtime_config',
      'list_providers',
      'submit_approval',
      'cancel_run',
      'configure_role_routing',
      'submit_task_graph',
      'delegate_explorer',
      'delegate_coder',
      'delegate_reviewer',
      'delegate_deep_reviewer',
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

describe('submit_task_graph', needsLoopback, () => {
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

      const broadcastGraphCompleted = await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'task_graph.graph_completed' && e.payload.executionId === executionId,
        { message: 'expected task_graph.graph_completed broadcast' },
      );
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
// is provided, also poll the events log until the terminal event appears. A
// successful Coder/Explorer terminal event carries `delegationOutcome`; for those,
// wait for the following state-file write too so callers can immediately
// `loadSessionState` without racing `saveSessionState` on slower Windows runners.
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
      if (terminal) {
        if (!terminal.payload?.delegationOutcome) return;
        const persisted = await loadSessionState(sessionId);
        const hasPersistedOutcome = persisted.delegationOutcomes?.some(
          (record) => record.subagentId === subagentId,
        );
        if (hasPersistedOutcome) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const details = sessionId
    ? `subagentId=${subagentId}, sessionId=${sessionId}`
    : `subagentId=${subagentId}`;
  throw new Error(`delegation background run did not complete within ${timeoutMs}ms (${details})`);
}

describe('delegate_explorer', needsLoopback, () => {
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
          provider: 'not-a-real-provider',
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
      assert.ok(response.error.message.includes('not-a-real-provider'));
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

      await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'subagent.started' && e.payload.subagentId === subagentId,
        { message: 'expected subagent.started broadcast' },
      );
      await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
        { message: 'expected subagent.completed broadcast' },
      );
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
describe('delegate_coder', needsLoopback, () => {
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
          provider: 'not-a-real-provider',
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
      assert.ok(response.error.message.includes('not-a-real-provider'));
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

      await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'subagent.started' && e.payload.subagentId === subagentId,
        { message: 'expected subagent.started broadcast' },
      );
      await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
        { message: 'expected subagent.completed broadcast' },
      );
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
    const routedMock = await startMockProviderServer({
      tokens: [ROUTED_ONLY_TOKEN],
      streamShape: 'responses',
    });
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

  it('rejects a read that appears after the mutation batch starts', () => {
    const write = JSON.stringify({ tool: 'write_file', args: { path: 'a.txt', content: '1' } });
    const read = JSON.stringify({ tool: 'read_file', args: { path: 'b.txt' } });
    const text = `\`\`\`json\n${write}\n\`\`\`\n\`\`\`json\n${read}\n\`\`\``;
    const detected = wrapCliDetectAllToolCalls(text);
    assert.deepEqual(detected.readOnly, []);
    assert.equal(detected.fileMutations.length, 1);
    assert.equal(detected.fileMutations[0].call.tool, 'write_file');
    assert.equal(detected.mutating, null);
    assert.equal(detected.extraMutations.length, 1);
    assert.equal(detected.extraMutations[0].call.tool, 'read_file');
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
      assert.equal(result.card?.type, 'diff-preview');
      assert.ok(result.editDiff, 'daemon executor should preserve the structured edit diff');

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
  it('READ_ONLY_TOOL_PROTOCOL advertises only tools Explorer can actually call', () => {
    // Post-Gap-2 invariant (2026-04-18): the Explorer prompt must
    // track the shared capability grant, not the local allowlist.
    // Advertising a tool that `roleCanUseTool('explorer', ...)`
    // denies wastes rounds — the model follows the prompt, emits
    // the call, hits the daemon-side denial.
    //
    // Parse tool names out of the protocol block. Each read-only
    // tool is documented on a line like `- <name>(<args>) — <desc>`.
    const toolLinePattern = /^- (\w+)\(/gm;
    const advertised = new Set();
    for (const match of READ_ONLY_TOOL_PROTOCOL.matchAll(toolLinePattern)) {
      advertised.add(match[1]);
    }

    // (1) Every advertised tool must exist in the executor's
    // allowlist, otherwise the model will emit a call that the
    // executor's tool dispatch doesn't recognize. This is the
    // pre-Gap-2 "dispatcher knows the name" invariant.
    for (const name of advertised) {
      assert.ok(
        READ_ONLY_TOOLS.has(name),
        `READ_ONLY_TOOL_PROTOCOL advertises "${name}" but READ_ONLY_TOOLS does not contain it`,
      );
    }

    // (2) Every advertised tool must be callable by Explorer per
    // the shared capability table. Without this check, the Gap 2
    // gate swap can deny a prompt-advertised tool and the model
    // grinds rounds. This is the post-Gap-2 addition.
    for (const name of advertised) {
      assert.ok(
        roleCanUseTool('explorer', name),
        `READ_ONLY_TOOL_PROTOCOL advertises "${name}" but roleCanUseTool('explorer', ...) denies it`,
      );
    }

    // (3) Every READ_ONLY_TOOLS entry that Explorer CAN call must
    // be advertised — an Explorer-callable tool sitting undocumented
    // in the allowlist is a missed prompt line. READ_ONLY_TOOLS
    // entries that Explorer can't call (e.g. exec_poll /
    // exec_list_sessions retained for deep-reviewer-agent's
    // read/mutate bucketing) are intentionally excluded from the
    // prompt and from this assertion.
    for (const name of READ_ONLY_TOOLS) {
      if (!roleCanUseTool('explorer', name)) continue;
      assert.ok(
        advertised.has(name),
        `Explorer-callable READ_ONLY_TOOLS entry "${name}" is missing from READ_ONLY_TOOL_PROTOCOL`,
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

// Drift-detector for the `create_artifact` tool. Pins both the registry
// shape (canonical name, public alias, source, mutating) and the
// capability grants by role so a future refactor can't silently shift
// who is allowed to emit artifact tool calls. Coder is now granted
// (cli/pushd.ts:makeDaemonCoderToolExec plumbs `role: 'coder'` through
// to the dispatch + the cli/tools.ts case gates with `roleCanUseTool`);
// explorer / reviewer / auditor remain denied.
describe('create_artifact tool registry + capability drift', () => {
  it('pins the canonical / public / source / mutation shape of create_artifact', () => {
    const spec = getToolSpec('create_artifact');
    assert.ok(spec, 'create_artifact must be registered in TOOL_SPECS');
    assert.equal(spec.canonicalName, 'create_artifact');
    assert.equal(spec.publicName, 'artifact');
    assert.equal(spec.source, 'artifacts');
    assert.equal(spec.readOnly, false);

    const byPublic = getToolSpec('artifact');
    assert.equal(byPublic?.canonicalName, 'create_artifact');
  });

  it('grants artifacts:write to orchestrator and coder; explorer/reviewer/auditor denied', () => {
    assert.equal(roleCanUseTool('orchestrator', 'create_artifact'), true);
    assert.equal(roleCanUseTool('coder', 'create_artifact'), true);
    assert.equal(roleCanUseTool('explorer', 'create_artifact'), false);
    assert.equal(roleCanUseTool('reviewer', 'create_artifact'), false);
    assert.equal(roleCanUseTool('auditor', 'create_artifact'), false);
  });
});

describe('branch switch registry + capability drift', () => {
  it('documents the shared switch_branch tool spec', () => {
    const spec = getToolSpec('switch_branch');
    assert.ok(spec, 'switch_branch must be registered in TOOL_SPECS');
    assert.equal(spec.canonicalName, 'sandbox_switch_branch');
    assert.equal(spec.publicName, 'switch_branch');
    assert.equal(spec.source, 'sandbox');
    assert.equal(spec.readOnly, false);
    assert.equal(spec.protocolSignature, 'switch_branch(branch)');
    assert.match(spec.protocolDescription, /current conversation/);
    assert.equal(spec.exampleJson, '{"tool": "switch_branch", "args": {"branch": "main"}}');
  });

  it('keeps typed branch tools grantable to the coder role used by the inline lead', () => {
    for (const tool of ['sandbox_create_branch', 'sandbox_switch_branch']) {
      assert.equal(roleCanUseTool('coder', tool), true);
      assert.equal(roleCanUseTool('explorer', tool), false);
      assert.equal(roleCanUseTool('reviewer', tool), false);
      assert.equal(roleCanUseTool('auditor', tool), false);
    }
  });
});

describe('delegate_reviewer', needsLoopback, () => {
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
          provider: 'not-a-real-provider',
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
      assert.ok(response.error.message.includes('not-a-real-provider'));
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

      const broadcastCompleted = await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
        { message: 'expected subagent.completed broadcast' },
      );
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

// ─── delegate_deep_reviewer ─────────────────────────────────────

describe('delegate_deep_reviewer', needsLoopback, () => {
  it('rejects missing sessionId', async () => {
    const response = await handleRequest(
      makeRequest('delegate_deep_reviewer', { diff: MINIMAL_REVIEWER_DIFF }),
      () => {},
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.ok(response.error.message.includes('sessionId'));
  });

  it('rejects missing diff', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-deepreview-nodiff-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const start = await handleRequest(
        makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;
      const response = await handleRequest(
        makeRequest('delegate_deep_reviewer', { sessionId, attachToken }, sessionId),
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
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-deepreview-badtok-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const start = await handleRequest(
        makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
        () => {},
      );
      const { sessionId } = start.payload;
      const response = await handleRequest(
        makeRequest(
          'delegate_deep_reviewer',
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

  it('honors reviewer role routing and rejects a stale unknown provider before acking', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-deepreview-stale-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const start = await handleRequest(
        makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);
      entry.state.roleRouting = { reviewer: { provider: 'not-a-real-provider' } };

      const response = await handleRequest(
        makeRequest(
          'delegate_deep_reviewer',
          { sessionId, attachToken, diff: MINIMAL_REVIEWER_DIFF },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'PROVIDER_NOT_CONFIGURED');
      assert.ok(response.error.message.includes('not-a-real-provider'));
      assert.equal(entry.activeDelegations?.size ?? 0, 0);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs the deep-reviewer kernel end-to-end and persists a ReviewResult', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-deepreview-happy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // The deep reviewer emits the [REVIEW_COMPLETE] marker, then JSON. A
    // round-1 response with no tool call + the marker exits the loop
    // immediately (no investigation needed for this deterministic case).
    const MOCK_DEEP_TOKENS = [
      'I reviewed the diff directly.\n[REVIEW_COMPLETE]\n',
      '{"summary": "MOCK_DEEP_SUMMARY: single added line looks fine.",',
      ' "comments": [',
      '{"file": "src/a.ts", "line": 3, "severity": "note",',
      ' "comment": "MOCK_DEEP_COMMENT: consider a test for this line"}',
      ']}',
    ];
    const mock = await startMockProviderServer({ tokens: MOCK_DEEP_TOKENS });
    const restoreConfig = patchProviderConfig('ollama', { url: mock.url, apiKey: 'test-mock-key' });

    try {
      const start = await handleRequest(
        makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
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
          'delegate_deep_reviewer',
          { sessionId, attachToken, diff: MINIMAL_REVIEWER_DIFF },
          sessionId,
        ),
        () => {},
      );

      assert.equal(response.ok, true);
      assert.equal(response.payload.accepted, true);
      assert.ok(response.payload.subagentId.startsWith('sub_deepreviewer_'));
      assert.ok(response.payload.childRunId.startsWith('run_'));

      const { subagentId, childRunId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry);

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
      // Deep reviewer tags its agent distinctly but runs under the reviewer role.
      assert.equal(started.payload.agent, 'deep_reviewer');
      assert.equal(started.payload.role, 'reviewer');
      assert.equal(completed.payload.agent, 'deep_reviewer');
      assert.equal(completed.runId, childRunId);

      const reviewResult = completed.payload.reviewResult;
      assert.ok(reviewResult, 'expected reviewResult payload');
      assert.ok(reviewResult.summary.includes('MOCK_DEEP_SUMMARY'));
      assert.equal(reviewResult.comments.length, 1);
      assert.equal(reviewResult.comments[0].file, 'src/a.ts');
      assert.equal(reviewResult.comments[0].severity, 'note');
      assert.equal(reviewResult.provider, 'ollama');

      const loaded = await loadSessionState(sessionId);
      const record = loaded.reviewOutcomes?.find((r) => r.subagentId === subagentId);
      assert.ok(record, 'expected reviewOutcome record in session state');
      assert.ok(record.result.summary.includes('MOCK_DEEP_SUMMARY'));

      const broadcastCompleted = await waitForBroadcast(
        broadcasted,
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
        { message: 'expected subagent.completed broadcast' },
      );
      assert.ok(broadcastCompleted.payload.reviewResult);
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('investigates via a local CLI read tool before reviewing (tool loop)', async () => {
    // Proves the deep reviewer is steered toward the LOCAL CLI read tools its
    // executor can actually run — the Codex P2 fix (truthy sandboxId suppresses
    // the "no sandbox, use GitHub tools" guidance). Round 1 emits a CLI-native
    // read_file call; round 2 (after the real tool result) emits the verdict.
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-delegate-deepreview-loop-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;

    // A real file in the workspace the reviewer will "read" during investigation.
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-deepreview-ws-'));
    await fs.writeFile(path.join(workRoot, 'a.ts'), 'export const answer = 42;\n');

    const responses = [
      // Round 1: investigate — emit a CLI-native read_file tool call.
      [
        'Let me read the changed file first.\n',
        '```json\n{"tool": "read_file", "args": {"path": "a.ts"}}\n```',
      ],
      // Round 2: now produce the verdict.
      [
        '[REVIEW_COMPLETE]\n',
        '{"summary": "MOCK_DEEP_LOOP: investigated a.ts before reviewing.",',
        ' "comments": []}',
      ],
    ];
    const mock = await startMockProviderServer({ responses });
    const restoreConfig = patchProviderConfig('ollama', { url: mock.url, apiKey: 'test-mock-key' });

    try {
      const start = await handleRequest(
        makeRequest('start_session', { provider: 'ollama', repo: { rootPath: workRoot } }),
        () => {},
      );
      const { sessionId, attachToken } = start.payload;

      const response = await handleRequest(
        makeRequest(
          'delegate_deep_reviewer',
          { sessionId, attachToken, diff: MINIMAL_REVIEWER_DIFF },
          sessionId,
        ),
        () => {},
      );
      assert.equal(response.ok, true);
      const { subagentId } = response.payload;
      const entry = __getActiveSessionForTesting(sessionId);
      await waitForDelegationComplete(entry, subagentId, sessionId);

      // The kernel ran at least two provider rounds: the investigation round
      // (tool call) and the verdict round. A single round would mean the tool
      // loop never engaged.
      assert.ok(
        mock.requestCount() >= 2,
        `expected >=2 provider rounds (investigate + verdict), got ${mock.requestCount()}`,
      );

      const events = await loadSessionEvents(sessionId);
      const completed = events.find(
        (e) => e.type === 'subagent.completed' && e.payload.subagentId === subagentId,
      );
      assert.ok(completed, 'expected subagent.completed');
      assert.ok(completed.payload.reviewResult.summary.includes('MOCK_DEEP_LOOP'));
    } finally {
      restoreConfig();
      await mock.stop();
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
      // Handed to the session as its workspace root — see rmWorkspace.
      await rmWorkspace(workRoot);
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

  it('legacy session without persisted attachToken is now REJECTED on a non-attach handler (bypass removed)', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-legacy-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      // Create a session the normal way, then strip the attachToken field
      // from its persisted state to simulate a session created before the
      // bearer field existed.
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

      // Universal Session Bearer: the `!entry.attachToken → true` bypass is
      // gone. A tokenless session hitting a NON-attach handler (no bootstrap
      // grace lives there — grace is attach-only) with no token is now
      // rejected. The migration path for such a session is to attach first
      // (which claims it via grace); only `attach_session` claims.
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
      assert.equal(response.ok, false, 'tokenless legacy session must no longer bypass auth');
      assert.equal(response.error.code, 'INVALID_TOKEN');
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('PUSHD_OPEN_ATTACH=1 re-opens a tokenless session as the explicit dev opt-out', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const originalOpenAttach = process.env.PUSHD_OPEN_ATTACH;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-open-attach-'));
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
      const raw = await loadSessionState(sessionId);
      delete raw.attachToken;
      await saveSessionState(raw);

      // Opt-out engaged: the bearerless call is accepted again, but only
      // because the operator deliberately set the env flag (logged once as
      // `open_attach_used`).
      process.env.PUSHD_OPEN_ATTACH = '1';
      const response = await handleRequest(
        makeRequest(
          'configure_role_routing',
          { sessionId, routing: { explorer: { provider: 'ollama' } } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(
        response.ok,
        true,
        `expected open-attach opt-out to accept, got ${JSON.stringify(response.error)}`,
      );
    } finally {
      if (originalOpenAttach === undefined) delete process.env.PUSHD_OPEN_ATTACH;
      else process.env.PUSHD_OPEN_ATTACH = originalOpenAttach;
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

  it('emits a workspace snapshot to a client that advertises workspace_state_v1', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-state-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          // The Push repo is a real git repo, so the emitter reads live state.
          repo: { rootPath: process.cwd() },
        }),
        () => {},
      );
      assert.equal(start.ok, true);
      const { sessionId, attachToken } = start.payload;

      const events = [];
      const attach = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId, attachToken, lastSeenSeq: 0, capabilities: ['workspace_state_v1'] },
          sessionId,
        ),
        (event) => events.push(event),
      );
      assert.equal(attach.ok, true);
      // The resync emit may read git asynchronously; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const snapshots = events.filter((e) => e.type === 'workspace.state_snapshot');
      assert.ok(snapshots.length >= 1, 'expected at least one workspace.state_snapshot');
      const snap = snapshots[snapshots.length - 1];
      assert.equal(typeof snap.payload.workspaceId, 'string');
      assert.ok(snap.payload.rev >= 0);
      assert.equal(typeof snap.payload.state.activeBranch, 'string');
      assert.equal(snap.payload.state.sandboxReady, true);
      // A client that never advertised the cap gets none of these — proven by
      // the sibling replay-exactness tests, which assert the raw missed set.
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('sends the opening workspace snapshot to a capable socket start_session client', async (t) => {
    const sockPath = makeTestSocketPath('push-ws-autoattach');
    const availability = await canListenOnUnixSocket(sockPath);
    if (!availability.ok) return t.skip(availability.reason);

    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-autoattach-state-'));
    const repoRoot = await createWorkspaceStateGitRepo('push-ws-autoattach-repo-');
    process.env.PUSH_SESSION_DIR = tmpRoot;
    __setLifecycleExitForTesting(() => {}, { graceMs: 60_000 });
    const server = net.createServer(__handleConnectionForTesting);
    let client = null;
    try {
      await new Promise((resolve) => server.listen(sockPath, resolve));
      client = await connectClient(sockPath);
      client.send(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: repoRoot },
          capabilities: [WORKSPACE_STATE_V1],
        }),
      );

      const response = await receiveMatching(
        client,
        (msg) => msg.kind === 'response' && msg.type === 'start_session',
        { message: 'start_session response' },
      );
      assert.equal(response.ok, true);

      const snapshot = await receiveMatching(
        client,
        (msg) => msg.kind === 'event' && msg.type === 'workspace.state_snapshot',
        { message: 'opening workspace.state_snapshot' },
      );
      assert.equal(snapshot.sessionId, response.payload.sessionId);
      assert.equal(snapshot.payload.workspaceId, response.payload.sessionId);
      assert.equal(snapshot.payload.rev, 0);
      assert.equal(typeof snapshot.payload.state.activeBranch, 'string');
      assert.ok(snapshot.payload.state.activeBranch.length > 0);
      assert.equal(snapshot.payload.state.dirtyFiles.length, 1);
      assert.equal(snapshot.payload.state.sandboxReady, true);
    } finally {
      if (client) {
        const socketClosed = new Promise((resolve) => client.socket.once('close', resolve));
        client.close();
        client.socket.destroy();
        await socketClosed;
      }
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => setTimeout(resolve, 25));
      __setLifecycleExitForTesting(undefined, { graceMs: 8000 });
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
      // Handed to the session as its workspace root — see rmWorkspace.
      await rmWorkspace(repoRoot);
      try {
        if (!isNamedPipePath(sockPath)) await fs.unlink(sockPath);
      } catch {
        /* ignore */
      }
    }
  });

  it('keeps the producer fresh across zero-subscriber run-end deltas', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-nosub-state-'));
    const repoRoot = await createWorkspaceStateGitRepo('push-ws-nosub-repo-');
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      const start = await handleRequest(
        makeRequest('start_session', {
          provider: 'ollama',
          repo: { rootPath: repoRoot },
        }),
        () => {},
      );
      assert.equal(start.ok, true);
      const { sessionId, attachToken } = start.payload;
      await waitUntil(() =>
        Boolean(__getActiveSessionForTesting(sessionId)?.workspaceStateProducer),
      );
      const entry = __getActiveSessionForTesting(sessionId);
      assert.ok(entry?.workspaceStateProducer);

      await fs.writeFile(path.join(repoRoot, 'second.txt'), 'new dirty file\n');
      await __emitWorkspaceStateForTesting(sessionId, entry, 'delta');

      const events = [];
      const attach = await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId, attachToken, lastSeenSeq: 0, capabilities: [WORKSPACE_STATE_V1] },
          sessionId,
        ),
        (event) => events.push(event),
      );
      assert.equal(attach.ok, true);

      const snapshot = await waitForBroadcast(
        events,
        (event) => event.type === 'workspace.state_snapshot',
        { message: 'workspace-state resync snapshot' },
      );
      assert.equal(snapshot.payload.workspaceId, sessionId);
      assert.equal(snapshot.payload.state.dirtyFiles.length, 2);
      assert.deepEqual(snapshot.payload.state.dirtyFiles.map((file) => file.path).sort(), [
        'README.md',
        'second.txt',
      ]);
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
      // Handed to the session as its workspace root — see rmWorkspace.
      await rmWorkspace(repoRoot);
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

  const BOGUS_EVENT = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: SESSION_ID,
    runId: null,
    seq: -1,
    ts: Date.now(),
    type: 'subagent.started',
    payload: {},
  };

  // Capture console.log (the daemon's structured-log channel) while
  // broadcasting `BOGUS_EVENT` with the given env overrides, then return any
  // parsed `protocol_drift_detected` line. No listeners are attached, so the
  // only observable effect is the validation branch.
  function broadcastAndCaptureDrift({ strict, observe }) {
    const prevStrict = process.env.PUSH_PROTOCOL_STRICT;
    const prevObserve = process.env.PUSH_PROTOCOL_OBSERVE;
    if (strict === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
    else process.env.PUSH_PROTOCOL_STRICT = strict;
    if (observe === undefined) delete process.env.PUSH_PROTOCOL_OBSERVE;
    else process.env.PUSH_PROTOCOL_OBSERVE = observe;
    const logged = [];
    const origLog = console.log;
    console.log = (line) => logged.push(line);
    try {
      assert.doesNotThrow(() => broadcastEvent(SESSION_ID, BOGUS_EVENT));
    } finally {
      console.log = origLog;
      if (prevStrict === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
      else process.env.PUSH_PROTOCOL_STRICT = prevStrict;
      if (prevObserve === undefined) delete process.env.PUSH_PROTOCOL_OBSERVE;
      else process.env.PUSH_PROTOCOL_OBSERVE = prevObserve;
    }
    return logged
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((o) => o && o.event === 'protocol_drift_detected');
  }

  it('observe mode (strict off, default on) logs drift but does not throw', () => {
    // Fail-open: a malformed event must NOT throw (that would drop it for
    // every attached client) but SHOULD surface a structured drift line.
    const drift = broadcastAndCaptureDrift({ strict: undefined, observe: undefined });
    assert.ok(drift, 'expected a protocol_drift_detected log line');
    assert.equal(drift.type, 'subagent.started');
    // Only sanitized dotted paths are logged — never raw field values (P2).
    assert.ok(Array.isArray(drift.issuePaths) && drift.issuePaths.length > 0);
    assert.ok(
      drift.issuePaths.every((p) => typeof p === 'string' && !p.includes(': ')),
      'issuePaths must be bare paths, not "path: message" strings',
    );
  });

  it('is a true silent no-op when both strict and observe are disabled', () => {
    const drift = broadcastAndCaptureDrift({ strict: undefined, observe: '0' });
    assert.equal(drift, undefined, 'expected no drift log when observe is disabled');
  });

  it('validates the original event on the replay path (emitEventWithDowngrade)', () => {
    // Persisted-but-not-live-broadcast events (the recovery trio) reach a
    // reconnecting client only through emitEventWithDowngrade. Its direct-emit
    // branch must still validate — and stay fail-open (emit anyway).
    const prevStrict = process.env.PUSH_PROTOCOL_STRICT;
    const prevObserve = process.env.PUSH_PROTOCOL_OBSERVE;
    delete process.env.PUSH_PROTOCOL_STRICT;
    delete process.env.PUSH_PROTOCOL_OBSERVE;
    const logged = [];
    const origLog = console.log;
    console.log = (line) => logged.push(line);
    let emitted = 0;
    try {
      assert.doesNotThrow(() =>
        emitEventWithDowngrade(
          {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId: SESSION_ID,
            seq: 3,
            ts: Date.now(),
            type: 'run_recovered',
            payload: { originalRunId: 'run_a' }, // missing recoveryRunId/policy/markerAge
          },
          () => {
            emitted += 1;
          },
          new Set(),
        ),
      );
    } finally {
      console.log = origLog;
      if (prevStrict === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
      else process.env.PUSH_PROTOCOL_STRICT = prevStrict;
      if (prevObserve === undefined) delete process.env.PUSH_PROTOCOL_OBSERVE;
      else process.env.PUSH_PROTOCOL_OBSERVE = prevObserve;
    }
    const drift = logged
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((o) => o && o.event === 'protocol_drift_detected');
    assert.ok(drift, 'expected replay-path validation to log drift');
    assert.equal(drift.type, 'run_recovered');
    assert.equal(emitted, 1, 'event should still be emitted (fail-open)');
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

  function makeToolCardComplete(sessionId) {
    return {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId: 'run_tool_card',
      seq: 78,
      ts: Date.now(),
      type: 'tool.execution_complete',
      payload: {
        round: 1,
        executionId: 'exec_tool_card',
        toolName: 'ci_status',
        toolSource: 'github',
        durationMs: 12,
        isError: false,
        preview: '3 checks',
        card: { type: 'ci-status', data: { checks: 3 } },
      },
    };
  }

  it('strips cards from legacy clients while capable clients receive them live', async () => {
    const ctx = await startTestSession();
    try {
      const legacyEvents = [];
      const cardEvents = [];
      await handleRequest(
        makeRequest(
          'attach_session',
          { sessionId: ctx.sessionId, attachToken: ctx.attachToken },
          ctx.sessionId,
        ),
        (event) => legacyEvents.push(event),
      );
      await handleRequest(
        makeRequest(
          'attach_session',
          {
            sessionId: ctx.sessionId,
            attachToken: ctx.attachToken,
            capabilities: [TOOL_CARDS_V1],
          },
          ctx.sessionId,
        ),
        (event) => cardEvents.push(event),
      );

      const legacyBaseline = legacyEvents.length;
      const cardBaseline = cardEvents.length;
      const event = makeToolCardComplete(ctx.sessionId);
      broadcastEvent(ctx.sessionId, event);

      const legacy = legacyEvents.slice(legacyBaseline)[0];
      const capable = cardEvents.slice(cardBaseline)[0];
      assert.equal(Object.hasOwn(legacy.payload, 'card'), false);
      assert.deepEqual(capable.payload.card, event.payload.card);
      assert.deepEqual(event.payload.card, { type: 'ci-status', data: { checks: 3 } });
    } finally {
      await ctx.cleanup();
    }
  });

  it('applies the same card gate on replay without mutating the persisted event', () => {
    const event = makeToolCardComplete('sess_replay_cards_abcdef');
    const legacy = [];
    const capable = [];
    emitEventWithDowngrade(event, (value) => legacy.push(value), new Set());
    emitEventWithDowngrade(event, (value) => capable.push(value), new Set([TOOL_CARDS_V1]));
    assert.equal(Object.hasOwn(legacy[0].payload, 'card'), false);
    assert.deepEqual(capable[0].payload.card, event.payload.card);
    assert.ok(event.payload.card, 'the persisted event must keep its card');
  });

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

describe('update_session (daemon as source of truth for session-scoped state)', () => {
  async function startTestSession(emit = () => {}) {
    const start = await handleRequest(
      makeRequest('start_session', {
        provider: 'ollama',
        model: 'ollama-base',
        repo: { rootPath: process.cwd() },
      }),
      emit,
    );
    assert.equal(start.ok, true);
    return { sessionId: start.payload.sessionId, attachToken: start.payload.attachToken };
  }

  it('applies a model-only patch and returns the new state', async () => {
    const { sessionId, attachToken } = await startTestSession();
    const res = await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken, patch: { model: 'ollama-updated' } },
        sessionId,
      ),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.provider, 'ollama'); // unchanged
    assert.equal(res.payload.model, 'ollama-updated');
  });

  it('applies a provider+model patch atomically', async () => {
    const { sessionId, attachToken } = await startTestSession();
    const res = await handleRequest(
      makeRequest(
        'update_session',
        {
          sessionId,
          attachToken,
          patch: { provider: 'sakana', model: 'fugu' },
        },
        sessionId,
      ),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.provider, 'sakana');
    assert.equal(res.payload.model, 'fugu');
  });

  it('snaps model to the new provider default when patch omits model', async () => {
    const { sessionId, attachToken } = await startTestSession();
    const res = await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken, patch: { provider: 'sakana' } },
        sessionId,
      ),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.provider, 'sakana');
    // Old model would have been ollama-base; atomic-selection rule forbids
    // stranding it on the new provider, so it snaps to sakana's default.
    assert.notEqual(res.payload.model, 'ollama-base');
    assert.ok(typeof res.payload.model === 'string' && res.payload.model.length > 0);
  });

  it('rejects unknown providers with PROVIDER_NOT_CONFIGURED', async () => {
    const { sessionId, attachToken } = await startTestSession();
    const res = await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken, patch: { provider: 'definitely-not-real' } },
        sessionId,
      ),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'PROVIDER_NOT_CONFIGURED');
  });

  it('rejects empty/whitespace model strings with INVALID_REQUEST', async () => {
    const { sessionId, attachToken } = await startTestSession();
    const res = await handleRequest(
      makeRequest('update_session', { sessionId, attachToken, patch: { model: '   ' } }, sessionId),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_REQUEST');
  });

  it('rejects bad attach tokens with INVALID_TOKEN', async () => {
    const { sessionId } = await startTestSession();
    const res = await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken: 'wrong-token', patch: { model: 'something' } },
        sessionId,
      ),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_TOKEN');
  });

  it('rejects updates while a run is active with RUN_IN_PROGRESS', async () => {
    const { sessionId, attachToken } = await startTestSession();
    // Mark the session as running via the test hook so we don't need a
    // real provider round-trip.
    const entry = __getActiveSessionForTesting(sessionId);
    entry.activeRunId = 'run_fake_active';
    try {
      const res = await handleRequest(
        makeRequest(
          'update_session',
          { sessionId, attachToken, patch: { model: 'should-be-rejected' } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'RUN_IN_PROGRESS');
    } finally {
      entry.activeRunId = null;
    }
  });

  it('rejects updates with active delegations as RUN_IN_PROGRESS', async () => {
    // Delegations and task-graph executions share the session's
    // provider/model via `resolveRoleRouting` — a mid-flight patch
    // would swap the model under the running sub-agent.
    const { sessionId, attachToken } = await startTestSession();
    const entry = ensureRuntimeState(__getActiveSessionForTesting(sessionId));
    entry.activeDelegations.set('sub_in_flight', { promise: Promise.resolve() });
    try {
      const res = await handleRequest(
        makeRequest(
          'update_session',
          { sessionId, attachToken, patch: { model: 'should-be-rejected' } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'RUN_IN_PROGRESS');
      assert.match(res.error.message, /delegation/);
    } finally {
      entry.activeDelegations.delete('sub_in_flight');
    }
  });

  it('rejects updates with active task graphs as RUN_IN_PROGRESS', async () => {
    const { sessionId, attachToken } = await startTestSession();
    const entry = ensureRuntimeState(__getActiveSessionForTesting(sessionId));
    entry.activeGraphs.set('graph_in_flight', { promise: Promise.resolve() });
    try {
      const res = await handleRequest(
        makeRequest(
          'update_session',
          { sessionId, attachToken, patch: { model: 'should-be-rejected' } },
          sessionId,
        ),
        () => {},
      );
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'RUN_IN_PROGRESS');
      assert.match(res.error.message, /task graph/);
    } finally {
      entry.activeGraphs.delete('graph_in_flight');
    }
  });

  it('persists eventSeq across the broadcast so attach-replay does not skip the event', async () => {
    // Regression: `broadcastSessionStateChanged` calls
    // `appendSessionEvent` which bumps `state.eventSeq`. If the caller
    // saves session state BEFORE the broadcast, the on-disk
    // `state.json` keeps the old eventSeq and a reconnecting client
    // computes `currentSeq` from the stale disk value — filtering
    // this very event out of replay (`e.seq <= currentSeq`). Forcing
    // a disk reload via eviction proves the persisted seq matches the
    // emitted seq.
    const { sessionId, attachToken } = await startTestSession();
    const updateRes = await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken, patch: { model: 'replay-target' } },
        sessionId,
      ),
      () => {},
    );
    assert.equal(updateRes.ok, true);
    __evictActiveSessionForTesting(sessionId);
    // Attach asking for events strictly after seq 0 — without the fix,
    // the event lives at seq N on disk but state.json says
    // `eventSeq = N-1`, so the replay filter drops it.
    const replayed = [];
    const attachRes = await handleRequest(
      makeRequest('attach_session', { sessionId, attachToken, lastSeenSeq: 0 }, sessionId),
      (event) => replayed.push(event),
    );
    assert.equal(attachRes.ok, true);
    const change = replayed.find((e) => e.type === 'session_state_changed');
    assert.ok(
      change,
      `expected session_state_changed in replay after disk reload; saw ${replayed.map((e) => e.type).join(',')}`,
    );
    assert.equal(change.payload.model, 'replay-target');
  });

  it('returns SESSION_NOT_FOUND for unknown session ids', async () => {
    const res = await handleRequest(
      makeRequest(
        'update_session',
        { sessionId: 'sess_does_not_exist', patch: { model: 'x' } },
        'sess_does_not_exist',
      ),
      () => {},
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'SESSION_NOT_FOUND');
  });

  it('attach_session response carries the current provider and model', async () => {
    const { sessionId, attachToken } = await startTestSession();
    await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken, patch: { model: 'hydration-target' } },
        sessionId,
      ),
      () => {},
    );
    // Force lazy reload by evicting the in-memory entry so attach reads
    // back from disk — covers the "TUI reconnects after daemon restart"
    // case where the entry isn't already resident.
    __evictActiveSessionForTesting(sessionId);
    const res = await handleRequest(
      makeRequest('attach_session', { sessionId, attachToken }, sessionId),
      () => {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.provider, 'ollama');
    assert.equal(res.payload.model, 'hydration-target');
  });

  it('broadcasts session_state_changed to attached clients', async () => {
    const broadcasted = [];
    const emit = (event) => broadcasted.push(event);
    const { sessionId, attachToken } = await startTestSession(emit);
    await handleRequest(makeRequest('attach_session', { sessionId, attachToken }, sessionId), emit);
    broadcasted.length = 0; // ignore session_started / attach replay
    await handleRequest(
      makeRequest(
        'update_session',
        { sessionId, attachToken, patch: { model: 'broadcast-target' } },
        sessionId,
      ),
      emit,
    );
    const change = broadcasted.find((e) => e.type === 'session_state_changed');
    assert.ok(
      change,
      `expected session_state_changed in broadcast; saw ${broadcasted.map((e) => e.type).join(',')}`,
    );
    assert.equal(change.payload.provider, 'ollama');
    assert.equal(change.payload.model, 'broadcast-target');
    // No runId because state changes are session-level, not run-scoped.
    // Strict-mode forbids `runId: null` so the field must be absent.
    assert.ok(!('runId' in change) || typeof change.runId === 'string');
  });

  it('configure_role_routing also broadcasts session_state_changed', async () => {
    const broadcasted = [];
    const emit = (event) => broadcasted.push(event);
    const { sessionId, attachToken } = await startTestSession(emit);
    await handleRequest(makeRequest('attach_session', { sessionId, attachToken }, sessionId), emit);
    broadcasted.length = 0;
    const res = await handleRequest(
      makeRequest(
        'configure_role_routing',
        { sessionId, attachToken, routing: { coder: { provider: 'sakana' } } },
        sessionId,
      ),
      emit,
    );
    assert.equal(res.ok, true);
    const change = broadcasted.find((e) => e.type === 'session_state_changed');
    assert.ok(change, 'expected session_state_changed after configure_role_routing');
    assert.equal(change.payload.roleRouting.coder.provider, 'sakana');
  });
});

// Daemon protocol capability vocabulary drift (#745). The daemon advertises
// DAEMON_CAPABILITIES in `hello`; clients advertise subsets back. These are
// the canonical source of truth in `lib/daemon-capabilities.ts`. The TS type
// `DaemonCapability` already makes a client profile fail to compile if it names
// a capability the daemon doesn't advertise; these runtime pins guard the
// vocabulary itself and the subset relationships against a literal that bypasses
// types (cast / @ts-ignore), and document the contract.
describe('daemon capability vocabulary drift (#745)', () => {
  it('pins the advertised daemon capability set (removals/renames must be deliberate)', () => {
    assert.deepEqual(
      [...DAEMON_CAPABILITIES],
      [
        'stream_tokens',
        'approvals',
        'replay_attach',
        'session_snapshot_v1',
        'multi_client',
        'crash_recovery',
        'role_routing',
        'runtime_config_v1',
        'delegation_explorer_v1',
        'delegation_reviewer_v1',
        'delegation_deep_reviewer_v1',
        'delegation_coder_v1',
        'task_graph_v1',
        'event_v2',
        'multi_agent',
        'workspace_state_v1',
        'tool_cards_v1',
      ],
    );
  });

  it('has no duplicate capability strings', () => {
    assert.equal(new Set(DAEMON_CAPABILITIES).size, DAEMON_CAPABILITIES.length);
  });

  it('the daemon advertises exactly the canonical set in its hello handshake', async () => {
    const res = await handleRequest(makeRequest('hello', {}), () => {});
    assert.equal(res.ok, true);
    // pushd's CAPABILITIES is the canonical array; the handshake must surface it
    // verbatim so a client negotiates against the real set.
    assert.deepEqual([...res.payload.capabilities], [...DAEMON_CAPABILITIES]);
  });

  it('every client-advertised profile is a subset of the daemon set', () => {
    for (const profile of [TUI_DAEMON_CAPABILITIES, ATTACH_CLIENT_CAPABILITIES]) {
      for (const cap of profile) {
        assert.ok(
          isDaemonCapability(cap),
          `client advertises "${cap}" which the daemon does not — capability drift`,
        );
      }
    }
  });

  it('keeps the named EVENT_V2 constant in sync with the vocabulary', () => {
    assert.equal(EVENT_V2, 'event_v2');
    assert.ok(isDaemonCapability(EVENT_V2));
  });

  it('keeps the named WORKSPACE_STATE_V1 constant in sync with the vocabulary', () => {
    assert.equal(WORKSPACE_STATE_V1, 'workspace_state_v1');
    assert.ok(isDaemonCapability(WORKSPACE_STATE_V1));
  });

  it('keeps the named TOOL_CARDS_V1 constant in sync with the vocabulary', () => {
    assert.equal(TOOL_CARDS_V1, 'tool_cards_v1');
    assert.ok(isDaemonCapability(TOOL_CARDS_V1));
  });

  it('the TUI profile opts into reconnect snapshots, raw v2 events, and workspace state', () => {
    // Guards the specific contract the TUI source-guard test asserts on the
    // consumer side — pinned here against the canonical profile so the two
    // can't drift apart.
    assert.deepEqual(
      [...TUI_DAEMON_CAPABILITIES],
      ['event_v2', 'session_snapshot_v1', 'workspace_state_v1', 'tool_cards_v1'],
    );
  });

  it('the attach profile opts into raw v2 events and workspace state', () => {
    assert.deepEqual(
      [...ATTACH_CLIENT_CAPABILITIES],
      ['event_v2', 'workspace_state_v1', 'tool_cards_v1'],
    );
  });
});

// ─── daemon runtime config verbs ─────────────────────────────────

describe('daemon runtime config verbs', () => {
  let savedConfigPath;
  let savedExecMode;
  let savedWebSearchBackend;
  let tmpConfigDir;

  before(async () => {
    savedConfigPath = process.env.PUSH_CONFIG_PATH;
    savedExecMode = process.env.PUSH_EXEC_MODE;
    savedWebSearchBackend = process.env.PUSH_WEB_SEARCH_BACKEND;
    tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-runtime-cfg-'));
  });

  after(async () => {
    if (savedConfigPath === undefined) delete process.env.PUSH_CONFIG_PATH;
    else process.env.PUSH_CONFIG_PATH = savedConfigPath;
    if (savedExecMode === undefined) delete process.env.PUSH_EXEC_MODE;
    else process.env.PUSH_EXEC_MODE = savedExecMode;
    if (savedWebSearchBackend === undefined) delete process.env.PUSH_WEB_SEARCH_BACKEND;
    else process.env.PUSH_WEB_SEARCH_BACKEND = savedWebSearchBackend;
    await fs.rm(tmpConfigDir, { recursive: true, force: true });
  });

  it('reads the daemon process env first and maps exec mode to approval mode', async () => {
    const configPath = path.join(tmpConfigDir, 'read-config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ execMode: 'strict', webSearchBackend: 'tavily' }),
      'utf8',
    );
    process.env.PUSH_CONFIG_PATH = configPath;
    process.env.PUSH_EXEC_MODE = 'yolo';
    process.env.PUSH_WEB_SEARCH_BACKEND = 'duckduckgo';

    const res = await handleRequest(makeRequest('get_daemon_runtime_config', {}), () => {});

    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.execMode, 'yolo');
    assert.equal(res.payload.approvalMode, 'full-auto');
    assert.equal(res.payload.webSearchBackend, 'duckduckgo');
    assert.equal(res.payload.configPath, configPath);
  });

  it('persists updates and applies them to the running daemon env', async () => {
    const configPath = path.join(tmpConfigDir, 'write-config.json');
    await fs.writeFile(configPath, JSON.stringify({ provider: 'zen' }), 'utf8');
    process.env.PUSH_CONFIG_PATH = configPath;
    delete process.env.PUSH_EXEC_MODE;
    delete process.env.PUSH_WEB_SEARCH_BACKEND;

    const res = await handleRequest(
      makeRequest('set_daemon_runtime_config', {
        patch: { execMode: 'strict', webSearchBackend: 'ollama' },
      }),
      () => {},
    );

    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.execMode, 'strict');
    assert.equal(res.payload.approvalMode, 'supervised');
    assert.equal(res.payload.webSearchBackend, 'ollama');
    assert.equal(process.env.PUSH_EXEC_MODE, 'strict');
    assert.equal(process.env.PUSH_WEB_SEARCH_BACKEND, 'ollama');
    const stored = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(stored.provider, 'zen');
    assert.equal(stored.execMode, 'strict');
    assert.equal(stored.webSearchBackend, 'ollama');
  });

  it('rejects unsupported values without mutating config', async () => {
    const configPath = path.join(tmpConfigDir, 'invalid-config.json');
    await fs.writeFile(configPath, JSON.stringify({ execMode: 'auto' }), 'utf8');
    process.env.PUSH_CONFIG_PATH = configPath;

    const res = await handleRequest(
      makeRequest('set_daemon_runtime_config', {
        patch: { execMode: 'turbo' },
      }),
      () => {},
    );

    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_REQUEST');
    const stored = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(stored.execMode, 'auto');
  });

  it('refuses a relay-sourced write without mutating config (global safety posture, not session-scoped)', async () => {
    const configPath = path.join(tmpConfigDir, 'relay-refused-config.json');
    await fs.writeFile(configPath, JSON.stringify({ execMode: 'auto' }), 'utf8');
    process.env.PUSH_CONFIG_PATH = configPath;

    const res = await handleRequest(
      makeRequest('set_daemon_runtime_config', { patch: { execMode: 'yolo' } }),
      () => {},
      { auth: { kind: 'attach', tokenId: 'pdat_relay', boundOrigin: 'relay' } },
    );

    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
    const stored = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(stored.execMode, 'auto');
  });

  it('allows a loopback-WS write (a direct loopback connection is the operator, on this machine)', async () => {
    const configPath = path.join(tmpConfigDir, 'loopback-allowed-config.json');
    await fs.writeFile(configPath, JSON.stringify({ execMode: 'auto' }), 'utf8');
    process.env.PUSH_CONFIG_PATH = configPath;

    const res = await handleRequest(
      makeRequest('set_daemon_runtime_config', { patch: { execMode: 'yolo' } }),
      () => {},
      { auth: { kind: 'device', tokenId: 'pdt_local', boundOrigin: 'loopback' } },
    );

    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.equal(res.payload.execMode, 'yolo');
    const stored = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(stored.execMode, 'yolo');
  });
});

// ─── list_providers verb ─────────────────────────────────────────
//
// Read-only catalog powering Remote's model picker — the web
// client has no other way to know which providers/models are actually
// usable on the paired machine. Safe over relay: `hasKey` is boolean only.

describe('list_providers verb', () => {
  it('returns every configured provider with hasKey and curated models', async () => {
    const res = await handleRequest(makeRequest('list_providers', {}), () => {});

    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.ok(Array.isArray(res.payload.providers));
    assert.ok(res.payload.providers.length > 0);
    const ollama = res.payload.providers.find((p) => p.id === 'ollama');
    assert.ok(ollama, 'expected an ollama entry');
    assert.equal(typeof ollama.hasKey, 'boolean');
    assert.equal(typeof ollama.requiresKey, 'boolean');
    assert.equal(typeof ollama.defaultModel, 'string');
    assert.ok(Array.isArray(ollama.models));
    // No secret material — only a boolean flag.
    assert.ok(!('apiKey' in ollama));
  });

  it('allows relay-sourced reads (read-only, no secrets)', async () => {
    const res = await handleRequest(makeRequest('list_providers', {}), () => {}, {
      auth: { kind: 'attach', tokenId: 'pdat_relay', boundOrigin: 'relay' },
    });

    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.ok(Array.isArray(res.payload.providers));
  });
});

// ─── reload_config verb ─────────────────────────────────────────
//
// The TUI fires this after persisting a provider-key edit so a long-lived
// daemon (which inherited its key env at spawn, then resolves keys live from
// process.env per run) picks up the rotated key without a restart. The verb
// re-reads the on-disk config and force-overwrites the provider env.
describe('reload_config verb', () => {
  let savedConfigPath;
  let savedZenKey;
  let tmpConfigDir;

  before(async () => {
    savedConfigPath = process.env.PUSH_CONFIG_PATH;
    savedZenKey = process.env.PUSH_ZEN_API_KEY;
    tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-reload-cfg-'));
  });
  after(async () => {
    if (savedConfigPath === undefined) delete process.env.PUSH_CONFIG_PATH;
    else process.env.PUSH_CONFIG_PATH = savedConfigPath;
    if (savedZenKey === undefined) delete process.env.PUSH_ZEN_API_KEY;
    else process.env.PUSH_ZEN_API_KEY = savedZenKey;
    await fs.rm(tmpConfigDir, { recursive: true, force: true });
  });

  it('re-reads config.json and overwrites the stale provider key env', async () => {
    const configPath = path.join(tmpConfigDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ zen: { apiKey: 'sk-rotated' } }), 'utf8');
    process.env.PUSH_CONFIG_PATH = configPath;
    process.env.PUSH_ZEN_API_KEY = 'sk-stale'; // what the daemon inherited at spawn

    const res = await handleRequest(makeRequest('reload_config', {}), () => {});

    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error)}`);
    assert.ok(res.payload.refreshed.includes('PUSH_ZEN_API_KEY'));
    assert.equal(process.env.PUSH_ZEN_API_KEY, 'sk-rotated');
  });

  it('surfaces a structured error when the config is unreadable', async () => {
    // ENOENT is swallowed by loadConfig (returns {}), so point at a directory
    // to force a real read error (EISDIR) instead.
    process.env.PUSH_CONFIG_PATH = tmpConfigDir;

    const res = await handleRequest(makeRequest('reload_config', {}), () => {});

    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'CONFIG_READ_FAILED');
  });
});
