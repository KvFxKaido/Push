/**
 * Characterization tests for `/rc` (remote control) — the one-shot "continue this
 * session on my phone" command (Claude Code-style ergonomics over the
 * relay pieces shipped in Remote Sessions Phases 1-3).
 *
 * Same harness + philosophy as `tui-session-verbs.test.mjs`: drive the
 * REAL keystroke → parseKey → composer → handleSlashCommand path against
 * the stub daemon client, and pin the admin-request choreography for each
 * relay state:
 *
 *   - unconfigured relay  → setup guidance, no bundle minted
 *   - no phone paired     → mints a pairing bundle for THIS session
 *   - phone paired        → confirms reachability, does NOT re-mint
 *   - `/rc pair`          → force-mints even when a phone is paired
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessTui } from './tui-driver.mjs';

const RELAY_PERSISTED = {
  deploymentUrl: 'https://push.example.com',
  enabledAt: 1719900000000,
};

function relayStatusResponse({
  running = true,
  allowlistSize = 0,
  state = 'open',
  exhausted = false,
  fatal = false,
  closeCode = null,
  closeReason = '',
} = {}) {
  return {
    ok: true,
    payload: {
      persisted: RELAY_PERSISTED,
      live: { running, state, allowlistSize, exhausted, fatal, closeCode, closeReason },
    },
  };
}

const PAIR_BUNDLE_RESPONSE = {
  ok: true,
  payload: {
    bundle: 'pushb1.eyJmYWtlIjoiYnVuZGxlIn0',
    deviceTokenId: 'pdt_test_device',
    attachTokenId: 'pdat_test_attach',
    sessionId: 'pushd-testhost',
    targetSessionId: 'stub-session',
    deploymentUrl: RELAY_PERSISTED.deploymentUrl,
    ttlMs: 600000,
  },
};

function transcriptText(h) {
  return (h.tuiState?.transcript ?? []).map((e) => e.text ?? '').join('\n');
}

async function runRemoteControl(line, verbResponses, { waitText } = {}) {
  const h = await startHeadlessTui({ verbResponses });
  await h.typeLine(line);
  await h.waitFor(() => (waitText ? transcriptText(h).includes(waitText) : false), {
    timeoutMs: 2000,
  });
  return h;
}

describe('TUI /rc (headless characterization)', () => {
  it('unconfigured relay → one-time setup guidance, no bundle minted', async () => {
    const h = await runRemoteControl(
      '/rc',
      { relay_status: { ok: true, payload: { persisted: null } } },
      { waitText: '/remote setup' },
    );
    try {
      assert.equal(h.requestsOfType('relay_status').length, 1);
      assert.equal(
        h.requestsOfType('mint_remote_pair_bundle').length,
        0,
        'must not mint before the relay is configured',
      );
      assert.ok(
        transcriptText(h).includes('/remote setup <deployment-url>'),
        'points at the one-time setup command',
      );
    } finally {
      await h.stop();
    }
  });

  it('relay up, no phone paired → mints a pairing bundle for this session', async () => {
    const h = await runRemoteControl(
      '/rc',
      {
        relay_status: relayStatusResponse({ allowlistSize: 0 }),
        mint_remote_pair_bundle: PAIR_BUNDLE_RESPONSE,
      },
      { waitText: 'Bundle (copy now' },
    );
    try {
      const mints = h.requestsOfType('mint_remote_pair_bundle');
      assert.equal(mints.length, 1, 'exactly one bundle minted');
      assert.equal(
        mints[0].payload.targetSessionId,
        'stub-session',
        'the bundle targets the current TUI session',
      );
      assert.equal(
        mints[0].payload.targetAttachToken,
        'stub-token',
        'carries the session attach token so the phone can resume it',
      );
      assert.ok(
        transcriptText(h).includes('Chats drawer under Connected'),
        'tells the user where the session shows up on the phone',
      );
    } finally {
      await h.stop();
    }
  });

  it('phone already paired → confirms reachability without re-minting', async () => {
    const h = await runRemoteControl(
      '/rc',
      { relay_status: relayStatusResponse({ allowlistSize: 2 }) },
      { waitText: 'reachable from your phone' },
    );
    try {
      assert.equal(
        h.requestsOfType('mint_remote_pair_bundle').length,
        0,
        'no new bundle when a phone is already paired',
      );
      const text = transcriptText(h);
      assert.ok(text.includes('paired phones: 2'));
      assert.ok(text.includes('listed under Connected'));
    } finally {
      await h.stop();
    }
  });

  it('/rc pair force-mints even with a phone already paired', async () => {
    const h = await runRemoteControl(
      '/rc pair',
      {
        relay_status: relayStatusResponse({ allowlistSize: 2 }),
        mint_remote_pair_bundle: PAIR_BUNDLE_RESPONSE,
      },
      { waitText: 'Bundle (copy now' },
    );
    try {
      assert.equal(h.requestsOfType('mint_remote_pair_bundle').length, 1);
    } finally {
      await h.stop();
    }
  });

  it('running-but-disconnected relay → reports the state instead of confirming', async () => {
    // Codex P2 on #1309: `running: true` alone doesn't mean the phone can
    // reach us — a closed/exhausted client still holds activeRelayClient.
    // With no saved relay config in the isolated test home, the re-dial is
    // skipped and the health gate must refuse to mint or confirm.
    const h = await runRemoteControl(
      '/rc',
      {
        relay_status: relayStatusResponse({
          allowlistSize: 2,
          state: 'closed',
          exhausted: true,
          closeCode: 1006,
          closeReason: 'abnormal closure',
        }),
      },
      { waitText: 'Remote relay is not connected' },
    );
    try {
      assert.equal(
        h.requestsOfType('mint_remote_pair_bundle').length,
        0,
        'must not mint over a dead relay',
      );
      const text = transcriptText(h);
      assert.ok(text.includes('state: closed'), 'surfaces the real relay state');
      assert.ok(!text.includes('reachable from your phone'), 'must not claim reachability');
    } finally {
      await h.stop();
    }
  });

  it('unknown subcommand → usage warning, no daemon admin traffic', async () => {
    const h = await runRemoteControl('/rc bogus', {}, { waitText: 'Usage: /rc' });
    try {
      assert.equal(h.requestsOfType('relay_status').length, 0);
      assert.equal(h.requestsOfType('mint_remote_pair_bundle').length, 0);
    } finally {
      await h.stop();
    }
  });
});
