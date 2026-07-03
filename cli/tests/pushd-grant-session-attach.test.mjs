/**
 * pushd-grant-session-attach.test.mjs — coverage for the
 * `grant_session_attach` handler (tap-to-resume: a paired phone asks
 * for one session's attach token so it can `attach_session` to a
 * conversation it discovered via `list_sessions`).
 *
 * Drives `handleRequest` directly, mirroring
 * `pushd-sandbox-exec.test.mjs`. Sessions are created through the real
 * `start_session` path so the Universal Session Bearer factory mints
 * the token this handler is expected to resolve (never re-mint).
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

/** The synthetic auth relay-forwarded phone frames carry (pushd.ts). */
const RELAY_AUTH = {
  kind: 'attach',
  tokenId: 'pdat_relay',
  parentDeviceTokenId: 'pdt_relay',
  boundOrigin: 'relay',
  lastUsedAt: null,
  deviceRecord: null,
};

async function startSession() {
  const res = await handleRequest(makeRequest('start_session', { mode: 'tui' }), NOOP_EMIT);
  assert.equal(res.ok, true, 'start_session should succeed');
  return { sessionId: res.payload.sessionId, attachToken: res.payload.attachToken };
}

describe('grant_session_attach', () => {
  it('grants the factory-minted token to a relay-authenticated caller', async () => {
    const { sessionId, attachToken } = await startSession();
    const res = await handleRequest(makeRequest('grant_session_attach', { sessionId }), NOOP_EMIT, {
      auth: RELAY_AUTH,
      relaySenderId: 'phone-1',
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.sessionId, sessionId);
    assert.equal(
      res.payload.attachToken,
      attachToken,
      'resolves the existing bearer — never re-mints for a tokened session',
    );
  });

  it('the granted token authorizes attach_session', async () => {
    const { sessionId } = await startSession();
    const grant = await handleRequest(
      makeRequest('grant_session_attach', { sessionId }),
      NOOP_EMIT,
      {
        auth: RELAY_AUTH,
      },
    );
    assert.equal(grant.ok, true);
    const attach = await handleRequest(
      {
        ...makeRequest('attach_session', {
          sessionId,
          attachToken: grant.payload.attachToken,
          lastSeenSeq: 0,
        }),
        sessionId,
      },
      NOOP_EMIT,
      { auth: RELAY_AUTH },
    );
    assert.equal(attach.ok, true, 'granted bearer must satisfy the attach gate');
  });

  it('a wrong token still fails attach_session (grant does not bypass the gate)', async () => {
    const { sessionId } = await startSession();
    const attach = await handleRequest(
      {
        ...makeRequest('attach_session', {
          sessionId,
          attachToken: 'not-the-real-token',
          lastSeenSeq: 0,
        }),
        sessionId,
      },
      NOOP_EMIT,
      { auth: RELAY_AUTH },
    );
    assert.equal(attach.ok, false);
    assert.equal(attach.error.code, 'INVALID_TOKEN');
  });

  it('rejects a missing sessionId with INVALID_REQUEST', async () => {
    const res = await handleRequest(makeRequest('grant_session_attach', {}), NOOP_EMIT, {
      auth: RELAY_AUTH,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_REQUEST');
  });

  it('rejects an unknown session with SESSION_NOT_FOUND', async () => {
    const res = await handleRequest(
      makeRequest('grant_session_attach', { sessionId: 'sess_nonexistent_abc123' }),
      NOOP_EMIT,
      { auth: RELAY_AUTH },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'SESSION_NOT_FOUND');
  });

  it('also serves loopback-WS (device-authed) and unix-socket callers', async () => {
    const { sessionId, attachToken } = await startSession();
    const deviceAuth = {
      kind: 'device',
      tokenId: 'pdt_test_grant',
      parentDeviceTokenId: 'pdt_test_grant',
      boundOrigin: 'http://localhost:5173',
      lastUsedAt: null,
      deviceRecord: null,
    };
    const viaDevice = await handleRequest(
      makeRequest('grant_session_attach', { sessionId }),
      NOOP_EMIT,
      { auth: deviceAuth },
    );
    assert.equal(viaDevice.ok, true);
    assert.equal(viaDevice.payload.attachToken, attachToken);

    // Unix socket (no context): the operator already has filesystem
    // authority over the session store, so refusing here would protect
    // nothing.
    const viaSocket = await handleRequest(
      makeRequest('grant_session_attach', { sessionId }),
      NOOP_EMIT,
    );
    assert.equal(viaSocket.ok, true);
    assert.equal(viaSocket.payload.attachToken, attachToken);
  });
});
