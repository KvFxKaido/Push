/**
 * pushd-device-admin.test.mjs — Coverage for the Phase 3 daemon
 * admin handlers: `revoke_device_token` and `list_devices`. These
 * are the Unix-socket-only endpoints the `push daemon revoke` / `push
 * daemon devices` CLI commands call into the running daemon.
 *
 * The tests drive `handleRequest` directly (the same shape the
 * Unix-socket adapter uses) and confirm:
 *   - revoke_device_token mutates the tokens file
 *   - revoke_device_token refuses requests carrying a WS-authenticated
 *     record (cross-device admin is not authorized)
 *   - list_devices reports `wsListenerActive: false` when the WS
 *     listener never started (no activeWsHandle in the process)
 *   - invalid inputs produce structured errors
 *
 * NB: live disconnect of an open WS via `disconnectByTokenId` is
 * covered in `pushd-ws.test.mjs` against the WS handle directly; this
 * test exercises the daemon-side wiring path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleRequest } from '../pushd.ts';
import { mintDeviceToken, listDeviceTokens } from '../pushd-device-tokens.ts';
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

let tmpDir;
let originalTokensEnv;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-device-admin-'));
  originalTokensEnv = process.env.PUSHD_TOKENS_PATH;
  process.env.PUSHD_TOKENS_PATH = path.join(tmpDir, 'pushd.tokens');
});

afterEach(async () => {
  if (originalTokensEnv === undefined) delete process.env.PUSHD_TOKENS_PATH;
  else process.env.PUSHD_TOKENS_PATH = originalTokensEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('revoke_device_token', () => {
  it('mutates the tokens file and returns closedConnections: 0 when no WS is up', async () => {
    const { tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const res = await handleRequest(makeRequest('revoke_device_token', { tokenId }), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.payload.tokenId, tokenId);
    // No WS listener active in this test process → 0 live connections
    // to close. The file mutation still happened.
    assert.equal(res.payload.closedConnections, 0);
    const remaining = await listDeviceTokens();
    assert.equal(
      remaining.some((r) => r.tokenId === tokenId),
      false,
    );
  });

  it('refuses when called with a WS-authenticated context (cross-device admin denied)', async () => {
    const { tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const res = await handleRequest(makeRequest('revoke_device_token', { tokenId }), NOOP_EMIT, {
      record: {
        tokenId: 'pdt_other',
        boundOrigin: 'loopback',
        tokenHash: 'x',
        createdAt: 0,
        lastUsedAt: null,
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
    // The token must still exist — the refusal cannot have side
    // effects on the tokens file. This is the load-bearing guard
    // against a paired device revoking another paired device.
    const remaining = await listDeviceTokens();
    assert.equal(
      remaining.some((r) => r.tokenId === tokenId),
      true,
    );
  });

  it('returns TOKEN_NOT_FOUND for an unknown tokenId', async () => {
    const res = await handleRequest(
      makeRequest('revoke_device_token', { tokenId: 'pdt_does_not_exist' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TOKEN_NOT_FOUND');
  });

  it('returns INVALID_REQUEST when tokenId is missing', async () => {
    const res = await handleRequest(makeRequest('revoke_device_token', {}), NOOP_EMIT);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_REQUEST');
  });
});

describe('list_devices', () => {
  it('reports wsListenerActive: false when no WS listener is running', async () => {
    // The test process doesn't boot pushd's WS listener — the handler
    // surfaces that explicitly so the CLI can render "daemon offline"
    // instead of an empty-list false negative.
    const res = await handleRequest(makeRequest('list_devices'), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.payload.wsListenerActive, false);
    assert.deepEqual(res.payload.devices, []);
  });

  it('refuses when called over the WS transport (cross-device admin)', async () => {
    const res = await handleRequest(makeRequest('list_devices'), NOOP_EMIT, {
      record: {
        tokenId: 'pdt_caller',
        boundOrigin: 'loopback',
        tokenHash: 'x',
        createdAt: 0,
        lastUsedAt: null,
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });
});
