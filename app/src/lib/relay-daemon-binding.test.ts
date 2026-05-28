/**
 * relay-daemon-binding.test.ts — Phase 2.f + targeted-attach tests.
 *
 * The `buildRelayUrl` block pins the pure helper that #530 review
 * tightened. The two `buildRelayUrl` impls (CLI side + web side)
 * must agree byte-for-byte, since the same operator deployment URL
 * flows through both.
 *
 * The targeted-attach block stands up a real `ws` server (Node 20
 * polyfill at the top, same pattern as
 * `local-daemon-sandbox-client.test.ts`) to verify the binding
 * issues `attach_session` over the freshly-opened WS when the bundle
 * carries `targetSessionId` + `targetAttachToken` (PR #686 + this
 * follow-up). The relay route in production lives behind a Worker
 * but the binding's behavior is independent of the routing layer —
 * once WS open, it speaks pushd's RPC vocabulary directly.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { PROTOCOL_VERSION } from '@push/lib/protocol-schema';
import { type AttachResult, buildRelayUrl, createRelayDaemonBinding } from './relay-daemon-binding';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as unknown as { WebSocket: typeof WsClient }).WebSocket = WsClient;
}

const RELAY_SUBPROTOCOL = 'push.relay.v1';
const VALID_TOKEN = 'pushd_da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_TOKEN = 'pushd_da_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TARGET_SESSION_ID = 'sess_tui_target_xyz';

describe('buildRelayUrl (#530 normalization)', () => {
  it('replaces the path on a bare https URL', () => {
    expect(buildRelayUrl('https://example.com', 'sess-1')).toBe(
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('replaces an existing /api path prefix (no double-up)', () => {
    expect(buildRelayUrl('https://example.com/api', 'sess-1')).toBe(
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('replaces an existing /v1/api path prefix', () => {
    expect(buildRelayUrl('https://example.com/v1/api', 'sess-1')).toBe(
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('rewrites http(s) → ws(s)', () => {
    expect(buildRelayUrl('http://localhost:8787', 'sess-1')).toBe(
      'ws://localhost:8787/api/relay/v1/session/sess-1/connect',
    );
  });

  it('tolerates a bare hostname (defaults to wss)', () => {
    expect(buildRelayUrl('relay.example.com', 'sess-1')).toBe(
      'wss://relay.example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('encodes sessionId path component', () => {
    expect(buildRelayUrl('https://example.com', 'pushd-host with spaces')).toMatch(
      /\/session\/pushd-host%20with%20spaces\/connect$/,
    );
  });
});

interface StubRelay {
  port: number;
  /** Every `kind: 'request'` envelope the client sent, in arrival order. */
  capturedRequests: Array<{ type: string; sessionId: string | null; payload: unknown }>;
  /** Override the next response for a given request type (failure-path tests). */
  setResponseOverride: (
    type: string,
    override: { ok: boolean; payload?: unknown; error?: unknown },
  ) => void;
  close: () => Promise<void>;
}

async function startStubRelay(): Promise<StubRelay> {
  const overrides = new Map<string, { ok: boolean; payload?: unknown; error?: unknown }>();
  const captured: StubRelay['capturedRequests'] = [];
  const wss = new WebSocketServer({
    port: 0,
    // The browser-side binding sends `[push.relay.v1, bearer.<token>]`;
    // the relay's job is to pick the selector subprotocol on accept.
    handleProtocols: (protocols) => (protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false),
  });
  const clients = new Set<WsServerSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => {
      const raw = data.toString('utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed) as {
          kind?: string;
          requestId?: string;
          type?: string;
          sessionId?: string | null;
          payload?: unknown;
        };
        if (parsed.kind !== 'request' || !parsed.requestId || !parsed.type) continue;
        captured.push({
          type: parsed.type,
          sessionId: parsed.sessionId ?? null,
          payload: parsed.payload ?? null,
        });
        const override = overrides.get(parsed.type);
        const response = {
          v: PROTOCOL_VERSION,
          kind: 'response' as const,
          requestId: parsed.requestId,
          type: parsed.type,
          sessionId: parsed.sessionId ?? null,
          ok: override?.ok ?? true,
          payload: override?.payload ?? { sessionId: parsed.sessionId },
          error: override?.error ?? null,
        };
        ws.send(`${JSON.stringify(response)}\n`);
      }
    });
    ws.on('close', () => clients.delete(ws));
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    capturedRequests: captured,
    setResponseOverride: (type, override) => overrides.set(type, override),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.close();
        wss.close(() => resolve());
      }),
  };
}

describe('createRelayDaemonBinding — targeted attach_session', () => {
  let server: StubRelay;

  beforeEach(async () => {
    server = await startStubRelay();
  });

  afterEach(async () => {
    await server.close();
  });

  // Helper: await the first attach result without racing the binding's
  // internal callback ordering. The binding always fires
  // `onAttachComplete` exactly once when targets are present.
  function awaitAttach(): { result: Promise<AttachResult>; resolve: (r: AttachResult) => void } {
    let resolve!: (r: AttachResult) => void;
    const result = new Promise<AttachResult>((r) => {
      resolve = r;
    });
    return { result, resolve };
  }

  it('issues attach_session with the target IDs once the WS opens', async () => {
    const attach = awaitAttach();
    const handle = createRelayDaemonBinding({
      deploymentUrl: `http://127.0.0.1:${server.port}`,
      sessionId: 'sess_relay_xyz',
      token: VALID_TOKEN,
      targetSessionId: TARGET_SESSION_ID,
      targetAttachToken: TARGET_TOKEN,
      allowAnyHost: true,
      onAttachComplete: attach.resolve,
    });
    const result = await attach.result;
    expect(result).toEqual({ ok: true, sessionId: TARGET_SESSION_ID });
    const attachReq = server.capturedRequests.find((r) => r.type === 'attach_session');
    expect(attachReq).toBeDefined();
    expect(attachReq?.sessionId).toBe(TARGET_SESSION_ID);
    expect(attachReq?.payload).toEqual({
      attachToken: TARGET_TOKEN,
      lastSeenSeq: 0,
    });
    handle.close();
  });

  it('routes daemon error codes through onAttachComplete', async () => {
    server.setResponseOverride('attach_session', {
      ok: false,
      error: { code: 'INVALID_TOKEN', message: 'attach token did not match', retryable: false },
    });
    const attach = awaitAttach();
    const handle = createRelayDaemonBinding({
      deploymentUrl: `http://127.0.0.1:${server.port}`,
      sessionId: 'sess_relay_xyz',
      token: VALID_TOKEN,
      targetSessionId: TARGET_SESSION_ID,
      targetAttachToken: TARGET_TOKEN,
      allowAnyHost: true,
      onAttachComplete: attach.resolve,
    });
    const result = await attach.result;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TOKEN');
      expect(result.error.message).toContain('attach token did not match');
      expect(result.error.retryable).toBe(false);
    }
    handle.close();
  });

  it('does not issue attach_session when target fields are absent', async () => {
    const attachFired: AttachResult[] = [];
    const handle = createRelayDaemonBinding({
      deploymentUrl: `http://127.0.0.1:${server.port}`,
      sessionId: 'sess_relay_xyz',
      token: VALID_TOKEN,
      // no targetSessionId / targetAttachToken
      allowAnyHost: true,
      onAttachComplete: (result) => attachFired.push(result),
    });
    // Give the WS open handler a beat to fire any unintended sends.
    await new Promise((r) => setTimeout(r, 50));
    expect(attachFired).toEqual([]);
    expect(server.capturedRequests.find((r) => r.type === 'attach_session')).toBeUndefined();
    handle.close();
  });
});
