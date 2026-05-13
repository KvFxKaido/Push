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
import {
  mintDeviceAttachToken,
  listDeviceAttachTokens,
  verifyDeviceAttachToken,
} from '../pushd-attach-tokens.ts';
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
let originalAttachEnv;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-device-admin-'));
  originalTokensEnv = process.env.PUSHD_TOKENS_PATH;
  originalAttachEnv = process.env.PUSHD_ATTACH_TOKENS_PATH;
  process.env.PUSHD_TOKENS_PATH = path.join(tmpDir, 'pushd.tokens');
  process.env.PUSHD_ATTACH_TOKENS_PATH = path.join(tmpDir, 'pushd.attach-tokens');
});

afterEach(async () => {
  if (originalTokensEnv === undefined) delete process.env.PUSHD_TOKENS_PATH;
  else process.env.PUSHD_TOKENS_PATH = originalTokensEnv;
  if (originalAttachEnv === undefined) delete process.env.PUSHD_ATTACH_TOKENS_PATH;
  else process.env.PUSHD_ATTACH_TOKENS_PATH = originalAttachEnv;
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

// ─── Phase 3 slice 2: attach-token admin handlers ────────────────

function deviceAuth(tokenId = 'pdt_test_caller') {
  // Synthesizes a WS-context-shaped `auth` for tests that need to
  // invoke handlers as if they were called over a real WS upgrade.
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

function attachAuth(tokenId, parentTokenId) {
  return {
    kind: 'attach',
    tokenId,
    parentDeviceTokenId: parentTokenId,
    boundOrigin: 'loopback',
    lastUsedAt: null,
    deviceRecord: null,
  };
}

describe('mint_device_attach_token', () => {
  it('mints from a device-token-authed WS and returns the secret + ttl', async () => {
    const auth = deviceAuth('pdt_parent_1');
    const res = await handleRequest(makeRequest('mint_device_attach_token', {}), NOOP_EMIT, {
      auth,
      record: auth.deviceRecord,
    });
    assert.equal(res.ok, true);
    assert.match(res.payload.token, /^pushd_da_/);
    assert.match(res.payload.tokenId, /^pdat_/);
    assert.equal(res.payload.parentTokenId, 'pdt_parent_1');
    assert.equal(typeof res.payload.ttlMs, 'number');
    // The minted token must verify against the parent.
    const verified = await verifyDeviceAttachToken(res.payload.token);
    assert.ok(verified);
    assert.equal(verified.parentTokenId, 'pdt_parent_1');
  });

  it('refuses when called over the Unix-socket admin transport (no WS context)', async () => {
    const res = await handleRequest(makeRequest('mint_device_attach_token', {}), NOOP_EMIT);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });

  it('refuses when the WS authed with an attach token (no privilege escalation)', async () => {
    const res = await handleRequest(makeRequest('mint_device_attach_token', {}), NOOP_EMIT, {
      auth: attachAuth('pdat_caller', 'pdt_parent_1'),
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'DEVICE_TOKEN_REQUIRED');
  });
});

describe('revoke_device_attach_token', () => {
  it('revokes an attach token by id', async () => {
    const minted = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const res = await handleRequest(
      makeRequest('revoke_device_attach_token', { tokenId: minted.tokenId }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.tokenId, minted.tokenId);
    // The revoked token must no longer verify.
    assert.equal(await verifyDeviceAttachToken(minted.token), null);
  });

  it('returns TOKEN_NOT_FOUND for an unknown attach tokenId', async () => {
    const res = await handleRequest(
      makeRequest('revoke_device_attach_token', { tokenId: 'pdat_does_not_exist' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TOKEN_NOT_FOUND');
  });

  it('refuses when called over the WS transport (cross-device admin)', async () => {
    const res = await handleRequest(
      makeRequest('revoke_device_attach_token', { tokenId: 'pdat_caller' }),
      NOOP_EMIT,
      { auth: deviceAuth('pdt_caller') },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });
});

describe('revoke_device_token cascade', () => {
  it('revokes the parent + every attach token derived from it', async () => {
    const { tokenId: parentId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const a = await mintDeviceAttachToken({ parentTokenId: parentId, boundOrigin: 'loopback' });
    const b = await mintDeviceAttachToken({ parentTokenId: parentId, boundOrigin: 'loopback' });
    const otherParent = await mintDeviceToken({ boundOrigin: 'loopback' });
    const survivor = await mintDeviceAttachToken({
      parentTokenId: otherParent.tokenId,
      boundOrigin: 'loopback',
    });
    const res = await handleRequest(
      makeRequest('revoke_device_token', { tokenId: parentId }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    const revokedIds = res.payload.revokedAttachTokens;
    assert.equal(revokedIds.length, 2);
    assert.ok(revokedIds.includes(a.tokenId));
    assert.ok(revokedIds.includes(b.tokenId));
    // Survivor's attach token (different parent) must still verify.
    assert.ok(await verifyDeviceAttachToken(survivor.token));
    // Cascade victims must NOT verify.
    assert.equal(await verifyDeviceAttachToken(a.token), null);
    assert.equal(await verifyDeviceAttachToken(b.token), null);
  });
});

describe('list_attach_tokens', () => {
  it('returns active tokens with the parent linkage', async () => {
    const a = await mintDeviceAttachToken({
      parentTokenId: 'pdt_parent_1',
      boundOrigin: 'loopback',
    });
    const res = await handleRequest(makeRequest('list_attach_tokens'), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(typeof res.payload.ttlMs, 'number');
    const row = res.payload.tokens.find((t) => t.tokenId === a.tokenId);
    assert.ok(row);
    assert.equal(row.parentTokenId, 'pdt_parent_1');
    assert.equal(row.boundOrigin, 'loopback');
  });

  it('refuses when called over the WS transport', async () => {
    const res = await handleRequest(makeRequest('list_attach_tokens'), NOOP_EMIT, {
      auth: deviceAuth('pdt_caller'),
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNSUPPORTED_VIA_TRANSPORT');
  });
});
