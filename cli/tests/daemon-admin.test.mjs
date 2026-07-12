/**
 * Behavioral tests for cli/daemon-admin.ts — relay/admin RPC helpers and
 * /remote + /rc control plane (security-adjacent: pairing, minting, health).
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  formatRelayStatusLines,
  requestDaemonAdmin,
  resolveRelayEnableArgs,
  runRemoteCommand,
  runRemoteControlCommand,
} from '../daemon-admin.ts';

function fakeDaemon({
  connected = true,
  sessionId = 'sess_test_abc123',
  attachToken = 'tok',
  requests = [],
  handlers = {},
} = {}) {
  const client = {
    request: async (type, payload, _sid, _timeout) => {
      requests.push({ type, payload });
      const handler = handlers[type];
      if (typeof handler === 'function') return handler(payload);
      if (handler && handler.reject) {
        const err = new Error(handler.message || 'rejected');
        err.code = handler.reject;
        throw err;
      }
      if (handler) return handler;
      return { ok: true, payload: {} };
    },
  };
  return {
    connected,
    sessionId,
    attachToken,
    client,
    autoStartAttempted: false,
    ensureConnected: async () => connected,
    ensureSession: async () => undefined,
    ensureReady: async () => Boolean(connected && sessionId),
    adoptAttachToken: (token) => {
      attachToken = token;
    },
    requests,
  };
}

describe('formatRelayStatusLines', () => {
  it('reports disabled when no persisted config', () => {
    assert.deepEqual(formatRelayStatusLines({ persisted: null }), ['Remote relay: disabled']);
  });

  it('includes live client state and allowlist size', () => {
    const lines = formatRelayStatusLines({
      persisted: { deploymentUrl: 'https://relay.example', enabledAt: 1_700_000_000_000 },
      live: {
        running: true,
        state: 'open',
        attempt: 2,
        allowlistSize: 1,
      },
    });
    assert.match(lines.join('\n'), /enabled/);
    assert.match(lines.join('\n'), /https:\/\/relay\.example/);
    assert.match(lines.join('\n'), /state: open/);
    assert.match(lines.join('\n'), /allowlist: 1/);
  });
});

describe('resolveRelayEnableArgs', () => {
  let tmp;
  let prevConfigPath;
  let prevToken;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'push-daemon-admin-'));
    prevConfigPath = process.env.PUSHD_RELAY_CONFIG_PATH;
    prevToken = process.env.PUSH_RELAY_TOKEN;
    process.env.PUSHD_RELAY_CONFIG_PATH = path.join(tmp, 'pushd.relay.json');
    delete process.env.PUSH_RELAY_TOKEN;
  });

  afterEach(async () => {
    if (prevConfigPath === undefined) delete process.env.PUSHD_RELAY_CONFIG_PATH;
    else process.env.PUSHD_RELAY_CONFIG_PATH = prevConfigPath;
    if (prevToken === undefined) delete process.env.PUSH_RELAY_TOKEN;
    else process.env.PUSH_RELAY_TOKEN = prevToken;
    await rm(tmp, { recursive: true, force: true });
  });

  it('maps two positionals to url + token', async () => {
    const got = await resolveRelayEnableArgs([
      'enable',
      'https://relay.example',
      'pushd_relay_abcdef',
    ]);
    assert.equal(got.deploymentUrl, 'https://relay.example');
    assert.equal(got.token, 'pushd_relay_abcdef');
  });

  it('treats a lone pushd_relay_ token as the token (url from disk)', async () => {
    await writeFile(
      process.env.PUSHD_RELAY_CONFIG_PATH,
      JSON.stringify({
        deploymentUrl: 'https://saved.example',
        token: 'pushd_relay_oldtoken',
        enabledAt: 1,
      }),
      'utf8',
    );
    const got = await resolveRelayEnableArgs(['enable', 'pushd_relay_newtoken']);
    assert.equal(got.deploymentUrl, 'https://saved.example');
    assert.equal(got.token, 'pushd_relay_newtoken');
  });
});

describe('runRemoteCommand', () => {
  it('/remote status reports formatted relay state over the admin RPC', async () => {
    const reports = [];
    const daemon = fakeDaemon({
      handlers: {
        relay_status: {
          ok: true,
          payload: {
            persisted: { deploymentUrl: 'https://relay.example', enabledAt: null },
            live: { running: true, state: 'open', allowlistSize: 0 },
          },
        },
      },
    });
    await runRemoteCommand('status', daemon, (level, text) => reports.push({ level, text }), {
      maskSecret: (v) => String(v).slice(0, 4) + '…',
    });
    assert.equal(daemon.requests[0].type, 'relay_status');
    assert.equal(reports[0].level, 'status');
    assert.match(reports[0].text, /https:\/\/relay\.example/);
  });

  it('/remote pair mints a bundle for the active session', async () => {
    const reports = [];
    const daemon = fakeDaemon({
      handlers: {
        mint_remote_pair_bundle: {
          ok: true,
          payload: {
            bundle: 'PAIR_BUNDLE_SECRET',
            deviceTokenId: 'dev_1',
            attachTokenId: 'att_1',
            deploymentUrl: 'https://relay.example',
            sessionId: 'relay-sess',
            targetSessionId: 'sess_test_abc123',
          },
        },
      },
    });
    await runRemoteCommand('pair', daemon, (level, text) => reports.push({ level, text }), {
      maskSecret: (v) => String(v),
    });
    assert.equal(daemon.requests[0].type, 'mint_remote_pair_bundle');
    assert.equal(daemon.requests[0].payload.targetSessionId, 'sess_test_abc123');
    assert.match(reports[0].text, /PAIR_BUNDLE_SECRET/);
  });

  it('/remote enable rejects a truncated token before contacting the daemon', async () => {
    const reports = [];
    const daemon = fakeDaemon();
    await runRemoteCommand(
      'enable https://relay.example pushd_relay_',
      daemon,
      (level, text) => reports.push({ level, text }),
      { maskSecret: (v) => String(v) },
    );
    assert.equal(daemon.requests.length, 0);
    assert.equal(reports[0].level, 'warning');
    assert.match(reports[0].text, /truncated|token body/i);
  });
});

describe('runRemoteControlCommand', () => {
  it('points at /remote setup when the relay was never configured', async () => {
    const reports = [];
    const daemon = fakeDaemon({
      handlers: {
        relay_status: { ok: true, payload: { persisted: null, live: null } },
      },
    });
    await runRemoteControlCommand('', daemon, (level, text) => reports.push({ level, text }));
    assert.equal(reports[0].level, 'warning');
    assert.match(reports[0].text, /\/remote setup/);
  });

  it('confirms reachability when relay is open and a phone is already paired', async () => {
    const reports = [];
    const daemon = fakeDaemon({
      handlers: {
        relay_status: {
          ok: true,
          payload: {
            persisted: { deploymentUrl: 'https://relay.example', enabledAt: 1 },
            live: { running: true, state: 'open', allowlistSize: 2 },
          },
        },
      },
    });
    await runRemoteControlCommand('', daemon, (level, text) => reports.push({ level, text }), {
      sessionName: 'phone-ready',
    });
    assert.equal(reports[0].level, 'status');
    assert.match(reports[0].text, /reachable from your phone/);
    assert.match(reports[0].text, /paired phones: 2/);
  });
});

describe('requestDaemonAdmin', () => {
  it('returns DAEMON_OFFLINE when no transport and socket connect fails', async () => {
    // With no daemon client and no live pushd, the short-lived connect fails closed.
    const res = await requestDaemonAdmin(null, 'relay_status', {}, { timeoutMs: 50 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'DAEMON_OFFLINE');
  });

  it('routes through the attached daemon client when connected', async () => {
    const daemon = fakeDaemon({
      handlers: {
        list_sessions: { ok: true, payload: { sessions: [{ sessionId: 'sess_a_111111' }] } },
      },
    });
    const res = await requestDaemonAdmin(daemon, 'list_sessions', { limit: 1000 });
    assert.equal(res.ok, true);
    assert.equal(res.payload.sessions[0].sessionId, 'sess_a_111111');
    assert.equal(daemon.requests[0].payload.limit, 1000);
  });
});
