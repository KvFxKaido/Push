import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { startPushdWs } from '../pushd-ws.ts';
import { mintDeviceToken, revokeDeviceToken } from '../pushd-device-tokens.ts';

let tmpDir;
let tokensPath;
let portPath;
let handle;
const originalTokensEnv = process.env.PUSHD_TOKENS_PATH;
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-ws-'));
  tokensPath = path.join(tmpDir, 'pushd.tokens');
  portPath = path.join(tmpDir, 'pushd.port');
  process.env.PUSHD_TOKENS_PATH = tokensPath;
  process.env.PUSHD_PORT_PATH = portPath;
  handle = await startPushdWs(stubDeps, { portFilePath: portPath });
});

after(async () => {
  await handle?.close();
  if (originalTokensEnv === undefined) delete process.env.PUSHD_TOKENS_PATH;
  else process.env.PUSHD_TOKENS_PATH = originalTokensEnv;
  if (originalPortEnv === undefined) delete process.env.PUSHD_PORT_PATH;
  else process.env.PUSHD_PORT_PATH = originalPortEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(tokensPath, { force: true });
});

function wsUrl() {
  return `ws://127.0.0.1:${handle.port}`;
}

function openWs({ token, origin }) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin !== undefined) headers.Origin = origin;
  return new WebSocket(wsUrl(), { headers });
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
      // ws library exposes upgrade rejections as "unexpected-response".
      // We don't need the body — the status is enough for the assert.
      settle({ kind: 'rejected', statusCode: res.statusCode });
      res.resume();
    });
    ws.on('error', (err) => settle({ kind: 'error', error: err }));
  });
}

function roundTripPing(ws) {
  return new Promise((resolve, reject) => {
    const requestId = `req_${Date.now().toString(36)}`;
    const timer = setTimeout(() => reject(new Error('ping timed out')), 2000);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.requestId === requestId) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    ws.send(
      JSON.stringify({
        v: 'push.runtime.v1',
        kind: 'request',
        requestId,
        type: 'ping',
        payload: {},
      }) + '\n',
    );
  });
}

describe('pushd-ws auth gate', () => {
  it('accepts a valid loopback-bound token + localhost origin and round-trips a ping', async () => {
    const { token } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const ws = openWs({ token, origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'open', `unexpected: ${JSON.stringify(outcome)}`);
    const response = await roundTripPing(ws);
    assert.equal(response.ok, true);
    assert.equal(response.payload.echo, 'ping');
    await closeAndWait(ws);
  });

  it('accepts a valid exact-origin-bound token + matching origin', async () => {
    const origin = 'https://push.zen-dev.com';
    const { token } = await mintDeviceToken({ boundOrigin: origin });
    const ws = openWs({ token, origin });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'open');
    await closeAndWait(ws);
  });

  it('rejects missing bearer token with 401', async () => {
    const ws = openWs({ token: null, origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 401);
  });

  it('rejects malformed bearer token with 401', async () => {
    const ws = openWs({ token: 'definitely-not-a-real-token', origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 401);
  });

  it('rejects unknown but well-shaped token with 401', async () => {
    const ws = openWs({
      token: 'pushd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      origin: 'http://localhost:5173',
    });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 401);
  });

  it('rejects missing Origin with 403 (non-loopback token)', async () => {
    const { token } = await mintDeviceToken({ boundOrigin: 'https://push.zen-dev.com' });
    const ws = openWs({ token, origin: undefined });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 403);
  });

  it('rejects Origin: null with 403', async () => {
    const { token } = await mintDeviceToken({ boundOrigin: 'loopback' });
    const ws = openWs({ token, origin: 'null' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 403);
  });

  it('rejects wrong origin against exact-bound token with 403', async () => {
    const { token } = await mintDeviceToken({ boundOrigin: 'https://push.zen-dev.com' });
    const ws = openWs({ token, origin: 'https://evil.example' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 403);
  });

  it('rejects loopback origin against exact-bound token with 403', async () => {
    const { token } = await mintDeviceToken({ boundOrigin: 'https://push.zen-dev.com' });
    const ws = openWs({ token, origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 403);
  });

  it('rejects revoked tokens with 401', async () => {
    const { token, tokenId } = await mintDeviceToken({ boundOrigin: 'loopback' });
    await revokeDeviceToken(tokenId);
    const ws = openWs({ token, origin: 'http://localhost:5173' });
    const outcome = await waitForUpgradeOutcome(ws);
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.statusCode, 401);
  });

  it('writes the bound port file', async () => {
    const portContent = await fs.readFile(portPath, 'utf8');
    assert.equal(portContent.trim(), String(handle.port));
  });
});
