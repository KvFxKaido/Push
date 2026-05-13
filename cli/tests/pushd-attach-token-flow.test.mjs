/**
 * pushd-attach-token-flow.test.mjs — End-to-end coverage for the
 * Phase 3 slice 2 attach-token flow: WS upgrade accepts both kinds,
 * cascade revoke fans out, single-attach revoke is narrow, and
 * `daemon_identify` surfaces the parent device + auth kind.
 *
 * Drives a real `startPushdWs` listener against `ws` clients so the
 * subprotocol auth path is exercised in full.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { startPushdWs } from '../pushd-ws.ts';
import { mintDeviceToken } from '../pushd-device-tokens.ts';
import { mintDeviceAttachToken } from '../pushd-attach-tokens.ts';

let tmpDir;
let tokensPath;
let attachTokensPath;
let portPath;
let handle;
const originalTokensEnv = process.env.PUSHD_TOKENS_PATH;
const originalAttachEnv = process.env.PUSHD_ATTACH_TOKENS_PATH;
const originalPortEnv = process.env.PUSHD_PORT_PATH;

const stubDeps = {
  handleRequest: async (req) => ({
    v: 'push.runtime.v1',
    kind: 'response',
    requestId: req.requestId,
    type: req.type,
    sessionId: req.sessionId ?? null,
    ok: true,
    payload: { echo: req.type },
    error: null,
  }),
  addSessionClient: () => {},
  removeSessionClient: () => {},
  makeErrorResponse: (requestId, type, code, message) => ({
    v: 'push.runtime.v1',
    kind: 'response',
    requestId,
    type,
    sessionId: null,
    ok: false,
    payload: {},
    error: { code, message, retryable: false },
  }),
  makeRequestId: () => `req_test_${Math.random().toString(36).slice(2, 8)}`,
};

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-attach-flow-'));
  tokensPath = path.join(tmpDir, 'pushd.tokens');
  attachTokensPath = path.join(tmpDir, 'pushd.attach-tokens');
  portPath = path.join(tmpDir, 'pushd.port');
  process.env.PUSHD_TOKENS_PATH = tokensPath;
  process.env.PUSHD_ATTACH_TOKENS_PATH = attachTokensPath;
  process.env.PUSHD_PORT_PATH = portPath;
  handle = await startPushdWs(stubDeps, { portFilePath: portPath });
});

after(async () => {
  await handle?.close();
  if (originalTokensEnv === undefined) delete process.env.PUSHD_TOKENS_PATH;
  else process.env.PUSHD_TOKENS_PATH = originalTokensEnv;
  if (originalAttachEnv === undefined) delete process.env.PUSHD_ATTACH_TOKENS_PATH;
  else process.env.PUSHD_ATTACH_TOKENS_PATH = originalAttachEnv;
  if (originalPortEnv === undefined) delete process.env.PUSHD_PORT_PATH;
  else process.env.PUSHD_PORT_PATH = originalPortEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(tokensPath, { force: true });
  await fs.rm(attachTokensPath, { force: true });
});

function wsUrl() {
  return `ws://127.0.0.1:${handle.port}`;
}

function openWs({ token, origin = 'http://localhost:5173' }) {
  const headers = { Authorization: `Bearer ${token}` };
  if (origin !== undefined) headers.Origin = origin;
  return new WebSocket(wsUrl(), { headers });
}

async function openAndWaitOpen({ token, origin }) {
  const ws = openWs({ token, origin });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function waitForUpgradeOutcome(ws) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    ws.on('open', () => settle({ kind: 'open' }));
    ws.on('unexpected-response', (_req, res) => {
      settle({ kind: 'rejected', statusCode: res.statusCode });
      res.resume();
    });
    ws.on('error', (err) => settle({ kind: 'error', error: err }));
  });
}

function closeAndWait(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.once('error', () => resolve());
    try {
      ws.close();
    } catch {
      resolve();
    }
  });
}

describe('WS auth accepts both device and attach tokens', () => {
  it('accepts a valid device-attach token + matching origin', async () => {
    const { tokenId: parentId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const { token: attachToken } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'loopback',
    });
    const ws = openWs({ token: attachToken, origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'open');
    await closeAndWait(ws);
  });

  it('still accepts the durable device token (back-compat for pre-mint clients)', async () => {
    const { token: deviceToken } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const ws = openWs({ token: deviceToken, origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'open');
    await closeAndWait(ws);
  });

  it('rejects an attach token whose origin does not match', async () => {
    const { tokenId: parentId } = await mintDeviceToken({
      boundOrigin: 'https://push.zen-dev.com',
    });
    const { token: attachToken } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'https://push.zen-dev.com',
    });
    const ws = openWs({ token: attachToken, origin: 'https://evil.example' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 403);
  });

  it('rejects an expired attach token (sliding TTL)', async () => {
    const originalTtl = process.env.PUSHD_ATTACH_TOKEN_TTL_MS;
    process.env.PUSHD_ATTACH_TOKEN_TTL_MS = '20';
    try {
      const { tokenId: parentId } = await mintDeviceToken({ boundOrigin: 'loopback' });
      const { token: attachToken } = await mintDeviceAttachToken({
        parentTokenId: parentId,
        boundOrigin: 'loopback',
      });
      // Sleep past the TTL.
      await new Promise((r) => setTimeout(r, 50));
      const ws = openWs({ token: attachToken, origin: 'http://localhost:5173' });
      const outcome = await waitForUpgradeOutcome(ws);
      assert.equal(outcome.kind, 'rejected');
      assert.equal(outcome.statusCode, 401);
    } finally {
      if (originalTtl === undefined) delete process.env.PUSHD_ATTACH_TOKEN_TTL_MS;
      else process.env.PUSHD_ATTACH_TOKEN_TTL_MS = originalTtl;
    }
  });
});

describe('listConnectedDevices groups attach + device under the parent device', () => {
  it('reports one row per parent device with the auth-kind split', async () => {
    const { tokenId: parentId, token: deviceToken } = await mintDeviceToken({
      boundOrigin: 'loopback',
    });
    const { token: attachToken1 } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'loopback',
    });
    const { token: attachToken2 } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'loopback',
    });
    const ws1 = await openAndWaitOpen({ token: deviceToken });
    const ws2 = await openAndWaitOpen({ token: attachToken1 });
    const ws3 = await openAndWaitOpen({ token: attachToken2 });
    try {
      const rows = handle.listConnectedDevices();
      const row = rows.find((r) => r.tokenId === parentId);
      assert.ok(row, 'parent device should appear once');
      assert.equal(row.connections, 3);
      assert.equal(row.deviceConnections, 1);
      assert.equal(row.attachConnections, 2);
    } finally {
      await closeAndWait(ws1);
      await closeAndWait(ws2);
      await closeAndWait(ws3);
    }
  });
});

describe('disconnectByTokenId cascades across attach children', () => {
  it('closes both device-token and attach-token connections for the same parent', async () => {
    const { tokenId: parentId, token: deviceToken } = await mintDeviceToken({
      boundOrigin: 'loopback',
    });
    const { token: attachToken } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'loopback',
    });
    const wsD = await openAndWaitOpen({ token: deviceToken });
    const wsA = await openAndWaitOpen({ token: attachToken });
    const dClose = new Promise((resolve) => wsD.once('close', (code) => resolve(code)));
    const aClose = new Promise((resolve) => wsA.once('close', (code) => resolve(code)));
    const closed = handle.disconnectByTokenId(parentId, 'cascade');
    assert.equal(closed, 2);
    const [dCode, aCode] = await Promise.all([dClose, aClose]);
    assert.equal(dCode, 1008);
    assert.equal(aCode, 1008);
  });

  it('does not affect other parent devices', async () => {
    const { tokenId: parentA, token: deviceA } = await mintDeviceToken({
      boundOrigin: 'loopback',
    });
    const { token: deviceB } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const wsA = await openAndWaitOpen({ token: deviceA });
    const wsB = await openAndWaitOpen({ token: deviceB });
    try {
      handle.disconnectByTokenId(parentA, 'targeted');
      await new Promise((r) => setTimeout(r, 50));
      const rows = handle.listConnectedDevices();
      assert.equal(
        rows.some((r) => r.tokenId === parentA),
        false,
      );
      assert.ok(
        rows.some((r) => r.deviceConnections > 0),
        'B unaffected',
      );
    } finally {
      await closeAndWait(wsB);
    }
  });
});

describe('disconnectByAttachTokenId is narrow', () => {
  it('closes only the WS bearing the specific attach token', async () => {
    const { tokenId: parentId, token: deviceToken } = await mintDeviceToken({
      boundOrigin: 'loopback',
    });
    const { token: attachA, tokenId: attachAId } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'loopback',
    });
    const { token: attachB } = await mintDeviceAttachToken({
      parentTokenId: parentId,
      boundOrigin: 'loopback',
    });
    const wsD = await openAndWaitOpen({ token: deviceToken });
    const wsA = await openAndWaitOpen({ token: attachA });
    const wsB = await openAndWaitOpen({ token: attachB });
    const aClose = new Promise((resolve) => wsA.once('close', (code) => resolve(code)));
    try {
      const closed = handle.disconnectByAttachTokenId(attachAId, 'targeted attach revoke');
      assert.equal(closed, 1);
      const code = await aClose;
      assert.equal(code, 1008);
      // Other connections must survive — give the close handler a tick
      // to deregister, then check the registry.
      await new Promise((r) => setTimeout(r, 50));
      const rows = handle.listConnectedDevices();
      const row = rows.find((r) => r.tokenId === parentId);
      assert.ok(row, 'parent still present');
      assert.equal(row.deviceConnections, 1);
      assert.equal(row.attachConnections, 1);
    } finally {
      await closeAndWait(wsD);
      await closeAndWait(wsB);
    }
  });

  it('returns 0 when the attach tokenId has no live connection', () => {
    const closed = handle.disconnectByAttachTokenId('pdat_does_not_exist', 'none');
    assert.equal(closed, 0);
  });
});
