/**
 * pushd-sandbox-exec.test.mjs — Coverage for the WS-reachable
 * `sandbox_exec` and `daemon_identify` request handlers added in
 * PR 3c.1 of the remote-sessions track. Drives `handleRequest`
 * directly (Unix-socket-compatible signature) so the dispatcher
 * path is exercised alongside the per-handler logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../pushd.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

const NOOP_EMIT = () => {};

function makeRequest(type, payload = {}) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    sessionId: null,
    payload,
  };
}

describe('sandbox_exec', () => {
  it('runs a successful command and returns exit code 0 with captured stdout', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'echo hello-3c1' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true, 'RPC should succeed');
    assert.equal(res.type, 'sandbox_exec');
    assert.equal(res.payload.exitCode, 0);
    assert.match(res.payload.stdout, /hello-3c1/);
    assert.equal(typeof res.payload.durationMs, 'number');
    assert.equal(res.payload.truncated, false);
  });

  it('reports a non-zero exit code without flipping ok to false', async () => {
    // Non-zero exits are normal results, not RPC failures — the model
    // needs to see the exit code to diagnose. Forcing ok=false here
    // would conflate "transport failed" with "command failed."
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'sh -c "exit 7"' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true, 'RPC succeeded — the command ran');
    assert.equal(res.payload.exitCode, 7);
  });

  it('rejects an empty or missing command with INVALID_REQUEST', async () => {
    const missing = await handleRequest(makeRequest('sandbox_exec', {}), NOOP_EMIT);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'INVALID_REQUEST');

    const empty = await handleRequest(makeRequest('sandbox_exec', { command: '' }), NOOP_EMIT);
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, 'INVALID_REQUEST');
  });

  it('respects timeoutMs and surfaces timedOut: true on kill', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_exec', { command: 'sleep 10', timeoutMs: 1_000 }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true, 'RPC succeeded — the command ran but was killed');
    assert.equal(res.payload.timedOut, true);
    // The timer-kill exit code varies by platform; 124 is the shell
    // convention for timeout, but a SIGTERM-killed Node child may
    // surface as `null` → coerced to 124 in the handler. Either way
    // it's non-zero.
    assert.notEqual(res.payload.exitCode, 0);
  });

  it('runs in the daemon process cwd by default', async () => {
    const res = await handleRequest(makeRequest('sandbox_exec', { command: 'pwd' }), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.payload.exitCode, 0);
    // Trim trailing newline; pwd may add one.
    assert.equal(res.payload.stdout.trim(), process.cwd());
  });
});

describe('daemon_identify', () => {
  it('returns the bound identity when the WS transport supplies a record', async () => {
    const record = {
      tokenId: 'pdt_test_12345',
      boundOrigin: 'http://localhost:5173',
      tokenHash: 'irrelevant',
      createdAt: 0,
      lastUsedAt: null,
    };
    const res = await handleRequest(makeRequest('daemon_identify'), NOOP_EMIT, { record });
    assert.equal(res.ok, true);
    assert.equal(res.payload.tokenId, 'pdt_test_12345');
    assert.equal(res.payload.boundOrigin, 'http://localhost:5173');
    assert.equal(typeof res.payload.daemonVersion, 'string');
    assert.equal(res.payload.protocolVersion, PROTOCOL_VERSION);
  });

  it('refuses without a context record (Unix-socket transport)', async () => {
    // The Unix-socket caller doesn't pass context. daemon_identify is
    // meaningful only over an authenticated WS upgrade.
    const res = await handleRequest(makeRequest('daemon_identify'), NOOP_EMIT);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });

  it('refuses when context lacks a tokenId field', async () => {
    const res = await handleRequest(makeRequest('daemon_identify'), NOOP_EMIT, { record: {} });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });
});
