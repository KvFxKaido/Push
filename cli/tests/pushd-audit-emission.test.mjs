/**
 * pushd-audit-emission.test.mjs — Integration coverage for the
 * Phase 3 slice 3 audit-log emission wiring.
 *
 * Drives `handleRequest` directly (Unix-socket-shaped) for the file
 * ops, mint, revoke, and session lifecycle handlers and asserts that
 * each one drops a structured audit record. The dispatcher-level
 * emission for delegate.* / session.* / tool.sandbox_{read,write,
 * list,diff} flows through the wrapper introduced in slice 3; the
 * sandbox_exec / mint / revoke handlers emit at a finer grain
 * themselves.
 *
 * NB: events are appended via a serialized in-process queue, so the
 * test awaits a short tick after each `handleRequest` to let the
 * append complete before reading the log.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleRequest } from '../pushd.ts';
import { mintDeviceToken } from '../pushd-device-tokens.ts';
import { mintDeviceAttachToken } from '../pushd-attach-tokens.ts';
import { readAuditEvents } from '../pushd-audit-log.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

const NOOP_EMIT = () => {};

function makeRequest(type, payload = {}, sessionId = null) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    sessionId,
    payload,
  };
}

let tmpDir;
let originalEnv = {};
let originalCwd;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-audit-em-'));
  originalCwd = process.cwd();
  originalEnv = {
    PUSHD_TOKENS_PATH: process.env.PUSHD_TOKENS_PATH,
    PUSHD_ATTACH_TOKENS_PATH: process.env.PUSHD_ATTACH_TOKENS_PATH,
    PUSHD_AUDIT_LOG_PATH: process.env.PUSHD_AUDIT_LOG_PATH,
    PUSHD_AUDIT_LOG_COMMANDS: process.env.PUSHD_AUDIT_LOG_COMMANDS,
  };
  process.env.PUSHD_TOKENS_PATH = path.join(tmpDir, 'pushd.tokens');
  process.env.PUSHD_ATTACH_TOKENS_PATH = path.join(tmpDir, 'pushd.attach-tokens');
  process.env.PUSHD_AUDIT_LOG_PATH = path.join(tmpDir, 'pushd.audit.log');
  delete process.env.PUSHD_AUDIT_LOG_COMMANDS;
  // Run handlers inside the tmp dir so allowlist enforcement permits
  // path operations (implicit-cwd default).
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Audit appends run through a serialized in-process queue. Awaiting a
// macrotask ensures every pending append has flushed by the time the
// test reads the log. Without this, fast assertions can race the
// queue and observe an empty file.
async function flushAuditQueue() {
  await new Promise((r) => setTimeout(r, 30));
}

describe('tool.sandbox_exec', () => {
  it('emits a structural record without the command text by default', async () => {
    await handleRequest(
      makeRequest('sandbox_exec', { command: 'echo hello secret-token', runId: 'run_abc' }),
      NOOP_EMIT,
    );
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'tool.sandbox_exec' });
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.surface, 'unix-socket');
    assert.equal(e.runId, 'run_abc');
    assert.equal(typeof e.payload.cwd, 'string');
    assert.equal(typeof e.payload.exitCode, 'number');
    assert.equal(typeof e.payload.durationMs, 'number');
    assert.equal(e.payload.cancelled, false);
    // Command text MUST NOT appear in the structural-only default.
    assert.equal(e.payload.command, undefined);
  });

  it('includes the command text when PUSHD_AUDIT_LOG_COMMANDS=1', async () => {
    process.env.PUSHD_AUDIT_LOG_COMMANDS = '1';
    await handleRequest(makeRequest('sandbox_exec', { command: 'echo opt-in-payload' }), NOOP_EMIT);
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'tool.sandbox_exec' });
    assert.equal(events.length, 1);
    assert.match(events[0].payload.command, /opt-in-payload/);
  });
});

describe('tool.sandbox_{read,write,list,diff}', () => {
  it('emits a tool.sandbox_read_file event with path + ok', async () => {
    await fs.writeFile(path.join(tmpDir, 'sample.txt'), 'hi', 'utf8');
    await handleRequest(makeRequest('sandbox_read_file', { path: 'sample.txt' }), NOOP_EMIT);
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'tool.sandbox_read_file' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.path, 'sample.txt');
    assert.equal(events[0].payload.ok, true);
  });

  it('emits a tool.sandbox_write_file event', async () => {
    await handleRequest(
      makeRequest('sandbox_write_file', { path: 'out.txt', content: 'content' }),
      NOOP_EMIT,
    );
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'tool.sandbox_write_file' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.path, 'out.txt');
    assert.equal(events[0].payload.ok, true);
  });

  it('emits a tool.sandbox_list_dir event', async () => {
    await handleRequest(makeRequest('sandbox_list_dir', { path: '.' }), NOOP_EMIT);
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'tool.sandbox_list_dir' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.path, '.');
  });

  it('records errorCode when the operation fails (e.g. INVALID_REQUEST)', async () => {
    await handleRequest(makeRequest('sandbox_read_file', {}), NOOP_EMIT);
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'tool.sandbox_read_file' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.ok, false);
    assert.equal(events[0].payload.errorCode, 'INVALID_REQUEST');
  });
});

describe('auth.{mint_attach,revoke_device,revoke_attach}', () => {
  function deviceAuth(tokenId = 'pdt_audit_caller') {
    return {
      kind: 'device',
      tokenId,
      parentDeviceTokenId: tokenId,
      boundOrigin: 'loopback',
      lastUsedAt: null,
      deviceRecord: {
        tokenId,
        tokenHash: 'x',
        boundOrigin: 'loopback',
        createdAt: 0,
        lastUsedAt: null,
      },
    };
  }

  it('emits auth.mint_attach with the parent + minted tokenId', async () => {
    const auth = deviceAuth('pdt_audit_parent');
    await handleRequest(makeRequest('mint_device_attach_token', {}), NOOP_EMIT, {
      auth,
      record: auth.deviceRecord,
    });
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'auth.mint_attach' });
    assert.equal(events.length, 1);
    assert.equal(events[0].surface, 'ws');
    assert.equal(events[0].deviceId, 'pdt_audit_parent');
    assert.equal(events[0].payload.parentTokenId, 'pdt_audit_parent');
    assert.match(events[0].payload.mintedTokenId, /^pdat_/);
  });

  it('emits auth.revoke_device with closedConnections + cascade list', async () => {
    const { tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    await mintDeviceAttachToken({ parentTokenId: tokenId, boundOrigin: 'loopback' });
    await handleRequest(makeRequest('revoke_device_token', { tokenId }), NOOP_EMIT);
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'auth.revoke_device' });
    assert.equal(events.length, 1);
    assert.equal(events[0].surface, 'unix-socket');
    assert.equal(events[0].payload.tokenId, tokenId);
    assert.equal(events[0].payload.revokedAttachTokens.length, 1);
  });

  it('emits auth.revoke_attach', async () => {
    const minted = await mintDeviceAttachToken({
      parentTokenId: 'pdt_audit_parent',
      boundOrigin: 'loopback',
    });
    await handleRequest(
      makeRequest('revoke_device_attach_token', { tokenId: minted.tokenId }),
      NOOP_EMIT,
    );
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'auth.revoke_attach' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.tokenId, minted.tokenId);
  });
});

describe('session.{start,cancel_run}', () => {
  it('emits session.cancel_run with the runId and ok flag', async () => {
    // No active session → handler returns INVALID_REQUEST (or
    // SESSION_NOT_FOUND). The audit emission is what we're pinning,
    // not the handler outcome.
    await handleRequest(
      makeRequest('cancel_run', { sessionId: 'sess_x', runId: 'run_y' }),
      NOOP_EMIT,
    );
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'session.cancel_run' });
    assert.equal(events.length, 1);
    assert.equal(events[0].runId, 'run_y');
    assert.equal(events[0].sessionId, 'sess_x');
    assert.equal(events[0].payload.ok, false);
    assert.ok(events[0].payload.errorCode);
  });
});

describe('delegate.* taskExcerpt privacy', () => {
  // The delegate handlers themselves require a full daemon setup
  // (sessions, providers, etc.) that's outside the scope of an
  // emission-wiring test. Validate the privacy contract by asserting
  // the audit row's payload directly: when PUSHD_AUDIT_LOG_COMMANDS
  // is unset, `taskExcerpt` is undefined regardless of the input
  // `task` field. When set, the truncated excerpt rides through.
  // The handler returns an error (no real session) but the audit
  // row is emitted via the dispatcher wrapper either way.
  it('omits taskExcerpt by default', async () => {
    await handleRequest(
      makeRequest('delegate_coder', { task: 'task-with-secret-token' }),
      NOOP_EMIT,
    );
    await flushAuditQueue();
    const events = await readAuditEvents({ type: 'delegate.coder' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.taskExcerpt, undefined);
  });

  it('includes the truncated taskExcerpt when PUSHD_AUDIT_LOG_COMMANDS=1', async () => {
    process.env.PUSHD_AUDIT_LOG_COMMANDS = '1';
    try {
      await handleRequest(
        makeRequest('delegate_coder', { task: 'task-with-marker-XYZ' }),
        NOOP_EMIT,
      );
      await flushAuditQueue();
      const events = await readAuditEvents({ type: 'delegate.coder' });
      assert.equal(events.length, 1);
      assert.match(events[0].payload.taskExcerpt ?? '', /marker-XYZ/);
    } finally {
      delete process.env.PUSHD_AUDIT_LOG_COMMANDS;
    }
  });
});

describe('audit-log kill switch', () => {
  it('no events are recorded when PUSHD_AUDIT_ENABLED=0', async () => {
    const original = process.env.PUSHD_AUDIT_ENABLED;
    process.env.PUSHD_AUDIT_ENABLED = '0';
    try {
      await handleRequest(makeRequest('sandbox_exec', { command: 'true' }), NOOP_EMIT);
      await flushAuditQueue();
      // The log file shouldn't exist at all when fully disabled.
      const exists = await fs
        .stat(process.env.PUSHD_AUDIT_LOG_PATH)
        .then(() => true)
        .catch(() => false);
      assert.equal(exists, false);
    } finally {
      if (original === undefined) delete process.env.PUSHD_AUDIT_ENABLED;
      else process.env.PUSHD_AUDIT_ENABLED = original;
    }
  });
});
