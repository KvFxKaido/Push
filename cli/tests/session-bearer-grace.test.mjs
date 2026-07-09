/**
 * session-bearer-grace.test.mjs — Universal Session Bearer step 2+4:
 * bootstrap grace (legacy cutover) + adopt-from-response.
 * Spec: docs/decisions/Universal Session Bearer.md
 *
 * Bootstrap grace: a session created before the bearer factory existed is
 * tokenless on disk. On its FIRST `attach_session` where the client ALSO
 * presents no token, the daemon CLAIMS it — mints + persists + accepts that
 * one attach — and returns the token so the client adopts it. Every later
 * attach then requires it.
 *
 * The gating risk these tests pin (from the audit): the stale-in-memory
 * lockout. Once the daemon claims+tokens a session, a client that failed to
 * ADOPT the returned token would present a stale `undefined` on its next
 * reconnect and be locked out of its own session. So we assert BOTH halves:
 *   - the response carries the claimed token (so the client CAN adopt), and
 *   - a tokenless reattach AFTER a claim is rejected (proving adoption is
 *     mandatory — a regression that stops returning the token would strand
 *     the client here).
 *
 * Per-client token sources (audit table) are re-verified:
 *   - TUI  adopts in-memory from `res.payload.attachToken` (source guard below)
 *   - CLI  adopts implicitly via shared disk (per-reconnect re-read)
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  handleRequest,
  __getActiveSessionForTesting,
  __evictActiveSessionForTesting,
} from '../pushd.ts';
import { PROTOCOL_VERSION, loadSessionState, saveSessionState } from '../session-store.ts';
import { buildAttachSessionPayloadForSession } from '../cli.ts';

// Match the daemon-integration harness: strict protocol mode pinned for the
// file's lifetime so any response/event drift the grace path introduces lands
// as a failure instead of silent consumer breakage.
let previousStrictMode;
before(() => {
  previousStrictMode = process.env.PUSH_PROTOCOL_STRICT;
  process.env.PUSH_PROTOCOL_STRICT = '1';
});
after(() => {
  if (previousStrictMode === undefined) delete process.env.PUSH_PROTOCOL_STRICT;
  else process.env.PUSH_PROTOCOL_STRICT = previousStrictMode;
});

function makeRequest(type, payload = {}, sessionId = null) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${randomBytes(4).toString('hex')}`,
    type,
    sessionId,
    payload,
  };
}

const noop = () => {};

async function withTempSessionDir(name, fn) {
  const original = process.env.PUSH_SESSION_DIR;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), name));
  process.env.PUSH_SESSION_DIR = tmpRoot;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = original;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

// Build a legacy tokenless session on disk: create one the normal way, strip
// its persisted attachToken (simulating a session written before the bearer
// field existed), and evict from memory so the next attach lazy-loads the
// tokenless state from disk.
async function makeLegacyTokenlessSession() {
  const start = await handleRequest(
    makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
    noop,
  );
  const { sessionId } = start.payload;
  __evictActiveSessionForTesting(sessionId);
  const raw = await loadSessionState(sessionId);
  delete raw.attachToken;
  await saveSessionState(raw);
  return sessionId;
}

describe('attach_session bootstrap grace (legacy cutover)', () => {
  it('claims a legacy tokenless session on a tokenless attach: mints, persists, returns the token', async () => {
    await withTempSessionDir('push-grace-claim-', async () => {
      const sessionId = await makeLegacyTokenlessSession();

      const res = await handleRequest(makeRequest('attach_session', { sessionId }), noop);
      assert.equal(
        res.ok,
        true,
        `expected claim-attach to succeed, got ${JSON.stringify(res.error)}`,
      );

      const claimed = res.payload.attachToken;
      assert.match(
        claimed,
        /^att_[0-9a-f]{16}$/,
        'response must carry the claimed token so the client can adopt it',
      );

      // Persisted to disk (durable across a daemon restart).
      const persisted = await loadSessionState(sessionId);
      assert.equal(persisted.attachToken, claimed, 'claimed token must be persisted');

      // Pinned in the in-memory registry entry too.
      const entry = __getActiveSessionForTesting(sessionId);
      assert.equal(entry.attachToken, claimed);
    });
  });

  it('after a claim the session is tokened forever: adopted token attaches, tokenless reattach is rejected (lockout guard)', async () => {
    await withTempSessionDir('push-grace-lockout-', async () => {
      const sessionId = await makeLegacyTokenlessSession();

      const first = await handleRequest(makeRequest('attach_session', { sessionId }), noop);
      const claimed = first.payload.attachToken;
      assert.ok(claimed, 'first tokenless attach should claim and return a token');

      // Reconnect WITH the adopted token → accepted, and the response echoes
      // it so re-adoption stays idempotent.
      const withToken = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken: claimed }),
        noop,
      );
      assert.equal(
        withToken.ok,
        true,
        `adopted-token reattach should succeed: ${JSON.stringify(withToken.error)}`,
      );
      assert.equal(withToken.payload.attachToken, claimed);

      // Reconnect WITHOUT the token → rejected. THIS is the lockout: a client
      // that didn't adopt the claimed token presents a stale `undefined` and
      // is locked out. Grace does NOT re-fire (the session is tokened now).
      const withoutToken = await handleRequest(makeRequest('attach_session', { sessionId }), noop);
      assert.equal(withoutToken.ok, false, 'a second tokenless attach must NOT silently re-claim');
      assert.equal(withoutToken.error.code, 'INVALID_TOKEN');
    });
  });

  it('does NOT claim a tokened session attached without a token (grace is scoped to tokenless)', async () => {
    await withTempSessionDir('push-grace-tokened-', async () => {
      const start = await handleRequest(
        makeRequest('start_session', { provider: 'ollama', repo: { rootPath: process.cwd() } }),
        noop,
      );
      const { sessionId } = start.payload;
      // Evict so the attach lazy-loads the (tokened) state from disk.
      __evictActiveSessionForTesting(sessionId);

      const res = await handleRequest(makeRequest('attach_session', { sessionId }), noop);
      assert.equal(res.ok, false, 'a tokened session must reject a tokenless attach, not claim it');
      assert.equal(res.error.code, 'INVALID_TOKEN');
    });
  });

  it('does NOT claim a legacy tokenless session attached WITH a token, and rejects it (bypass removed)', async () => {
    await withTempSessionDir('push-grace-clienttoken-', async () => {
      const sessionId = await makeLegacyTokenlessSession();

      // tokenless on disk + client presents a token → "any other combination
      // enforces normally". Grace does NOT fire (client presented a token), and
      // with the bypass removed (Universal Session Bearer) the mismatch
      // (undefined session token vs the client's token) is now rejected.
      const res = await handleRequest(
        makeRequest('attach_session', { sessionId, attachToken: 'att_clientheld' }),
        noop,
      );
      assert.equal(res.ok, false, 'tokenless session + client token must be rejected, not claimed');
      assert.equal(res.error.code, 'INVALID_TOKEN');

      const entry = __getActiveSessionForTesting(sessionId);
      assert.equal(
        entry.attachToken,
        undefined,
        'grace must not mint when the client presented a token',
      );
    });
  });

  it('CLI adopts the claimed token implicitly via shared disk (per-reconnect re-read)', async () => {
    await withTempSessionDir('push-grace-cli-adopt-', async () => {
      const sessionId = await makeLegacyTokenlessSession();

      // Before the claim: disk is tokenless, so the CLI attach payload omits
      // the token (readLocalAttachToken returns null).
      const before = await buildAttachSessionPayloadForSession(sessionId, 0);
      assert.equal(before.attachToken, undefined, 'pre-claim CLI payload carries no token');

      // Daemon claims on a tokenless attach and persists the token to the same
      // shared session dir the CLI reads from.
      const res = await handleRequest(makeRequest('attach_session', { sessionId }), noop);
      const claimed = res.payload.attachToken;

      // After the claim: the CLI's NEXT attach payload re-reads disk and picks
      // up the persisted token — no in-memory adopt code needed on the CLI.
      const afterPayload = await buildAttachSessionPayloadForSession(sessionId, 5);
      assert.equal(
        afterPayload.attachToken,
        claimed,
        'post-claim CLI payload re-reads the persisted token',
      );
    });
  });
});

// ─── client-side adopt source guards ─────────────────────────────
//
// The handler returns the token; the clients must consume it. These pin the
// two adopt paths so a refactor that drops adoption fails loudly instead of
// silently reintroducing the lockout.
describe('adopt-from-response source guards', () => {
  const read = (rel) => fs.readFile(path.join(import.meta.dirname, '..', rel), 'utf8');

  it('the daemon attach_session response returns attachToken for adoption', async () => {
    const src = await read('pushd.ts');
    // Within handleAttachSession's success response.
    assert.match(
      src,
      /attachToken: entry\.attachToken/,
      'attach_session must echo the session token so clients can adopt it',
    );
  });

  it('the TUI adopts res.payload.attachToken into durable state on attach', async () => {
    // The attach path lives on the DaemonSessionController (TUI Decomposition
    // Phase 1): it reads the token from the attach response and persists it
    // through the durable-session hook, which the TUI wires to
    // `state.attachToken`.
    const controllerSrc = await read('tui-daemon-session.ts');
    assert.match(
      controllerSrc,
      /res\.payload\?\.attachToken/,
      'attachExistingSession must read the token from the attach response',
    );
    assert.match(
      controllerSrc,
      /if \(adoptedToken\) this\.#hooks\.setDurableAttachToken\(adoptedToken\);/,
      'the controller must persist the adopted token through the durable-session hook',
    );
    const tuiSrc = await read('tui.ts');
    assert.match(
      tuiSrc,
      /setDurableAttachToken: \(token\) => \{\s*if \(state && typeof state === 'object'\) state\.attachToken = token;/,
      'the TUI must wire the durable-token hook to in-memory state for the next reconnect',
    );
  });
});
