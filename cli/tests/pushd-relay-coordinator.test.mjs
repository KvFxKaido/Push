/**
 * Focused ownership tests for the Phase 3 relay coordinator boundary.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION, RELAY_SENDER_FIELD } from '../../lib/protocol-schema.ts';
import { createDeviceAdminHandlers } from '../pushd/device-admin-handlers.ts';
import { makeResponse } from '../pushd/envelopes.ts';
import { createRelayCoordinator } from '../pushd/relay-coordinator.ts';

const NOOP_EMIT = () => {};

function makeFakeRelay() {
  const frames = [];
  let options = null;
  let closed = false;
  const handle = {
    status: { state: 'connecting', attempt: 0 },
    send(frame) {
      frames.push(frame);
      return true;
    },
    reconnect() {},
    nudge() {},
    close() {
      closed = true;
    },
  };
  return {
    frames,
    handle,
    startClient(nextOptions) {
      options = nextOptions;
      return handle;
    },
    get options() {
      return options;
    },
    get closed() {
      return closed;
    },
  };
}

let tmpDir;
let originalRelayConfigPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-relay-coordinator-'));
  originalRelayConfigPath = process.env.PUSHD_RELAY_CONFIG_PATH;
  process.env.PUSHD_RELAY_CONFIG_PATH = path.join(tmpDir, 'pushd.relay.json');
});

afterEach(async () => {
  if (originalRelayConfigPath === undefined) delete process.env.PUSHD_RELAY_CONFIG_PATH;
  else process.env.PUSHD_RELAY_CONFIG_PATH = originalRelayConfigPath;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('RelayCoordinator', () => {
  it('owns live state and emits allow/revoke envelopes through the active client', async () => {
    const fake = makeFakeRelay();
    const coordinator = createRelayCoordinator({
      dispatch: async (request) =>
        makeResponse(request.requestId ?? 'req', request.type ?? 'unknown', null, true, {}),
      addSessionClient() {},
      startClient: fake.startClient,
    });

    coordinator.allowAttachToken('pdat_one', 'hash_one');
    coordinator.start({
      deploymentUrl: 'https://relay.example',
      token: 'pushd_relay_test',
      enabledAt: 123,
    });
    assert.equal(coordinator.isRunning(), true);

    const openedFrames = [];
    fake.options.onOpen((frame) => openedFrames.push(JSON.parse(frame)));
    assert.deepEqual(openedFrames[0].tokenHashes, ['hash_one']);
    assert.equal(openedFrames[0].kind, 'relay_phone_allow');

    fake.options.onStatus({ state: 'open' });
    const status = await coordinator.buildStatusPayload();
    assert.equal(status.live.running, true);
    assert.equal(status.live.state, 'open');
    assert.equal(status.live.allowlistSize, 1);

    coordinator.revokeAttachToken('pdat_one');
    assert.equal(JSON.parse(fake.frames.at(-1)).kind, 'relay_phone_revoke');
    assert.deepEqual(JSON.parse(fake.frames.at(-1)).tokenHashes, ['hash_one']);

    coordinator.stop({ clearAllowlist: true });
    assert.equal(fake.closed, true);
    assert.equal(coordinator.isRunning(), false);
  });

  it('dispatches relay requests with synthetic auth, sender ownership, and session fan-out', async () => {
    const fake = makeFakeRelay();
    let dispatched = null;
    const registrations = [];
    const coordinator = createRelayCoordinator({
      dispatch: async (request, emitEvent, context) => {
        dispatched = { request, emitEvent, context };
        return makeResponse(request.requestId, request.type, null, true, {});
      },
      addSessionClient: (...args) => registrations.push(args),
      startClient: fake.startClient,
    });
    coordinator.start({
      deploymentUrl: 'https://relay.example',
      token: 'pushd_relay_test',
      enabledAt: 123,
    });

    await fake.options.onMessage(
      `${JSON.stringify({
        v: PROTOCOL_VERSION,
        kind: 'request',
        requestId: 'req_attach',
        type: 'attach_session',
        payload: { sessionId: 'sess_one', capabilities: ['event_v2'] },
        [RELAY_SENDER_FIELD]: 'phone_one',
      })}\n`,
    );

    assert.equal(dispatched.context.auth.kind, 'attach');
    assert.equal(dispatched.context.auth.boundOrigin, 'relay');
    assert.equal(dispatched.context.relaySenderId, 'phone_one');
    assert.ok(dispatched.context.wsState.activeRuns instanceof Map);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0][0], 'sess_one');
    assert.deepEqual(registrations[0][2], ['event_v2']);
    assert.equal(JSON.parse(fake.frames.at(-1)).requestId, 'req_attach');
  });

  it('drives relay enable/status/disable through the device-admin handlers', async () => {
    const fake = makeFakeRelay();
    const coordinator = createRelayCoordinator({
      dispatch: async (request) =>
        makeResponse(request.requestId ?? 'req', request.type ?? 'unknown', null, true, {}),
      addSessionClient() {},
      startClient: fake.startClient,
    });
    const handlers = createDeviceAdminHandlers({
      relay: coordinator,
      getWsHandle: () => null,
      sessions: new Map(),
      loadSessionState: async () => {
        throw new Error('not used');
      },
      saveSessionState: async () => {},
    });

    const enabled = await handlers.handleRelayEnable(
      {
        requestId: 'req_enable',
        type: 'relay_enable',
        payload: {
          deploymentUrl: 'https://relay.example',
          token: 'pushd_relay_test',
        },
      },
      NOOP_EMIT,
    );
    assert.equal(enabled.ok, true);
    assert.equal(coordinator.isRunning(), true);

    const status = await handlers.handleRelayStatus(
      { requestId: 'req_status', type: 'relay_status', payload: {} },
      NOOP_EMIT,
    );
    assert.equal(status.ok, true);
    assert.equal(status.payload.persisted.deploymentUrl, 'https://relay.example');
    assert.equal(status.payload.live.running, true);

    const disabled = await handlers.handleRelayDisable(
      { requestId: 'req_disable', type: 'relay_disable', payload: {} },
      NOOP_EMIT,
    );
    assert.equal(disabled.ok, true);
    assert.equal(disabled.payload.configRemoved, true);
    assert.equal(disabled.payload.clientStopped, true);
    assert.equal(coordinator.isRunning(), false);
  });
});
